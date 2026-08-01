import { describe, it, expect } from 'vitest';
import {
  defaultLineup,
  lineupErrors,
  formationLabel,
  swapLineupSlots,
  startersOf,
  benchOf,
  foldPlan,
  applySwaps,
  deriveFreeTransfers,
  INITIAL_BUDGET,
  MAX_FREE_TRANSFERS,
  type PlannerPlayer,
  type PlannerPlan,
  type SquadSlot,
} from '../src/lib/squad-rules';
import { draftSpend, draftToSlots, maxAffordable } from '../src/lib/planner-draft';

// ---- fixtures ------------------------------------------------------------

/** Build a players map. Each entry: [id, element_type, team, now_cost]. */
function makePlayers(rows: [number, number, number, number][]): Map<number, PlannerPlayer> {
  const m = new Map<number, PlannerPlayer>();
  for (const [id, element_type, team, now_cost] of rows) {
    m.set(id, { id, web_name: `P${id}`, team, element_type, now_cost });
  }
  return m;
}

/**
 * 15 players, one club each, priced so ordering is unambiguous: within a
 * position the lower id is dearer, so "most expensive first" is predictable.
 * ids 1-2 GKP, 3-7 DEF, 8-12 MID, 13-15 FWD.
 */
function draftPool(): { order: number[]; players: Map<number, PlannerPlayer> } {
  const rows: [number, number, number, number][] = [];
  let id = 1;
  for (const [type, count] of [
    [1, 2],
    [2, 5],
    [3, 5],
    [4, 3],
  ] as [number, number][]) {
    for (let i = 0; i < count; i++) {
      rows.push([id, type, id, 100 - id]); // club = id, price descends with id
      id++;
    }
  }
  return { order: rows.map(([pid]) => pid), players: makePlayers(rows) };
}

const typeOf = (players: Map<number, PlannerPlayer>) => (el: number) => players.get(el)!.element_type;

// ---- defaultLineup -------------------------------------------------------

describe('defaultLineup', () => {
  it('produces a legal XI with one keeper starting and the other benched first', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);

    expect(lineup).toHaveLength(15);
    expect(new Set(lineup)).toEqual(new Set(order));
    expect(lineupErrors(lineup, players)).toEqual([]);

    const starters = startersOf(lineup);
    const bench = benchOf(lineup);
    expect(starters.filter((el) => typeOf(players)(el) === 1)).toHaveLength(1);
    // The pricier keeper (id 1) starts; the reserve heads the bench.
    expect(starters).toContain(1);
    expect(bench[0]).toBe(2);
  });

  it('meets position minimums and fills the rest with the priciest outfielders', () => {
    const { order, players } = draftPool();
    const starters = startersOf(defaultLineup(order, players));
    const counts = { 2: 0, 3: 0, 4: 0 } as Record<number, number>;
    for (const el of starters) {
      const t = typeOf(players)(el);
      if (t !== 1) counts[t] += 1;
    }
    expect(counts[2]).toBeGreaterThanOrEqual(3);
    expect(counts[3]).toBeGreaterThanOrEqual(2);
    expect(counts[4]).toBeGreaterThanOrEqual(1);
    expect(counts[2] + counts[3] + counts[4]).toBe(10);
    // Cheapest outfielders (highest ids) are the ones left on the bench.
    expect(benchOf(defaultLineup(order, players))).toContain(12);
  });

  it('leaves an incomplete squad untouched', () => {
    const { order, players } = draftPool();
    const partial = order.slice(0, 9);
    expect(defaultLineup(partial, players)).toEqual(partial);
  });
});

// ---- lineupErrors --------------------------------------------------------

