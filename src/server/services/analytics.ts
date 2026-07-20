/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { fetchBootstrap, fetchFixtures, fetchManagerHistory, getCompletedGameweeks } from '../fpl/client';
import { dataCache } from '../data-cache';

// =============================================================================
// SEASON ANALYTICS (computed on demand from cached data)
// =============================================================================
export async function calculateSeasonAnalytics(): Promise<any> {
    if (!dataCache.standings?.standings) {
        return { error: 'Data still loading. Please refresh in a moment.' };
    }

    const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 0;

    if (completedGWs.length === 0) {
        return { error: 'No completed gameweeks yet.' };
    }

    const managerList = dataCache.standings.standings;

    // Fetch all manager histories in parallel
    const histories: any[] = await Promise.all(
        managerList.map((m: any) => fetchManagerHistory(m.entryId))
    );

    // Step 1: Calculate league average per GW
    const leagueAvgByGW: any = {};
    for (const gw of completedGWs) {
        let total = 0, count = 0;
        histories.forEach(h => {
            const gwData = h.current.find((g: any) => g.event === gw);
            if (gwData) { total += gwData.points; count++; }
        });
        leagueAvgByGW[gw] = count > 0 ? total / count : 0;
    }

    // Step 2: Build analytics per manager
    const analyticsManagers: any[] = [];

    for (let i = 0; i < managerList.length; i++) {
        const manager = managerList[i];
        const history = histories[i];
        const entryId = manager.entryId;

        if (!history?.current || history.current.length === 0) continue;

        const totalPoints = manager.totalPoints ||
            history.current[history.current.length - 1]?.total_points || 0;

        // --- Tinkering Impact (Transfer ROI) ---
        let totalTinkeringImpact = 0;
        let bestTinkering: any = null;
        let worstTinkering: any = null;
        let tinkeringGWCount = 0;

        for (const gw of completedGWs) {
            if (gw < 2) continue;
            const cacheKey = `${entryId}-${gw}`;
            const tinkering = dataCache.tinkeringCache[cacheKey];
            if (tinkering?.available && typeof tinkering.netImpact === 'number') {
                totalTinkeringImpact += tinkering.netImpact;
                tinkeringGWCount++;
                if (!bestTinkering || tinkering.netImpact > bestTinkering.impact) {
                    bestTinkering = { gw, impact: tinkering.netImpact };
                }
                if (!worstTinkering || tinkering.netImpact < worstTinkering.impact) {
                    worstTinkering = { gw, impact: tinkering.netImpact };
                }
            }
        }

        // --- Captain Points ---
        // Prefer the processed cache (effective captain after VC inheritance and
        // correct multiplier for Triple Captain). Fall back to raw picks for GWs
        // that haven't been processed yet.
        let totalCaptainPoints = 0;
        let captainBlanks = 0;
        let captainGWs = 0;

        for (const gw of completedGWs) {
            const cacheKey = `${entryId}-${gw}`;
            const processed = dataCache.processedPicksCache[cacheKey];
            const picks = dataCache.picksCache[cacheKey];
            const liveData = dataCache.liveDataCache[gw];

            const effectiveCaptain = processed?.players?.find((p: any) => p.isCaptain);
            if (effectiveCaptain) {
                const basePoints = effectiveCaptain.points || 0;
                totalCaptainPoints += basePoints * (effectiveCaptain.multiplier || 2);
                captainGWs++;
                if (basePoints <= 2) captainBlanks++;
            } else if (picks?.picks && liveData?.elements) {
                const captain = picks.picks.find((p: any) => p.is_captain);
                if (captain) {
                    const basePoints = liveData.elements.find(
                        (e: any) => e.id === captain.element
                    )?.stats?.total_points || 0;
                    const isTC = picks.active_chip === '3xc';
                    totalCaptainPoints += basePoints * (isTC ? 3 : 2);
                    captainGWs++;
                    if (basePoints <= 2) captainBlanks++;
                }
            }
        }

        // --- Bench Points Wasted ---
        let totalBenchPoints = 0;
        history.current.forEach((gw: any) => {
            const usedBB = history.chips?.some(
                (c: any) => c.name === 'bboost' && c.event === gw.event
            );
            if (!usedBB) {
                totalBenchPoints += gw.points_on_bench || 0;
            }
        });

        // --- Consistency (Standard Deviation) ---
        const scores = history.current.map((g: any) => g.points);
        const avgScore = scores.reduce((a: any, b: any) => a + b, 0) / scores.length;
        const variance = scores.reduce(
            (sum: any, val: any) => sum + Math.pow(val - avgScore, 2), 0
        ) / scores.length;
        const stdDev = Math.sqrt(variance);

        // --- Form Streaks (vs league average) ---
        let longestAboveAvg = 0, currentAboveAvg = 0;
        let longestBelowAvg = 0, currentBelowAvg = 0;
        let aboveAvgCount = 0;
        let currentStreak: any = { type: 'none', length: 0 };

        for (const gw of completedGWs) {
            const gwData = history.current.find((g: any) => g.event === gw);
            if (!gwData) continue;

            if (gwData.points >= leagueAvgByGW[gw]) {
                aboveAvgCount++;
                currentAboveAvg++;
                currentBelowAvg = 0;
                if (currentAboveAvg > longestAboveAvg) longestAboveAvg = currentAboveAvg;
                currentStreak = { type: 'above', length: currentAboveAvg };
            } else {
                currentBelowAvg++;
                currentAboveAvg = 0;
                if (currentBelowAvg > longestBelowAvg) longestBelowAvg = currentBelowAvg;
                currentStreak = { type: 'below', length: currentBelowAvg };
            }
        }

        // --- Transfer Stats ---
        const totalTransfers = history.current.reduce(
            (sum: any, gw: any) => sum + (gw.event_transfers || 0), 0
        );
        const totalHitCost = history.current.reduce(
            (sum: any, gw: any) => sum + (gw.event_transfers_cost || 0), 0
        );

        analyticsManagers.push({
            entryId,
            name: manager.name,
            team: manager.team,
            rank: manager.rank,
            totalPoints,
            avgScore: Math.round(avgScore * 10) / 10,
            tinkering: {
                netImpact: totalTinkeringImpact,
                bestGW: bestTinkering,
                worstGW: worstTinkering,
                gwCount: tinkeringGWCount
            },
            captain: {
                totalPoints: totalCaptainPoints,
                blanks: captainBlanks,
                gwCount: captainGWs,
                avgPoints: captainGWs > 0
                    ? Math.round(totalCaptainPoints / captainGWs * 10) / 10
                    : 0
            },
            benchPoints: {
                total: totalBenchPoints,
                perGW: completedGWs.length > 0
                    ? Math.round(totalBenchPoints / completedGWs.length * 10) / 10
                    : 0
            },
            consistency: {
                stdDev: Math.round(stdDev * 10) / 10
            },
            streaks: {
                longestAboveAvg,
                longestBelowAvg,
                currentStreak,
                aboveAvgCount,
                totalGWs: completedGWs.length
            },
            transfers: {
                total: totalTransfers,
                hitCost: totalHitCost
            }
        });
    }

    // Sort by league rank
    analyticsManagers.sort((a, b) => a.rank - b.rank);

    return {
        currentGW,
        completedGWs: completedGWs.length,
        managers: analyticsManagers
    };
}
