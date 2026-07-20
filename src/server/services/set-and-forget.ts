/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchManagerPicks, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache } from '../data-cache';
import { calculateHypotheticalScore } from '../services/scoring';

/**
 * Calculate Set and Forget data - what if managers kept their GW1 team all season
 * Uses GW1 picks for each manager and calculates hypothetical scores with auto-subs
 */
export async function calculateSetAndForgetData() {
    console.log('[SetAndForget] Starting calculation...');
    const startTime = Date.now();

    try {
        const [bootstrap, leagueData, fixtures] = await Promise.all([fetchBootstrap(), fetchLeagueData(), fetchFixtures()]);
        const managers = leagueData.standings.results;
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);

        if (completedGWs.length === 0) {
            console.log('[SetAndForget] No completed gameweeks yet');
            return { managers: [], completedGWs: 0 };
        }

        // Get GW1 picks for all managers
        const gw1Picks: any = {};
        for (const m of managers) {
            const cacheKey = `${m.entry}-1`;
            if (dataCache.picksCache[cacheKey]) {
                gw1Picks[m.entry] = dataCache.picksCache[cacheKey];
            } else {
                // Fetch if not cached
                try {
                    const picks = await fetchManagerPicks(m.entry, 1);
                    gw1Picks[m.entry] = picks;
                    dataCache.picksCache[cacheKey] = picks;
                } catch (err) {
                    console.log(`[SetAndForget] Could not fetch GW1 picks for ${m.entry}`);
                }
            }
        }

        // Calculate set-and-forget scores for each manager
        const results: any[] = [];

        for (const m of managers) {
            const picks = gw1Picks[m.entry];
            if (!picks?.picks) continue;

            let totalSAFPoints = 0;
            const gwBreakdown = [];

            for (const gw of completedGWs) {
                // Get live data for this GW (from cache)
                const liveData = dataCache.liveDataCache[gw];
                if (!liveData) continue;

                const gwFixtures = fixtures.filter(f => f.event === gw);

                // Calculate what GW1 team would have scored in this GW
                const result = calculateHypotheticalScore(picks, liveData, bootstrap, gwFixtures);
                totalSAFPoints += result.totalPoints;

                gwBreakdown.push({
                    gw,
                    points: result.totalPoints,
                    benchPoints: result.benchPoints
                });
            }

            // Get actual total points
            const actualTotal = m.total;

            results.push({
                entryId: m.entry,
                name: m.player_name,
                team: m.entry_name,
                actualRank: m.rank,
                actualTotal,
                safTotal: totalSAFPoints,
                difference: actualTotal - totalSAFPoints,
                gwBreakdown
            });
        }

        // Sort by SAF total (highest first) and assign SAF ranks
        results.sort((a, b) => b.safTotal - a.safTotal);
        results.forEach((r, i) => r.safRank = i + 1);

        // Re-sort by difference to show who benefited most from tinkering
        const sortedByDiff = [...results].sort((a, b) => b.difference - a.difference);

        console.log(`[SetAndForget] Calculated in ${Date.now() - startTime}ms for ${results.length} managers`);

        return {
            leagueName: leagueData.league.name,
            managers: results,
            completedGWs: completedGWs.length,
            bestTinkerer: sortedByDiff[0],
            worstTinkerer: sortedByDiff[sortedByDiff.length - 1]
        };
    } catch (error: any) {
        console.error('[SetAndForget] Error:', error.message);
        return { managers: [], completedGWs: 0, error: error.message };
    }
}
