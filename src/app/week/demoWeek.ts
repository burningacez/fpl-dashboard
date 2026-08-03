/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Scores walkthrough.
 *
 * WHY THIS EXISTS. The walkthrough's whole job is onboarding, and onboarding
 * happens pre-season — before GW1 there are no scores, no fixtures in the
 * strip, no live events and an empty table, so a tour running on real data can
 * only show a handful of its steps at exactly the moment it matters most. So
 * the tour runs against a frozen example league instead, and every step has
 * something to point at all year round.
 *
 * WHAT THIS IS NOT. Not a second copy of the Scores page. The real page renders
 * the real components with this payload swapped in for the duration of the run,
 * then drops back to live data — so there is one implementation to maintain and
 * the walkthrough can't drift away from the interface it is describing.
 *
 * Loaded with a dynamic import so this never lands in the /week bundle for the
 * (vast majority of) page loads that don't run a tour.
 *
 * THE MAINTENANCE COST, stated plainly: this payload mirrors the shape of
 * /api/week and four other endpoints, and nothing type-checks that (the page
 * reads them as `any`). If those shapes change, this goes stale silently and
 * the tour starts describing a broken page. `npm run test:tour` walks every
 * step against this data and is the thing that catches it — run it when you
 * touch the week service.
 */

/** A fake manager's slot in the demo table. Rank 2 is handed to the real user. */
const YOU_SLOT = 1;

const PLAYERS: Record<number, [name: string, teamId: number, positionId: number]> = {
  1: ['Salah', 11, 3], 2: ['Haaland', 13, 4], 3: ['Palmer', 3, 3], 4: ['Saka', 1, 3],
  5: ['Raya', 1, 1], 6: ['Gabriel', 1, 2], 7: ['Van Dijk', 11, 2], 8: ['Trippier', 14, 2],
  9: ['Foden', 13, 3], 10: ['Watkins', 2, 4], 11: ['Isak', 14, 4], 12: ['Sels', 15, 1],
  13: ['Konsa', 2, 2], 14: ['Mbeumo', 4, 3], 15: ['Wood', 15, 4],
};

const POSITIONS = ['', 'GKP', 'DEF', 'MID', 'FWD'];

export const DEMO_PL_TEAMS = [
  { id: 1, name: 'Arsenal', shortName: 'ARS' },
  { id: 2, name: 'Aston Villa', shortName: 'AVL' },
  { id: 3, name: 'Chelsea', shortName: 'CHE' },
  { id: 4, name: 'Brentford', shortName: 'BRE' },
  { id: 11, name: 'Liverpool', shortName: 'LIV' },
  { id: 13, name: 'Man City', shortName: 'MCI' },
  { id: 14, name: 'Newcastle', shortName: 'NEW' },
  { id: 15, name: "Nott'm Forest", shortName: 'NFO' },
];

const DEMO_SQUAD_PLAYERS = Object.fromEntries(
  Object.entries(PLAYERS).map(([id, [name, teamId, positionId]]) => [id, { name, teamId, positionId }]),
);

/**
 * Six managers, deliberately varied so the table's own vocabulary all has
 * something to show: movement arrows both ways and a dash, a transfer hit, an
 * active chip, players-left pills, and a spread of captains.
 */
