/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import config from '../config';
import { fetchBootstrap, fetchFixtures, fetchLiveGWData, fetchManagerPicks, fetchManagerHistory, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { calculatePointsWithAutoSubs } from '../services/scoring';

const MOTM_PERIODS: any = config.fpl.MOTM_PERIODS;

export function calculateMotmRankings(managers: any, periodNum: any, completedGWs: any) {
    const [startGW, endGW] = MOTM_PERIODS[periodNum];
    const periodGWs: any[] = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (completedGWs.includes(gw)) periodGWs.push(gw);
    }

    if (periodGWs.length === 0) {
        return { rankings: [], periodComplete: false, periodGWs: [], startGW, endGW };
    }

    const rankings = managers.map((manager: any) => {
        const periodData = manager.gameweeks.filter((g: any) => periodGWs.includes(g.event));
        const grossScore = periodData.reduce((sum: number, g: any) => sum + g.points, 0);
        const transferCost = periodData.reduce((sum: number, g: any) => sum + g.event_transfers_cost, 0);
        const transfers = periodData.reduce((sum: number, g: any) => sum + g.event_transfers, 0);
        const netScore = grossScore - transferCost;
        const gwScores = periodData.map((g: any) => g.points - g.event_transfers_cost).sort((a: number, b: number) => b - a);
        const highestGW = gwScores[0] || 0;
        const sortedAsc = [...gwScores].sort((a, b) => a - b);
        const lowestTwo = sortedAsc.slice(0, 2);

        return {
            name: manager.name, team: manager.team, netScore, grossScore, transfers, transferCost, highestGW, lowestTwo, coinFlip: getOrCreateCoinFlip('motm', periodNum, manager.name),
            // entryId added for my-team highlighting (rewrite deviation)
            entryId: manager.entryId
        };
    });

    rankings.sort((a: any, b: any) => {
        if (b.netScore !== a.netScore) return b.netScore - a.netScore;
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        if (b.highestGW !== a.highestGW) return b.highestGW - a.highestGW;
        for (let i = 0; i < Math.max(a.lowestTwo.length, b.lowestTwo.length); i++) {
            const aVal = a.lowestTwo[i] || 0, bVal = b.lowestTwo[i] || 0;
            if (bVal !== aVal) return bVal - aVal;
        }
        return b.coinFlip - a.coinFlip;
    });

    rankings.forEach((r: any, i: number) => r.rank = i + 1);
    const periodComplete = periodGWs.length === (endGW - startGW + 1);
    return { rankings, periodComplete, periodGWs, startGW, endGW };
}

export async function fetchMotmData() {
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const currentGW = bootstrap.events.find(e => e.is_current);
    const managers = leagueData.standings.results;

    // Check if current GW is in progress (deadline passed but not finished)
    const now = new Date();
    const gwDeadline = currentGW ? new Date(currentGW.deadline_time) : null;
    const isLive = currentGW && !currentGW.finished && gwDeadline && now > gwDeadline;

    const histories: any[] = await Promise.all(
        managers.map(async (m: any) => {
            const history = await fetchManagerHistory(m.entry);
            // Override history points with cached calculated points when available
            // The history API's points can be incorrect (e.g., missing bench boost bonus).
            // Include totalProvisionalBonus for GWs that are finished_provisional but
            // not yet officially finished - live stats.total_points doesn't include
            // bonus until FPL confirms it.
            const gameweeks = history.current.map((gw: any) => {
                const cacheKey = `${m.entry}-${gw.event}`;
                const cached: any = dataCache.processedPicksCache[cacheKey];
                if (cached?.calculatedPoints !== undefined) {
                    const gross = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0);
                    return { ...gw, points: gross };
                }
                return gw;
            });
            return { name: m.player_name, team: m.entry_name, entryId: m.entry, gameweeks };
        })
    );

    // If there's live data, include current GW in calculations
    let gwsForCalc = [...completedGWs];
    if (isLive && currentGW) {
        gwsForCalc.push(currentGW.id);

        // Fetch live points for current GW with auto-sub calculation
        try {
            const [liveData, fixtures] = await Promise.all([
                fetchLiveGWData(currentGW.id),
                fetchFixtures()
            ]);
            const gwFixtures = fixtures.filter(f => f.event === currentGW.id);

            const livePicksData = await Promise.all(
                managers.map(async (m: any) => {
                    const picks = await fetchManagerPicks(m.entry, currentGW.id);
                    // Calculate points with auto-subs for accurate live scoring
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    return {
                        entryId: m.entry,
                        points: calculated.totalPoints,
                        transferCost: picks.entry_history?.event_transfers_cost || 0
                    };
                })
            );

            // Update live GW data in histories with auto-sub calculated points
            histories.forEach(h => {
                const livePicks = livePicksData.find(p => p.entryId === h.entryId);
                if (livePicks) {
                    const existingGW = h.gameweeks.find((g: any) => g.event === currentGW.id);
                    if (existingGW) {
                        // Update existing GW with calculated points (includes auto-subs)
                        existingGW.points = livePicks.points;
                        existingGW.isLive = true;
                    } else {
                        // Add new GW entry
                        h.gameweeks.push({
                            event: currentGW.id,
                            points: livePicks.points,
                            event_transfers_cost: livePicks.transferCost,
                            event_transfers: 0,
                            isLive: true
                        });
                    }
                }
            });
        } catch (e: any) {
            console.error('[MotM] Failed to fetch live data:', e.message);
        }
    }

    const periods: any = {}, winners: any[] = [];
    for (let p = 1; p <= 9; p++) {
        const result = calculateMotmRankings(histories, p, gwsForCalc);
        periods[p] = result;
        periods[p].isLive = isLive && currentGW && result.periodGWs.includes(currentGW.id);

        // Fix: a live (unfinished) GW is included in gwsForCalc for ranking calculations,
        // but it should not cause the period to be marked as complete
        if (periods[p].isLive && result.periodComplete) {
            const trueCompleted = completedGWs.filter(gw => gw >= result.startGW && gw <= result.endGW);
            result.periodComplete = trueCompleted.length === (result.endGW - result.startGW + 1);
        }

        if (result.rankings.length > 0 && result.periodComplete) {
            winners.push({ period: p, gwRange: `GW ${result.startGW}-${result.endGW}`, winner: result.rankings[0] });
        } else if (result.rankings.length > 0) {
            winners.push({
                period: p,
                gwRange: `GW ${result.startGW}-${result.endGW}`,
                winner: null,
                inProgress: result.periodGWs.length > 0,
                isLive: periods[p].isLive,
                completedGWs: result.periodGWs.length,
                totalGWs: result.endGW - result.startGW + 1
            });
        }
    }

    return { leagueName: leagueData.league.name, periods, winners, completedGWs, currentGW: currentGW?.id, isLive };
}
