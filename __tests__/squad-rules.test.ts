import { describe, it, expect } from 'vitest';
import {
  sellingPrice,
  applyTransfers,
  validateSquad,
  freeTransfersAfter,
  hitCost,
  foldPlan,
  squadHash,
  type PlannerPlayer,
  type SquadSlot,
  type PlannerPlan,
} from '../src/lib/squad-rules';

// ---- test fixtures -------------------------------------------------------

/** Build a players map. Each entry: [id, element_type, team, now_cost]. */
function makePlayers(rows: [number, number, number, number][]): Map<number, PlannerPlayer> {
  const m = new Map<number, PlannerPlayer>();
  for (const [id, element_type, team, now_cost] of rows) {
    m.set(id, { id, web_name: `P${id}`, team, element_type, now_cost });
  }
  return m;
}

/** A legal 15-man squad: 2 GK / 5 DEF / 5 MID / 3 FWD, ≤3 per club. */
function legalSquad(): { squad: SquadSlot[]; players: Map<number, PlannerPlayer> } {
  const rows: [number, number, number, number][] = [];
  let id = 1;
  const quotas: [number, number][] = [
    [1, 2],
    [2, 5],
    [3, 5],
    [4, 3],
  ];
  for (const [type, count] of quotas) {
    for (let i = 0; i < count; i++) {
      // spread clubs so max-per-club is never exceeded (id as club → 1 each)
      rows.push([id, type, id, 50]);
      id++;
    }
  }
  const players = makePlayers(rows);
  const squad: SquadSlot[] = rows.map(([pid]) => ({ element: pid, purchasePrice: 50, sellingPrice: 50 }));
  return { squad, players };
}

// ---- sellingPrice --------------------------------------------------------

describe('sellingPrice', () => {
  it('keeps half the profit, rounded down, when price rose', () => {
    expect(sellingPrice(55, 58)).toBe(56); // +3 → +1
    expect(sellingPrice(55, 59)).toBe(57); // +4 → +2
    expect(sellingPrice(50, 55)).toBe(52); // +5 → +2
  });

  it('sells at the current price when the price dropped', () => {
    expect(sellingPrice(55, 53)).toBe(53);
    expect(sellingPrice(100, 90)).toBe(90);
  });

  it('is unchanged when price is flat', () => {
    expect(sellingPrice(55, 55)).toBe(55);
  });
});

// ---- freeTransfers & hits ------------------------------------------------

describe('freeTransfersAfter', () => {
  it('accrues by one up to the cap of 5', () => {
    expect(freeTransfersAfter(1, 0)).toBe(2);
    expect(freeTransfersAfter(4, 0)).toBe(5);
    expect(freeTransfersAfter(5, 0)).toBe(5); // capped
  });

  it('subtracts used transfers before accruing', () => {
    expect(freeTransfersAfter(2, 2)).toBe(1); // used both, +1
    expect(freeTransfersAfter(1, 3)).toBe(1); // over-spent, floors at 0, +1
  });

  it('ignores used transfers on a wildcard/free-hit week', () => {
    expect(freeTransfersAfter(2, 8, true)).toBe(3); // used ignored → 2 + 1
  });
});

describe('hitCost', () => {
  it('charges 4 points per transfer beyond the free allowance', () => {
    expect(hitCost(1, 1)).toBe(0);
    expect(hitCost(1, 2)).toBe(4); // 2 transfers on 1 FT
    expect(hitCost(1, 3)).toBe(8);
    expect(hitCost(2, 2)).toBe(0);
  });

  it('is zero on a wildcard/free-hit week regardless of count', () => {
    expect(hitCost(1, 5, true)).toBe(0);
  });
});

// ---- applyTransfers ------------------------------------------------------

describe('applyTransfers', () => {
  it('swaps a player and adjusts the bank by selling price minus buy cost', () => {
    const players = makePlayers([
      [1, 3, 10, 70],
      [2, 3, 11, 60],
    ]);
    const squad: SquadSlot[] = [{ element: 1, purchasePrice: 68, sellingPrice: 69 }];
    const res = applyTransfers(squad, [{ out: 1, in: 2 }], players, 5);
    expect(res.applied).toBe(1);
    expect(res.bank).toBe(5 + 69 - 60); // 14
    expect(res.squad[0]).toEqual({ element: 2, purchasePrice: 60, sellingPrice: 60 });
    expect(res.errors).toEqual([]);
  });

  it('reports a negative bank but still returns the state', () => {
    const players = makePlayers([
      [1, 3, 10, 40],
      [2, 3, 11, 130],
    ]);
    const squad: SquadSlot[] = [{ element: 1, purchasePrice: 40, sellingPrice: 40 }];
    const res = applyTransfers(squad, [{ out: 1, in: 2 }], players, 0);
    expect(res.bank).toBe(0 + 40 - 130); // -90
    expect(res.errors.some((e) => e.includes('negative'))).toBe(true);
  });

  it('skips selling a player not owned and buying one already owned', () => {
    const players = makePlayers([
      [1, 3, 10, 50],
      [2, 3, 11, 50],
      [9, 3, 12, 50],
    ]);
    const squad: SquadSlot[] = [{ element: 1, purchasePrice: 50, sellingPrice: 50 }];
    const notOwned = applyTransfers(squad, [{ out: 9, in: 2 }], players, 0);
    expect(notOwned.applied).toBe(0);
    expect(notOwned.errors[0]).toContain('not in your squad');
    const already = applyTransfers(squad, [{ out: 1, in: 1 }], players, 0);
    expect(already.applied).toBe(0);
    expect(already.errors[0]).toContain('already in your squad');
  });
});

