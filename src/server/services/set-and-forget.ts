/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import {
    fetchBootstrap,
    fetchFixtures,
    fetchManagerPicks,
    fetchManagerHistory,
    fetchLeagueData,
    getCompletedGameweeks,
} from '../fpl/client';
import { dataCache, fetchLiveGWDataCached } from '../data-cache';
import { calculateHypotheticalScore } from '../services/scoring';

/**
 * Per-manager history in the shape refreshAllData already builds for the
 * profile/hall-of-fame passes: gameweek rows straight from the FPL history
 * endpoint (with `points` upgraded to our bonus-accurate gross where a
 * processed-picks entry exists) plus the chips the manager played.
 */
export interface SafHistory {
    entryId: number;
    gameweeks: any[];
    chips: any[];
}

// Only these two chips change what a fixed squad scores: Bench Boost counts
// the bench (and disables auto-subs), Triple Captain trebles the captain.
// Wildcard, Free Hit and Assistant Manager only buy transfers or add a slot
// the GW1 squad doesn't have, so they leave a set-and-forget score untouched.
const SCORING_CHIPS = new Set(['bboost', '3xc']);

/** GW number → the scoring-relevant chip the manager played that week. */
function chipsByGameweek(chips: any[]): Map<number, string> {
    const byGw = new Map<number, string>();
    for (const chip of chips || []) {
        if (chip?.event == null || !SCORING_CHIPS.has(chip.name)) continue;
        byGw.set(chip.event, chip.name);
    }
    return byGw;
}

/**
 * GW number → the manager's actual NET score for that week.
 *
 * `points` from the FPL history endpoint is gross, with the transfer hit
 * reported separately (the convention every other service here follows), so
 * the hit comes off explicitly. Callers that pass histories through from
 * refreshAllData have already had `points` replaced with our own
 * bonus-accurate gross, which is what makes this agree with the Scores page.
 */
function actualByGameweek(gameweeks: any[]): Map<number, number> {
    const byGw = new Map<number, number>();
    for (const gw of gameweeks || []) {
        if (gw?.event == null) continue;
        byGw.set(gw.event, (gw.points || 0) - (gw.event_transfers_cost || 0));
    }
    return byGw;
}

/**
 * Fetch histories for the standalone path (no caller-supplied ones), applying
 * the same bonus-accurate `points` upgrade refreshAllData does so both entry
 * points produce identical numbers.
 *
 * A manager whose history won't fetch is left out rather than failing the
 * whole pass — they get skipped below, and the rest of the league still gets
 * a table.
 */
async function fetchSafHistories(managers: any[]): Promise<SafHistory[]> {
    const fetched = await Promise.all(
        managers.map(async (m: any): Promise<SafHistory | null> => {
            try {
                const history = await fetchManagerHistory(m.entry);
                const gameweeks = (history.current || []).map((gw: any) => {
                    const cached = dataCache.processedPicksCache[`${m.entry}-${gw.event}`] as any;
                    if (cached?.calculatedPoints !== undefined) {
                        const gross = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0);
                        return { ...gw, points: gross };
                    }
                    return gw;
                });
                return { entryId: m.entry, gameweeks, chips: history.chips || [] };
            } catch {
                console.log(`[SetAndForget] Could not fetch history for ${m.entry}`);
                return null;
            }
        }),
    );
    return fetched.filter((h): h is SafHistory => h !== null);
}

/**
 * Calculate Set and Forget data — what if managers kept their GW1 team all season.
 *
 * Scores each manager's GW1 squad against every completed gameweek's live data,
 * applying auto-subs, vice-captain inheritance and the chips they actually
 * played, then compares that to what they really scored over the SAME set of
 * gameweeks.
 *
 * `histories` is optional: refreshAllData already builds these for the profile
 * and hall-of-fame passes, so it hands them over rather than making us refetch
 * every manager's season. Omit it and they're fetched here.
 */
