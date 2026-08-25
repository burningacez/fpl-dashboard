import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Set & Forget scores everyone's GW1 squad against every completed gameweek.
 * The invariant that anchors these tests: over GW1 alone the SAF total must
 * equal the actual total for every manager, because the GW1 squad IS the team
 * they played. Any non-zero difference one week into the season is a bug.
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
const GW1: Record<number, { total_points: number; minutes: number; bonus: number }> = {
  1: { total_points: 6, minutes: 90, bonus: 1 },
  2: { total_points: 3, minutes: 90, bonus: 0 },
  3: { total_points: 8, minutes: 90, bonus: 2 },
  4: { total_points: 2, minutes: 90, bonus: 0 },
  5: { total_points: 5, minutes: 90, bonus: 0 },
  6: { total_points: 1, minutes: 90, bonus: 0 },
  7: { total_points: 4, minutes: 90, bonus: 0 },
  8: { total_points: 9, minutes: 90, bonus: 3 },
  9: { total_points: 0, minutes: 0, bonus: 0 },   // blanked
  10: { total_points: 7, minutes: 90, bonus: 0 },
  11: { total_points: 2, minutes: 75, bonus: 0 },
  12: { total_points: 6, minutes: 90, bonus: 0 },
  13: { total_points: 12, minutes: 90, bonus: 3 },
  14: { total_points: 0, minutes: 0, bonus: 0 },  // blanked
  15: { total_points: 5, minutes: 90, bonus: 0 },
};

const LIVE_BY_GW: Record<number, any> = {
  1: { elements: ELEMENTS.map((e) => ({ id: e.id, stats: GW1[e.id] })) },
  2: { elements: ELEMENTS.map((e) => ({ id: e.id, stats: { total_points: 2, minutes: 90, bonus: 0 } })) },
};

// Mutable per-test state, read through getters by the mocked client.
const state = {
  completedGWs: [1] as number[],
  managers: [] as any[],
  picks: {} as Record<string, any>,
  histories: null as any[] | null,
};

function pick(element: number, position: number, c = false, vc = false) {
  return {
    element,
    position,
    is_captain: c,
    is_vice_captain: vc,
    // FPL rewrites this to the post-auto-sub state for a completed GW; the
    // scoring core deliberately ignores it and derives from is_captain.
    multiplier: c ? 2 : position <= 11 ? 1 : 0,
  };
}

/**
 * 1 GKP / 4 DEF / 4 MID / 2 FWD. Bench in FPL order: sub GK, then 7, 9, 14.
 * Captain 13 (played), vice 15 (played). Nobody in the XI blanks, so GW1
 * needs no auto-sub and no armband transfer.
 */
function cleanSquad() {
  return {
    active_chip: null,
    entry_history: { points: 0, event_transfers_cost: 0 },
    picks: [
      pick(1, 1), pick(3, 2), pick(4, 3), pick(5, 4), pick(6, 5),
      pick(8, 6), pick(10, 7), pick(11, 8), pick(12, 9),
      pick(13, 10, true), pick(15, 11, false, true),
      pick(2, 12), pick(7, 13), pick(9, 14), pick(14, 15),
    ],
  };
}
// 6 + 8+2+5+1 + 9+7+2+6 + 12*2 + 5
const CLEAN_XI = 75;
const CLEAN_BENCH = 3 + 4 + 0 + 0; // 7

/** Starting MID 9 blanks; first eligible bench outfielder (7, DEF) comes on. */
function autoSubSquad() {
  return {
    active_chip: null,
    entry_history: { points: 0, event_transfers_cost: 0 },
    picks: [
      pick(1, 1), pick(3, 2), pick(4, 3), pick(5, 4),
      pick(8, 5), pick(9, 6), pick(10, 7), pick(12, 8),
      pick(13, 9, true), pick(15, 10), pick(6, 11),
      pick(2, 12), pick(7, 13), pick(11, 14), pick(14, 15),
    ],
  };
}
// 6 + 8+2+5+1 + 9+7+6 + 12*2 + 5 + 4 (sub 7 in for 9)
const AUTOSUB_XI = 77;

/** Captain 14 blanks; vice 13 played, so the armband must pass to 13. */
function viceCaptainSquad() {
  return {
    active_chip: null,
    entry_history: { points: 0, event_transfers_cost: 0 },
    picks: [
      pick(1, 1), pick(3, 2), pick(4, 3), pick(5, 4),
      pick(8, 5), pick(10, 6), pick(11, 7), pick(12, 8),
      pick(14, 9, true), pick(13, 10, false, true), pick(15, 11),
      pick(2, 12), pick(6, 13), pick(7, 14), pick(9, 15),
    ],
  };
}
// 6 + 8+2+5 + 9+7+2+6 + 13 doubled (24) + 5 + 1 (sub 6 in for 14)
const VICE_XI = 75;