describe('lineupErrors', () => {
  it('accepts a legal lineup', () => {
    const { order, players } = draftPool();
    expect(lineupErrors(defaultLineup(order, players), players)).toEqual([]);
  });

  it('rejects a squad that is not 15 players', () => {
    const { order, players } = draftPool();
    expect(lineupErrors(order.slice(0, 14), players)).toHaveLength(1);
  });

  it('rejects two keepers in the starting XI', () => {
    const { order, players } = draftPool();
    // Both keepers (1, 2) start; a defender drops to the bench.
    const bad = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 7, 12, 14, 15];
    // Matched exactly: 'reserve goalkeeper' (which this lineup also trips)
    // contains the word 'goalkeeper' too, so a loose check proves nothing.
    expect(lineupErrors(bad, players)).toContain('Starting XI has 2 goalkeepers. Must be exactly 1');
  });

  it('rejects fewer than three defenders in the starting XI', () => {
    const { order, players } = draftPool();
    // 1 GK, 2 DEF, 5 MID, 3 FWD = 11, but the back line is a defender short.
    const bad = [1, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 2, 5, 6, 7];
    expect(lineupErrors(bad, players).some((e) => e.includes('DEF'))).toBe(true);
  });

  it('rejects a bench that does not start with the reserve keeper', () => {
    const legal = draftPool();
    const lineup = defaultLineup(legal.order, legal.players);
    // Swap the reserve keeper out of bench slot 0 without touching the XI.
    const bad = [...lineup];
    [bad[11], bad[12]] = [bad[12], bad[11]];
    expect(bad).toHaveLength(15);
    expect(lineupErrors(bad, legal.players).some((e) => e.includes('reserve goalkeeper'))).toBe(true);
  });
});

// ---- formationLabel ------------------------------------------------------

describe('formationLabel', () => {
  it('reads out the outfield shape of the starting XI', () => {
    const { players } = draftPool();
    // 1 GK + 3 DEF + 4 MID + 3 FWD
    const starters = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15];
    expect(formationLabel(starters, players)).toBe('3-4-3');
  });
});

// ---- swapLineupSlots -----------------------------------------------------

describe('swapLineupSlots', () => {
  it('swaps a starter for a bench player when the formation survives', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    // Find a benched outfielder and a starter of the same position to swap.
    const bench = benchOf(lineup);
    const benchOutfielder = bench.find((el) => typeOf(players)(el) !== 1)!;
    const type = typeOf(players)(benchOutfielder);
    const starter = startersOf(lineup).find((el) => typeOf(players)(el) === type)!;

    const next = swapLineupSlots(lineup, lineup.indexOf(starter), lineup.indexOf(benchOutfielder), players);
    expect(next).not.toBeNull();
    expect(startersOf(next!)).toContain(benchOutfielder);
    expect(benchOf(next!)).toContain(starter);
    expect(lineupErrors(next!, players)).toEqual([]);
  });

  it('refuses to start the reserve keeper alongside the first-choice one', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    const outfieldStarter = startersOf(lineup).find((el) => typeOf(players)(el) !== 1)!;
    // Bench slot 0 is the reserve keeper — swapping him for an outfield
    // starter would mean two keepers in the XI and no keeper on the bench.
    expect(swapLineupSlots(lineup, lineup.indexOf(outfieldStarter), 11, players)).toBeNull();
  });

  it('refuses a swap that leaves the starting XI short of defenders', () => {
    const { players } = draftPool();
    // 1 GK, 3 DEF (3,4,5), 4 MID, 3 FWD — the back line is already at minimum.
    const lineup = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15, 2, 6, 7, 12];
    expect(lineupErrors(lineup, players)).toEqual([]);
    // Swapping a starting defender for a benched midfielder breaks it.
    expect(swapLineupSlots(lineup, lineup.indexOf(5), lineup.indexOf(12), players)).toBeNull();
  });

  it('returns null for out-of-range or no-op indices', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    expect(swapLineupSlots(lineup, 3, 3, players)).toBeNull();
    expect(swapLineupSlots(lineup, -1, 4, players)).toBeNull();
    expect(swapLineupSlots(lineup, 4, 99, players)).toBeNull();
  });
});

// ---- the unlimited GW1 week ---------------------------------------------

