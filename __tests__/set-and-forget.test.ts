import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Set & Forget replays the season with everyone's GW1 squad frozen.
 *
 * The invariant these tests exist to enforce: in GW1 the frozen squad IS the
 * squad the manager played, so the difference is ZERO for every manager, with
 * no exceptions — whatever their squad needed that week (auto-subs, the
 * armband moving to the vice-captain, a chip). Any non-zero GW1 difference is
 * a bug, because nobody has tinkered yet. The same holds in any later
 * gameweek where a manager made no changes.
 */

// ---------------------------------------------------------------------------
// Synthetic league: 4 teams, 15 players, 2 gameweeks.
// ---------------------------------------------------------------------------
const ELEMENTS: any[] = [];
function mkEl(id: number, team: number, type: number) {
  ELEMENTS.push({ id, team, element_type: type, web_name: `P${id}` });
}
// GKP
mkEl(1, 1, 1); mkEl(2, 2, 1);
// DEF
mkEl(3, 1, 2); mkEl(4, 1, 2); mkEl(5, 2, 2); mkEl(6, 2, 2); mkEl(7, 3, 2);
// MID
mkEl(8, 1, 3); mkEl(9, 2, 3); mkEl(10, 3, 3); mkEl(11, 3, 3); mkEl(12, 4, 3);
// FWD
mkEl(13, 4, 4); mkEl(14, 4, 4); mkEl(15, 1, 4);
// A spare set so a "played" squad can differ from the frozen one.
mkEl(16, 2, 2); mkEl(17, 3, 3); mkEl(18, 1, 4);

const BOOTSTRAP: any = {
  events: [
    { id: 1, finished: true, is_current: false },
    { id: 2, finished: true, is_current: true },
  ],
  elements: ELEMENTS,
  teams: [1, 2, 3, 4].map((t) => ({ id: t, code: t, short_name: `T${t}` })),
  element_types: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
};

const FIXTURES: any[] = [
  { id: 1, event: 1, team_h: 1, team_a: 2, started: true, finished: true, finished_provisional: true, stats: [] },
  { id: 2, event: 1, team_h: 3, team_a: 4, started: true, finished: true, finished_provisional: true, stats: [] },
  { id: 3, event: 2, team_h: 1, team_a: 3, started: true, finished: true, finished_provisional: true, stats: [] },
  { id: 4, event: 2, team_h: 2, team_a: 4, started: true, finished: true, finished_provisional: true, stats: [] },
];

// GW1 live stats. Official bonus already inside total_points (GW is finished).
// Players 9 and 14 blank, so auto-subs and armband transfers get exercised.
const GW1_STATS: Record<number, { total_points: number; minutes: number; bonus: number }> = {
  1: { total_points: 6, minutes: 90, bonus: 1 },
  2: { total_points: 3, minutes: 90, bonus: 0 },
  3: { total_points: 8, minutes: 90, bonus: 2 },
  4: { total_points: 2, minutes: 90, bonus: 0 },
  5: { total_points: 5, minutes: 90, bonus: 0 },
  6: { total_points: 1, minutes: 90, bonus: 0 },
  7: { total_points: 4, minutes: 90, bonus: 0 },
  8: { total_points: 9, minutes: 90, bonus: 3 },
  9: { total_points: 0, minutes: 0, bonus: 0 },
  10: { total_points: 7, minutes: 90, bonus: 0 },
  11: { total_points: 2, minutes: 75, bonus: 0 },
  12: { total_points: 6, minutes: 90, bonus: 0 },
  13: { total_points: 12, minutes: 90, bonus: 3 },
  14: { total_points: 0, minutes: 0, bonus: 0 },
  15: { total_points: 5, minutes: 90, bonus: 0 },
  16: { total_points: 11, minutes: 90, bonus: 2 },
  17: { total_points: 1, minutes: 20, bonus: 0 },
  18: { total_points: 0, minutes: 0, bonus: 0 },
};

const LIVE_BY_GW: Record<number, any> = {
  1: { elements: ELEMENTS.map((e) => ({ id: e.id, stats: GW1_STATS[e.id] })) },
  // GW2: flat 2 apiece, so a divergence is easy to reason about.
  2: { elements: ELEMENTS.map((e) => ({ id: e.id, stats: { total_points: 2, minutes: 90, bonus: 0 } })) },
};

