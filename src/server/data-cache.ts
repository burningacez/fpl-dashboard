import 'server-only';
import { redisGet, redisSet } from './redis';
import { sanitizeCachedNames } from './fpl/client';
import { getCurrentSeason } from './season-state';
import { getSeasonConfig } from '../lib/season-config';
import { normalizeNameKey } from '../lib/identity';

/**
 * Processed data cache — port of the dataCache singleton and its Redis
 * persistence from legacy/server.js (:55-83, :408-614).
 *
 * Persisted blob shape and Redis keys are byte-compatible with the legacy
 * app ('data-cache', 'coin-flips', 'archived-seasons-list', 'season-{s}'),
 * so the two apps stay interchangeable during cutover.
 */

// Bump when a calculation change requires rebuilding persisted derived caches
// (losers, motm, earnings, weekHistoryCache, hallOfFame, managerProfiles, setAndForget).
// On startup, a mismatch between persisted cacheVersion and this constant forces
// a one-time refreshAllData('startup') so users see the corrected numbers.
export const CACHE_VERSION = 8;

/* Feature payloads are transliterated legacy JS with dynamic shapes; the
 * characterization suite (not the type system) is what guards their contents. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = any;

export interface DataCache {
  cacheVersion: number | null;
  standings: Payload | null;
  losers: Payload | null;
  motm: Payload | null;
  chips: Payload | null;
  earnings: Payload | null;
  league: Payload | null;
  week: Payload | null;
  managerProfiles: Record<string, Payload>; // Pre-calculated manager profiles by entryId
  hallOfFame: Payload | null; // Pre-calculated hall of fame data
  setAndForget: Payload | null; // Pre-calculated set-and-forget data
  cup: Payload | null; // Cached cup bracket (also what gets archived — cup is otherwise computed live)
  analytics: Payload | null; // Cached season analytics (ditto)
  tinkeringCache: Record<string, Payload>; // Cached tinkering results by `${entryId}-${gw}`
  picksCache: Record<string, Payload>; // Cached raw picks by `${entryId}-${gw}`
  liveDataCache: Record<number, Payload>; // Cached live GW data by gw number
  processedPicksCache: Record<string, Payload>; // Cached processed/enriched picks by `${entryId}-${gw}`
  weekHistoryCache: Record<string, Payload>; // Pre-built /api/week/history responses by GW number
  fixtureStatsCache: Record<number, Payload>; // Cached fixture stats by fixtureId (finished fixtures only)
  formResultsCache: Record<string, { data: Payload; ts: number }>; // Cached form API results by weeks count
  coinFlips: { motm: Record<string, Record<string, number>>; losers: Record<string, Record<string, number>> };
  lastRefresh: string | null;
  lastWeekRefresh: string | null; // Separate timestamp for live week data
  lastDataHash: string | null; // For detecting overnight changes
}

export interface RebuildStatus {
  inProgress: boolean;
  startTime: string | null;
  phase: string | null; // 'clearing', 'refreshing', 'picks', 'tinkering', 'complete', 'failed'
  progress: string | null; // e.g., '15/375 picks'
  error: string | null;
  result: Payload | null;
}

declare global {
  var __fplDataCache: DataCache | undefined;
  var __fplRebuildStatus: RebuildStatus | undefined;
  var __fplArchivedSeasons: Record<string, Payload> | undefined;
}

export const dataCache: DataCache = (globalThis.__fplDataCache ??= {
  cacheVersion: null,
  standings: null,
  losers: null,
  motm: null,
  chips: null,
  earnings: null,
  league: null,
  week: null,
  managerProfiles: {},
  hallOfFame: null,
  setAndForget: null,
  cup: null,
  analytics: null,
  tinkeringCache: {},
  picksCache: {},
  liveDataCache: {},
  processedPicksCache: {},
  weekHistoryCache: {},
  fixtureStatsCache: {},
  formResultsCache: {},
  coinFlips: { motm: {}, losers: {} },
  lastRefresh: null,
  lastWeekRefresh: null,
  lastDataHash: null,
});

export const rebuildStatus: RebuildStatus = (globalThis.__fplRebuildStatus ??= {
  inProgress: false,
  startTime: null,
  phase: null,
  progress: null,
  error: null,
  result: null,
});

export const archivedSeasons: Record<string, Payload> = (globalThis.__fplArchivedSeasons ??= {});

export async function saveDataCache(): Promise<void> {
  try {
    // Only persist the main data, not the temporary caches
    const persistData = {
      cacheVersion: CACHE_VERSION,
      // Season stamp: loadDataCache discards a blob from a different season so
      // a restart right after rollover can't resurrect old-season data.
      season: getCurrentSeason(),
      standings: dataCache.standings,
      losers: dataCache.losers,
      motm: dataCache.motm,
      chips: dataCache.chips,
      earnings: dataCache.earnings,
      league: dataCache.league,
      week: dataCache.week,
      managerProfiles: dataCache.managerProfiles,
      hallOfFame: dataCache.hallOfFame,
      setAndForget: dataCache.setAndForget,
      cup: dataCache.cup,
      analytics: dataCache.analytics,
      weekHistoryCache: dataCache.weekHistoryCache,
      lastRefresh: dataCache.lastRefresh,
      lastWeekRefresh: dataCache.lastWeekRefresh,
      lastDataHash: dataCache.lastDataHash,
    };
    const success = await redisSet('data-cache', persistData);
    if (success) {
      console.log(`[DataCache] Saved to Redis at ${new Date().toLocaleString('en-GB')}`);
    }
  } catch (error) {
    console.error('[DataCache] Error saving:', (error as Error).message);
  }
}

export async function loadDataCache(): Promise<boolean> {
  try {
    const data = await redisGet<Payload>('data-cache');
    if (data) {
      // A blob stamped with a different season is pre-rollover leftovers (e.g.
      // the process crashed between the season flip and the post-flip save).
      // Missing stamp = legacy blob = treat as current season.
      if (data.season && data.season !== getCurrentSeason()) {
        console.log(
          `[DataCache] Discarding persisted cache from season ${data.season} (active season is ${getCurrentSeason()})`,
        );
        return false;
      }
      dataCache.cacheVersion = data.cacheVersion ?? null;
      dataCache.standings = data.standings || null;
      dataCache.losers = data.losers || null;
      dataCache.motm = data.motm || null;
      dataCache.chips = data.chips || null;
      dataCache.earnings = data.earnings || null;
      dataCache.league = data.league || null;
      dataCache.week = data.week || null;
      dataCache.managerProfiles = data.managerProfiles || {};
      dataCache.hallOfFame = data.hallOfFame || null;
      dataCache.setAndForget = data.setAndForget || null;
      dataCache.cup = data.cup || null;
      dataCache.analytics = data.analytics || null;
      dataCache.weekHistoryCache = data.weekHistoryCache || {};
      dataCache.lastRefresh = data.lastRefresh || null;
      dataCache.lastWeekRefresh = data.lastWeekRefresh || null;
      dataCache.lastDataHash = data.lastDataHash || null;
      // Sanitize any stale manager/team names persisted before cleanDisplayName was added
      sanitizeCachedNames(dataCache);
      console.log(`[DataCache] Loaded from Redis (last refresh: ${data.lastRefresh || 'unknown'})`);
      return true;
    } else {
      console.log('[DataCache] No cached data in Redis');
      return false;
    }
  } catch (error) {
    console.error('[DataCache] Error loading:', (error as Error).message);
    return false;
  }
}

// =============================================================================
// COIN FLIP PERSISTENCE - Ensures tiebreaker results never change once flipped
// =============================================================================

export async function loadCoinFlips(): Promise<void> {
  try {
    const data = await redisGet<Payload>('coin-flips');
    if (data) {
      dataCache.coinFlips = {
        motm: data.motm || {},
        losers: data.losers || {},
      };
      console.log(
        `[CoinFlips] Loaded from Redis (MOTM periods: ${Object.keys(dataCache.coinFlips.motm).length}, Loser GWs: ${Object.keys(dataCache.coinFlips.losers).length})`,
      );
    } else {
      console.log('[CoinFlips] No persisted coin flips in Redis');
    }
  } catch (error) {
    console.error('[CoinFlips] Error loading:', (error as Error).message);
  }
}

export async function saveCoinFlips(): Promise<void> {
  try {
    const success = await redisSet('coin-flips', dataCache.coinFlips);
    if (success) {
      console.log(`[CoinFlips] Saved to Redis`);
    }
  } catch (error) {
    console.error('[CoinFlips] Error saving:', (error as Error).message);
  }
}

/**
 * Get or create a persistent coin flip value for a manager in a given context.
 * Once a value is generated, it's stored and reused on every subsequent call.
 */