describe('foldPlan with an unlimited gameweek', () => {
  /** A draft base: squad at gw 0, no free transfers banked, GW1 unlimited. */
  function draftBase(squad: SquadSlot[]) {
    return { squad, bank: 0, freeTransfers: 0, baseGw: 0, unlimitedGw: 1 };
  }

  function planWith(weeks: PlannerPlan['weeks']): PlannerPlan {
    return { version: 1, entryId: 1, season: '2026-27', baseGw: 0, baseSquadHash: '', updatedAt: 0, weeks };
  }

  it('charges nothing for GW1 changes however many are made', () => {
    const { order, players } = draftPool();
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    players.set(21, { id: 21, web_name: 'P21', team: 91, element_type: 3, now_cost: 45 });
    const squad = draftToSlots(order, players);

    const plan = planWith({
      '1': {
        transfers: [
          { out: 8, in: 20 },
          { out: 9, in: 21 },
        ],
      },
    });
    const states = foldPlan(draftBase(squad), plan, players, 5);

    const gw1 = states[0];
    expect(gw1.gw).toBe(1);
    expect(gw1.unlimited).toBe(true);
    expect(gw1.used).toBe(2);
    expect(gw1.hits).toBe(0);
  });

  it('leaves the free-transfer bank alone, so GW2 opens with exactly one', () => {
    const { order, players } = draftPool();
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    const squad = draftToSlots(order, players);

    const states = foldPlan(draftBase(squad), planWith({ '1': { transfers: [{ out: 8, in: 20 }] } }), players, 5);
    expect(states.map((s) => s.gw)).toEqual([1, 2, 3, 4, 5]);
    // Not 2: nothing accrues before the season starts, and GW1's changes
    // aren't transfers, so GW2 is the first week with a free transfer.
    expect(states.map((s) => s.freeTransfers)).toEqual([0, 1, 2, 3, 4]);
    expect(states.every((s) => s.hits === 0)).toBe(true);
  });

  it('charges normally from GW2 onward', () => {
    const { order, players } = draftPool();
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    players.set(21, { id: 21, web_name: 'P21', team: 91, element_type: 3, now_cost: 45 });
    const squad = draftToSlots(order, players);

    const plan = planWith({
      '2': {
        transfers: [
          { out: 8, in: 20 },
          { out: 9, in: 21 },
        ],
      },
    });
    const states = foldPlan(draftBase(squad), plan, players, 5);
    const gw2 = states[1];
    expect(gw2.unlimited).toBe(false);
    expect(gw2.freeTransfers).toBe(1);
    expect(gw2.hits).toBe(4); // 2 transfers, 1 free
  });

  it('marks only the nominated week as unlimited', () => {
    const { order, players } = draftPool();
    const squad = draftToSlots(order, players);
    const states = foldPlan(draftBase(squad), planWith({}), players, 5);
    expect(states.map((s) => s.unlimited)).toEqual([true, false, false, false, false]);
  });

  it('is off by default, leaving existing in-season folds unchanged', () => {
    const { order, players } = draftPool();
    players.set(20, { id: 20, web_name: 'P20', team: 90, element_type: 3, now_cost: 45 });
    const squad = draftToSlots(order, players);
    const plan = planWith({ '1': { transfers: [{ out: 8, in: 20 }] } });
    const [gw1] = foldPlan({ squad, bank: 0, freeTransfers: 0, baseGw: 0 }, plan, players, 2);
    expect(gw1.unlimited).toBe(false);
    expect(gw1.hits).toBe(4); // no free transfers, so the change costs
  });
});

// ---- substitutions -------------------------------------------------------

describe('applySwaps', () => {
  it('swaps the given slot indices in order', () => {
    expect(applySwaps(['a', 'b', 'c', 'd'], [[0, 3]])).toEqual(['d', 'b', 'c', 'a']);
    // Applied in sequence, so the second swap sees the first one's result.
    expect(applySwaps(['a', 'b', 'c'], [[0, 1], [1, 2]])).toEqual(['b', 'c', 'a']);
  });

  it('returns the input untouched when there is nothing to do', () => {
    const squad = ['a', 'b'];
    expect(applySwaps(squad, undefined)).toBe(squad);
    expect(applySwaps(squad, [])).toBe(squad);
  });

  it('ignores out-of-range pairs rather than throwing', () => {
    // A saved plan can outlive the shape of the squad it was written against.
    expect(applySwaps(['a', 'b'], [[0, 9], [-1, 1], [0, 1]])).toEqual(['b', 'a']);
  });
});