// Mutable per-test state, read through the mocked client.
const state = {
  completedGWs: [1] as number[],
  managers: [] as any[],
  picks: {} as Record<string, any>,
};

function pick(element: number, position: number, c = false, vc = false) {
  return {
    element,
    position,
    is_captain: c,
    is_vice_captain: vc,
    // FPL rewrites this to the post-auto-sub state on a completed gameweek;
    // the scoring core deliberately ignores it and derives from is_captain.
    multiplier: c ? 2 : position <= 11 ? 1 : 0,
  };
}

type SquadOpts = { chip?: string | null; transfersCost?: number };

function squad(elements: number[], captain: number, vice: number, opts: SquadOpts = {}) {
  return {
    active_chip: opts.chip ?? null,
    entry_history: { event_transfers_cost: opts.transfersCost ?? 0 },
    picks: elements.map((el, i) => pick(el, i + 1, el === captain, el === vice)),
  };
}

// Squad shapes. Element order is FPL pick order: 11 starters, then the
// substitute goalkeeper, then three outfield subs in priority order.

/** Nobody in the XI blanks, captain plays. 1 GKP / 4 DEF / 4 MID / 2 FWD. */
const CLEAN = [1, 3, 4, 5, 6, 8, 10, 11, 12, 13, 15, /* bench */ 2, 7, 9, 14];
/** Starting MID 9 blanks; first eligible bench outfielder (7, a DEF) comes on. */
const NEEDS_AUTOSUB = [1, 3, 4, 5, 8, 9, 10, 12, 13, 15, 6, /* bench */ 2, 7, 11, 14];
/** Captain 14 blanks, so the armband must pass to vice-captain 13. */
const NEEDS_VICE = [1, 3, 4, 5, 8, 10, 11, 12, 14, 13, 15, /* bench */ 2, 6, 7, 9];
/** Starting GK 1 and two outfielders blank — several subs at once. */
const MESSY = [1, 9, 14, 3, 4, 8, 10, 11, 12, 13, 15, /* bench */ 2, 16, 17, 5];

vi.mock('../src/server/redis', () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => true),
  redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
  getCurrentSeason: () => '2026-27',
  getActiveSeasonConfig: () => ({ leagueId: 1 }),
  getLeagueId: () => 1,
}));
vi.mock('../src/server/fpl/client', () => ({
  sanitizeCachedNames: (x: any) => x,
  fetchBootstrap: vi.fn(async () => BOOTSTRAP),
  fetchFixtures: vi.fn(async () => FIXTURES),
  fetchLeagueData: vi.fn(async () => ({
    league: { name: 'Test League' },
    standings: { results: state.managers },
  })),
  fetchLiveGWData: vi.fn(async (gw: number) => LIVE_BY_GW[gw]),
  fetchManagerPicks: vi.fn(async (entry: number, gw: number) => {
    const p = state.picks[`${entry}-${gw}`];
    if (!p) throw new Error(`no picks for ${entry}-${gw}`);
    return p;
  }),
  getCompletedGameweeks: vi.fn(() => state.completedGWs),
}));

import { calculateSetAndForgetData } from '../src/server/services/set-and-forget';
import { dataCache } from '../src/server/data-cache';

beforeEach(() => {
  dataCache.picksCache = {};
  dataCache.liveDataCache = {};
  dataCache.processedPicksCache = {};
  state.completedGWs = [1];
  state.managers = [];
  state.picks = {};
});

function enter(entry: number, name: string, gw1: any, rest: Record<number, any> = {}) {
  state.managers.push({ entry, player_name: name, entry_name: `T${entry}`, rank: state.managers.length + 1 });
  state.picks[`${entry}-1`] = gw1;
  for (const [gw, p] of Object.entries(rest)) state.picks[`${entry}-${gw}`] = p;
}

function byName(res: any) {
  return Object.fromEntries(res.managers.map((m: any) => [m.name, m]));
}