const DEMO_MANAGERS: any[] = [
  { entryId: 900_001, name: 'Danny Kelly', team: 'Kelly Kong', overallRank: 1, movement: 2, gwScore: 71, transferCost: 0, captainName: 'Salah', viceCaptainName: 'Haaland', benchPoints: 6, overallPoints: 812, teamValue: '101.4', seasonGoals: 34, seasonAssists: 21, activeChip: '3xc', playersLeft: 1, activePlayers: 2, starting11: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], benchPlayerIds: [12, 13, 14, 15], captainId: 1, autoSubsIn: [], autoSubsOut: [] },
  { entryId: 900_002, name: 'Example Manager', team: 'Your Team', overallRank: 2, movement: -1, gwScore: 64, transferCost: 4, captainName: 'Haaland', viceCaptainName: 'Salah', benchPoints: 2, overallPoints: 806, teamValue: '103.1', seasonGoals: 31, seasonAssists: 18, activeChip: null, playersLeft: 3, activePlayers: 1, starting11: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], benchPlayerIds: [12, 13, 14, 15], captainId: 2, autoSubsIn: [15], autoSubsOut: [10] },
  { entryId: 900_003, name: 'Ste Hughes', team: 'Hughes Are Ya', overallRank: 3, movement: 0, gwScore: 58, transferCost: 0, captainName: 'Palmer', viceCaptainName: 'Saka', benchPoints: 9, overallPoints: 790, teamValue: '100.2', seasonGoals: 28, seasonAssists: 22, activeChip: 'bboost', playersLeft: 2, activePlayers: 0, starting11: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], benchPlayerIds: [1, 2, 14, 15], captainId: 3, autoSubsIn: [], autoSubsOut: [] },
  { entryId: 900_004, name: 'Michael Owen', team: 'Owen Me a Favour', overallRank: 4, movement: 1, gwScore: 55, transferCost: 8, captainName: 'Salah', viceCaptainName: 'Palmer', benchPoints: 1, overallPoints: 771, teamValue: '99.8', seasonGoals: 25, seasonAssists: 14, activeChip: null, playersLeft: 0, activePlayers: 3, starting11: [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 14], benchPlayerIds: [2, 4, 13, 15], captainId: 1, autoSubsIn: [], autoSubsOut: [] },
  { entryId: 900_005, name: 'Jonny Doyle', team: 'Doyle Rules', overallRank: 5, movement: -2, gwScore: 49, transferCost: 0, captainName: 'Saka', viceCaptainName: 'Haaland', benchPoints: 12, overallPoints: 754, teamValue: '98.5', seasonGoals: 22, seasonAssists: 17, activeChip: null, playersLeft: 4, activePlayers: 1, starting11: [2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14], benchPlayerIds: [1, 3, 6, 15], captainId: 4, autoSubsIn: [], autoSubsOut: [] },
  { entryId: 900_006, name: 'Tom Rowley', team: 'Rowley Poly', overallRank: 6, movement: 0, gwScore: 41, transferCost: 4, captainName: 'Haaland', viceCaptainName: 'Palmer', benchPoints: 3, overallPoints: 728, teamValue: '97.9', seasonGoals: 19, seasonAssists: 11, activeChip: null, playersLeft: 2, activePlayers: 2, starting11: [1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 15], benchPlayerIds: [3, 7, 11, 14], captainId: 2, autoSubsIn: [], autoSubsOut: [] },
];

/** One in play, one finished, two to come — so the strip shows all three states. */
const DEMO_FIXTURES = [
  { id: 900_501, home: 'LIV', away: 'MCI', homeScore: 2, awayScore: 1, started: true, finished: false, minutes: 67 },
  { id: 900_502, home: 'ARS', away: 'CHE', homeScore: 1, awayScore: 1, started: true, finished: true, minutes: 90 },
  { id: 900_503, home: 'NEW', away: 'AVL', started: false, finished: false, kickoff: demoKickoff(3) },
  { id: 900_504, home: 'BRE', away: 'NFO', started: false, finished: false, kickoff: demoKickoff(27) },
];