describe('foldPlan with substitutions', () => {
  function planWith(weeks: PlannerPlan['weeks']): PlannerPlan {
    return { version: 1, entryId: 1, season: '2026-27', baseGw: 0, baseSquadHash: '', updatedAt: 0, weeks };
  }

  it('reorders the squad so a benched player starts', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    const squad = draftToSlots(lineup, players);
    const benchOutfielder = benchOf(lineup).find((el) => players.get(el)!.element_type !== 1)!;
    const starter = startersOf(lineup).find(
      (el) => players.get(el)!.element_type === players.get(benchOutfielder)!.element_type,
    )!;

    const plan = planWith({
      '1': { transfers: [], swaps: [[lineup.indexOf(starter), lineup.indexOf(benchOutfielder)]] },
    });
    const [gw1] = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 0 }, plan, players, 3);

    const after = gw1.squad.map((s) => s.element);
    expect(startersOf(after)).toContain(benchOutfielder);
    expect(benchOf(after)).toContain(starter);
    expect(lineupErrors(after, players)).toEqual([]);
  });

  it('carries the new lineup into later weeks', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    const squad = draftToSlots(lineup, players);
    const benched = benchOf(lineup).find((el) => players.get(el)!.element_type !== 1)!;
    const starter = startersOf(lineup).find(
      (el) => players.get(el)!.element_type === players.get(benched)!.element_type,
    )!;

    const plan = planWith({
      '1': { transfers: [], swaps: [[lineup.indexOf(starter), lineup.indexOf(benched)]] },
    });
    const states = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 0 }, plan, players, 3);
    // FPL keeps a lineup change until you change it again.
    for (const st of states) {
      expect(startersOf(st.squad.map((s) => s.element))).toContain(benched);
    }
  });

  it('is not a transfer: no hit and no free transfer consumed', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    const squad = draftToSlots(lineup, players);
    const plan = planWith({ '1': { transfers: [], swaps: [[0, 11]] } });
    const [gw1, gw2] = foldPlan({ squad, bank: 0, freeTransfers: 1, baseGw: 0 }, plan, players, 2);
    expect(gw1.used).toBe(0);
    expect(gw1.hits).toBe(0);
    expect(gw2.freeTransfers).toBe(2); // accrued as normal
  });

  it('applies subs after transfers, so a swapped slot holds the incoming player', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    const squad = draftToSlots(lineup, players);
    // Replace a benched outfielder, then start whoever now holds that slot.
    const benched = benchOf(lineup).find((el) => players.get(el)!.element_type !== 1)!;
    const type = players.get(benched)!.element_type;
    players.set(30, { id: 30, web_name: 'NEW', team: 90, element_type: type, now_cost: 45 });
    const starter = startersOf(lineup).find((el) => players.get(el)!.element_type === type)!;

    const plan = planWith({
      '1': {
        transfers: [{ out: benched, in: 30 }],
        swaps: [[lineup.indexOf(starter), lineup.indexOf(benched)]],
      },
    });
    const [gw1] = foldPlan({ squad, bank: 100, freeTransfers: 1, baseGw: 0 }, plan, players, 2);
    expect(startersOf(gw1.squad.map((s) => s.element))).toContain(30);
  });
});

// ---- free-transfer derivation -------------------------------------------