export function getOrCreateCoinFlip(type: 'motm' | 'losers', key: string | number, managerName: string): number {
  const keyStr = String(key);
  if (!dataCache.coinFlips[type][keyStr]) {
    dataCache.coinFlips[type][keyStr] = {};
  }
  if (dataCache.coinFlips[type][keyStr][managerName] === undefined) {
    dataCache.coinFlips[type][keyStr][managerName] = Math.random();
  }
  return dataCache.coinFlips[type][keyStr][managerName];
}

// =============================================================================
// SEASON ARCHIVE MANAGEMENT
// =============================================================================

export async function loadArchivedSeasons(): Promise<void> {
  try {
    const seasonsList = await redisGet<string[]>('archived-seasons-list');
    if (seasonsList && Array.isArray(seasonsList)) {
      console.log(`[Seasons] Found ${seasonsList.length} archived season(s): ${seasonsList.join(', ')}`);
      // Load each archived season into memory
      for (const season of seasonsList) {
        const data = await redisGet<Payload>(`season-${season}`);
        if (data) {
          archivedSeasons[season] = sanitizeCachedNames(data);
          // Per-GW week history lives in a sidecar key (kept out of the main
          // blob for size); absent for snapshots taken before it existed.
          const weeks = await redisGet<Payload>(`season-${season}:weeks`);
          if (weeks) {
            archivedSeasons[season].weekHistory = sanitizeCachedNames(weeks);
          }
          console.log(`[Seasons] Loaded ${season}${weeks ? ' (with week history)' : ''}`);
        }
      }
    } else {
      console.log('[Seasons] No archived seasons found');
    }
  } catch (error) {
    console.error('[Seasons] Error loading archived seasons:', (error as Error).message);
  }
}