/** Kick-offs are relative so the strip never shows a date from years ago. */
function demoKickoff(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

/**
 * Ticker events. The first one (Salah's goal) is what the walkthrough pins, so
 * it deliberately touches four of the six demo managers — enough that the
 * table's dim-and-badge behaviour is obvious.
 */
const DEMO_EVENTS = [
  { type: 'goal', player: 'Salah', elementId: 1, points: 5, icon: '⚽', match: 'LIV v MCI', timestamp: demoKickoff(-0.1) },
  { type: 'bonus_change', icon: '✨', match: 'ARS v CHE', timestamp: demoKickoff(-0.2), changes: [{ elementId: 4, player: 'Saka', impact: 2 }, { elementId: 3, player: 'Palmer', impact: -1 }] },
  { type: 'assist', player: 'Haaland', elementId: 2, points: 3, icon: '👟', match: 'LIV v MCI', timestamp: demoKickoff(-0.4) },
  { type: 'yellow', player: 'Van Dijk', elementId: 7, points: -1, icon: '🟨', match: 'LIV v MCI', timestamp: demoKickoff(-0.6) },
  { type: 'team_clean_sheet_lost', team: 'MCI', icon: '💥', match: 'LIV v MCI', timestamp: demoKickoff(-0.8), affectedPlayers: [{ elementId: 9, points: 0 }] },
  { type: 'saves', player: 'Raya', elementId: 5, points: 1, icon: '🧤', match: 'ARS v CHE', timestamp: demoKickoff(-1.2) },
];

/** The example gameweek the walkthrough narrates. */
export const DEMO_GW = 21;

function demoWeekPayload(leagueName: string): any {
  return {
    leagueName,
    currentGW: DEMO_GW,
    isLive: true,
    managers: DEMO_MANAGERS,
    lastUpdated: new Date().toISOString(),
    // The page reverses chronologicalEvents into newest-first, so hand them
    // over oldest-first exactly as the real service does.
    chronologicalEvents: [...DEMO_EVENTS].reverse(),
    changeEvents: [],
    fixtures: DEMO_FIXTURES,
    nextKickoff: demoKickoff(3),
    squadPlayers: DEMO_SQUAD_PLAYERS,
    plTeams: DEMO_PL_TEAMS,
  };
}

// =============================================================================
// Child-endpoint payloads (the modals fetch these on open)
// =============================================================================

function pitchPlayer(id: number, over: Record<string, unknown> = {}): any {
  const [name, teamId, positionId] = PLAYERS[id];
  return {
    id, element: id, name, web: name, fullName: name,
    positionId, position: POSITIONS[positionId],
    teamId, teamCode: teamId, teamName: DEMO_PL_TEAMS.find((t) => t.id === teamId)?.name ?? '',
    points: 4, totalPoints: 4, multiplier: 1, minutes: 90, provisionalBonus: 0,
    isCaptain: false, isViceCaptain: false, isBench: false, subIn: false, subOut: false,
    events: [], pointsBreakdown: [], allFixturesFinished: true,
    hasDoubleGameweek: false, hasNoGame: false, playStatus: 'played', chanceOfPlaying: 100,
    opponent: 'MCI (H)', fixtureDetails: [],
    ...over,
  };
}

const DEMO_PICKS: any = {
  calculatedPoints: 62, points: 62, totalProvisionalBonus: 6, transfersCost: 4, pointsOnBench: 2,
  autoSubs: [{ in: { name: 'Wood' }, out: { name: 'Watkins' } }],
  players: [
    pitchPlayer(5, { points: 6 }),
    pitchPlayer(6, { points: 7 }), pitchPlayer(7, { points: 2 }), pitchPlayer(8, { points: 5 }),
    pitchPlayer(1, { points: 14 }), pitchPlayer(3, { points: 8 }), pitchPlayer(9, { points: 5 }), pitchPlayer(4, { points: 9 }),
    pitchPlayer(2, { points: 24, multiplier: 2, isCaptain: true }),
    pitchPlayer(11, { points: 6 }), pitchPlayer(15, { points: 3, subIn: true }),
    pitchPlayer(12, { isBench: true, points: 1 }), pitchPlayer(13, { isBench: true, points: 1 }),
    pitchPlayer(14, { isBench: true, points: 0 }),
    pitchPlayer(10, { isBench: true, points: 0, subOut: true }),
  ],
};

function statPlayer(id: number, over: Record<string, unknown> = {}): any {
  const [name, , positionId] = PLAYERS[id];
  return {
    id, name, position: POSITIONS[positionId], points: 4, bps: 12,
    goals: 0, assists: 0, cleanSheet: false, yellowCard: false, redCard: false,
    saves: 0, defcon: 0, provisionalBonus: 0, subbedOn: false, subbedOff: false,
    ...over,
  };
}

const DEMO_FIXTURE_STATS: any = {
  finished: false, finishedProvisional: false,
  home: {
    starters: [
      statPlayer(5, { saves: 3, points: 5 }),
      statPlayer(7, { points: 1, yellowCard: true }),
      statPlayer(1, { goals: 1, points: 9, bps: 34, provisionalBonus: 3 }),
      statPlayer(11, { assists: 1, points: 6, bps: 22, provisionalBonus: 2 }),
    ],
    subs: [statPlayer(15, { points: 1, subbedOn: true, onMinute: 61 })],
  },
  away: {
    starters: [statPlayer(9, { points: 2 }), statPlayer(2, { assists: 1, points: 5, bps: 18, provisionalBonus: 1 })],
    subs: [statPlayer(14, { points: 0 })],
  },
};

const DEMO_PROFILE: any = {
  history: Array.from({ length: DEMO_GW }, (_, i) => ({
    gw: i + 1,
    rank: 4 - Math.round(2 * Math.sin(i / 3)),
    points: 50 + ((i * 7) % 30),
  })),
  chips: { first: [{ name: 'Wildcard', gw: 8 }], second: [] },
  loserCount: 2,
  motmWins: 3,
};

const DEMO_TINKERING: any = {
  available: true, keptScore: 58, actualNetScore: 64, transferCost: 4, netImpact: 6,
  chip: null, isLiveGW: true,
  buckets: {
    transfers: { total: 8, rows: [{ id: 2, name: 'Haaland', direction: 'in', delta: 12, captain: true }, { id: 10, name: 'Watkins', direction: 'out', delta: -4 }] },
    captaincy: { total: 4, changed: true, oldCaptain: { name: 'Salah' }, newCaptain: { name: 'Haaland' }, rows: [{ id: 2, name: 'Haaland', delta: 4 }] },
    bench: { total: -6, rows: [{ id: 15, name: 'Wood', tag: 'autoSub', delta: 3 }, { id: 12, name: 'Sels', tag: 'benched', delta: -1 }] },
  },
};

function demoFormPayload(managers: any[]): any {
  // Form is a different ordering of the same people, so the tab visibly isn't
  // just the table again.
  const order = [2, 1, 0, 4, 3, 5];
  return {
    totalCompleted: DEMO_GW - 1,
    gwRange: [DEMO_GW - 5, DEMO_GW - 4, DEMO_GW - 3, DEMO_GW - 2, DEMO_GW - 1],
    form: order.map((idx, i) => {
      const m = managers[idx];
      return {
        rank: i + 1, entryId: m.entryId, name: m.name, team: m.team,
        grossScore: 312 - i * 14, transfers: 3 + i, transferCost: (i % 3) * 4,
        netScore: 312 - i * 14 - (i % 3) * 4,
      };
    }),
  };
}

// =============================================================================
// Assembly
// =============================================================================

export interface DemoIdentity {
  entryId: number;
  name: string;
  team: string;
}

export interface DemoData {
  week: any;
  form: any;
  picks: any;
  profile: any;
  tinkering: any;
  fixtureStats: any;
  /** The row the walkthrough opens its modals against — the user's, if known. */
  focusManager: any;
  /** Ticker event the walkthrough pins. */
  focusEventKey: string | null;
}

/**
 * Build the demo payload set, seating the real user in the example table when
 * we know who they are.
 *
 * This is the bit that makes the "your row is tinted teal" step work in
 * pre-season, when the user has no real row anywhere: their claimed name and
 * team really are in the demo table, so the highlight they're being shown is
 * genuinely their own, driven by the same useIsMe() path as the live page.
 */
export function buildDemoData(
  me: DemoIdentity | null,
  leagueName: string,
  eventKey: (ev: any) => string,
): DemoData {
  const week = demoWeekPayload(leagueName);
  const managers: any[] = week.managers.map((m: any, i: number) =>
    me && i === YOU_SLOT ? { ...m, entryId: me.entryId, name: me.name, team: me.team || m.team } : m,
  );
  week.managers = managers;

  return {
    week,
    form: demoFormPayload(managers),
    picks: DEMO_PICKS,
    profile: DEMO_PROFILE,
    tinkering: DEMO_TINKERING,
    fixtureStats: DEMO_FIXTURE_STATS,
    focusManager: managers[YOU_SLOT],
    // Newest-first, matching how the page stores the ticker.
    focusEventKey: eventKey(DEMO_EVENTS[0]),
  };
}

// =============================================================================
// Child-endpoint interception
// =============================================================================

/**
 * Endpoints the modals fetch when they open. Only these are served from demo
 * data while a walkthrough runs.
 *
 * /api/week is deliberately NOT in this list. The page keeps its real week
 * state throughout and merely renders the demo payload instead for the
 * duration — so a live SSE `data-update` arriving mid-tour can't write demo
 * scores into real state and leave them there once the tour ends.
 */
const DEMO_ROUTES: { test: (path: string) => boolean; pick: (d: DemoData) => unknown }[] = [
  { test: (p) => /^\/api\/manager\/\d+\/picks$/.test(p), pick: (d) => d.picks },
  { test: (p) => /^\/api\/manager\/\d+\/profile$/.test(p), pick: (d) => d.profile },
  { test: (p) => /^\/api\/manager\/\d+\/tinkering$/.test(p), pick: (d) => d.tinkering },
  { test: (p) => /^\/api\/fixture\/\d+\/stats$/.test(p), pick: (d) => d.fixtureStats },
  { test: (p) => p === '/api/form', pick: (d) => d.form },
];

/** Which demo payload (if any) answers this request. Pure, so it's testable. */
export function demoResponseFor(url: string, data: DemoData): unknown | undefined {
  let path: string;
  try {
    path = new URL(url, 'http://local').pathname;
  } catch {
    return undefined;
  }
  return DEMO_ROUTES.find((r) => r.test(path))?.pick(data);
}

type Fetch = typeof globalThis.fetch;

/**
 * Serve the modal endpoints from `data` until the returned function is called.
 *
 * Patching window.fetch is a blunt instrument, and the alternative — threading a
 * demo payload as a prop through PitchModal, MatchModal, ProfileModal,
 * TinkeringImpact and FormView — would put a tour-only parameter in five
 * components' public API for the sake of one walkthrough. This keeps it in one
 * place with a hard allowlist, and anything not on that list goes straight to
 * the real fetch untouched.
 *
 * Restoration is idempotent, and it re-checks that nothing else has patched
 * fetch since, so a double-teardown can't resurrect a stale implementation.
 */
export function installDemoFetch(data: DemoData): () => void {
  if (typeof window === 'undefined') return () => {};

  const original: Fetch = window.fetch.bind(window);
  const patched: Fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = demoResponseFor(url, data);
    if (body === undefined) return original(input, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  window.fetch = patched;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (window.fetch === patched) window.fetch = original;
  };
}
