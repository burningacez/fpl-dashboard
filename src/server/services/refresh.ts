/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import {
    fetchBootstrap,
    fetchBootstrapFresh,
    fetchFixtures,
    fetchLiveGWData,
    fetchManagerPicks,
    fetchManagerHistory,
    fetchLeagueData,
    getCompletedGameweeks,
    invalidateRawLiveGW,
    invalidateRawFixtures,
} from '../fpl/client';
import {
    dataCache,
    saveDataCache,
    savePicksDetail,
    saveCoinFlips,
    rebuildStatus,
    fetchLiveGWDataCached,
} from '../data-cache';
import { generateDataHash } from '../../lib/utils';
import { broadcastSSE } from '../live/sse-hub';
import { sendEmailAlert } from '../email';
import { fetchStandingsWithTransfers } from './standings';
import { fetchWeeklyLosers } from './losers';
import { fetchMotmData } from './motm';
import { fetchChipsData } from './chips';
import { fetchProfitLossData } from './earnings';
import { calculateSetAndForgetData } from './set-and-forget';
import { refreshWeekData } from './week';
import { preCalculateManagerProfiles } from './profiles';
import { preCalculateHallOfFame } from './hall-of-fame';
import { fetchManagerPicksDetailed } from './picks';
import { preCalculateTinkeringData } from './tinkering';
import { buildCupData } from './cup';
import { calculateSeasonAnalytics } from './analytics';
import { bakeOverallTotals } from '../../lib/overall-totals';
import { hasUnfrozenWork } from '../../lib/refresh-freeze';

export function invalidateRecentGWCaches(completedGWs: any[], gwsToInvalidate: number = 2): void {
    const recentGWs = completedGWs.slice(-gwsToInvalidate);
    if (recentGWs.length === 0) return;

    let processedDropped = 0;
    let liveDropped = 0;
    let apiLiveDropped = 0;
    const recentSet = new Set(recentGWs);

    for (const gw of recentGWs) {
        if (dataCache.liveDataCache[gw]) {
            delete dataCache.liveDataCache[gw];
            liveDropped++;
        }
        if (invalidateRawLiveGW(gw)) {
            apiLiveDropped++;
        }
    }

    for (const key of Object.keys(dataCache.processedPicksCache)) {
        const gw = parseInt(key.split('-')[1], 10);
        if (recentSet.has(gw)) {
            delete dataCache.processedPicksCache[key];
            processedDropped++;
        }
    }

    // Tinkering results embed live points, so FPL's post-finish corrections
    // (bonus, defcon) must invalidate them too — preCalculateTinkeringData
    // re-warms these in the same refresh pass.
    let tinkeringDropped = 0;
    for (const key of Object.keys(dataCache.tinkeringCache)) {
        const gw = parseInt(key.split('-')[1], 10);
        if (recentSet.has(gw)) {
            delete dataCache.tinkeringCache[key];
            tinkeringDropped++;
        }
    }

    let apiFixturesDropped = 0;
    if (invalidateRawFixtures()) {
        apiFixturesDropped = 1;
    }

    console.log(`[Refresh] Invalidated caches for GW${recentGWs.join(', GW')}: ${liveDropped} live, ${processedDropped} processed picks, ${tinkeringDropped} tinkering, ${apiLiveDropped} api live, ${apiFixturesDropped} api fixtures`);
}

