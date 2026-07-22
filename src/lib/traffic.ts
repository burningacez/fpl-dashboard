/**
 * Traffic analytics — pure logic (bucket mutation, date keys, filtering,
 * summarising). Stateless and importable from tests; the stateful server
 * wrapper (Redis persistence, flush timer, claims memo) lives in
 * src/server/traffic.ts, mirroring the identity.ts / identity-store.ts split.
 *
 * A "view" is one client-side navigation to a page, beaconed to
 * /api/traffic/track. Devices are the httpOnly `fpl-device` token; claimed
 * devices additionally attribute views to a member's nameKey.
 */

/** Pages that count as views. Anything else posted to the track endpoint is
 *  dropped so junk POSTs can't grow the stats blob with arbitrary keys. */
export const TRACKED_PATHS = [
  '/',
  '/analytics',
  '/cup',
  '/earnings',
  '/h2h',
  '/hall-of-fame',
  '/losers',
  '/motm',
  '/planner',
  '/rules',
  '/set-and-forget',
  '/standings',
  '/week',
] as const;

const TRACKED_SET = new Set<string>(TRACKED_PATHS);

/** Cap on the all-time seen-devices map — safety valve for a small league. */
export const MAX_SEEN_DEVICES = 2000;

/** localStorage flag that stops this browser being counted (admin opt-out). */
export const TRAFFIC_OPTOUT_KEY = 'fpl-traffic-optout';

export interface DayBucket {
  /** Total page views this day. */
  total: number;
  /** Devices first seen (ever this season) on this day. */
  newDevices: number;
  /** Unique devices this day — finalized for past days, live-computed for today. */
  uniqueDevices: number;
  /** path -> views. */
  pages: Record<string, number>;
  /** nameKey -> path -> views (claimed devices only). */
  users: Record<string, Record<string, number>>;
  /** deviceToken -> views. Present for the current day only; collapsed into
   *  uniqueDevices when the day rolls over, so historical buckets stay small. */
  devices?: Record<string, number>;
}

export interface TrafficStats {
  season: string;
  startedAt: string; // ISO timestamp of first-ever init for this season
  /** deviceToken -> first-seen date key ('YYYY-MM-DD'). */
  seenDevices: Record<string, string>;
  /** date key ('YYYY-MM-DD', Europe/London) -> bucket. */
  days: Record<string, DayBucket>;
}

// The league is UK-based, so "a day" is a London day (handles BST/GMT).
const londonDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' for the given instant, in Europe/London. */
export function londonDateKey(date: Date): string {
  return londonDateFormat.format(date);
}

export function emptyStats(season: string, now: Date): TrafficStats {
  return { season, startedAt: now.toISOString(), seenDevices: {}, days: {} };
}

function emptyBucket(): DayBucket {
  return { total: 0, newDevices: 0, uniqueDevices: 0, pages: {}, users: {}, devices: {} };
}

/**
 * Normalise a beaconed path: strip query/hash, drop trailing slash, and
 * validate against the tracked-pages allowlist. Returns null for anything
 * that shouldn't be counted (unknown paths, /api/*, /admin*).
 */
export function normalizeTrackedPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  let path = raw.split(/[?#]/)[0];
  if (!path.startsWith('/')) return null;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return TRACKED_SET.has(path) ? path : null;
}

/** Crude bot filter for the track endpoint (beacon already requires JS). */
export function isBotUserAgent(ua: string | null): boolean {
  if (!ua) return true; // real browsers always send a UA
  return /bot|crawl|spider|scrape|headless|lighthouse|preview|monitor|curl|wget|python|node-fetch/i.test(ua);
}

export interface RecordViewInput {
  path: string; // already validated via normalizeTrackedPath
  deviceToken: string;
  /** Claimed member's nameKey for this device, if any. */
  nameKey: string | null;
  dateKey: string; // londonDateKey(now)
}

/**
 * Record one page view into the stats (mutates in place — the caller owns
 * the object, matching the logger's in-memory-state model).
 */
export function recordView(stats: TrafficStats, view: RecordViewInput): void {
  const { path, deviceToken, nameKey, dateKey } = view;

  finalizePastDays(stats, dateKey);

  const day = (stats.days[dateKey] ??= emptyBucket());
  day.devices ??= {}; // day created before a restart mid-day may have been collapsed

  day.total += 1;
  day.pages[path] = (day.pages[path] ?? 0) + 1;
  day.devices[deviceToken] = (day.devices[deviceToken] ?? 0) + 1;
  day.uniqueDevices = Object.keys(day.devices).length;

  if (nameKey) {
    const userPages = (day.users[nameKey] ??= {});
    userPages[path] = (userPages[path] ?? 0) + 1;
  }

  if (!stats.seenDevices[deviceToken]) {
    stats.seenDevices[deviceToken] = dateKey;
    day.newDevices += 1;
    pruneSeenDevices(stats);
  }
}

/**
 * Collapse per-device maps on buckets older than `todayKey` into their
 * uniqueDevices count. Keeps full-season retention affordable: historical
 * days cost a handful of counters instead of a UUID map.
 */
export function finalizePastDays(stats: TrafficStats, todayKey: string): void {
  for (const [key, bucket] of Object.entries(stats.days)) {
    if (key < todayKey && bucket.devices) {
      bucket.uniqueDevices = Object.keys(bucket.devices).length;
      delete bucket.devices;
    }
  }
}

/** Drop the oldest-seen devices once over the cap (safety valve only). */
function pruneSeenDevices(stats: TrafficStats): void {
  const entries = Object.entries(stats.seenDevices);
  if (entries.length <= MAX_SEEN_DEVICES) return;
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [token] of entries.slice(0, entries.length - MAX_SEEN_DEVICES)) {
    delete stats.seenDevices[token];
  }
}

