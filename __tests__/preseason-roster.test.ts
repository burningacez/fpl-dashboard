import { describe, it, expect } from 'vitest';
import { isPreSeason } from '../src/lib/season-phase';
import { rosterEntryIds, rosterDiff } from '../src/server/services/roster';
import type { LeagueStandings } from '../src/server/fpl/types';

// Pre-season is the only window in which the league roster changes, and the
// only window in which nothing on the normal schedule would notice: no fixtures
// for a current gameweek means no match-window jobs, and the freeze guard makes
// the daily check a no-op. See src/server/services/roster.ts.

const events = (over: Partial<{ finished: boolean; is_current: boolean }>[] = []) =>
  Array.from({ length: 38 }, (_, i) => ({
    id: i + 1,
    finished: false,
    is_current: false,
    ...(over[i] ?? {}),
  }));

describe('isPreSeason', () => {
  it('is true for a reset season with nothing finished or current', () => {
    expect(isPreSeason(events())).toBe(true);
  });

  it('is false once GW1 goes current (deadline passed)', () => {
    expect(isPreSeason(events([{ is_current: true }]))).toBe(false);
  });

  it('is false mid-season, with completed gameweeks behind us', () => {
    const mid = events();
    mid[0].finished = true;
    mid[1].finished = true;
    mid[2].is_current = true;
    expect(isPreSeason(mid)).toBe(false);
  });

  it('is false for a concluded season (the July pre-reset shape)', () => {
    const done = events().map((e, i) => ({ ...e, finished: true, is_current: i === 37 }));
    expect(isPreSeason(done)).toBe(false);
  });

  it('is false — not "unknown" — when the event list is missing or empty', () => {
    // A failed bootstrap must never look like pre-season: callers fall back to
    // their in-season behaviour rather than acting on a guess.
    expect(isPreSeason([])).toBe(false);
    expect(isPreSeason(null)).toBe(false);
    expect(isPreSeason(undefined)).toBe(false);
  });
});

const league = (entries: number[]): LeagueStandings =>
  ({
    league: { id: 117775, name: 'Top of the Bots' },
    standings: {
      results: entries.map((entry, i) => ({
        id: entry,
        entry,
        entry_name: `Team ${entry}`,
        player_name: `Manager ${entry}`,
        rank: i + 1,
        last_rank: i + 1,
        total: 0,
        event_total: 0,
      })),
    },
  }) as LeagueStandings;

describe('rosterEntryIds', () => {
  it('returns sorted entry ids so the roster has a stable identity', () => {
    expect(rosterEntryIds(league([504026, 111, 900]))).toEqual([111, 900, 504026]);
  });

  it('treats a missing or empty league as an empty roster', () => {
    expect(rosterEntryIds(null)).toEqual([]);
    expect(rosterEntryIds(league([]))).toEqual([]);
  });
});

describe('rosterDiff', () => {
  it('detects a new entrant', () => {
    expect(rosterDiff([111, 900], [111, 900, 504026])).toEqual({ added: [504026], removed: [] });
  });

  it('detects a departure', () => {
    expect(rosterDiff([111, 900], [900])).toEqual({ added: [], removed: [111] });
  });

  it('reports no change for an unchanged roster — the poll stays cheap', () => {
    expect(rosterDiff([111, 900], [111, 900])).toEqual({ added: [], removed: [] });
  });

  it('reports the whole roster as added on a cold cache', () => {
    expect(rosterDiff([], [111, 900])).toEqual({ added: [111, 900], removed: [] });
  });
});