export async function preCalculatePicksData(managers: any[]): Promise<void> {
    console.log('[Picks] Pre-caching picks and live data for all managers...');
    const startTime = Date.now();

    try {
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);

        if (completedGWs.length === 0) {
            console.log('[Picks] No completed GWs to cache');
            return;
        }

        // First, cache live data for all completed GWs (once per GW)
        let liveDataCached = 0;
        for (const gw of completedGWs) {
            if (!dataCache.liveDataCache[gw]) {
                const liveData = await fetchLiveGWData(gw);
                dataCache.liveDataCache[gw] = liveData;
                liveDataCached++;
                // Update rebuild status if in progress
                if (rebuildStatus.inProgress) {
                    rebuildStatus.phase = 'picks';
                    rebuildStatus.progress = `Fetching live data: GW${gw} (${liveDataCached}/${completedGWs.length})`;
                }
            }
        }
        console.log(`[Picks] Cached live data for ${liveDataCached} GWs (${completedGWs.length - liveDataCached} already cached)`);

        // Then cache raw picks for all managers × all completed GWs
        let picksCached = 0;
        let picksSkipped = 0;
        const totalPicks = managers.length * completedGWs.length;

        for (const manager of managers) {
            for (const gw of completedGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                if (dataCache.picksCache[cacheKey]) {
                    picksSkipped++;
                    continue;
                }

                try {
                    const picks = await fetchManagerPicks(manager.entry, gw);
                    dataCache.picksCache[cacheKey] = picks;
                    picksCached++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && picksCached % 10 === 0) {
                        rebuildStatus.progress = `Fetching picks: ${picksCached + picksSkipped}/${totalPicks}`;
                    }
                } catch (e) {
                    // Skip failed fetches
                }
            }
        }

        console.log(`[Picks] Raw picks cached: ${picksCached} new, ${picksSkipped} already cached`);

        // Finally, pre-calculate processed picks for all managers × all completed GWs
        let processedCached = 0;
        let processedSkipped = 0;

        for (const manager of managers) {
            for (const gw of completedGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                if (dataCache.processedPicksCache[cacheKey]) {
                    processedSkipped++;
                    continue;
                }

                try {
                    const processedData = await fetchManagerPicksDetailed(manager.entry, gw, bootstrap);
                    dataCache.processedPicksCache[cacheKey] = processedData;
                    processedCached++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && processedCached % 10 === 0) {
                        rebuildStatus.progress = `Processing picks: ${processedCached + processedSkipped}/${totalPicks}`;
                    }
                } catch (e) {
                    // Skip failed fetches
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Picks] Pre-cache complete in ${duration}s - ${processedCached} processed picks cached (${processedSkipped} already cached)`);
    } catch (error: any) {
        console.error('[Picks] Pre-cache failed:', error.message);
    }
}

// =============================================================================
// WEEK HISTORY CACHE BUILDER (runs after picks pre-calculation)
// =============================================================================
// Builds fully-assembled /api/week/history responses for all completed GWs.
// This means the endpoint returns a simple cache lookup — no per-request
// iteration, no bootstrap calls, no API fallbacks.
export function buildWeekHistoryCache(managers: any[], bootstrap: any, completedGWs: any[], leagueName: any): void {
    console.log('[WeekHistory] Building pre-calculated history cache...');
    const startTime = Date.now();
    let built = 0;

    // Build plTeams once (same for every GW within a season)
    const plTeams = bootstrap.teams.map((t: any) => ({
        id: t.id, name: t.name, shortName: t.short_name
    })).sort((a: any, b: any) => a.name.localeCompare(b.name));

    // Index elements by id for fast lookup
    const elementsById: any = {};
    bootstrap.elements.forEach((e: any) => { elementsById[e.id] = e; });

    for (const gw of completedGWs) {
        const weekManagers: any[] = [];

        for (const m of managers) {
            const cacheKey = `${m.entry}-${gw}`;
            const cached = dataCache.processedPicksCache[cacheKey];

            if (!cached) continue; // Skip individual missing managers, not the whole GW

            const gwScore = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0) - (cached.transfersCost || 0);
            // Use the originally-selected captain/VC. When the VC inherited the
            // armband, the post-resolve players array has isViceCaptain cleared
            // on the inheriting player so a `find(p => p.isViceCaptain)` returns
            // nothing — the original IDs preserved on the cache entry survive.
            const captainName = cached.originalCaptainName
                ?? cached.players?.find((p: any) => p.isCaptain)?.name
                ?? null;
            const viceCaptainName = cached.originalViceCaptainName
                ?? cached.players?.find((p: any) => p.isViceCaptain)?.name
                ?? null;
            // Effective captain's multiplied points, stored so H2H can compare
            // captaincy statically (no live picks fetch for a completed GW).
            const effCaptain = (cached.players || []).find((p: any) => p.isCaptain);
            const captainPoints = effCaptain ? (effCaptain.points || 0) * (effCaptain.multiplier || 1) : 0;
            const starting11 = (cached.players || []).filter((p: any) => !p.isBench).map((p: any) => p.id);
            const benchPlayerIds = (cached.players || []).filter((p: any) => p.isBench).map((p: any) => p.id);

            weekManagers.push({
                name: m.player_name,
                team: m.entry_name,
                entryId: m.entry,
                gwScore,
                benchPoints: cached.pointsOnBench || 0,
                activeChip: cached.activeChip || null,
                captainName,
                captainPoints,
                viceCaptainName,
                starting11,
                benchPlayerIds,
                transferCost: cached.transfersCost || 0,
                transfers: cached.transfers || 0,
                teamValue: cached.teamValue || null,
                autoSubsIn: (cached.autoSubs || []).map((s: any) => s.in?.id).filter(Boolean),
                autoSubsOut: (cached.autoSubs || []).map((s: any) => s.out?.id).filter(Boolean)
            });
        }

        // Need at least one manager to build a useful GW entry
        if (weekManagers.length === 0) continue;

        // Sort by score and assign ranks
        weekManagers.sort((a, b) => b.gwScore - a.gwScore);
        weekManagers.forEach((m, i) => m.gwRank = i + 1);

        // Build squad players map for highlight feature
        const squadPlayers: any = {};
        weekManagers.forEach(m => {
            [...(m.starting11 || []), ...(m.benchPlayerIds || [])].forEach(elementId => {
                if (!squadPlayers[elementId]) {
                    const element = elementsById[elementId];
                    if (element) {
                        squadPlayers[elementId] = {
                            name: element.web_name,
                            positionId: element.element_type,
                            teamId: element.team
                        };
                    }
                }
            });
        });

        dataCache.weekHistoryCache[gw] = {
            leagueName,
            viewingGW: gw,
            managers: weekManagers,
            squadPlayers,
            plTeams
        };
        built++;
    }

    // Materialise cumulative Total + rank onto every GW now, at build time, so
    // past-week reads are static lookups (no live re-computation on request).
    bakeOverallTotals(dataCache.weekHistoryCache);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[WeekHistory] Built ${built}/${completedGWs.length} GW history caches in ${duration}s`);
}

