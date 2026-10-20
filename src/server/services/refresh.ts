/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import {
    fetchBootstrap,
    fetchBootstrapFresh,
    fetchFixtures,
    fetchLiveGWData,
    fetchManagerPicks,
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
    evictOldLiveData,
    clearDerivedCaches,
} from '../data-cache';
import { generateDataHash } from '../../lib/utils';
import { broadcastSSE } from '../live/sse-hub';
import { sendEmailAlert } from '../email';
import { fetchStandingsWithTransfers, applyFinalStandingsOrder } from './standings';
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
import { seasonFromWeekHistory } from './season-scores';
import { storeGameweek, bakeStoredTotals, ensureStoredWeeks } from './stored-weeks';
import { hasUnfrozenWork, canRebuildOnDeploy } from '../../lib/refresh-freeze';
import { getActiveSeasonConfig } from '../season-state';

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

    for (const gw of completedGWs) {
        const noEntry = dataCache.weekHistoryCache[gw]?.noEntry ?? [];
        if (storeGameweek(gw, managers, bootstrap, leagueName, noEntry)) built++;
    }

    // Materialise cumulative Total + rank (and running goals/assists) onto
    // every GW now, so past-week reads are static lookups.
    bakeStoredTotals();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[WeekHistory] Built ${built}/${completedGWs.length} GW history caches in ${duration}s`);
}

// On-demand fallback when a completed GW is missing from weekHistoryCache:
// store whatever is missing (the same pass the refresh runs first), then
// persist so it only ever needs building once.
export async function buildWeekHistoryOnDemand(gw: number): Promise<any> {
    const [bootstrap, fixtures]: [any, any] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    if (!getCompletedGameweeks(bootstrap, fixtures).includes(gw)) throw new Error(`Gameweek ${gw} is not completed yet`);

    await ensureStoredWeeks();
    const historyData = dataCache.weekHistoryCache[gw];
    if (!historyData) throw new Error('Could not fetch data for any managers');

    saveDataCache().catch((e: any) => console.error(`[WeekHistory] Failed to persist GW${gw} to Redis:`, e.message));
    return historyData;
}

// In-flight latch: scheduler timers fire refreshAllData without awaiting the
// previous run (60s setInterval during live polling, fire-and-forget window
// transitions). Overlapping full refreshes interleave writes on the shared
// dataCache singleton, so a call that arrives mid-run joins the existing run.
let refreshAllInFlight: Promise<any> | null = null;

export async function refreshAllData(reason: string = 'scheduled'): Promise<any> {
    if (refreshAllInFlight) {
        console.log(`[Refresh] Refresh already in progress — joining it (requested reason: ${reason})`);
        return refreshAllInFlight;
    }
    refreshAllInFlight = refreshAllDataInner(reason).finally(() => {
        refreshAllInFlight = null;
    });
    return refreshAllInFlight;
}

async function refreshAllDataInner(reason: string): Promise<any> {
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

        // DEPLOY REBUILD GUARD — a new build may have changed how scores are
        // calculated, so 'deploy-rebuild' deliberately bypasses the freeze
        // guard below and recomputes a concluded gameweek. It still must not
        // recompute a season that is over, or one the FPL API has already
        // rolled past (see canRebuildOnDeploy) — that's the July-reset
        // accident the freeze guard exists to prevent.
        if (reason === 'deploy-rebuild') {
            try {
                const [bs, fx] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
                const allowed = canRebuildOnDeploy({
                    storedGameweeks: Object.keys(dataCache.weekHistoryCache).length,
                    liveCompletedGameweeks: getCompletedGameweeks(bs, fx).length,
                    totalWeeks: getActiveSeasonConfig().totalWeeks,
                });
                if (!allowed) {
                    console.log('[Refresh] Season is finished or the FPL API has rolled past it — skipping the deploy rebuild');
                    return { success: true, frozen: true };
                }
            } catch (e: any) {
                // Can't establish it's safe, so don't rebuild. Unlike the
                // freeze check below, failing open here would risk writing a
                // finished season over itself.
                console.warn('[Refresh] Deploy-rebuild safety check failed, skipping:', e.message);
                return { success: false, error: `deploy-rebuild safety check failed: ${e.message}` };
            }
            // Only now that a rebuild is going ahead. Clearing before the
            // check would drop the in-memory detail caches loaded from Redis
            // at boot and then leave without repopulating them.
            const cleared = clearDerivedCaches();
            console.log(`[Refresh] Cleared caches for deploy rebuild: ${cleared.picks} picks, ${cleared.liveData} liveData, ${cleared.processed} processed, ${cleared.tinkering} tinkering`);
        }

        // FREEZE GUARD — the periodic boot/daily refreshes must not recompute a
        // season whose gameweeks are all officially concluded. Scores are live
        // only up to the point a gameweek is confirmed finished (event-driven
        // refreshes: live-*, bonus-pending, gameweek-confirmed, morning-after);
        // after that they're static and only a rebuild recomputes them (the
        // admin action, or 'deploy-rebuild' above).
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
            'admin-rebuild-historical', 'deploy-rebuild',
            'gameweek-confirmed'
        ].includes(reason);

        // 'bonus-pending' deliberately sits outside shouldPreCache. It runs on
        // a timer every few minutes for up to 12 hours after the last match,
        // waiting for FPL to flip `finished`, and it used to run the full
        // heavy pass each time: picks for every manager across every completed
        // gameweek, week-history rebuild, hall of fame, and a rewrite of every
        // persisted pick chunk. That was the single largest consumer of
        // Render's outbound bandwidth allowance.
        //
        // What the loop actually needs is narrow: FPL's late bonus and defcon
        // corrections only ever touch the gameweek that just ended, so drop
        // that one gameweek's caches and let the standings/losers/MotM pass
        // below recompute it. Nothing older can have changed.
        const isBonusPending = reason === 'bonus-pending';
        if (shouldPreCache || isBonusPending) {
            const [bs, fx] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
            const completedAtStart = getCompletedGameweeks(bs, fx);
            invalidateRecentGWCaches(completedAtStart, isBonusPending ? 1 : 2);
        }

        // Every completed gameweek is stored before anything season-long is
        // built from it. Standings, losers, MotM and earnings all read those
        // stored rows; this is where a newly completed (or just invalidated)
        // gameweek gets written.
        await ensureStoredWeeks();

        const [standings, losers, motm, chips, earnings, league]: any[] = await Promise.all([
            fetchStandingsWithTransfers(),
            fetchWeeklyLosers(),
            fetchMotmData(),
            fetchChipsData(),
            fetchProfitLossData(),
            fetchLeagueData()
        ]);

        // standings, losers and MotM are built in parallel, so the standings
        // service saw the *previous* refresh's losers/MotM when it broke ties.
        // Re-apply the final-standings order now all three are fresh.
        applyFinalStandingsOrder(standings.standings, losers, motm);

        let managerProfiles = dataCache.managerProfiles || {};
        let hallOfFame = dataCache.hallOfFame || null;

        // Heavy pre-calculation (profiles, hall of fame, set-and-forget,
        // analytics) runs ONLY on the shouldPreCache reasons. It used to run
        // for every non-live-poll reason, which meant every kickoff-window
        // start/stop (live-start-*/live-end-*) refetched 29 histories and
        // re-sampled hall-of-fame picks — right when load matters most.
        // Completed-GW data doesn't change at kickoff; the pre-cache reasons
        // (startup/daily/morning/confirmed/bonus-pending/admin) cover every
        // moment it can actually change.
        if (shouldPreCache) {
            console.log('[Refresh] Pre-calculating manager profiles and hall of fame...');
            const managers = league.standings.results;

            // Get completed gameweeks (include provisionally completed GWs)
            const [bootstrap, fixturesForGW] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
            const completedGWs = getCompletedGameweeks(bootstrap, fixturesForGW);

            // Pre-cache picks and live data FIRST so histories can use cached calculated points
            await preCalculatePicksData(managers);
            await preCalculateTinkeringData(managers);
            // Build fully-assembled week history responses from processedPicksCache
            buildWeekHistoryCache(managers, bootstrap, completedGWs, league.league.name);
            // Freeze the pitch/tinkering detail to Redis so the modals are
            // static lookups after a restart (they never change once a GW
            // is done, and the FPL API can't rebuild them post-reset).
            await savePicksDetail();

            // Profiles and the Hall of Fame read the stored week rows just
            // built above — the same per-GW scores the week page shows — rather
            // than re-deriving completed gameweeks from FPL's history feed.
            const seasons = seasonFromWeekHistory(dataCache.weekHistoryCache, managers, completedGWs);

            managerProfiles = preCalculateManagerProfiles(league, seasons, losers, motm, chips);

            // Pre-season there are no completed gameweeks, and every record
            // would come back as a zero the whole league ties on, so skip the
            // pass entirely and leave the cache empty until one has been played.
            hallOfFame = completedGWs.length > 0
                ? preCalculateHallOfFame(seasons, losers, motm, completedGWs)
                : null;

            // Calculate Set and Forget data. Scores each manager's played and
            // frozen squads against the same live data in one pass, so it needs
            // only the raw picks preCalculatePicksData has already cached above.
            // null = incomplete source data; keep the previous snapshot.
            const safResult = await calculateSetAndForgetData();
            if (safResult) dataCache.setAndForget = safResult;

            const analyticsResult = await calculateSeasonAnalytics().catch((e: any) => {
                console.warn('[Refresh] Analytics cache refresh failed:', e.message);
                return null;
            });
            // calculateSeasonAnalytics reports soft failures as { error };
            // never overwrite a good cache with one of those.
            if (analyticsResult && !analyticsResult.error) {
                dataCache.analytics = analyticsResult;
            }

            // The full live-points payloads (1-3MB per GW, `explain` included)
            // are only needed while the pre-calculation above runs. Keeping
            // all of them meant unbounded growth over the season — a realistic
            // OOM on a 512MB instance by the run-in. Old GWs re-fetch through
            // the cache on the next heavy pass.
            evictOldLiveData(completedGWs, 3);
        }

        // Keep cup cached so the season archive can snapshot it without the
        // FPL API (which loses old-season data when it resets in July), and
        // so live cup-round scores stay fresh at kickoff-window boundaries.
        if (!isLivePoll) {
            dataCache.cup = await buildCupData().catch((e: any) => {
                console.warn('[Refresh] Cup cache refresh failed:', e.message);
                return dataCache.cup;
            });
        }

        const newDataHash = generateDataHash({ standings, losers, motm, chips, earnings });
        const hadChanges = dataCache.lastDataHash && dataCache.lastDataHash !== newDataHash;
        // No stored hash means nothing has been persisted under this process
        // yet (fresh boot, or a season/version flip dropped the blob), so the
        // save below can't be skipped however unchanged the data looks.
        const hasStoredHash = Boolean(dataCache.lastDataHash);

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

        // Persist data to Redis so it survives server restarts.
        //
        // saveDataCache() POSTs the entire blob (standings, week,
        // weekHistoryCache, profiles, hall of fame, cup, analytics) on every
        // call, and Render bills that body as service-initiated outbound
        // bandwidth. During a kickoff window this runs every 60s, so an
        // unchanged gameweek used to re-send megabytes a minute.
        //
        // Only the live poll is skipped, and only when the hash says nothing
        // moved. Every other reason still saves unconditionally: the hash
        // covers standings/losers/motm/chips/earnings but NOT week,
        // weekHistoryCache, managerProfiles, hallOfFame, cup or analytics, so
        // it cannot be trusted to prove a heavy pass changed nothing. Those
        // reasons run a handful of times a day and aren't what ran up the bill.
        const skipPersist = isLivePoll && hasStoredHash && !hadChanges;
        if (skipPersist) {
            console.log('[Refresh] No changes this live poll — skipping Redis persist');
        } else {
            await saveDataCache();
            await saveCoinFlips();
        }

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
