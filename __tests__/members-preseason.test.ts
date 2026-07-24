import { describe, it, expect } from 'vitest';
import { withNewEntryMembers } from '../src/server/fpl/client';
import type { LeagueStandings } from '../src/server/fpl/types';

// Pre-season the FPL API returns joined managers under `new_entries` with an
// empty `standings.results`. The league member list (the "who are you?" picker
// and /api/members) reads `standings.results`, so withNewEntryMembers folds
// new_entries into standings before kickoff — without touching a live season.

const newEntry = (entry: number, first: string, last: string, team: string) => ({
  entry,
  entry_name: team,
  player_first_name: first,
  player_last_name: last,
  joined_time: '2026-07-23T21:07:28Z',
});

const base = (over: Partial<LeagueStandings>): LeagueStandings =>
  ({ league: { id: 117775, name: 'Top of the Bots' }, standings: { results: [] }, ...over }) as LeagueStandings;

describe('withNewEntryMembers (pre-season member list)', () => {
  it('synthesizes standings rows from new_entries when standings is empty', () => {
    const data = base({
      new_entries: {
        results: [
          newEntry(504026, 'Ewan', 'Pirrie', 'Chini Juniors'),
          newEntry(111, 'Mike', 'Garty', 'Gunning for Glory'),
        ],
      },
    });

    const results = withNewEntryMembers(data).standings.results;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      entry: 504026,
      player_name: 'Ewan Pirrie',
      entry_name: 'Chini Juniors',
      total: 0,
      event_total: 0,
      rank: 0,
    });
    expect(results[1]).toMatchObject({ entry: 111, player_name: 'Mike Garty', entry_name: 'Gunning for Glory' });
  });

  it('does NOT overwrite a live season with populated standings', () => {
    const data = base({
      standings: {
        results: [
          { id: 1, entry: 999, entry_name: 'Live Team', player_name: 'Live Manager', rank: 1, last_rank: 1, total: 50, event_total: 50 },
        ],
      },
      new_entries: { results: [newEntry(504026, 'Ewan', 'Pirrie', 'Chini Juniors')] },
    });

    const results = withNewEntryMembers(data).standings.results;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ entry: 999, total: 50 });
  });

  it('leaves data unchanged when both standings and new_entries are empty', () => {
    const data = base({ new_entries: { results: [] } });
    expect(withNewEntryMembers(data)).toBe(data);
  });

  it('is a no-op when new_entries is absent', () => {
    const data = base({});
    expect(withNewEntryMembers(data)).toBe(data);
  });
});