describe('deriveFreeTransfers', () => {
  const noChips = new Map<number, string>();
  const rows = (spec: [number, number][]) =>
    spec.map(([event, event_transfers]) => ({ event, event_transfers }));

  it('gives exactly one free transfer entering GW2 after a quiet GW1', () => {
    // Squad selection before the GW1 deadline is not a transfer, so nothing
    // banks on top of the first free transfer.
    const d = deriveFreeTransfers(rows([[1, 0]]), noChips, 1);
    expect(d.freeTransfers).toBe(1);
  });

  it('banks an unused transfer, so GW3 opens with two', () => {
    const d = deriveFreeTransfers(rows([[1, 0], [2, 0]]), noChips, 2);
    expect(d.freeTransfers).toBe(2);
  });

  it('spends the bank when transfers are made', () => {
    const d = deriveFreeTransfers(rows([[1, 0], [2, 1], [3, 0]]), noChips, 3);
    // GW2 opens with 1, one used → GW3 opens with 1, unused → GW4 opens with 2.
    expect(d.freeTransfers).toBe(2);
  });

  it('caps the bank at five', () => {
    const quiet = Array.from({ length: 12 }, (_, i) => [i + 1, 0] as [number, number]);
    expect(deriveFreeTransfers(rows(quiet), noChips, 12).freeTransfers).toBe(MAX_FREE_TRANSFERS);
  });

  it('ignores transfers made on a wildcard week', () => {
    const chips = new Map([[3, 'wildcard']]);
    const d = deriveFreeTransfers(rows([[1, 0], [2, 0], [3, 8]]), chips, 3);
    // The eight wildcard moves are free, so the bank still accrues normally.
    expect(d.freeTransfers).toBe(3);
  });

  it('ignores gameweeks beyond the current one', () => {
    const d = deriveFreeTransfers(rows([[1, 0], [2, 0], [9, 5]]), noChips, 2);
    expect(d.transfersByGw).toEqual({ 1: 0, 2: 0 });
    expect(d.freeTransfers).toBe(2);
  });

  it('loses confidence when a hit is recorded with no transfers', () => {
    const odd = [{ event: 1, event_transfers: 0 }, { event: 2, event_transfers: 0, event_transfers_cost: 4 }];
    expect(deriveFreeTransfers(odd, noChips, 2).confident).toBe(false);
  });
});

// ---- draft helpers -------------------------------------------------------

describe('draftToSlots', () => {
  it('prices a pre-season buy at the current price for both purchase and sale', () => {
    const { order, players } = draftPool();
    const slots = draftToSlots(order, players);
    expect(slots).toHaveLength(15);
    for (const slot of slots) {
      const cost = players.get(slot.element)!.now_cost;
      expect(slot.purchasePrice).toBe(cost);
      expect(slot.sellingPrice).toBe(cost);
    }
  });

  it('preserves lineup order', () => {
    const { order, players } = draftPool();
    const lineup = defaultLineup(order, players);
    expect(draftToSlots(lineup, players).map((s) => s.element)).toEqual(lineup);
  });
});

describe('draftSpend', () => {
  it('totals the current prices of the drafted players', () => {
    const { order, players } = draftPool();
    const expected = order.reduce((sum, el) => sum + players.get(el)!.now_cost, 0);
    expect(draftSpend(order, players)).toBe(expected);
    expect(draftSpend([], players)).toBe(0);
  });
});

describe('maxAffordable', () => {
  it('reserves the cheapest option for every slot still to fill', () => {
    const players = makePlayers([
      [1, 1, 1, 55], // GKP
      [2, 1, 2, 40], // GKP, cheapest keeper
      [3, 2, 3, 60], // DEF
      [4, 2, 4, 40], // DEF, cheapest defender
    ]);
    const all = [...players.values()];

    // Nothing picked, buying a keeper: budget minus one more keeper (40) and
    // both defenders' cheapest (40 x 2)... quotas are 2 GK / 5 DEF / 5 MID /
    // 3 FWD, and with no MIDs or FWDs in the pool those reserve 0 each.
    const cap = maxAffordable([], 1, players, INITIAL_BUDGET, all);
    expect(cap).toBe(INITIAL_BUDGET - (1 * 40 + 5 * 40));
  });

  it('shrinks as the budget is spent', () => {
    const { order, players } = draftPool();
    const all = [...players.values()];
    const empty = maxAffordable([], 3, players, INITIAL_BUDGET, all);
    const spent = maxAffordable(order.slice(0, 6), 3, players, INITIAL_BUDGET, all);
    expect(spent).toBeLessThan(empty);
  });

  it('never reserves for a position that is already full', () => {
    const players = makePlayers([
      [1, 1, 1, 50],
      [2, 1, 2, 50],
      [3, 3, 3, 90],
    ]);
    const all = [...players.values()];
    // Both keeper slots filled, so buying a MID reserves nothing for GKP.
    const cap = maxAffordable([1, 2], 3, players, INITIAL_BUDGET, all);
    // Spend so far 100; 4 MID slots left reserve the cheapest MID (90) each.
    expect(cap).toBe(INITIAL_BUDGET - 100 - 4 * 90);
  });
});
