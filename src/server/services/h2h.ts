/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { fetchBootstrap, fetchFixtures, fetchManagerHistory, getCompletedGameweeks } from '../fpl/client';
import { dataCache, fetchManagerPicksCached, fetchLiveGWDataCached } from '../data-cache';

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
export async function fetchH2HComparison(entryId1: any, entryId2: any): Promise<any> {
    const [bootstrap, fixtures, history1, history2]: any[] = await Promise.all([
        fetchBootstrap(),
        fetchFixtures(),
        fetchManagerHistory(entryId1),
        fetchManagerHistory(entryId2)
    ]);

    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 0;

    // Get manager profiles for names, rank history
    const profile1 = dataCache.managerProfiles[entryId1];
    const profile2 = dataCache.managerProfiles[entryId2];

    if (!profile1 || !profile2) {
        return { error: 'One or both manager profiles not found. Data may still be loading.' };
    }

    // GW-by-GW comparison
    const gwComparison: any[] = [];
    let m1Wins = 0, m2Wins = 0, draws = 0;
    let m1Cumulative = 0, m2Cumulative = 0;

    for (const gw of completedGWs) {
        const gw1 = history1.current.find((h: any) => h.event === gw);
        const gw2 = history2.current.find((h: any) => h.event === gw);

        if (!gw1 || !gw2) continue;

        const pts1 = gw1.points;
        const pts2 = gw2.points;
        m1Cumulative += pts1;
        m2Cumulative += pts2;

        if (pts1 > pts2) m1Wins++;
        else if (pts2 > pts1) m2Wins++;
        else draws++;

        gwComparison.push({
            gw,
            m1Points: pts1,
            m2Points: pts2,
            m1Cumulative,
            m2Cumulative
        });
    }

    // Captain comparison - fetch picks for each completed GW (uses cache)
    const captainData: any[] = [];
    let m1CaptainTotal = 0, m2CaptainTotal = 0;
    let sameCaptainCount = 0;

    // Helper to read effective captain (post VC inheritance) from processed cache,
    // falling back to raw picks. captain.multiplier from raw picks is unreliable
    // for completed GWs — FPL rewrites it to 0 on a non-playing captain, which
    // would falsely zero the H2H captain comparison if used directly.
    const resolveCaptainForGW = (entryId: any, gw: any, picks: any, liveData: any) => {
        const processed = dataCache.processedPicksCache[`${entryId}-${gw}`];
        const effectiveCaptain = processed?.players?.find((p: any) => p.isCaptain);
        if (effectiveCaptain) {
            return {
                elementId: effectiveCaptain.id,
                name: effectiveCaptain.name,
                basePoints: effectiveCaptain.points || 0,
                multiplier: effectiveCaptain.multiplier || (picks?.active_chip === '3xc' ? 3 : 2)
            };
        }
        const captain = picks?.picks?.find((p: any) => p.is_captain);
        if (!captain) return null;
        const basePoints = liveData?.elements?.find((e: any) => e.id === captain.element)?.stats?.total_points || 0;
        const isTC = picks?.active_chip === '3xc';
        return {
            elementId: captain.element,
            name: bootstrap.elements?.find((e: any) => e.id === captain.element)?.web_name || 'Unknown',
            basePoints,
            multiplier: isTC ? 3 : 2
        };
    };

    for (const gw of completedGWs) {
        try {
            const [picks1, picks2, liveData]: any[] = await Promise.all([
                fetchManagerPicksCached(entryId1, gw, bootstrap),
                fetchManagerPicksCached(entryId2, gw, bootstrap),
                fetchLiveGWDataCached(gw, bootstrap)
            ]);

            const cap1 = resolveCaptainForGW(entryId1, gw, picks1, liveData);
            const cap2 = resolveCaptainForGW(entryId2, gw, picks2, liveData);

            if (cap1 && cap2) {
                const c1Multiplied = cap1.basePoints * cap1.multiplier;
                const c2Multiplied = cap2.basePoints * cap2.multiplier;

                m1CaptainTotal += c1Multiplied;
                m2CaptainTotal += c2Multiplied;

                if (cap1.elementId === cap2.elementId) sameCaptainCount++;

                captainData.push({
                    gw,
                    m1: { name: cap1.name, points: c1Multiplied, chip: picks1.active_chip || null },
                    m2: { name: cap2.name, points: c2Multiplied, chip: picks2.active_chip || null },
                    same: cap1.elementId === cap2.elementId
                });
            }
        } catch (e) {
            // Skip GWs where picks couldn't be fetched
        }
    }

    // Transfer comparison
    const m1Transfers = history1.current.reduce((sum: any, gw: any) => sum + gw.event_transfers, 0);
    const m2Transfers = history2.current.reduce((sum: any, gw: any) => sum + gw.event_transfers, 0);
    const m1TransferCost = history1.current.reduce((sum: any, gw: any) => sum + gw.event_transfers_cost, 0);
    const m2TransferCost = history2.current.reduce((sum: any, gw: any) => sum + gw.event_transfers_cost, 0);

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
    const m1Chips = buildChipStatus(history1.chips || []);
    const m2Chips = buildChipStatus(history2.chips || []);

    // Form (last 5 GW average)
    const last5GWs = completedGWs.slice(-5);
    const m1Form = last5GWs.map((gw: any) => history1.current.find((h: any) => h.event === gw)?.points || 0);
    const m2Form = last5GWs.map((gw: any) => history2.current.find((h: any) => h.event === gw)?.points || 0);
    const m1FormAvg = m1Form.length > 0 ? Math.round(m1Form.reduce((s: any, p: any) => s + p, 0) / m1Form.length * 10) / 10 : 0;
    const m2FormAvg = m2Form.length > 0 ? Math.round(m2Form.reduce((s: any, p: any) => s + p, 0) / m2Form.length * 10) / 10 : 0;

    // Totals and bench points
    const m1Total = history1.current[history1.current.length - 1]?.total_points || 0;
    const m2Total = history2.current[history2.current.length - 1]?.total_points || 0;
    const m1BenchTotal = history1.current.reduce((sum: any, gw: any) => sum + (gw.points_on_bench || 0), 0);
    const m2BenchTotal = history2.current.reduce((sum: any, gw: any) => sum + (gw.points_on_bench || 0), 0);

    // Best/worst GW
    const m1Best = history1.current.reduce((best: any, gw: any) => gw.points > best.points ? { points: gw.points, gw: gw.event } : best, { points: 0, gw: 0 });
    const m2Best = history2.current.reduce((best: any, gw: any) => gw.points > best.points ? { points: gw.points, gw: gw.event } : best, { points: 0, gw: 0 });
    const m1Worst = history1.current.reduce((worst: any, gw: any) => gw.points < worst.points ? { points: gw.points, gw: gw.event } : worst, { points: Infinity, gw: 0 });
    const m2Worst = history2.current.reduce((worst: any, gw: any) => gw.points < worst.points ? { points: gw.points, gw: gw.event } : worst, { points: Infinity, gw: 0 });
    if (m1Worst.points === Infinity) m1Worst.points = 0;
    if (m2Worst.points === Infinity) m2Worst.points = 0;

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
