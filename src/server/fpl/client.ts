import 'server-only';
import config from '../config';
import { getLeagueId } from '../season-state';
import type {
  Bootstrap,
  CupStatus,
  Fixture,
  H2HMatch,
  LeagueStandings,
  LiveGWData,
  ManagerEntry,
  ManagerHistory,
  ManagerPicksResponse,
  ManagerTransfer,
  ApiStatus,
} from './types';

/**
 * Typed FPL API client — port of the fetchers in legacy/server.js:673-915.
 * Preserves the two-tier behaviour exactly:
 *  - 30s stale-while-revalidate caches per endpoint
 *  - in-flight dedupe so concurrent callers share one upstream request
 *
 * All fetches pass cache:'no-store' so Next's Data Cache never interposes —
 * these hand-rolled caches are the only caching layer.
 *
 * Cache state lives on globalThis so dev-mode module re-instantiation (HMR)
 * and route-handler bundling can't fork it; Render runs one long-lived
 * process in production.
 */

const FPL_API_BASE_URL = config.FPL_API_BASE_URL;
const API_TIMEOUT_MS = config.API_TIMEOUT_MS;
export const API_CACHE_TTL = 30000; // 30 seconds

interface CacheEntry<T> {
  data: T | null;
  ts: number;
}

interface FplClientState {
  apiStatus: ApiStatus;
  bootstrapCache: CacheEntry<Bootstrap>;
  fixturesCache: CacheEntry<Fixture[]>;
  liveGWCache: Record<number, CacheEntry<LiveGWData>>;
  cupStatusCache: CacheEntry<CupStatus> & { leagueId: number | null };
  cupMatchesCache: CacheEntry<H2HMatch[]> & { h2hId: number | null };
  inFlight: {
    bootstrap: Promise<unknown> | null;
    fixtures: Promise<Fixture[]> | null;
    liveGW: Record<number, Promise<LiveGWData>>;
    cupStatus: Promise<unknown> | null;
    cupMatches: Promise<unknown> | null;
  };
}

declare global {
  var __fplClientState: FplClientState | undefined;
}

const state: FplClientState = (globalThis.__fplClientState ??= {
  apiStatus: {
    available: true,
    lastError: null,
    lastErrorTime: null,
    lastSuccessTime: null,
    errorMessage: null,
  },
  bootstrapCache: { data: null, ts: 0 },
  fixturesCache: { data: null, ts: 0 },
  liveGWCache: {},
  cupStatusCache: { data: null, ts: 0, leagueId: null },
  cupMatchesCache: { data: null, ts: 0, h2hId: null },
  inFlight: { bootstrap: null, fixtures: null, liveGW: {}, cupStatus: null, cupMatches: null },
});

export function getApiStatus(): ApiStatus {
  return state.apiStatus;
}

export async function fetchWithTimeout<T>(url: string, timeoutMs: number = API_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) {
    // Try to get error message from response body
    let errorBody = '';
    try {
      errorBody = await response.text();
      // FPL returns JSON string like "The game is being updated."
      if (errorBody.startsWith('"') && errorBody.endsWith('"')) {
        errorBody = JSON.parse(errorBody);
      }
    } catch {
      /* ignore parse errors */
    }

    // Only update API status for actual outages (5xx errors, 503, etc.)
    // 404 errors are expected for future GWs and shouldn't mark API as unavailable
    if (response.status >= 500 || response.status === 503) {
      state.apiStatus.available = false;
      state.apiStatus.lastError = `HTTP ${response.status}`;
      state.apiStatus.lastErrorTime = new Date().toISOString();
      state.apiStatus.errorMessage = errorBody || response.statusText;
    }

    throw new Error(`HTTP ${response.status}: ${errorBody || response.statusText} for ${url}`);
  }

  // API is working
  state.apiStatus.available = true;
  state.apiStatus.lastSuccessTime = new Date().toISOString();
  state.apiStatus.errorMessage = null;

  return response.json() as Promise<T>;
}

