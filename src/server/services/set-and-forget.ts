/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchManagerPicks, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache, fetchLiveGWDataCached } from '../data-cache';
import { scoreSquad } from './scoring-core';

// =============================================================================
// SET AND FORGET
//
// What everyone would have scored keeping their GW1 team all season.
//
// The number that matters on this page is the DIFFERENCE between the squad a
// manager actually fielded and the squad they froze in GW1, so the two sides
// are scored the same way on purpose: one scoreSquad call each, same live
// gameweek data, same fixtures, same chip, in the same pass. Auto-subs,
// vice-captain inheritance and bonus therefore land identically on both sides
// and cancel out, leaving only what the manager actually changed.
//
// That gives the invariant this page lives by: in GW1 the frozen squad IS the
// squad they played, so the difference is zero for every manager — not zero
// because two calculations agreed, zero because it is the same squad through
// the same function. The same holds in any later gameweek where a manager
// made no changes.
//
// The previous version compared our score for the frozen squad against a
// cached per-gameweek actual (and before that, the league standings' season
// total). Those come from different passes over different snapshots, so
// whenever bonus or a defensive-contribution correction had landed on one
// side and not the other, the skew was published as points won or lost by
// tinkering — including in GW1, where nobody had tinkered yet.
// =============================================================================

// The only chips that change what a given squad scores: Bench Boost counts the
// bench (and disables auto-subs), Triple Captain trebles the captain. Wildcard
// and Free Hit only buy transfers, so they leave a score untouched. Both sides
// are scored under the same chip, so this is really about not letting an
// unrecognised chip name reach scoreSquad and mean something different there.
const SCORING_CHIPS = new Set(['bboost', '3xc']);

function scoringChip(chip: any): string | null {
    return typeof chip === 'string' && SCORING_CHIPS.has(chip) ? chip : null;
}

/** Raw picks for one manager/gameweek, cache-first. null if FPL has none. */
async function picksFor(entryId: number, gw: number): Promise<any | null> {
    const cacheKey = `${entryId}-${gw}`;
    const cached = dataCache.picksCache[cacheKey];
    if (cached) return cached;
    try {
        const picks = await fetchManagerPicks(entryId, gw);
        dataCache.picksCache[cacheKey] = picks;
        return picks;
    } catch {
        return null;
    }
}

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

        // Fixtures per GW, hoisted out of the manager × gameweek loop.
        const fixturesByGw = new Map<number, any[]>();
        for (const gw of completedGWs) {
            fixturesByGw.set(gw, fixtures.filter((f: any) => f.event === gw));
        }

        // The frozen squad: each manager's GW1 picks.
        const gw1Picks: Record<number, any> = {};
        for (const m of managers) {
            const picks = await picksFor(m.entry, 1);
            if (picks) gw1Picks[m.entry] = picks;
            else console.log(`[SetAndForget] Could not fetch GW1 picks for ${m.entry}`);
        }

        // Live points per GW. Fetch-through-cache rather than reading
        // dataCache.liveDataCache directly: after a restart (the cache isn't
        // persisted) the old code silently skipped every uncached GW and
        // PERSISTED near-zero season totals for everyone. A GW that still
        // can't be fetched marks the result incomplete so the caller keeps
        // the previous data instead.
        // A payload with no `elements` counts as missing too, not just a thrown
        // error: scoreSquad scores an empty squad against one, so letting it
        // through would publish a table of zeroes for the whole league.
        const liveByGw: Record<number, any> = {};
        const missingGWs: number[] = [];
        for (const gw of completedGWs) {
            try {
                const liveData = await fetchLiveGWDataCached(gw, bootstrap);
                if (!liveData?.elements?.length) missingGWs.push(gw);
                else liveByGw[gw] = liveData;
            } catch {
                missingGWs.push(gw);
            }
        }
        if (missingGWs.length > 0) {
            console.error(`[SetAndForget] Missing live data for GW${missingGWs.join(', GW')} — keeping previous data`);
            return null;
        }

        const results: any[] = [];
        const uncomparable: string[] = [];

        for (const m of managers) {
            const frozenPicks = gw1Picks[m.entry];
            if (!frozenPicks?.picks) continue;

            let safTotal = 0;
            let actualTotal = 0;
            const gwBreakdown = [];

            for (const gw of completedGWs) {
                const liveData = liveByGw[gw];
                const gwFixtures = fixturesByGw.get(gw) ?? [];

                // In GW1 the squad they fielded IS the frozen squad, so score
                // the one object twice rather than refetching a copy of it.
                // This is what makes the GW1 difference exactly zero by
                // construction instead of by two lookups agreeing.
                const playedPicks = gw === 1 ? frozenPicks : await picksFor(m.entry, gw);
                if (!playedPicks?.picks) {
                    // No actual squad to compare against — drop the gameweek
                    // from BOTH totals so the difference stays honest.
                    uncomparable.push(`${m.entry}/GW${gw}`);
                    continue;
                }

                // One chip for both sides. A chip is not a team change: a
                // set-and-forget manager would still have played their Bench
                // Boost or Triple Captain that week, on the frozen squad.
                const chip = scoringChip(playedPicks.active_chip);

                const played = scoreSquad(playedPicks, liveData, bootstrap, gwFixtures, { chipOverride: chip });
                const frozen = scoreSquad(frozenPicks, liveData, bootstrap, gwFixtures, { chipOverride: chip });

                // Hits are the price of tinkering, so they come off the actual
                // side only — the frozen squad never makes a transfer.
                const transfersCost = playedPicks.entry_history?.event_transfers_cost || 0;
                const actualPoints = played.totalPoints - transfersCost;

                actualTotal += actualPoints;
                safTotal += frozen.totalPoints;

                gwBreakdown.push({
                    gw,
                    points: frozen.totalPoints,
                    actualPoints,
                    benchPoints: frozen.benchPoints,
                    transfersCost,
                    chip,
                });
            }

            results.push({
                entryId: m.entry,
                name: m.player_name,
                team: m.entry_name,
                actualRank: m.rank,
                actualTotal,
                safTotal,
                difference: actualTotal - safTotal,
                gwBreakdown,
            });
        }

        if (uncomparable.length > 0) {
            console.warn(`[SetAndForget] Skipped ${uncomparable.length} manager-gameweek(s) with no picks: ${uncomparable.join(', ')}`);
        }
        // Nobody came through but the league does have GW1 squads: a source is
        // down, not the season empty. Keep the previous snapshot rather than
        // publishing a table that renders as "no data yet".
        if (results.length === 0 && Object.keys(gw1Picks).length > 0) {
            console.error('[SetAndForget] No manager could be scored — keeping previous data');
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
