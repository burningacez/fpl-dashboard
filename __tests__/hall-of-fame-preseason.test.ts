import { describe, it, expect, vi } from 'vitest';

// Chip awards need bootstrap + picks from the FPL API; nothing here is about
// them, so they come back empty.
vi.mock('../src/server/services/profiles', () => ({
  calculatePerfectChipUsage: vi.fn(async () => ({
    perfectBB: [],
    perfectTC: [],
    worstBB: null,
    worstTC: null,
  })),
}));

import { preCalculateHallOfFame } from '../src/server/services/hall-of-fame';

// A record every manager in the league shares is the season's starting state,
// not a record: pre-season and after a single gameweek nobody has won a MotM,
// paid a weekly fine, made a transfer or taken a hit, and every squad is still
// worth the same. Listing all 29 names against a 0 reads as a broken page, so
// the Hall of Fame publishes nothing at all until a gameweek is played, and
// leaves whole-league ties unclaimed after that.

const LEAGUE_SIZE = 29;

const manager = (i: number, gameweeks: any[]) => ({
  name: `Manager ${i}`,
  team: `Team ${i}`,
  entryId: 1000 + i,
  gameweeks,
  chips: [],
});

/** One gameweek row in the shape fetchManagerHistory returns. */
const gw = (event: number, points: number, over: Record<string, unknown> = {}) => ({
  event,
  points,
  event_transfers: 0,
  event_transfers_cost: 0,
  value: 1000,
  points_on_bench: 0,
  ...over,
});

const league = (gameweeksFor: (i: number) => any[]) =>
  Array.from({ length: LEAGUE_SIZE }, (_, i) => manager(i, gameweeksFor(i)));

describe('Hall of Fame — pre-season and whole-league ties', () => {
  it('publishes nothing before the season\'s first gameweek', async () => {
    const hof = await preCalculateHallOfFame(league(() => []), null, null, null, []);
    expect(hof).toBeNull();
  });

  it('publishes nothing for an empty league', async () => {
    expect(await preCalculateHallOfFame([], null, null, null, [])).toBeNull();
  });

  it('leaves records the whole league is level on unclaimed after GW1', async () => {
    // Distinct scores, nobody transferred before the GW1 deadline, every squad
    // still worth £100.0m — the state this page was showing 29-way ties for.
    const hof = await preCalculateHallOfFame(
      league((i) => [gw(1, 50 + i)]),
      { losers: [] },
      { winners: [] },
      null,
      [1],
    );

    expect(hof).not.toBeNull();
    // Wins, losses and transfers: nobody has any, so nobody holds the award.
    expect(hof.highlights.mostMotM.names).toEqual([]);
    expect(hof.highlights.mostMotM.name).toBe('-');
    expect(hof.lowlights.mostLosses.names).toEqual([]);
    expect(hof.lowlights.mostTransfers.names).toEqual([]);
    expect(hof.lowlights.biggestHit.names).toEqual([]);
    // Team value is identical for everyone until prices move.
    expect(hof.highlights.highestTeamValue.names).toEqual([]);
    expect(hof.lowlights.lowestTeamValue.names).toEqual([]);
    // One gameweek gives every manager a deviation of 0.
    expect(hof.highlights.mostConsistent.names).toEqual([]);
    // Rank movement needs two gameweeks to compare.
    expect(hof.highlights.biggestClimb.names).toEqual([]);
    expect(hof.lowlights.biggestDrop.names).toEqual([]);
    // The scores themselves are real records from GW1 onwards, and topping the
    // week is a real win.
    expect(hof.highlights.highestGW.names).toEqual(['Manager 28']);
    expect(hof.highlights.highestGW.score).toBe(78);
    expect(hof.lowlights.lowestGW.names).toEqual(['Manager 0']);
    expect(hof.highlights.mostWeeklyWins).toMatchObject({ names: ['Manager 28'], count: 1 });
  });

  it('awards the records once someone actually holds them', async () => {
    const hof = await preCalculateHallOfFame(
      league((i) => [
        gw(1, 50 + i),
        // Manager 5 repeats their GW1 score, so consistency has one winner
        // instead of a league-wide tie on the same deviation.
        gw(2, i === 5 ? 50 + i : 40 + i, {
          event_transfers: i === 3 ? 4 : 1,
          event_transfers_cost: i === 3 ? 12 : 0,
          value: 1000 + i,
          points_on_bench: i === 7 ? 22 : 2,
        }),
      ]),
      { losers: [{ name: 'Manager 0' }, { name: 'Manager 0' }, { name: 'Manager 1' }] },
      { winners: [{ winner: { name: 'Manager 28' } }] },
      null,
      [1, 2],
    );

    expect(hof.highlights.mostMotM).toMatchObject({ names: ['Manager 28'], count: 1 });
    expect(hof.lowlights.mostLosses).toMatchObject({ names: ['Manager 0'], count: 2 });
    expect(hof.lowlights.mostTransfers).toMatchObject({ names: ['Manager 3'], count: 4 });
    expect(hof.lowlights.biggestHit).toMatchObject({ names: ['Manager 3'], cost: 12, gw: 2 });
    expect(hof.lowlights.biggestBenchHaul).toMatchObject({ names: ['Manager 7'], points: 22 });
    expect(hof.highlights.highestTeamValue).toMatchObject({ names: ['Manager 28'], value: '102.8' });
    // Two gameweeks in, consistency has a single winner rather than the league.
    expect(hof.highlights.mostConsistent).toMatchObject({ names: ['Manager 5'], stdDev: 0 });
  });
});
