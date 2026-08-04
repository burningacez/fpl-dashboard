import { describe, expect, it } from 'vitest';
import { liveLoser, sortLive } from '@/app/losers/liveLoser';

/**
 * The live tile on Weekly Losers names a manager; tapping it opens the live
 * table. Those two have to agree, and the tile must not claim a margin over
 * someone who is level on score.
 */

const mgr = (
  name: string,
  gwScore: number,
  extra: { gwGoals?: number; gwAssists?: number; transfersMade?: number } = {},
) => ({ entryId: name.length * 1000, name, team: `${name} FC`, gwScore, ...extra });

describe('live loser', () => {
  it('names whoever the table puts first, under either season, however the tie splits', () => {
    const weeks = [
      // Clear bottom, nothing to split.
      [mgr('Alice', 40), mgr('Bob', 33), mgr('Carol', 51)],
      // Level on score, split on goals.
      [mgr('Alice', 30, { gwGoals: 2 }), mgr('Bob', 30, { gwGoals: 0 }), mgr('Carol', 44)],
      // Level on score and goals, split on assists.
      [
        mgr('Alice', 30, { gwGoals: 1, gwAssists: 2 }),
        mgr('Bob', 30, { gwGoals: 1, gwAssists: 0 }),
        mgr('Carol', 44),
      ],
      // Level all the way to transfers.
      [
        mgr('Alice', 30, { gwGoals: 1, gwAssists: 1, transfersMade: 1 }),
        mgr('Bob', 30, { gwGoals: 1, gwAssists: 1, transfersMade: 4 }),
        mgr('Carol', 44),
      ],
    ];
    for (const managers of weeks) {
      for (const showAttacking of [true, false]) {
        const info = liveLoser(managers, showAttacking)!;
        expect(info.name).toBe(sortLive(managers, showAttacking)[0].name);
        expect(info.entryId).toBe(sortLive(managers, showAttacking)[0].entryId);
      }
    }
  });

  it('splits on goals, then assists, before reaching transfers', () => {
    // The manager with the fewest goals loses even though the other tinkered more.
    const goals = [
      mgr('Alice', 30, { gwGoals: 0, transfersMade: 0 }),
      mgr('Bob', 30, { gwGoals: 3, transfersMade: 4 }),
    ];
    expect(liveLoser(goals, true)!.name).toBe('Alice');
    // Before 2026-27, goals and assists did not count and transfers decided.
    expect(liveLoser(goals, false)!.name).toBe('Bob');

    const assists = [
      mgr('Alice', 30, { gwGoals: 1, gwAssists: 0, transfersMade: 0 }),
      mgr('Bob', 30, { gwGoals: 1, gwAssists: 3, transfersMade: 4 }),
    ];
    expect(liveLoser(assists, true)!.name).toBe('Alice');
    expect(liveLoser(assists, false)!.name).toBe('Bob');
  });

  it('reports a tie rather than a margin over someone level on score', () => {
    // Bob loses on transfers, but Alice is level with him: the tile has to say
    // Tiebreaker, not measure 14 points up to Carol.
    const managers = [
      mgr('Alice', 30, { transfersMade: 1 }),
      mgr('Bob', 30, { transfersMade: 4 }),
      mgr('Carol', 44),
    ];
    const info = liveLoser(managers, true)!;
    expect(info.name).toBe('Bob');
    expect(info.tiedCount).toBe(2);
    expect(info.runners).toEqual(['Bob', 'Alice']);
  });

  it('measures the margin to the next manager up when the loser is alone', () => {
    const info = liveLoser([mgr('Alice', 40), mgr('Bob', 33), mgr('Carol', 51)], true)!;
    expect(info.name).toBe('Bob');
    expect(info.score).toBe(33);
    expect(info.margin).toBe(7);
    expect(info.tiedCount).toBe(1);
  });

  it('has nobody to name before any scores exist', () => {
    expect(liveLoser([], true)).toBeNull();
    expect(liveLoser(undefined, true)).toBeNull();
    expect(sortLive(undefined, true)).toEqual([]);
  });

  it('treats missing goals, assists and transfers as zero', () => {
    const managers = [mgr('Alice', 30), mgr('Bob', 30, { transfersMade: 2 })];
    expect(liveLoser(managers, true)!.name).toBe('Bob');
    expect(sortLive(managers, true).map((m) => m.name)).toEqual(['Bob', 'Alice']);
  });
});
