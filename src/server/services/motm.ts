/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchLiveGWData, fetchManagerPicks, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { calculatePointsWithAutoSubs } from '../services/scoring';
import { getActiveSeasonConfig } from '../season-state';
import { motmPeriodCount } from '../../lib/season-config';
import { attackingFromLive } from '../../lib/attacking-stats';
import { seasonFromWeekHistory } from './season-scores';
import { ensureStoredWeeks } from './stored-weeks';

/**
 * Ranking rows for every manager's completed gameweeks, read from the stored
 * week rows (the same scores the week page shows), in the shape
 * calculateMotmRankings sums: gross points and the hit, transfers, and the
 * goals/assists the attacking tiebreakers rank on.
 *
 * Shared by the MotM page and earnings so the MotM winner paid out is
 * always the one the MotM page displays.
 */
export function storedRankingHistories(managers: any[], completedGWs: number[]): any[] {
    return seasonFromWeekHistory(dataCache.weekHistoryCache, managers, completedGWs).map((s) => ({
        name: s.name,
        team: s.team,
        entryId: s.entryId,
        gameweeks: s.gameweeks.map((g) => ({
            event: g.event,
            points: g.score + g.transferCost,
            event_transfers_cost: g.transferCost,
            event_transfers: g.transfers,
            goals: g.goals,
            assists: g.assists,
        })),
    }));
}

export function calculateMotmRankings(managers: any, periodNum: any, completedGWs: any) {
    const seasonConfig = getActiveSeasonConfig();
    const [startGW, endGW] = seasonConfig.motmPeriods[periodNum];
    // From 2026-27, attacking returns settle a net-score tie ahead of
    // transfers. Completed seasons keep the winners they finished with.
    const useAttacking = !!seasonConfig.attackingTiebreakers;
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
        const goals = periodData.reduce((sum: number, g: any) => sum + (g.goals || 0), 0);
        const assists = periodData.reduce((sum: number, g: any) => sum + (g.assists || 0), 0);

        return {
            name: manager.name, team: manager.team, netScore, grossScore, transfers, transferCost, highestGW, lowestTwo, goals, assists, coinFlip: getOrCreateCoinFlip('motm', periodNum, manager.name),
            // entryId added for my-team highlighting (rewrite deviation)
            entryId: manager.entryId
        };
    });

    rankings.sort((a: any, b: any) => {
        if (b.netScore !== a.netScore) return b.netScore - a.netScore;
        if (useAttacking) {
            if (b.goals !== a.goals) return b.goals - a.goals;
            if (b.assists !== a.assists) return b.assists - a.assists;
        }
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

    // Completed gameweeks from the stored week rows; only an in-progress
    // gameweek is scored live below.
    await ensureStoredWeeks();
    const histories: any[] = storedRankingHistories(managers, completedGWs);

    // If there's live data, include current GW in calculations. Once every
    // fixture is provisionally finished the GW is completed and stored, so
    // its stored row is used rather than re-scoring it live.
    let gwsForCalc = [...completedGWs];
    if (isLive && currentGW && !completedGWs.includes(currentGW.id)) {
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
                        transferCost: picks.entry_history?.event_transfers_cost || 0,
                        transfers: picks.entry_history?.event_transfers || 0,
                        // Live element stats are aggregated per GW by FPL, so
                        // this is DGW-safe without touching the explain array.
                        ...attackingFromLive(calculated.players, liveData)
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
                        existingGW.goals = livePicks.goals;
                        existingGW.assists = livePicks.assists;
                        existingGW.isLive = true;
                    } else {
                        // Add new GW entry
                        h.gameweeks.push({
                            event: currentGW.id,
                            points: livePicks.points,
                            event_transfers_cost: livePicks.transferCost,
                            event_transfers: livePicks.transfers,
                            goals: livePicks.goals,
                            assists: livePicks.assists,
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
    for (let p = 1; p <= motmPeriodCount(getActiveSeasonConfig()); p++) {
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