// =============================================================================
// Summaries (shape consumed by /api/admin/traffic; names resolved by caller)
// =============================================================================

export interface TrafficDaySummary {
  date: string;
  views: number;
  uniques: number;
  newDevices: number;
  returning: number;
}

export interface TrafficPageSummary {
  path: string;
  views: number;
}

export interface TrafficUserSummary {
  nameKey: string;
  views: number;
  lastSeen: string; // date key
  pages: TrafficPageSummary[];
}

export interface TrafficSummary {
  season: string;
  startedAt: string;
  totals: { views: number; uniqueDevices: number };
  days: TrafficDaySummary[]; // newest first, clipped to the requested range
  pages: TrafficPageSummary[]; // summed over the range, most viewed first
  users: TrafficUserSummary[]; // summed over the range, most active first
}

function sortedPages(counts: Record<string, number>): TrafficPageSummary[] {
  return Object.entries(counts)
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
}

/**
 * Aggregate the last `rangeDays` London days (ending at `todayKey`) into the
 * admin summary. `rangeDays <= 0` means the whole season.
 */
export function summarizeTraffic(stats: TrafficStats, rangeDays: number, todayKey: string): TrafficSummary {
  const dayKeys = Object.keys(stats.days).sort().reverse(); // newest first
  const inRange = rangeDays > 0
    ? dayKeys.filter((key) => daysBetween(key, todayKey) < rangeDays)
    : dayKeys;

  const days: TrafficDaySummary[] = [];
  const pageTotals: Record<string, number> = {};
  const userTotals: Record<string, { views: number; lastSeen: string; pages: Record<string, number> }> = {};
  let views = 0;

  for (const key of inRange) {
    const bucket = stats.days[key];
    const uniques = bucket.devices ? Object.keys(bucket.devices).length : bucket.uniqueDevices;
    views += bucket.total;
    days.push({
      date: key,
      views: bucket.total,
      uniques,
      newDevices: bucket.newDevices,
      returning: Math.max(0, uniques - bucket.newDevices),
    });

    for (const [path, count] of Object.entries(bucket.pages)) {
      pageTotals[path] = (pageTotals[path] ?? 0) + count;
    }

    for (const [nameKey, pages] of Object.entries(bucket.users)) {
      const user = (userTotals[nameKey] ??= { views: 0, lastSeen: key, pages: {} });
      if (key > user.lastSeen) user.lastSeen = key;
      for (const [path, count] of Object.entries(pages)) {
        user.views += count;
        user.pages[path] = (user.pages[path] ?? 0) + count;
      }
    }
  }

  const users: TrafficUserSummary[] = Object.entries(userTotals)
    .map(([nameKey, u]) => ({ nameKey, views: u.views, lastSeen: u.lastSeen, pages: sortedPages(u.pages) }))
    .sort((a, b) => b.views - a.views || a.nameKey.localeCompare(b.nameKey));

  // Season-wide unique devices, regardless of the requested range.
  const uniqueDevices = Object.keys(stats.seenDevices).length;

  return {
    season: stats.season,
    startedAt: stats.startedAt,
    totals: { views, uniqueDevices },
    days,
    pages: sortedPages(pageTotals),
    users,
  };
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'); positive when to > from. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