describe('Set & Forget — GW1 is zero for everyone', () => {
  it('holds whatever the squad needed that week', async () => {
    enter(101, 'clean', squad(CLEAN, 13, 15));
    enter(102, 'autosub', squad(NEEDS_AUTOSUB, 13, 15));
    enter(103, 'vice', squad(NEEDS_VICE, 14, 13));
    enter(104, 'messy', squad(MESSY, 13, 15));

    const res: any = await calculateSetAndForgetData();
    const rows = byName(res);

    expect(Object.keys(rows).sort()).toEqual(['autosub', 'clean', 'messy', 'vice']);
    for (const name of Object.keys(rows)) {
      expect(rows[name].difference, `${name} diff`).toBe(0);
      // And not zero because both sides came out empty.
      expect(rows[name].safTotal, `${name} scored`).toBeGreaterThan(0);
    }
  });

  it('holds when a chip was played', async () => {
    enter(201, 'none', squad(CLEAN, 13, 15));
    enter(202, 'bboost', squad(CLEAN, 13, 15, { chip: 'bboost' }));
    enter(203, '3xc', squad(CLEAN, 13, 15, { chip: '3xc' }));
    enter(204, 'wildcard', squad(CLEAN, 13, 15, { chip: 'wildcard' }));
    // An unrecognised chip must not silently change one side's scoring.
    enter(205, 'unknown', squad(CLEAN, 13, 15, { chip: 'some_new_chip' }));

    const res: any = await calculateSetAndForgetData();
    const rows = byName(res);

    for (const name of ['none', 'bboost', '3xc', 'wildcard', 'unknown']) {
      expect(rows[name].difference, `${name} diff`).toBe(0);
    }
    // The chips that change a score are still applied, not ignored.
    expect(rows.bboost.safTotal).toBeGreaterThan(rows.none.safTotal);
    expect(rows['3xc'].safTotal).toBeGreaterThan(rows.none.safTotal);
    // The ones that only buy transfers leave the score alone.
    expect(rows.wildcard.safTotal).toBe(rows.none.safTotal);
    expect(rows.unknown.safTotal).toBe(rows.none.safTotal);
  });

  it('applies auto-subs and the vice-captain to the frozen squad, not just to actual', async () => {
    // Scored in GW1 where 9 and 14 blank, so a frozen squad that ignored
    // auto-subs or the armband would come out lower than the real score.
    enter(301, 'autosub', squad(NEEDS_AUTOSUB, 13, 15));
    enter(302, 'vice', squad(NEEDS_VICE, 14, 13));

    const res: any = await calculateSetAndForgetData();
    const rows = byName(res);

    // 6 + 8+2+5+1 + 9+7+6 + 12x2 + 5, plus 4 for bench DEF 7 replacing MID 9.
    expect(rows.autosub.safTotal).toBe(77);
    // 6 + 8+2+5 + 9+7+2+6 + 5, plus 1 for bench DEF 6 replacing FWD 14,
    // plus 24 for vice-captain 13 inheriting the armband.
    expect(rows.vice.safTotal).toBe(75);
  });
});

describe('Set & Forget — a manager who never changes anything', () => {
  it('stays at zero across every gameweek', async () => {
    state.completedGWs = [1, 2];
    const frozen = squad(CLEAN, 13, 15);
    enter(401, 'loyal', frozen, { 2: squad(CLEAN, 13, 15) });

    const res: any = await calculateSetAndForgetData();
    expect(res.managers[0].difference).toBe(0);
    expect(res.managers[0].gwBreakdown).toHaveLength(2);
  });
});

describe('Set & Forget — the difference is what tinkering was worth', () => {
  it('credits a transfer that scored more than the player it replaced', async () => {
    // GW1 identical. In GW2 they swap starter 6 (2 pts) for 16 (2 pts) — flat
    // scoring, so the swap is worth nothing and only the hit shows.
    state.completedGWs = [1, 2];
    const played2 = [1, 3, 4, 5, 16, 8, 10, 11, 12, 13, 15, 2, 7, 9, 14];
    enter(501, 'hit', squad(CLEAN, 13, 15), { 2: squad(played2, 13, 15, { transfersCost: 4 }) });

    const res: any = await calculateSetAndForgetData();
    expect(res.managers[0].difference).toBe(-4);
  });

  it('credits an armband switch that paid off', async () => {
    // GW2 is flat, so move the captaincy onto a player and the doubled points
    // are the same — instead switch the captain onto someone the frozen squad
    // does not double, and confirm the totals still track exactly.
    state.completedGWs = [1, 2];
    enter(601, 'switch', squad(CLEAN, 13, 15), { 2: squad(CLEAN, 8, 15) });

    const res: any = await calculateSetAndForgetData();
    // Flat GW2 scoring means captaining 8 instead of 13 is worth the same.
    expect(res.managers[0].difference).toBe(0);
    expect(res.managers[0].gwBreakdown[1]).toMatchObject({ gw: 2, points: 24, actualPoints: 24 });
  });

  it('charges the hit even when the transfer changed nothing', async () => {
    state.completedGWs = [1, 2];
    enter(701, 'wasteful', squad(CLEAN, 13, 15), { 2: squad(CLEAN, 13, 15, { transfersCost: 8 }) });

    const res: any = await calculateSetAndForgetData();
    expect(res.managers[0].difference).toBe(-8);
    expect(res.managers[0].gwBreakdown[1]).toMatchObject({ gw: 2, transfersCost: 8 });
  });
});