function history(entryId: number, gameweeks: any[], chips: any[] = []) {
  return { entryId, gameweeks, chips };
}
function gwRow(event: number, points: number, transfersCost = 0) {
  return { event, points, event_transfers_cost: transfersCost };
}

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
    if (!p) throw new Error('no picks');
    return p;
  }),
  fetchManagerHistory: vi.fn(async (entry: number) => {
    const h = (state.histories || []).find((x) => x.entryId === entry);
    if (!h) throw new Error('no history');
    return { current: h.gameweeks, chips: h.chips, past: [] };
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
  state.histories = null;
});

function byName(res: any) {
  return Object.fromEntries(res.managers.map((m: any) => [m.name, m]));
}

describe('Set & Forget — GW1 only', () => {
  it('shows a zero difference for every manager, whatever their GW1 needed', async () => {
    state.picks['101-1'] = cleanSquad();
    state.picks['102-1'] = autoSubSquad();
    state.picks['103-1'] = viceCaptainSquad();
    state.managers = [
      { entry: 101, player_name: 'clean', entry_name: 'x', rank: 1, total: CLEAN_XI },
      { entry: 102, player_name: 'autosub', entry_name: 'x', rank: 2, total: AUTOSUB_XI },
      { entry: 103, player_name: 'vice', entry_name: 'x', rank: 3, total: VICE_XI },
    ];
    const histories = [
      history(101, [gwRow(1, CLEAN_XI)]),
      history(102, [gwRow(1, AUTOSUB_XI)]),
      history(103, [gwRow(1, VICE_XI)]),
    ];

    const res: any = await calculateSetAndForgetData(histories);
    const rows = byName(res);

    // Auto-subs applied: the blanked starter is replaced by the first eligible
    // bench outfielder that keeps a legal formation.
    expect(rows.autosub.safTotal).toBe(AUTOSUB_XI);
    // Armband passes to the vice-captain when the captain doesn't play.
    expect(rows.vice.safTotal).toBe(VICE_XI);
    for (const name of ['clean', 'autosub', 'vice']) {
      expect(rows[name].difference, `${name} diff`).toBe(0);
    }
  });

  it('honours a Bench Boost or Triple Captain played in GW1', async () => {
    state.picks['201-1'] = cleanSquad();
    state.picks['202-1'] = { ...cleanSquad(), active_chip: 'bboost' };
    state.picks['203-1'] = { ...cleanSquad(), active_chip: '3xc' };
    const bboostTotal = CLEAN_XI + CLEAN_BENCH;
    const tcTotal = CLEAN_XI + 12; // captain 13 goes from x2 to x3
    state.managers = [
      { entry: 201, player_name: 'none', entry_name: 'x', rank: 1, total: CLEAN_XI },
      { entry: 202, player_name: 'bboost', entry_name: 'x', rank: 2, total: bboostTotal },
      { entry: 203, player_name: '3xc', entry_name: 'x', rank: 3, total: tcTotal },
    ];
    const histories = [
      history(201, [gwRow(1, CLEAN_XI)]),
      history(202, [gwRow(1, bboostTotal)], [{ name: 'bboost', event: 1 }]),
      history(203, [gwRow(1, tcTotal)], [{ name: '3xc', event: 1 }]),
    ];

    const res: any = await calculateSetAndForgetData(histories);
    const rows = byName(res);

    expect(rows.bboost.safTotal).toBe(bboostTotal);
    expect(rows['3xc'].safTotal).toBe(tcTotal);
    for (const name of ['none', 'bboost', '3xc']) {
      expect(rows[name].difference, `${name} diff`).toBe(0);
    }
  });

  it('ignores chips that only buy transfers', async () => {
    // A wildcard or free hit changes nothing about what a fixed squad scores,
    // so it must not shift the baseline.
    state.picks['301-1'] = cleanSquad();
    state.managers = [{ entry: 301, player_name: 'wc', entry_name: 'x', rank: 1, total: CLEAN_XI }];
    const histories = [history(301, [gwRow(1, CLEAN_XI)], [{ name: 'wildcard', event: 1 }])];

    const res: any = await calculateSetAndForgetData(histories);
    expect(res.managers[0].safTotal).toBe(CLEAN_XI);
    expect(res.managers[0].difference).toBe(0);
  });
});