// ---- validateSquad -------------------------------------------------------

describe('validateSquad', () => {
  it('passes a legal 15-man squad', () => {
    const { squad, players } = legalSquad();
    expect(validateSquad(squad, players)).toEqual([]);
  });

  it('flags wrong squad size', () => {
    const { squad, players } = legalSquad();
    expect(validateSquad(squad.slice(0, 14), players).some((e) => e.includes('exactly 15'))).toBe(true);
  });

  it('flags wrong positional quota (3 GKs)', () => {
    const { squad, players } = legalSquad();
    // turn a DEF (id 3) into a 3rd GK by swapping in a GK-typed player
    players.set(99, { id: 99, web_name: 'GK3', team: 99, element_type: 1, now_cost: 50 });
    const bad = squad.map((s) => (s.element === 3 ? { ...s, element: 99 } : s));
    expect(validateSquad(bad, players).some((e) => e.includes('GKP'))).toBe(true);
  });

  it('flags more than 3 players from one club', () => {
    const { squad, players } = legalSquad();
    // point ids 2,3,4,5 all at club 2 (4 defenders from one club)
    for (const id of [3, 4, 5]) players.set(id, { ...players.get(id)!, team: 2 });
    expect(validateSquad(squad, players).some((e) => e.includes('max 3 per club'))).toBe(true);
  });

  it('flags duplicates', () => {
    const { squad, players } = legalSquad();
    const dup = [...squad.slice(0, 14), { ...squad[0] }];
    expect(validateSquad(dup, players).some((e) => e.includes('Duplicate'))).toBe(true);
  });
});

// ---- foldPlan ------------------------------------------------------------

describe('foldPlan', () => {
  it('carries a GW+1 transfer into the GW+2 squad and threads the bank', () => {
    const { squad, players } = legalSquad();
    // add two bench-able alternatives in the same position/quota-safe way:
    // replace MID id 8 → 20 in GW+1, then MID 9 → 21 in GW+2
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    players.set(21, { id: 21, web_name: 'P21', team: 91, element_type: 3, now_cost: 45 });

    const plan: PlannerPlan = {
      version: 1,
      entryId: 1,
      season: '2026-27',
      baseGw: 24,
      baseSquadHash: squadHash(squad, 0),
      updatedAt: 0,
      weeks: {
        '25': { transfers: [{ out: 8, in: 20 }] },
        '26': { transfers: [{ out: 9, in: 21 }] },
      },
    };

    const states = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 24 }, plan, players);
    expect(states.map((s) => s.gw)).toEqual([25, 26]);

    const gw25 = states[0];
    expect(gw25.squad.some((s) => s.element === 20)).toBe(true);
    expect(gw25.squad.some((s) => s.element === 8)).toBe(false);
    expect(gw25.bank).toBe(50 - 45); // sold 50, bought 45

    const gw26 = states[1];
    // GW+1's new player 20 is still present in GW+2
    expect(gw26.squad.some((s) => s.element === 20)).toBe(true);
    expect(gw26.squad.some((s) => s.element === 21)).toBe(true);
    expect(gw26.bank).toBe(5 + 50 - 45); // carried 5, then sold 50 bought 45
    // FT: entered GW25 with 1, used 1 → GW26 enters with 1
    expect(gw25.freeTransfers).toBe(1);
    expect(gw26.freeTransfers).toBe(1);
    expect(gw25.hits).toBe(0);
    expect(gw26.hits).toBe(0);
  });

  it('charges a hit when transfers exceed free transfers', () => {
    const { squad, players } = legalSquad();
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    players.set(21, { id: 21, web_name: 'P21', team: 91, element_type: 3, now_cost: 45 });
    const plan: PlannerPlan = {
      version: 1,
      entryId: 1,
      season: '2026-27',
      baseGw: 24,
      baseSquadHash: '',
      updatedAt: 0,
      weeks: { '25': { transfers: [{ out: 8, in: 20 }, { out: 9, in: 21 }] } },
    };
    const [gw25] = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 24 }, plan, players);
    expect(gw25.used).toBe(2);
    expect(gw25.hits).toBe(4); // 2 transfers, 1 free → one -4 hit
  });

  it('extends the horizon with empty weeks via throughGw', () => {
    const { squad, players } = legalSquad();
    const plan: PlannerPlan = {
      version: 1,
      entryId: 1,
      season: '2026-27',
      baseGw: 24,
      baseSquadHash: '',
      updatedAt: 0,
      weeks: {},
    };
    const states = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 24 }, plan, players, 29);
    expect(states.map((s) => s.gw)).toEqual([25, 26, 27, 28, 29]);
    // FT accrues 1→2→3→4→5→5 (capped)
    expect(states.map((s) => s.freeTransfers)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('squadHash', () => {
  it('is stable regardless of slot order and changes with bank', () => {
    const a: SquadSlot[] = [
      { element: 3, purchasePrice: 50, sellingPrice: 50 },
      { element: 1, purchasePrice: 50, sellingPrice: 50 },
    ];
    const b: SquadSlot[] = [
      { element: 1, purchasePrice: 99, sellingPrice: 99 },
      { element: 3, purchasePrice: 12, sellingPrice: 12 },
    ];
    expect(squadHash(a, 5)).toBe(squadHash(b, 5)); // order + selling price ignored
    expect(squadHash(a, 5)).not.toBe(squadHash(a, 6)); // bank matters
  });
});
