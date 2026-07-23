/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { dataCache } from '../data-cache';

export function calculateLeagueRankHistory(allHistories: any): any {
    if (!allHistories || allHistories.length === 0) return {};

    // Find max GW
    const maxGW = Math.max(...allHistories.flatMap((h: any) => h.gameweeks.map((g: any) => g.event)));

    // Build cumulative points per manager per GW
    const managerCumulative: any = {};
    allHistories.forEach((manager: any) => {
        managerCumulative[manager.entryId] = {};
        let cumulative = 0;
        manager.gameweeks.forEach((gw: any) => {
            cumulative += gw.points - (gw.event_transfers_cost || 0);
            managerCumulative[manager.entryId][gw.event] = cumulative;
        });
    });

    // Calculate rank for each manager at each GW
    const rankHistory: any = {};
    allHistories.forEach((m: any) => rankHistory[m.entryId] = []);

    for (let gw = 1; gw <= maxGW; gw++) {
        // Get all managers' cumulative at this GW
        const gwScores = allHistories
            .filter((m: any) => managerCumulative[m.entryId][gw] !== undefined)
            .map((m: any) => ({
                entryId: m.entryId,
                cumulative: managerCumulative[m.entryId][gw]
            }))
            .sort((a: any, b: any) => b.cumulative - a.cumulative);

        // Assign ranks
        gwScores.forEach((score: any, idx: number) => {
            rankHistory[score.entryId].push({
                gw,
                rank: idx + 1,
                points: allHistories.find((h: any) => h.entryId === score.entryId)?.gameweeks.find((g: any) => g.event === gw)?.points || 0
            });
        });
    }

    return rankHistory;
}