// On-demand builder for a single GW — used as fallback when weekHistoryCache misses.
// Fetches picks sequentially (not in parallel) to avoid FPL API rate limits, then
// persists the result to Redis so it only ever needs to be built once per GW.
const weekHistoryBuildLocks: any = {}; // Per-GW promise locks to prevent duplicate concurrent builds
export async function buildWeekHistoryOnDemand(gw: number): Promise<any> {
    // If another request is already building this GW, wait for it instead of duplicating work
    if (weekHistoryBuildLocks[gw]) {
        return weekHistoryBuildLocks[gw];
    }

    const buildPromise = (async () => {
        const [bootstrap, fixtures]: [any, any] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const league: any = dataCache.league || await fetchLeagueData();
        const managers = league.standings?.results || [];
        if (managers.length === 0) throw new Error('No league data available');

        const leagueName = league.league?.name || '';
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
        if (!completedGWs.includes(gw)) throw new Error(`Gameweek ${gw} is not completed yet`);

        const plTeams = bootstrap.teams.map((t: any) => ({
            id: t.id, name: t.name, shortName: t.short_name
        })).sort((a: any, b: any) => a.name.localeCompare(b.name));

        const elementsById: any = {};
        bootstrap.elements.forEach((e: any) => { elementsById[e.id] = e; });

        // Pre-fetch shared data once — liveData and fixtures are the same for every manager in a GW
        const liveData = await fetchLiveGWDataCached(gw, bootstrap);
        const sharedData = { liveData, fixtures };
        const isFinished = bootstrap.events.find((e: any) => e.id === gw)?.finished;

        // Fetch picks SEQUENTIALLY to avoid FPL API rate limits.
        // Only the per-manager picks endpoint varies — bootstrap/liveData/fixtures are shared.
        const managerResults: any[] = [];
        for (const m of managers) {
            const cacheKey = `${m.entry}-${gw}`;
            let cached = dataCache.processedPicksCache[cacheKey];
            if (!cached) {
                try {
                    cached = await fetchManagerPicksDetailed(m.entry, gw, bootstrap, sharedData);
                    if (isFinished) {
                        dataCache.processedPicksCache[cacheKey] = cached;
                    }
                } catch (e: any) {
                    console.log(`[WeekHistory] Failed to fetch GW${gw} picks for ${m.player_name}: ${e.message}`);
                    continue;
                }
            }
            managerResults.push({ manager: m, data: cached });
        }

        const weekManagers: any[] = [];
        for (const { manager: m, data: cached } of managerResults) {
            if (!cached) continue;

            const gwScore = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0) - (cached.transfersCost || 0);
            // See buildWeekHistoryCache for why we prefer the originally-selected
            // captain/VC names over re-scanning the post-resolve players array.
            const captainName = cached.originalCaptainName
                ?? cached.players?.find((p: any) => p.isCaptain)?.name
                ?? null;
            const viceCaptainName = cached.originalViceCaptainName
                ?? cached.players?.find((p: any) => p.isViceCaptain)?.name
                ?? null;
            // Effective captain's multiplied points, stored so H2H can compare
            // captaincy statically (no live picks fetch for a completed GW).
            const effCaptain = (cached.players || []).find((p: any) => p.isCaptain);
            const captainPoints = effCaptain ? (effCaptain.points || 0) * (effCaptain.multiplier || 1) : 0;
            const starting11 = (cached.players || []).filter((p: any) => !p.isBench).map((p: any) => p.id);
            const benchPlayerIds = (cached.players || []).filter((p: any) => p.isBench).map((p: any) => p.id);

            weekManagers.push({
                name: m.player_name,
                team: m.entry_name,
                entryId: m.entry,
                gwScore,
                benchPoints: cached.pointsOnBench || 0,
                activeChip: cached.activeChip || null,
                captainName,
                captainPoints,
                viceCaptainName,
                starting11,
                benchPlayerIds,
                transferCost: cached.transfersCost || 0,
                transfers: cached.transfers || 0,
                teamValue: cached.teamValue || null,
                autoSubsIn: (cached.autoSubs || []).map((s: any) => s.in?.id).filter(Boolean),
                autoSubsOut: (cached.autoSubs || []).map((s: any) => s.out?.id).filter(Boolean)
            });
        }

        if (weekManagers.length === 0) throw new Error('Could not fetch data for any managers');

        weekManagers.sort((a, b) => b.gwScore - a.gwScore);
        weekManagers.forEach((m, i) => m.gwRank = i + 1);

        const squadPlayers: any = {};
        weekManagers.forEach(m => {
            [...(m.starting11 || []), ...(m.benchPlayerIds || [])].forEach(elementId => {
                if (!squadPlayers[elementId]) {
                    const element = elementsById[elementId];
                    if (element) {
                        squadPlayers[elementId] = {
                            name: element.web_name,
                            positionId: element.element_type,
                            teamId: element.team
                        };
                    }
                }
            });
        });

        const historyData = { leagueName, viewingGW: gw, managers: weekManagers, squadPlayers, plTeams };

        // Cache in memory so subsequent requests are instant
        dataCache.weekHistoryCache[gw] = historyData;

        // Materialise this GW's cumulative Total + rank from the (now updated)
        // cache so the response is a static value, not a per-request calc. Uses
        // whatever completed GWs are already cached — no live API.
        bakeOverallTotals(dataCache.weekHistoryCache);

        // Persist to Redis immediately so this GW never needs to be rebuilt again
        saveDataCache().catch((e: any) => console.error(`[WeekHistory] Failed to persist GW${gw} to Redis:`, e.message));

        return historyData;
    })();

    weekHistoryBuildLocks[gw] = buildPromise;
    try {
        return await buildPromise;
    } finally {
        delete weekHistoryBuildLocks[gw];
    }
}