export async function calculateSetAndForgetData(histories: SafHistory[] | null = null) {
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

        // Live points per GW. Fetch-through-cache rather than reading
        // dataCache.liveDataCache directly: after a restart (the cache isn't
        // persisted) the old code silently skipped every uncached GW and
        // PERSISTED near-zero season totals for everyone. A GW that still
        // can't be fetched marks the result incomplete so the caller keeps
        // the previous data instead.
        const liveByGw: Record<number, any> = {};
        const missingGWs: number[] = [];
        for (const gw of completedGWs) {
            try {
                liveByGw[gw] = await fetchLiveGWDataCached(gw, bootstrap);
            } catch {
                missingGWs.push(gw);
            }
        }
        if (missingGWs.length > 0) {
            console.error(`[SetAndForget] Missing live data for GW${missingGWs.join(', GW')} — keeping previous data`);
            return null;
        }

        // Per-manager actual scores and chips, indexed by entry id. Without a
        // history the actual side of the comparison can't be built for that
        // manager, so they're skipped rather than compared against a total
        // covering different gameweeks.
        const historyList = histories ?? (await fetchSafHistories(managers));
        const historyByEntry = new Map<number, SafHistory>(historyList.map((h) => [h.entryId, h]));

        // Calculate set-and-forget scores for each manager
        const results: any[] = [];
        const skipped: number[] = [];

        for (const m of managers) {
            const picks = gw1Picks[m.entry];
            if (!picks?.picks) continue;

            const history = historyByEntry.get(m.entry);
            if (!history) {
                skipped.push(m.entry);
                continue;
            }
            const actualByGw = actualByGameweek(history.gameweeks);
            const chipByGw = chipsByGameweek(history.chips);

            // Both sides must cover exactly the same gameweeks or the
            // difference is meaningless — see actualTotal below.
            if (completedGWs.some((gw) => !actualByGw.has(gw))) {
                skipped.push(m.entry);
                continue;
            }

            let totalSAFPoints = 0;
            let actualTotal = 0;
            const gwBreakdown = [];

            for (const gw of completedGWs) {
                const liveData = liveByGw[gw];
                if (!liveData) continue;

                const gwFixtures = fixtures.filter(f => f.event === gw);

                // Calculate what GW1 team would have scored in this GW, under
                // the chip the manager actually played that week. A chip isn't
                // a team change, so a set-and-forget manager still plays it —
                // and without this a Bench Boost or Triple Captain gameweek
                // shows up as points "gained by tinkering" that nobody gained.
                const chip = chipByGw.get(gw) ?? null;
                const result = calculateHypotheticalScore(picks, liveData, bootstrap, gwFixtures, chip);
                totalSAFPoints += result.totalPoints;

                const actualPoints = actualByGw.get(gw) || 0;
                actualTotal += actualPoints;

                gwBreakdown.push({
                    gw,
                    points: result.totalPoints,
                    actualPoints,
                    benchPoints: result.benchPoints,
                    chip
                });
            }

            results.push({
                entryId: m.entry,
                name: m.player_name,
                team: m.entry_name,
                actualRank: m.rank,
                // Summed over completedGWs, NOT the league standings' season
                // total. FPL counts a gameweek in `total` as soon as its points
                // land, while completedGWs waits for bonus confirmation (or for
                // every fixture to be finished_provisional — indefinitely, if
                // one is postponed). Comparing a whole-season total against a
                // subset of gameweeks charged every manager's entire unscored
                // gameweek to "tinkering", which is why a discrepancy showed up
                // one week into the season.
                actualTotal,
                safTotal: totalSAFPoints,
                difference: actualTotal - totalSAFPoints,
                gwBreakdown
            });
        }

        if (skipped.length > 0) {
            console.warn(`[SetAndForget] Skipped ${skipped.length} manager(s) with no history covering every completed GW: ${skipped.join(', ')}`);
        }
        // Nobody came through but the league does have GW1 squads: the history
        // source is down, not the season empty. Keep the previous snapshot
        // instead of publishing a table that renders as "no data yet".
        if (results.length === 0 && Object.keys(gw1Picks).length > 0) {
            console.error('[SetAndForget] No manager had both GW1 picks and a usable history — keeping previous data');
            return null;
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
