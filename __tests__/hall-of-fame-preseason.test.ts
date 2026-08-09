import { describe, it, expect, vi } from 'vitest';

// The chip awards need bootstrap + picks from the FPL API; they are not what
// these tests are about, so stub the whole pass out.
vi.mock('../src/server/services/profiles', () => ({
  calculatePerfectChipUsage: async () => ({
    perfectBB: [],
    perfectTC: [],
    worstBB: null,
    worstTC: null,
  }),
}));

import { preCalculateHallOfFame } from '../src/server/services/hall-of-fame';

type GW = { event: number; points: number; event_transfers?: number; event_transfers_cost?: number; value?: number };

function manager(name: string, entryId: number, gameweeks: GW[]) {
  return { name, team: `${name} FC`, entryId, gameweeks, chips: [] };
}

describe('preCalculateHallOfFame — before the season has run', () => {
  it('publishes nothing when no gameweek has been completed', async () => {
    // Pre-season shape: the league has entrants, none of them have played.
    const histories = [manager('Alice', 1, []), manager('Bob', 2, []), manager('Carol', 3, [])];

    const hof = await preCalculateHallOfFame(histories, null, null, null, []);

    expect(hof).toBeNull();
  });

  it('leaves counting awards unclaimed until someone has actually earned them', async () => {
    // One gameweek played. Nobody has taken a hit, no MotM period has run,
    // and no weekly loser has been settled — so those awards have no holder,
    // even though the gameweek records themselves do.
    const histories = [
      manager('Alice', 1, [{ event: 1, points: 62, event_transfers: 0, event_transfers_cost: 0, value: 1000 }]),
      manager('Bob', 2, [{ event: 1, points: 48, event_transfers: 0, event_transfers_cost: 0, value: 1000 }]),
      manager('Carol', 3, [{ event: 1, points: 55, event_transfers: 0, event_transfers_cost: 0, value: 1000 }]),
    ];

    const hof = await preCalculateHallOfFame(histories, { losers: [] }, { winners: [] }, null, [1]);

    // Real records still get attributed.
    expect(hof.highlights.highestGW.names).toEqual(['Alice']);
    expect(hof.highlights.highestGW.score).toBe(62);
    expect(hof.lowlights.lowestGW.names).toEqual(['Bob']);
    expect(hof.highlights.mostWeeklyWins).toMatchObject({ names: ['Alice'], count: 1 });

    // Zero-count awards name nobody, rather than tying the whole league.
    expect(hof.highlights.mostMotM.names).toEqual([]);
    expect(hof.highlights.mostMotM.name).toBe('-');
    for (const record of [hof.lowlights.mostLosses, hof.lowlights.mostTransfers, hof.lowlights.biggestHit]) {
      expect(record.names).toEqual([]);
      expect(record.name).toBe('-');
    }
  });

  it('still awards the counting records once they have a real holder', async () => {
    const histories = [
      manager('Alice', 1, [{ event: 1, points: 62, event_transfers: 2, event_transfers_cost: 4, value: 1000 }]),
      manager('Bob', 2, [{ event: 1, points: 48, event_transfers: 0, event_transfers_cost: 0, value: 1000 }]),
    ];

    const hof = await preCalculateHallOfFame(
      histories,
      { losers: [{ name: 'Bob' }] },
      { winners: [{ winner: { name: 'Alice' } }] },
      null,
      [1],
    );

    expect(hof.lowlights.mostTransfers).toMatchObject({ names: ['Alice'], count: 2 });
    expect(hof.lowlights.biggestHit).toMatchObject({ names: ['Alice'], cost: 4 });
    expect(hof.lowlights.mostLosses).toMatchObject({ names: ['Bob'], count: 1 });
    expect(hof.highlights.mostMotM).toMatchObject({ names: ['Alice'], count: 1 });
    expect(hof.highlights.mostWeeklyWins).toMatchObject({ names: ['Alice'], count: 1 });
  });
});