export function cleanDisplayName<T extends string | null | undefined>(name: T): T {
  if (!name) return name;
  return name
    .replace(/[⭐★☆\u{1F31F}\u{1F320}\u{2728}\u{FE0F}]/gu, '') // Remove star/sparkle emoji
    .replace(/\s+\.(?=\s|$)/g, '') // Remove " ." before space or end (handles mid-string and trailing)
    .trim() as T;
}

/** Recursively sanitize all manager/team name fields in cached data (e.g. loaded from Redis) */
export function sanitizeCachedNames<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    obj.forEach((item) => {
      if (typeof item === 'object' && item !== null) sanitizeCachedNames(item);
    });
    return obj;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'string' && ['name', 'team', 'player_name', 'entry_name'].includes(key)) {
      (obj as Record<string, unknown>)[key] = cleanDisplayName(value);
    } else if (key === 'names' && Array.isArray(value)) {
      (obj as Record<string, unknown>)[key] = value.map((n) =>
        typeof n === 'string' ? cleanDisplayName(n) : n,
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitizeCachedNames(value);
    }
  }
  return obj;
}

export async function fetchLeagueData(): Promise<LeagueStandings> {
  const data = await fetchWithTimeout<LeagueStandings>(
    `${FPL_API_BASE_URL}/leagues-classic/${getLeagueId()}/standings/`,
  );
  if (data?.standings?.results) {
    data.standings.results.forEach((m) => {
      m.player_name = cleanDisplayName(m.player_name);
      m.entry_name = cleanDisplayName(m.entry_name);
    });
  }
  return data;
}

// FPL mini-league cup lives in an auto-generated H2H sub-league. cup-status
// tells us whether it's been drawn yet and, if so, its H2H league id.
export async function fetchCupStatus(leagueId: number): Promise<CupStatus> {
  const now = Date.now();
  const cached = state.cupStatusCache.leagueId === leagueId ? state.cupStatusCache : null;
  const fresh = cached?.data && now - cached.ts < API_CACHE_TTL;
  if (fresh) return cached.data as CupStatus;

  const url = `${FPL_API_BASE_URL}/league/${leagueId}/cup-status/`;

  if (cached?.data) {
    if (!state.inFlight.cupStatus) {
      state.inFlight.cupStatus = fetchWithTimeout<CupStatus>(url)
        .then((data) => {
          state.cupStatusCache = { data, ts: Date.now(), leagueId };
        })
        .catch(() => {})
        .finally(() => {
          state.inFlight.cupStatus = null;
        });
    }
    return cached.data as CupStatus;
  }

  const data = await fetchWithTimeout<CupStatus>(url);
  state.cupStatusCache = { data, ts: Date.now(), leagueId };
  return data;
}