export async function archiveCurrentSeason(): Promise<{ success: boolean; season?: string; error?: string }> {
  const season = getCurrentSeason();
  try {
    console.log(`[Seasons] Archiving season ${season}...`);

    // Compact roster keyed by the same normalised name the client uses, so
    // future cross-season career stats (all-time earnings, average rank) can
    // join season-* blobs by nameKey with no migration. FPL entry ids rotate
    // each season and are not a reliable cross-season key.
    const rosterRows: Payload[] = dataCache.standings?.standings || [];
    const members = rosterRows.map((s: Payload) => ({
      entryId: s.entryId,
      name: s.name,
      nameKey: normalizeNameKey(s.name),
      team: s.team,
      rank: s.rank,
      netScore: s.netScore,
    }));

    const weekHistory = dataCache.weekHistoryCache || {};
    const archivedGWs = Object.keys(weekHistory).map(Number).filter(Number.isFinite);
    const finalGW = archivedGWs.length > 0 ? Math.max(...archivedGWs) : null;

    // Gather all current data
    const archive = {
      season,
      archivedAt: new Date().toISOString(),
      leagueName: dataCache.league?.league?.name || 'Unknown',
      standings: dataCache.standings,
      losers: dataCache.losers,
      motm: dataCache.motm,
      chips: dataCache.chips,
      earnings: dataCache.earnings,
      hallOfFame: dataCache.hallOfFame,
      managerProfiles: dataCache.managerProfiles,
      setAndForget: dataCache.setAndForget,
      cup: dataCache.cup,
      analytics: dataCache.analytics,
      coinFlips: dataCache.coinFlips,
      finalGW,
      // Frozen copy of the season's rules for provenance — the live SEASONS
      // map stays authoritative for rendering.
      seasonConfig: getSeasonConfig(season),
      members,
    };

    // Week history goes in a sidecar key: it's by far the largest payload
    // (38 GWs × full manager tables + squad maps) and keeping the main blob
    // shape legacy-compatible avoids Upstash request-size limits.
    if (finalGW !== null) {
      const weeksSaved = await redisSet(`season-${season}:weeks`, weekHistory);
      if (!weeksSaved) {
        throw new Error('Failed to save week history to Redis');
      }
    }

    // Save to Redis
    const success = await redisSet(`season-${season}`, archive);
    if (!success) {
      throw new Error('Failed to save to Redis');
    }

    // Update seasons list
    const seasonsList = (await redisGet<string[]>('archived-seasons-list')) || [];
    if (!seasonsList.includes(season)) {
      seasonsList.push(season);
      seasonsList.sort().reverse(); // Most recent first
      await redisSet('archived-seasons-list', seasonsList);
    }

    // Update local cache (weekHistory rides alongside like loadArchivedSeasons builds it)
    archivedSeasons[season] = { ...archive, weekHistory: finalGW !== null ? weekHistory : undefined };

    console.log(`[Seasons] Successfully archived ${season}`);
    return { success: true, season };
  } catch (error) {
    console.error('[Seasons] Archive error:', (error as Error).message);
    return { success: false, error: (error as Error).message };
  }
}