export async function refreshAllData(reason: string = 'scheduled'): Promise<any> {
    console.log(`[Refresh] Starting data refresh - Reason: ${reason}`);
    const startTime = Date.now();

    // Skip heavy profile/hall-of-fame calculations during live polling
    const isLivePoll = reason.includes('live-poll');

    try {
        // Fetch fresh bootstrap data BEFORE any calculations.
        // fetchBootstrap() uses stale-while-revalidate (returns old data, refreshes in background).
        // If we don't force a fresh fetch here, parallel functions below may use stale data
        // and miss gameweek completions (e.g., GW marked as finished won't be detected).
        if (!isLivePoll) {
            await fetchBootstrapFresh();
        }

        // FREEZE GUARD — the periodic boot/daily refreshes must not recompute a
        // season whose gameweeks are all officially concluded. Scores are live
        // only up to the point a gameweek is confirmed finished (event-driven
        // refreshes: live-*, bonus-pending, gameweek-confirmed, morning-after);
        // after that they're static and only an admin rebuild recomputes them.
        // Without this, the 6am daily-check (and a version-bump startup) would
        // overwrite the stored season with whatever the FPL API now returns —
        // which, once it resets for the new season in July, is wrong.
        if (reason === 'startup' || reason === 'daily-check') {
            try {
                const [bs, fx] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
                const unfrozen = hasUnfrozenWork({
                    events: bs.events,
                    completedGWs: getCompletedGameweeks(bs, fx),
                    // losers is written once per GW, so its gameweeks are our
                    // "already captured" set.
                    processedGWs: (dataCache.losers?.losers || []).map((l: any) => l.gameweek),
                    now: new Date(),
                });
                if (!unfrozen) {
                    console.log(`[Refresh] No live or newly-concluded gameweek — keeping stored static data (reason: ${reason})`);
                    return { success: true, frozen: true };
                }
            } catch (e: any) {
                console.warn('[Refresh] Freeze check failed, proceeding with refresh:', e.message);
            }
        }

        // Invalidate caches for the most recent completed GWs BEFORE the
        // parallel fetches kick off. fetchWeeklyLosers and fetchMotmData both
        // read processedPicksCache, so if we don't drop stale entries first
        // they'll happily serve the old snapshot back. FPL applies bonus
        // shifts and defcon corrections after a GW is officially finished,
        // and the caches are otherwise write-once.
        const shouldPreCache = !isLivePoll && [
            'startup', 'morning-after-gameweek', 'daily-check',
            'admin-rebuild-historical', 'gameweek-confirmed', 'bonus-pending'
        ].includes(reason);
        if (shouldPreCache) {
            const [bs, fx] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
            const completedAtStart = getCompletedGameweeks(bs, fx);
            invalidateRecentGWCaches(completedAtStart, 2);
        }

        const [standings, losers, motm, chips, earnings, league]: any[] = await Promise.all([
            fetchStandingsWithTransfers(),
            fetchWeeklyLosers(),
            fetchMotmData(),
            fetchChipsData(),
            fetchProfitLossData(),
            fetchLeagueData()
        ]);

        let managerProfiles = dataCache.managerProfiles || {};
        let hallOfFame = dataCache.hallOfFame || null;

        // Only pre-calculate profiles/hall-of-fame on startup, morning refresh, or non-live refreshes
        if (!isLivePoll) {
            console.log('[Refresh] Pre-calculating manager profiles and hall of fame...');
            const managers = league.standings.results;

            // Get completed gameweeks (include provisionally completed GWs)
            const [bootstrap, fixturesForGW] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
            const completedGWs = getCompletedGameweeks(bootstrap, fixturesForGW);

            // Pre-cache picks and live data FIRST so histories can use cached calculated points
            // Only run during startup/daily/morning refreshes, NOT during live polling.
            // (shouldPreCache was already evaluated above to drive the
            // upstream cache invalidation before the parallel fetches.)
            if (shouldPreCache) {
                await preCalculatePicksData(managers);
                await preCalculateTinkeringData(managers);
                // Build fully-assembled week history responses from processedPicksCache
                buildWeekHistoryCache(managers, bootstrap, completedGWs, league.league.name);
                // Freeze the pitch/tinkering detail to Redis so the modals are
                // static lookups after a restart (they never change once a GW
                // is done, and the FPL API can't rebuild them post-reset).
                await savePicksDetail();
            }

            // Now build histories - will use cached calculated points when available
            // (history API's points can be incorrect, e.g., missing bench boost bonus).
            // Include totalProvisionalBonus for finished_provisional GWs - live
            // stats.total_points excludes bonus until FPL officially confirms it.
            const histories = await Promise.all(
                managers.map(async (m: any) => {
                    const history = await fetchManagerHistory(m.entry);
                    const gameweeks = history.current.map((gw: any) => {
                        const cacheKey = `${m.entry}-${gw.event}`;
                        const cached = dataCache.processedPicksCache[cacheKey];
                        if (cached?.calculatedPoints !== undefined) {
                            const gross = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0);
                            return { ...gw, points: gross };
                        }
                        return gw;
                    });
                    return {
                        name: m.player_name,
                        team: m.entry_name,
                        entryId: m.entry,
                        gameweeks,
                        chips: history.chips || []  // Include chips for bench boost detection
                    };
                })
            );

            managerProfiles = await preCalculateManagerProfiles(league, histories, losers, motm, chips);

            // Filter histories to only completed GWs for Hall of Fame (exclude current/live GW)
            const completedHistories = histories.map((h: any) => ({
                ...h,
                gameweeks: h.gameweeks.filter((gw: any) => completedGWs.includes(gw.event))
            }));

            // Calculate hall of fame (uses tinkering cache) - only completed GWs
            hallOfFame = await preCalculateHallOfFame(completedHistories, losers, motm, chips, completedGWs);

            // Calculate Set and Forget data (uses picks cache and live data cache)
            dataCache.setAndForget = await calculateSetAndForgetData();

            // Keep cup + analytics cached so the season archive can snapshot
            // them without the FPL API (which loses old-season data when it
            // resets for the new season in July). Both are still computed
            // live for current-season requests.
            dataCache.cup = await buildCupData().catch((e: any) => {
                console.warn('[Refresh] Cup cache refresh failed:', e.message);
                return dataCache.cup;
            });
            if (shouldPreCache) {
                const analyticsResult = await calculateSeasonAnalytics().catch((e: any) => {
                    console.warn('[Refresh] Analytics cache refresh failed:', e.message);
                    return null;
                });
                // calculateSeasonAnalytics reports soft failures as { error };
                // never overwrite a good cache with one of those.
                if (analyticsResult && !analyticsResult.error) {
                    dataCache.analytics = analyticsResult;
                }
            }
        }

        const newDataHash = generateDataHash({ standings, losers, motm, chips, earnings });
        const hadChanges = dataCache.lastDataHash && dataCache.lastDataHash !== newDataHash;

        Object.assign(dataCache, {
            // Preserve week data (Object.assign onto the singleton keeps unlisted keys)
            standings,
            losers,
            motm,
            chips,
            earnings,
            league,
            managerProfiles,
            hallOfFame,
            lastRefresh: new Date().toISOString(),
            lastDataHash: newDataHash
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Refresh] Complete in ${duration}s - Changes detected: ${hadChanges}${isLivePoll ? ' (live poll - skipped profile calc)' : ''}`);

        if (hadChanges) {
            broadcastSSE('data-update', { type: 'standings', timestamp: new Date().toISOString() });
        }

        // Persist data to Redis so it survives server restarts
        await saveDataCache();
        await saveCoinFlips();

        return { success: true, hadChanges };
    } catch (error: any) {
        console.error('[Refresh] Failed:', error.message);
        return { success: false, error: error.message };
    }
}

export async function morningRefreshWithAlert(): Promise<void> {
    console.log('[Morning] Starting morning-after gameweek refresh with change detection');

    const oldHash = dataCache.lastDataHash;
    const result = await refreshAllData('morning-after-gameweek');
    await refreshWeekData();  // Also refresh week data to update timestamp

    if (result.success && result.hadChanges) {
        await sendEmailAlert(
            'Overnight FPL Data Changes Detected',
            `The FPL dashboard data has changed overnight since the last match.\n\n` +
            `This could indicate:\n` +
            `- Bonus points being added\n` +
            `- Score corrections\n` +
            `- Late substitution points\n\n` +
            `Please check the dashboard at barryfpl.site for updates.`
        );
    }
}

// =============================================================================
// FIXTURE TRACKING AND SCHEDULING
// =============================================================================
let fixturesCache: any = null;
let lastFixturesFetch: any = null;

export async function getFixturesForCurrentGW(forceRefresh: boolean = false): Promise<any> {
    const now = Date.now();
    // Cache fixtures for 1 hour unless forced
    if (!forceRefresh && fixturesCache && lastFixturesFetch && (now - lastFixturesFetch) < 3600000) {
        return fixturesCache;
    }

    try {
        const [fixtures, bootstrap]: [any, any] = await Promise.all([fetchFixtures(), fetchBootstrap()]);
        const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 0;
        const currentGWFixtures = fixtures.filter((f: any) => f.event === currentGW);
        const currentGWEvent = bootstrap.events.find((e: any) => e.id === currentGW);

        // Detect if current GW is fully done (finished or all matches provisionally done)
        const currentGWDone = currentGWEvent?.finished ||
            (currentGWFixtures.length > 0 && currentGWFixtures.every((f: any) => f.finished_provisional));

        // When current GW is done, look ahead to the next GW for scheduling and display
        let nextGW: any = null;
        let nextGWFixtures: any[] = [];
        let nextGWEvent: any = null;
        if (currentGWDone) {
            nextGWEvent = bootstrap.events.find((e: any) => e.is_next) ||
                          bootstrap.events.find((e: any) => e.id === currentGW + 1);
            if (nextGWEvent) {
                nextGW = nextGWEvent.id;
                nextGWFixtures = fixtures.filter((f: any) => f.event === nextGW);
            }
        }

        fixturesCache = {
            all: fixtures,
            currentGW,
            currentGWFixtures,
            currentGWDone,
            nextGW,
            nextGWFixtures,
            nextGWEvent,
            events: bootstrap.events
        };
        lastFixturesFetch = now;

        return fixturesCache;
    } catch (error: any) {
        console.error('[Fixtures] Failed to fetch:', error.message);
        return null;
    }
}

// Note: getMatchEndTime and groupFixturesIntoWindows are imported from lib/utils.js
