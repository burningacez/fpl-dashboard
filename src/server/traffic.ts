import 'server-only';

/**
 * Traffic analytics server module — same lifecycle as logger.ts: state on
 * globalThis, dirty flag, periodic flush to a single Redis key, loaded once
 * from bootServer(). Pure bucket/summary logic lives in src/lib/traffic.ts.
 *
 * Redis keys:
 * - `traffic-stats`          → TrafficStats for the current season
 * - `traffic-stats:<season>` → archived snapshot, written on season rollover
 *
 * Claim attribution: recordView() must be synchronous and cheap (it runs per
 * beacon), but getClaims() hits Redis. So a deviceToken → nameKey map is
 * memoised and refreshed in the background at most once per minute — a fresh
 * claim can take up to a minute to start attributing, which is fine here.
 */

import {
  type TrafficStats,
  type TrafficSummary,
  emptyStats,
  finalizePastDays,
  londonDateKey,
  recordView as recordViewPure,
  summarizeTraffic,
} from '@/lib/traffic';
import { getClaims } from '@/server/identity-store';

const STATS_KEY = 'traffic-stats';
const FLUSH_INTERVAL_MS = 60 * 1000;
const CLAIMS_MEMO_TTL_MS = 60 * 1000;

type RedisGet = (key: string) => Promise<unknown>;
type RedisSet = (key: string, value: unknown) => Promise<boolean>;

interface TrafficModuleState {
  stats: TrafficStats;
  redisGet: RedisGet | null;
  redisSet: RedisSet | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  dirty: boolean;
  initialized: boolean;
  claimsMemo: Map<string, string>; // deviceToken -> nameKey
  claimsMemoAt: number;
  claimsRefreshing: boolean;
}

declare global {
  var __fplTrafficState: TrafficModuleState | undefined;
}

const state: TrafficModuleState = (globalThis.__fplTrafficState ??= {
  stats: emptyStats('', new Date()),
  redisGet: null,
  redisSet: null,
  flushTimer: null,
  dirty: false,
  initialized: false,
  claimsMemo: new Map(),
  claimsMemoAt: 0,
  claimsRefreshing: false,
});

function isTrafficStats(value: unknown): value is TrafficStats {
  const v = value as TrafficStats | null;
  return !!v && typeof v === 'object'
    && typeof v.season === 'string'
    && typeof v.startedAt === 'string'
    && typeof v.seenDevices === 'object'
    && typeof v.days === 'object';
}

export async function init(opts: {
  season: string;
  redisGet?: RedisGet;
  redisSet?: RedisSet;
}): Promise<void> {
  if (opts.redisGet) state.redisGet = opts.redisGet;
  if (opts.redisSet) state.redisSet = opts.redisSet;

  if (!state.initialized || state.stats.season !== opts.season) {
    state.stats = emptyStats(opts.season, new Date());
  }

  if (state.redisGet) {
    try {
      const stored = await state.redisGet(STATS_KEY);
      if (isTrafficStats(stored)) {
        if (stored.season === opts.season) {
          state.stats = stored;
        } else if (state.redisSet) {
          // Season rolled over: archive last season's stats and start fresh.
          await state.redisSet(`${STATS_KEY}:${stored.season}`, stored);
          state.dirty = true; // persist the fresh blob so the archive isn't re-run
          console.log(`[Traffic] Archived ${stored.season} stats, starting ${opts.season}`);
        }
      }
    } catch (e) {
      console.error('[Traffic] Failed to load stats from Redis:', (e as Error).message);
    }
  }

  if (state.redisSet && !state.flushTimer) {
    state.flushTimer = setInterval(flushToRedis, FLUSH_INTERVAL_MS);
  }

  state.initialized = true;
}

/** Record one validated page view for a device. Synchronous by design. */
export function trackView(path: string, deviceToken: string): void {
  maybeRefreshClaimsMemo();
  recordViewPure(state.stats, {
    path,
    deviceToken,
    nameKey: state.claimsMemo.get(deviceToken) ?? null,
    dateKey: londonDateKey(new Date()),
  });
  state.dirty = true;
}

/** Kick off a background claims-map refresh if the memo has gone stale. */
function maybeRefreshClaimsMemo(): void {
  if (state.claimsRefreshing || Date.now() - state.claimsMemoAt < CLAIMS_MEMO_TTL_MS) return;
  state.claimsRefreshing = true;
  getClaims()
    .then((registry) => {
      const next = new Map<string, string>();
      for (const [nameKey, record] of Object.entries(registry)) {
        next.set(record.deviceToken, nameKey);
      }
      state.claimsMemo = next;
      state.claimsMemoAt = Date.now();
    })
    .catch((e) => console.error('[Traffic] Claims refresh failed:', (e as Error).message))
    .finally(() => {
      state.claimsRefreshing = false;
    });
}

/** Admin summary over the last `rangeDays` days (<= 0 for the whole season). */
export function getSummary(rangeDays: number): TrafficSummary {
  finalizePastDays(state.stats, londonDateKey(new Date()));
  return summarizeTraffic(state.stats, rangeDays, londonDateKey(new Date()));
}

/** Reset all stats for the current season (admin action). */
export async function resetStats(): Promise<void> {
  state.stats = emptyStats(state.stats.season, new Date());
  state.dirty = true;
  await flushToRedis();
}

export async function flushToRedis(): Promise<void> {
  if (!state.redisSet || !state.dirty) return;
  try {
    finalizePastDays(state.stats, londonDateKey(new Date()));
    await state.redisSet(STATS_KEY, state.stats);
    state.dirty = false;
  } catch (e) {
    console.error('[Traffic] Redis flush failed:', (e as Error).message);
  }
}

/** Shutdown: flush remaining stats and stop the timer. */
export async function shutdown(): Promise<void> {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  await flushToRedis();
}