export async function fetchCupMatches(h2hLeagueId: number): Promise<H2HMatch[]> {
  const now = Date.now();
  const cached = state.cupMatchesCache.h2hId === h2hLeagueId ? state.cupMatchesCache : null;
  const fresh = cached?.data && now - cached.ts < API_CACHE_TTL;
  if (fresh) return cached.data as H2HMatch[];

  const loadAll = async (): Promise<H2HMatch[]> => {
    const all: H2HMatch[] = [];
    let page = 1;
    while (true) {
      const pageData = await fetchWithTimeout<{ results?: H2HMatch[]; has_next?: boolean }>(
        `${FPL_API_BASE_URL}/leagues-h2h-matches/league/${h2hLeagueId}/?page=${page}`,
      );
      const results = pageData?.results || [];
      all.push(...results);
      if (!pageData?.has_next) break;
      page += 1;
      if (page > 20) break; // safety cap
    }
    return all;
  };

  if (cached?.data) {
    if (!state.inFlight.cupMatches) {
      state.inFlight.cupMatches = loadAll()
        .then((data) => {
          state.cupMatchesCache = { data, ts: Date.now(), h2hId: h2hLeagueId };
        })
        .catch(() => {})
        .finally(() => {
          state.inFlight.cupMatches = null;
        });
    }
    return cached.data as H2HMatch[];
  }

  const data = await loadAll();
  state.cupMatchesCache = { data, ts: Date.now(), h2hId: h2hLeagueId };
  return data;
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const now = Date.now();
  const fresh = state.bootstrapCache.data && now - state.bootstrapCache.ts < API_CACHE_TTL;
  if (fresh) return state.bootstrapCache.data as Bootstrap;

  // Stale but have data → return stale immediately, refresh in background
  if (state.bootstrapCache.data) {
    if (!state.inFlight.bootstrap) {
      state.inFlight.bootstrap = fetchWithTimeout<Bootstrap>(`${FPL_API_BASE_URL}/bootstrap-static/`)
        .then((data) => {
          state.bootstrapCache = { data, ts: Date.now() };
        })
        .catch(() => {})
        .finally(() => {
          state.inFlight.bootstrap = null;
        });
    }
    return state.bootstrapCache.data as Bootstrap;
  }

  // No cache at all → must wait for fetch
  const data = await fetchWithTimeout<Bootstrap>(`${FPL_API_BASE_URL}/bootstrap-static/`);
  state.bootstrapCache = { data, ts: Date.now() };
  return data;
}

// Force-fresh bootstrap fetch that bypasses the stale-return-with-background-refresh cache.
// Used for critical checks like bonus confirmation where stale data causes missed transitions.
export async function fetchBootstrapFresh(): Promise<Bootstrap> {
  const data = await fetchWithTimeout<Bootstrap>(`${FPL_API_BASE_URL}/bootstrap-static/`);
  state.bootstrapCache = { data, ts: Date.now() };
  return data;
}

export async function fetchManagerHistory(entryId: number): Promise<ManagerHistory> {
  return fetchWithTimeout<ManagerHistory>(`${FPL_API_BASE_URL}/entry/${entryId}/history/`);
}

export async function fetchFixtures(): Promise<Fixture[]> {
  const now = Date.now();
  const fresh = state.fixturesCache.data && now - state.fixturesCache.ts < API_CACHE_TTL;
  if (fresh) return state.fixturesCache.data as Fixture[];

  if (state.fixturesCache.data) {
    if (!state.inFlight.fixtures) {
      state.inFlight.fixtures = fetchWithTimeout<Fixture[]>(`${FPL_API_BASE_URL}/fixtures/`)
        .then((data) => {
          state.fixturesCache = { data, ts: Date.now() };
          return data;
        })
        .catch(() => [] as Fixture[])
        .finally(() => {
          state.inFlight.fixtures = null;
        });
    }
    return state.fixturesCache.data as Fixture[];
  }

  // Cold path - dedupe concurrent callers so a single FPL request fills the cache
  // for everyone (refreshAllData fires 6+ parallel functions that all reach here
  // after invalidateRecentGWCaches drops the upstream entry).
  if (!state.inFlight.fixtures) {
    state.inFlight.fixtures = fetchWithTimeout<Fixture[]>(`${FPL_API_BASE_URL}/fixtures/`)
      .then((data) => {
        state.fixturesCache = { data, ts: Date.now() };
        return data;
      })
      .finally(() => {
        state.inFlight.fixtures = null;
      });
  }
  return state.inFlight.fixtures;
}