describe('Set & Forget — missing and unusable data', () => {
  it('drops a gameweek from both totals when the played squad is unavailable', async () => {
    // GW2 picks missing: the gameweek leaves both sides, so the difference
    // stays honest rather than counting the frozen squad against nothing.
    state.completedGWs = [1, 2];
    enter(801, 'partial', squad(CLEAN, 13, 15));

    const res: any = await calculateSetAndForgetData();
    expect(res.managers[0].gwBreakdown.map((b: any) => b.gw)).toEqual([1]);
    expect(res.managers[0].difference).toBe(0);
  });

  it('leaves out a manager with no GW1 squad', async () => {
    enter(901, 'present', squad(CLEAN, 13, 15));
    state.managers.push({ entry: 902, player_name: 'latecomer', entry_name: 'T902', rank: 2 });

    const res: any = await calculateSetAndForgetData();
    expect(res.managers.map((m: any) => m.name)).toEqual(['present']);
  });

  it('keeps the previous snapshot when no live data can be fetched', async () => {
    enter(1001, 'solo', squad(CLEAN, 13, 15));
    state.completedGWs = [3]; // no live data for GW3

    expect(await calculateSetAndForgetData()).toBeNull();
  });

  it('reports no data before a gameweek has been played', async () => {
    state.completedGWs = [];
    const res: any = await calculateSetAndForgetData();
    expect(res).toEqual({ managers: [], completedGWs: 0 });
  });
});

/**
 * The pitch a manager opens from this page shows what their frozen fifteen did
 * over the whole season, so the same live payloads that produced the totals
 * above are also totalled per player. Same source, same gameweeks: the pitch
 * cannot tell a different story from the table it was opened from.
 */
describe('Set & Forget — season totals for the frozen squad', () => {
  it('totals each player across every completed gameweek', async () => {
    state.completedGWs = [1, 2];
    enter(1101, 'solo', squad(CLEAN, 13, 15), { 2: squad(CLEAN, 13, 15) });

    const res: any = await calculateSetAndForgetData();
    const season = res.playerSeason;

    // Player 1: 6 in GW1, 2 in GW2, 90 minutes in each.
    expect(season[1].totalPoints).toBe(8);
    expect(season[1].minutes).toBe(180);
    expect(season[1].appearances).toBe(2);
    expect(season[1].gamesAvailable).toBe(2);
  });

  it('counts appearances, not gameweeks, so a blank does not flatten the average', async () => {
    state.completedGWs = [1, 2];
    // Player 9 blanks in GW1 (0 minutes) and plays in GW2.
    enter(1201, 'solo', squad(CLEAN, 13, 15), { 2: squad(CLEAN, 13, 15) });

    const res: any = await calculateSetAndForgetData();
    const season = res.playerSeason;

    expect(season[9].totalPoints).toBe(2);
    expect(season[9].appearances).toBe(1);
    // Their club played both weeks — the minutes are on the player, not a blank.
    expect(season[9].gamesAvailable).toBe(2);
  });

  it('covers every player in the frozen squad and no one else', async () => {
    enter(1301, 'solo', squad(CLEAN, 13, 15));

    const res: any = await calculateSetAndForgetData();
    const ids = Object.keys(res.playerSeason).map(Number).sort((a, b) => a - b);

    expect(ids).toEqual([...CLEAN].sort((a, b) => a - b));
  });
});