export async function getAvailableSeasons(): Promise<{ id: string; label: string; isCurrent: boolean }[]> {
  const currentSeason = getCurrentSeason();
  const seasons = [{ id: currentSeason, label: `${currentSeason} (Current)`, isCurrent: true }];

  const archivedList = (await redisGet<string[]>('archived-seasons-list')) || [];
  for (const season of archivedList) {
    if (season !== currentSeason) {
      seasons.push({ id: season, label: season, isCurrent: false });
    }
  }

  return seasons;
}

/**
 * Wipe every season-scoped cache after a rollover. The new season starts
 * from nothing — data repopulates from the new league via refreshAllData.
 * Synchronous on purpose: it cannot fail partway.
 */
export function resetDataCacheForNewSeason(): void {
  Object.assign(dataCache, {
    cacheVersion: CACHE_VERSION,
    standings: null,
    losers: null,
    motm: null,
    chips: null,
    earnings: null,
    league: null,
    week: null,
    managerProfiles: {},
    hallOfFame: null,
    setAndForget: null,
    cup: null,
    analytics: null,
    tinkeringCache: {},
    picksCache: {},
    liveDataCache: {},
    processedPicksCache: {},
    weekHistoryCache: {},
    fixtureStatsCache: {},
    formResultsCache: {},
    coinFlips: { motm: {}, losers: {} },
    lastRefresh: null,
    lastWeekRefresh: null,
    lastDataHash: null,
  });
  // Ad-hoc per-GW fixture caches the week/history route hangs off the singleton.
  for (const key of Object.keys(dataCache)) {
    if (key.startsWith('weekHistoryFixtures_')) {
      delete (dataCache as Record<string, Payload>)[key];
    }
  }
}

export function getSeasonData(season: string | null | undefined, dataType: string): Payload | null {
  // If current season, return live data
  if (season === getCurrentSeason() || !season) {
    return null; // Caller should use dataCache
  }

  // Return archived data
  const archived = archivedSeasons[season];
  if (!archived) return null;

  return archived[dataType] || null;
}

// =============================================================================
// CACHED FPL FETCH VARIANTS (depend on dataCache, so live here rather than
// in fpl/client.ts) — ports of legacy/server.js:918-961
// =============================================================================

import { fetchBootstrap, fetchLiveGWData, fetchManagerPicks } from './fpl/client';
import type { Bootstrap, LiveGWData, ManagerPicksResponse } from './fpl/types';

/** Cached version of fetchManagerPicks - uses cache for completed GWs */
export async function fetchManagerPicksCached(
  entryId: number,
  gw: number,
  bootstrap: Bootstrap | null = null,
): Promise<ManagerPicksResponse> {
  const cacheKey = `${entryId}-${gw}`;

  // Check cache first
  if (dataCache.picksCache[cacheKey]) {
    return dataCache.picksCache[cacheKey];
  }

  // Fetch fresh
  const picks = await fetchManagerPicks(entryId, gw);

  // Cache if GW is completed (get bootstrap if not provided)
  if (!bootstrap) {
    bootstrap = await fetchBootstrap();
  }
  const gwEvent = bootstrap.events.find((e) => e.id === gw);
  if (gwEvent?.finished) {
    dataCache.picksCache[cacheKey] = picks;
  }

  return picks;
}

/** Cached version of fetchLiveGWData - uses cache for completed GWs */
export async function fetchLiveGWDataCached(gw: number, bootstrap: Bootstrap | null = null): Promise<LiveGWData> {
  // Check cache first
  if (dataCache.liveDataCache[gw]) {
    return dataCache.liveDataCache[gw];
  }

  // Fetch fresh
  const liveData = await fetchLiveGWData(gw);

  // Cache if GW is completed (get bootstrap if not provided)
  if (!bootstrap) {
    bootstrap = await fetchBootstrap();
  }
  const gwEvent = bootstrap.events.find((e) => e.id === gw);
  if (gwEvent?.finished) {
    dataCache.liveDataCache[gw] = liveData;
  }

  return liveData;
}
