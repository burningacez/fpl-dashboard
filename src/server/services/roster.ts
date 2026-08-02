import 'server-only';
import { fetchBootstrap, fetchLeagueData } from '../fpl/client';
import type { LeagueStandings } from '../fpl/types';
import { dataCache } from '../data-cache';
import { isPreSeason } from '../../lib/season-phase';
import { refreshAllData } from './refresh';
import { refreshWeekData } from './week';

/**
 * Pre-season roster sync.
 *
 * Everything else on this site is score data, which only moves while a
 * gameweek is live — hence the freeze guard in refreshAllData, which turns the
 * startup and daily refreshes into no-ops outside a live/settling gameweek.
 * The league roster is the exception: pre-season, entrants trickle in right up
 * to the GW1 deadline, and nothing on the normal schedule notices them (the
 * match-window jobs need fixtures, which don't exist for a gameweek that isn't
 * current yet). Until this existed a new entrant only appeared when the process
 * restarted, because boot unconditionally re-runs refreshWeekData.
 *
 * So: while pre-season, poll the league endpoint directly and run a full
 * refresh only when the member list actually changes. One cheap request per
 * poll; the expensive pass happens once per joiner. The window closes by
 * itself at the first deadline.
 */

/** How often the roster is re-read while entrants are still joining. */
export const PRESEASON_ROSTER_POLL_MS = 2 * 60 * 1000;

/**
 * Throttle shared by the poller and the per-request member reads, so a burst
 * of page loads can't turn into a burst of FPL calls. Well under the poll
 * interval, so the poller always sees a fresh fetch.
 */
const ROSTER_TTL_MS = 30 * 1000;

interface RosterState {
  cache: { data: LeagueStandings; ts: number } | null;
  inFlight: Promise<LeagueStandings> | null;
}

declare global {
  var __fplRosterState: RosterState | undefined;
}

const state: RosterState = (globalThis.__fplRosterState ??= { cache: null, inFlight: null });

/**
 * Live league read with a short TTL and in-flight dedupe — same two-tier shape
 * as the fpl/client caches, kept here because the league endpoint is otherwise
 * deliberately uncached (refreshAllData always wants it fresh).
 */
export async function fetchLeagueRosterThrottled(): Promise<LeagueStandings> {
  const cached = state.cache;
  if (cached && Date.now() - cached.ts < ROSTER_TTL_MS) return cached.data;
  if (state.inFlight) return state.inFlight;

  state.inFlight = fetchLeagueData()
    .then((data) => {
      state.cache = { data, ts: Date.now() };
      return data;
    })
    .finally(() => {
      state.inFlight = null;
    });
  return state.inFlight;
}

/** Drop the throttle window — used by tests and after a season rollover. */
export function invalidateRosterCache(): void {
  state.cache = null;
}

/** Are we in the joining phase? Falls back to "no" if bootstrap is unavailable. */
export async function inPreSeason(): Promise<boolean> {
  try {
    const bootstrap = await fetchBootstrap();
    return isPreSeason(bootstrap.events);
  } catch (error) {
    console.warn('[PreSeason] Could not determine season phase:', (error as Error).message);
    return false;
  }
}

/** Sorted entry ids of a league payload — the roster's identity. */
export function rosterEntryIds(league: LeagueStandings | null | undefined): number[] {
  const rows = league?.standings?.results ?? [];
  return rows
    .map((r) => r.entry)
    .filter((id): id is number => Number.isFinite(id))
    .sort((a, b) => a - b);
}

export function rosterDiff(prev: number[], next: number[]): { added: number[]; removed: number[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !prevSet.has(id)),
    removed: prev.filter((id) => !nextSet.has(id)),
  };
}

export interface RosterSyncResult {
  changed: boolean;
  added: number[];
  removed: number[];
  total: number;
}

/**
 * Compare the live roster against the cached one and, when it has moved, run a
 * full refresh so every surface (standings snapshot, member picker, week data)
 * picks the new entrants up at once.
 *
 * The `new-entrant` reason deliberately matches neither the freeze list nor the
 * heavy pre-cache list in refreshAllData: it must not be frozen, and pre-season
 * there is no completed gameweek worth pre-calculating.
 */
export async function syncLeagueRoster(reason: string = 'poll'): Promise<RosterSyncResult> {
  const league = await fetchLeagueRosterThrottled();
  const next = rosterEntryIds(league);
  const prev = rosterEntryIds(dataCache.league as LeagueStandings | null);
  const { added, removed } = rosterDiff(prev, next);

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, added, removed, total: next.length };
  }

  console.log(
    `[PreSeason] Roster changed (${reason}): +${added.length} / -${removed.length}, now ${next.length} member(s) — refreshing`,
  );

  const result = await refreshAllData(`new-entrant-${reason}`);
  if (!result?.success) {
    // Left as-is on purpose: dataCache.league still holds the old roster, so
    // the next poll sees the same diff and retries.
    console.error(`[PreSeason] Refresh after roster change failed: ${result?.error}`);
    return { changed: false, added, removed, total: next.length };
  }
  await refreshWeekData().catch((e: Error) =>
    console.error('[PreSeason] Week refresh after roster change failed:', e.message),
  );

  return { changed: true, added, removed, total: next.length };
}