// =============================================================================
// HEAD-TO-HEAD COMPARISON
// =============================================================================
// Built entirely from materialised, frozen caches — the per-GW week history
// (score, bench, transfers, cost, captain, chip) and the pre-computed manager
// profiles (names, rank history). A completed gameweek is never recomputed or
// re-fetched from the FPL API here, so H2H keeps working after the season reset.
export async function fetchH2HComparison(entryId1: any, entryId2: any): Promise<any> {
    // Get manager profiles for names, rank history
    const profile1 = dataCache.managerProfiles[entryId1];
    const profile2 = dataCache.managerProfiles[entryId2];

    if (!profile1 || !profile2) {
        return { error: 'One or both manager profiles not found. Data may still be loading.' };
    }

    const weekHistory = dataCache.weekHistoryCache || {};
    const gws = Object.keys(weekHistory)
        .map(Number)
        .filter((g) => Number.isFinite(g))
        .sort((a, b) => a - b);
    // "Current" GW for chip-window logic is the latest concluded GW we hold.
    const currentGW = gws.length ? gws[gws.length - 1] : 0;

    const rowFor = (gw: number, entryId: any): any =>
        (weekHistory[gw]?.managers || []).find((m: any) => m.entryId === entryId);

    // GW-by-GW comparison (net GW score — the same value the week table shows)
    const gwComparison: any[] = [];
    let m1Wins = 0, m2Wins = 0, draws = 0;
    let m1Cumulative = 0, m2Cumulative = 0;

    // Captain comparison (from stored captain name/points/chip per GW)
    const captainData: any[] = [];
    let m1CaptainTotal = 0, m2CaptainTotal = 0, sameCaptainCount = 0;

    // Chips actually played, reconstructed from each GW's activeChip
    const usedChips1: any[] = [];
    const usedChips2: any[] = [];

    for (const gw of gws) {
        const r1 = rowFor(gw, entryId1);
        const r2 = rowFor(gw, entryId2);
        if (!r1 || !r2) continue;

        const pts1 = r1.gwScore ?? 0;
        const pts2 = r2.gwScore ?? 0;
        m1Cumulative += pts1;
        m2Cumulative += pts2;
        if (pts1 > pts2) m1Wins++;
        else if (pts2 > pts1) m2Wins++;
        else draws++;
        gwComparison.push({ gw, m1Points: pts1, m2Points: pts2, m1Cumulative, m2Cumulative });

        const c1 = r1.captainPoints ?? 0;
        const c2 = r2.captainPoints ?? 0;
        m1CaptainTotal += c1;
        m2CaptainTotal += c2;
        const same = !!r1.captainName && r1.captainName === r2.captainName;
        if (same) sameCaptainCount++;
        if (r1.captainName || r2.captainName) {
            captainData.push({
                gw,
                m1: { name: r1.captainName ?? 'Unknown', points: c1, chip: r1.activeChip || null },
                m2: { name: r2.captainName ?? 'Unknown', points: c2, chip: r2.activeChip || null },
                same,
            });
        }

        if (r1.activeChip) usedChips1.push({ name: r1.activeChip, event: gw });
        if (r2.activeChip) usedChips2.push({ name: r2.activeChip, event: gw });
    }

    const sumField = (entryId: any, key: string): number =>
        gws.reduce((sum, gw) => sum + (rowFor(gw, entryId)?.[key] || 0), 0);

    // Transfer comparison
    const m1Transfers = sumField(entryId1, 'transfers');
    const m2Transfers = sumField(entryId2, 'transfers');
    const m1TransferCost = sumField(entryId1, 'transferCost');
    const m2TransferCost = sumField(entryId2, 'transferCost');

    // Chip comparison - compute per-half status matching chips page format
    function buildChipStatus(usedChips: any) {
        const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'];
        const chipStatus: any = { firstHalf: {}, secondHalf: {} };
        CHIP_TYPES.forEach(chipType => {
            const usedFirstHalf = usedChips.find((c: any) => c.name === chipType && c.event <= 19);
            if (usedFirstHalf) {
                chipStatus.firstHalf[chipType] = { status: 'used', gw: usedFirstHalf.event };
            } else if (currentGW >= 20) {
                chipStatus.firstHalf[chipType] = { status: 'expired' };
            } else {
                chipStatus.firstHalf[chipType] = { status: 'available' };
            }
            const usedSecondHalf = usedChips.find((c: any) => c.name === chipType && c.event >= 20);
            if (usedSecondHalf) {
                chipStatus.secondHalf[chipType] = { status: 'used', gw: usedSecondHalf.event };
            } else if (currentGW >= 20) {
                chipStatus.secondHalf[chipType] = { status: 'available' };
            } else {
                chipStatus.secondHalf[chipType] = { status: 'locked' };
            }
        });
        return chipStatus;
    }
    const m1Chips = buildChipStatus(usedChips1);
    const m2Chips = buildChipStatus(usedChips2);

    // Form (last 5 GW average) — from stored net GW scores
    const last5GWs = gws.slice(-5);
    const m1Form = last5GWs.map((gw: any) => rowFor(gw, entryId1)?.gwScore || 0);
    const m2Form = last5GWs.map((gw: any) => rowFor(gw, entryId2)?.gwScore || 0);
    const m1FormAvg = m1Form.length > 0 ? Math.round(m1Form.reduce((s: any, p: any) => s + p, 0) / m1Form.length * 10) / 10 : 0;
    const m2FormAvg = m2Form.length > 0 ? Math.round(m2Form.reduce((s: any, p: any) => s + p, 0) / m2Form.length * 10) / 10 : 0;

    // Totals (baked cumulative Total at the latest GW) and bench points
    const m1Total = rowFor(currentGW, entryId1)?.overallPoints ?? m1Cumulative;
    const m2Total = rowFor(currentGW, entryId2)?.overallPoints ?? m2Cumulative;
    const m1BenchTotal = sumField(entryId1, 'benchPoints');
    const m2BenchTotal = sumField(entryId2, 'benchPoints');

    // Best/worst GW — from the per-GW net scores
    const bestWorst = (entryId: any) => {
        let best = { points: 0, gw: 0 };
        let worst = { points: Infinity, gw: 0 };
        for (const gw of gws) {
            const p = rowFor(gw, entryId)?.gwScore;
            if (p == null) continue;
            if (p > best.points) best = { points: p, gw };
            if (p < worst.points) worst = { points: p, gw };
        }
        if (worst.points === Infinity) worst = { points: 0, gw: 0 };
        return { best, worst };
    };
    const { best: m1Best, worst: m1Worst } = bestWorst(entryId1);
    const { best: m2Best, worst: m2Worst } = bestWorst(entryId2);

    return {
        manager1: { entryId: entryId1, name: profile1.name, team: profile1.team },
        manager2: { entryId: entryId2, name: profile2.name, team: profile2.team },
        currentGW,
        headToHead: { m1Wins, m2Wins, draws },
        gwComparison,
        captains: {
            data: captainData,
            m1Total: m1CaptainTotal,
            m2Total: m2CaptainTotal,
            sameCaptainCount,
            totalGWs: captainData.length
        },
        transfers: {
            m1: { total: m1Transfers, cost: m1TransferCost },
            m2: { total: m2Transfers, cost: m2TransferCost }
        },
        chips: { m1: m1Chips, m2: m2Chips },
        form: {
            m1: { avg: m1FormAvg, scores: m1Form, gws: last5GWs },
            m2: { avg: m2FormAvg, scores: m2Form, gws: last5GWs }
        },
        totals: { m1: m1Total, m2: m2Total },
        benchPoints: { m1: m1BenchTotal, m2: m2BenchTotal },
        bestGW: { m1: m1Best, m2: m2Best },
        worstGW: { m1: m1Worst, m2: m2Worst },
        rankHistory: {
            m1: profile1.history || [],
            m2: profile2.history || []
        }
    };
}