describe('Set & Forget — the actual side matches the scored gameweeks', () => {
  it('ignores a gameweek FPL has counted but that is not yet complete here', async () => {
    // GW2 is played and in the manager's season total, but completedGWs still
    // holds only GW1 (bonus unconfirmed, or a fixture not yet provisional).
    // Charging that whole gameweek to tinkering was the week-one discrepancy.
    state.completedGWs = [1];
    state.picks['401-1'] = cleanSquad();
    state.managers = [
      { entry: 401, player_name: 'solo', entry_name: 'x', rank: 1, total: CLEAN_XI + 60 },
    ];
    const histories = [history(401, [gwRow(1, CLEAN_XI), gwRow(2, 60)])];

    const res: any = await calculateSetAndForgetData(histories);
    expect(res.managers[0].actualTotal).toBe(CLEAN_XI);
    expect(res.managers[0].difference).toBe(0);
  });

  it('charges transfer hits to the tinkerer', async () => {
    // Over GW1+GW2 the squad is unchanged, so the only difference is the hit
    // a set-and-forget manager would never have taken.
    state.completedGWs = [1, 2];
    state.picks['501-1'] = cleanSquad();
    // Every player scores 2 in GW2: XI = 11 x 2, captain doubled = 24.
    const gw2Saf = 24;
    state.managers = [
      { entry: 501, player_name: 'hit', entry_name: 'x', rank: 1, total: CLEAN_XI + gw2Saf - 4 },
    ];
    const histories = [history(501, [gwRow(1, CLEAN_XI), gwRow(2, gw2Saf, 4)])];

    const res: any = await calculateSetAndForgetData(histories);
    expect(res.managers[0].safTotal).toBe(CLEAN_XI + gw2Saf);
    expect(res.managers[0].difference).toBe(-4);
  });

  it('reports actual alongside SAF for each gameweek', async () => {
    state.completedGWs = [1, 2];
    state.picks['601-1'] = cleanSquad();
    state.managers = [{ entry: 601, player_name: 'b', entry_name: 'x', rank: 1, total: 0 }];
    const histories = [history(601, [gwRow(1, CLEAN_XI), gwRow(2, 30)])];

    const res: any = await calculateSetAndForgetData(histories);
    expect(res.managers[0].gwBreakdown).toEqual([
      { gw: 1, points: CLEAN_XI, actualPoints: CLEAN_XI, benchPoints: CLEAN_BENCH, chip: null },
      { gw: 2, points: 24, actualPoints: 30, benchPoints: 8, chip: null },
    ]);
  });
});

describe('Set & Forget — incomplete source data', () => {
  it('fetches histories itself when the caller has none', async () => {
    state.picks['701-1'] = cleanSquad();
    state.managers = [{ entry: 701, player_name: 'solo', entry_name: 'x', rank: 1, total: CLEAN_XI }];
    state.histories = [history(701, [gwRow(1, CLEAN_XI)])];

    const res: any = await calculateSetAndForgetData();
    expect(res.managers[0].difference).toBe(0);
  });

  it('keeps the previous snapshot when no history can be fetched at all', async () => {
    state.picks['801-1'] = cleanSquad();
    state.managers = [{ entry: 801, player_name: 'solo', entry_name: 'x', rank: 1, total: CLEAN_XI }];
    state.histories = []; // fetchManagerHistory throws for everyone

    // Publishing here would render as "no data yet" and wipe a good snapshot.
    expect(await calculateSetAndForgetData()).toBeNull();
  });

  it('still builds a table when only one manager\'s history is missing', async () => {
    state.picks['811-1'] = cleanSquad();
    state.picks['812-1'] = cleanSquad();
    state.managers = [
      { entry: 811, player_name: 'ok', entry_name: 'x', rank: 1, total: CLEAN_XI },
      { entry: 812, player_name: 'broken', entry_name: 'x', rank: 2, total: CLEAN_XI },
    ];
    state.histories = [history(811, [gwRow(1, CLEAN_XI)])];

    const res: any = await calculateSetAndForgetData();
    expect(res.managers.map((m: any) => m.name)).toEqual(['ok']);
    expect(res.managers[0].difference).toBe(0);
  });

  it('skips a manager whose history does not cover every completed gameweek', async () => {
    // A late joiner: real GW1 picks are unavailable for them anyway, but guard
    // the case where picks exist and the history is short.
    state.completedGWs = [1, 2];
    state.picks['901-1'] = cleanSquad();
    state.picks['902-1'] = cleanSquad();
    state.managers = [
      { entry: 901, player_name: 'full', entry_name: 'x', rank: 1, total: 0 },
      { entry: 902, player_name: 'partial', entry_name: 'x', rank: 2, total: 0 },
    ];
    const histories = [
      history(901, [gwRow(1, CLEAN_XI), gwRow(2, 24)]),
      history(902, [gwRow(2, 24)]),
    ];

    const res: any = await calculateSetAndForgetData(histories);
    expect(res.managers.map((m: any) => m.name)).toEqual(['full']);
  });
});