export async function fetchLiveGWData(gw: number): Promise<LiveGWData> {
  const now = Date.now();
  const cached = state.liveGWCache[gw];
  const fresh = cached && now - cached.ts < API_CACHE_TTL;
  if (fresh) return cached.data as LiveGWData;

  if (cached) {
    if (!state.inFlight.liveGW[gw]) {
      state.inFlight.liveGW[gw] = fetchWithTimeout<LiveGWData>(`${FPL_API_BASE_URL}/event/${gw}/live/`)
        .then((data) => {
          state.liveGWCache[gw] = { data, ts: Date.now() };
          return data;
        })
        .catch(() => cached.data as LiveGWData)
        .finally(() => {
          delete state.inFlight.liveGW[gw];
        });
    }
    return cached.data as LiveGWData;
  }

  // Cold path - dedupe concurrent callers so a single FPL request fills the cache
  // for everyone (refreshAllData fires 6+ parallel functions that all reach here
  // after invalidateRecentGWCaches drops the upstream entry).
  if (!state.inFlight.liveGW[gw]) {
    state.inFlight.liveGW[gw] = fetchWithTimeout<LiveGWData>(`${FPL_API_BASE_URL}/event/${gw}/live/`)
      .then((data) => {
        state.liveGWCache[gw] = { data, ts: Date.now() };
        return data;
      })
      .finally(() => {
        delete state.inFlight.liveGW[gw];
      });
  }
  return state.inFlight.liveGW[gw];
}

export async function fetchManagerPicks(entryId: number, gw: number): Promise<ManagerPicksResponse> {
  return fetchWithTimeout<ManagerPicksResponse>(`${FPL_API_BASE_URL}/entry/${entryId}/event/${gw}/picks/`);
}

export async function fetchManagerData(entryId: number): Promise<ManagerEntry> {
  const response = await fetch(`${FPL_API_BASE_URL}/entry/${entryId}/`, { cache: 'no-store' });
  return response.json() as Promise<ManagerEntry>;
}

/** Manager transfer history — new fetcher for the planner (small public endpoint). */
export async function fetchManagerTransfers(entryId: number): Promise<ManagerTransfer[]> {
  return fetchWithTimeout<ManagerTransfer[]>(`${FPL_API_BASE_URL}/entry/${entryId}/transfers/`);
}

/**
 * Invalidate the raw upstream caches (used by admin rebuild + GW transitions).
 */
export function invalidateRawCaches(): void {
  state.bootstrapCache = { data: null, ts: 0 };
  state.fixturesCache = { data: null, ts: 0 };
  state.liveGWCache = {};
}

/**
 * Selective raw-cache invalidation used by invalidateRecentGWCaches
 * (legacy/server.js:5489-5524): drop the upstream live cache for one GW.
 * Returns true if an entry was dropped.
 */
export function invalidateRawLiveGW(gw: number): boolean {
  if (state.liveGWCache[gw]) {
    delete state.liveGWCache[gw];
    return true;
  }
  return false;
}

/** Drop the upstream fixtures cache. Returns true if an entry was dropped. */
export function invalidateRawFixtures(): boolean {
  if (state.fixturesCache.data) {
    state.fixturesCache = { data: null, ts: 0 };
    return true;
  }
  return false;
}

/**
 * Get completed gameweeks, including provisionally-completed ones.
 * The FPL API only sets finished=true after official bonus confirmation (30 min to hours
 * after matches end). But all other data (picks, live points, fixtures) is available as
 * soon as finished_provisional is set. Without this, views like losers and H2H show a gap
 * where the week view has already advanced but losers/H2H don't include the just-ended GW.
 */
export function getCompletedGameweeks(bootstrap: Bootstrap, fixtures: Fixture[]): number[] {
  const completedGWs = bootstrap.events.filter((e) => e.finished).map((e) => e.id);

  // Also include the current GW if ALL its fixtures are finished provisionally
  const currentGW = bootstrap.events.find((e) => e.is_current);
  if (currentGW && !currentGW.finished) {
    const gwFixtures = fixtures.filter((f) => f.event === currentGW.id);
    if (gwFixtures.length > 0 && gwFixtures.every((f) => f.finished_provisional)) {
      completedGWs.push(currentGW.id);
    }
  }

  return completedGWs;
}
