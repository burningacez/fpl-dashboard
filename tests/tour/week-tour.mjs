#!/usr/bin/env node
/**
 * Smoke test for the /week walkthrough: walks every step against stubbed API
 * payloads, screenshots each one, and checks the run cleans up after itself.
 *
 * This exists because tour steps are a second source of truth about the UI.
 * Nothing else in CI notices when a restructure orphans a `data-tour` anchor —
 * the engine degrades quietly by design, so a broken step just silently stops
 * appearing. Run this after touching the Scores page or its modals.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/week-tour.mjs /tmp/shots 1280 900     # desktop
 *   node tests/tour/week-tour.mjs /tmp/shots-phone 390 844 # phone
 *
 * Every endpoint the page and its modals touch is stubbed, so this runs
 * without FPL API access and produces the same walkthrough every time —
 * which is the point: the live payload changes hourly, the steps shouldn't.
 *
 * Exits non-zero if a step's anchor goes missing, if the expected step count
 * isn't reached, or if the run leaves a modal open behind it.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
/**
 * `--empty` serves a pre-season / cold-cache payload instead: no fixtures, no
 * ticker, no managers, nothing live. Every data-dependent step should drop out
 * and the tour should still complete, which is the whole anti-fragility claim.
 */
const EMPTY = args.includes('--empty');
const [outDir = 'shots', W = '1280', H = '900'] = args.filter((a) => !a.startsWith('--'));
const width = Number(W);
const height = Number(H);
const BASE = 'http://localhost:3000';

const ME = { entryId: 101, name: 'Barry Sherlock', team: 'Sherlock Homes' };

const MANAGERS = [
  { entryId: 104, name: 'Danny Kelly', team: 'Kelly Kong', overallRank: 1, movement: 2, gwScore: 71, transferCost: 0, captainName: 'Salah', viceCaptainName: 'Haaland', benchPoints: 6, overallPoints: 812, teamValue: '101.4', seasonGoals: 34, seasonAssists: 21, activeChip: '3xc', playersLeft: 1, activePlayers: 2, starting11: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], benchPlayerIds: [12, 13, 14, 15], captainId: 1 },
  { entryId: 101, name: 'Barry Sherlock', team: 'Sherlock Homes', overallRank: 2, movement: -1, gwScore: 64, transferCost: 4, captainName: 'Haaland', viceCaptainName: 'Salah', benchPoints: 2, overallPoints: 806, teamValue: '103.1', seasonGoals: 31, seasonAssists: 18, activeChip: null, playersLeft: 3, activePlayers: 1, starting11: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], benchPlayerIds: [12, 13, 14, 15], captainId: 2 },
  { entryId: 102, name: 'Ste Hughes', team: 'Hughes Are Ya', overallRank: 3, movement: 0, gwScore: 58, transferCost: 0, captainName: 'Palmer', viceCaptainName: 'Saka', benchPoints: 9, overallPoints: 790, teamValue: '100.2', seasonGoals: 28, seasonAssists: 22, activeChip: 'bboost', playersLeft: 2, activePlayers: 0, starting11: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], benchPlayerIds: [1, 2, 14, 15], captainId: 3 },
  { entryId: 103, name: 'Michael Owen', team: 'Owen Me a Favour', overallRank: 4, movement: 1, gwScore: 55, transferCost: 8, captainName: 'Salah', viceCaptainName: 'Palmer', benchPoints: 1, overallPoints: 771, teamValue: '99.8', seasonGoals: 25, seasonAssists: 14, activeChip: null, playersLeft: 0, activePlayers: 3, starting11: [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 14], benchPlayerIds: [2, 4, 13, 15], captainId: 1 },
  { entryId: 105, name: 'Jonny Doyle', team: 'Doyle Rules', overallRank: 5, movement: -2, gwScore: 49, transferCost: 0, captainName: 'Saka', viceCaptainName: 'Haaland', benchPoints: 12, overallPoints: 754, teamValue: '98.5', seasonGoals: 22, seasonAssists: 17, activeChip: null, playersLeft: 4, activePlayers: 1, starting11: [2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14], benchPlayerIds: [1, 3, 6, 15], captainId: 4 },
  { entryId: 106, name: 'Tom Rowley', team: 'Rowley Poly', overallRank: 6, movement: 0, gwScore: 41, transferCost: 4, captainName: 'Haaland', viceCaptainName: 'Palmer', benchPoints: 3, overallPoints: 728, teamValue: '97.9', seasonGoals: 19, seasonAssists: 11, activeChip: null, playersLeft: 2, activePlayers: 2, starting11: [1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 15], benchPlayerIds: [3, 7, 11, 14], captainId: 2 },
];

const PLAYER_NAMES = {
  1: ['Salah', 3, 11], 2: ['Haaland', 13, 4], 3: ['Palmer', 6, 3], 4: ['Saka', 1, 3],
  5: ['Raya', 1, 1], 6: ['Gabriel', 1, 2], 7: ['Van Dijk', 11, 2], 8: ['Trippier', 14, 2],
  9: ['Foden', 13, 3], 10: ['Watkins', 2, 4], 11: ['Isak', 14, 4], 12: ['Sels', 15, 1],
  13: ['Konsa', 2, 2], 14: ['Mbeumo', 4, 3], 15: ['Wood', 15, 4],
};

const squadPlayers = Object.fromEntries(
  Object.entries(PLAYER_NAMES).map(([id, [name, teamId, positionId]]) => [id, { name, teamId, positionId }]),
);

const plTeams = [
  { id: 1, name: 'Arsenal', shortName: 'ARS' }, { id: 2, name: 'Aston Villa', shortName: 'AVL' },
  { id: 3, name: 'Chelsea', shortName: 'CHE' }, { id: 4, name: 'Brentford', shortName: 'BRE' },
  { id: 11, name: 'Liverpool', shortName: 'LIV' }, { id: 13, name: 'Man City', shortName: 'MCI' },
  { id: 14, name: 'Newcastle', shortName: 'NEW' }, { id: 15, name: "Nott'm Forest", shortName: 'NFO' },
];

const FIXTURES = [
  { id: 501, home: 'LIV', away: 'MCI', homeScore: 2, awayScore: 1, started: true, finished: false, minutes: 67, kickoff: '2026-08-03T14:00:00Z' },
  { id: 502, home: 'ARS', away: 'CHE', homeScore: 1, awayScore: 1, started: true, finished: true, minutes: 90, kickoff: '2026-08-03T11:30:00Z' },
  { id: 503, home: 'NEW', away: 'AVL', started: false, finished: false, kickoff: '2026-08-03T18:30:00Z' },
  { id: 504, home: 'BRE', away: 'NFO', started: false, finished: false, kickoff: '2026-08-04T14:00:00Z' },
];

const EVENTS = [
  { timestamp: '2026-08-03T15:05:00Z', type: 'goal', player: 'Salah', elementId: 1, points: 5, icon: '⚽', match: 'LIV v MCI' },
  { timestamp: '2026-08-03T15:02:00Z', type: 'bonus_change', icon: '✨', match: 'ARS v CHE', changes: [{ elementId: 4, player: 'Saka', impact: 2 }, { elementId: 3, player: 'Palmer', impact: -1 }] },
  { timestamp: '2026-08-03T14:48:00Z', type: 'assist', player: 'Haaland', elementId: 2, points: 3, icon: '👟', match: 'LIV v MCI' },
  { timestamp: '2026-08-03T14:31:00Z', type: 'yellow', player: 'Van Dijk', elementId: 7, points: -1, icon: '🟨', match: 'LIV v MCI' },
  { timestamp: '2026-08-03T14:12:00Z', type: 'team_clean_sheet_lost', team: 'MCI', icon: '💥', match: 'LIV v MCI', affectedPlayers: [{ elementId: 9, points: 0 }] },
  { timestamp: '2026-08-03T13:20:00Z', type: 'saves', player: 'Raya', elementId: 5, points: 1, icon: '🧤', match: 'ARS v CHE' },
];

const WEEK = {
  leagueName: "Barry's Fantasy Premier League",
  currentGW: 21,
  isLive: true,
  managers: MANAGERS,
  lastUpdated: '2026-08-03T15:06:00Z',
  chronologicalEvents: [...EVENTS].reverse(),
  changeEvents: [],
  fixtures: FIXTURES,
  nextKickoff: '2026-08-03T18:30:00Z',
  squadPlayers,
  plTeams,
};

const pitchPlayer = (id, over = {}) => {
  const [name, teamId, positionId] = PLAYER_NAMES[id];
  return {
    id, element: id, name, web: name, fullName: name, positionId, position: ['', 'GKP', 'DEF', 'MID', 'FWD'][positionId],
    teamId, teamName: plTeams.find((t) => t.id === teamId)?.name ?? '', teamCode: teamId,
    points: 4, totalPoints: 4, multiplier: 1, minutes: 90, provisionalBonus: 0,
    isCaptain: false, isViceCaptain: false, isBench: false, subIn: false, subOut: false,
    events: [], pointsBreakdown: [], allFixturesFinished: true, hasDoubleGameweek: false, hasNoGame: false,
    playStatus: 'played', chanceOfPlaying: 100, opponent: 'MCI (H)', fixtureDetails: [],
    ...over,
  };
};

const PICKS = {
  calculatedPoints: 62, points: 62, totalProvisionalBonus: 6, transfersCost: 4, pointsOnBench: 2,
  autoSubs: [{ in: { name: 'Wood' }, out: { name: 'Watkins' } }],
  players: [
    pitchPlayer(5, { points: 6 }),
    pitchPlayer(6, { points: 7 }), pitchPlayer(7, { points: 2 }), pitchPlayer(8, { points: 5 }),
    pitchPlayer(1, { points: 14, isCaptain: false }), pitchPlayer(3, { points: 8 }), pitchPlayer(9, { points: 5 }), pitchPlayer(4, { points: 9 }),
    pitchPlayer(2, { points: 24, multiplier: 2, isCaptain: true }), pitchPlayer(11, { points: 6 }), pitchPlayer(15, { points: 3, subIn: true }),
    pitchPlayer(12, { isBench: true, points: 1 }), pitchPlayer(13, { isBench: true, points: 1 }),
    pitchPlayer(14, { isBench: true, points: 0 }), pitchPlayer(10, { isBench: true, points: 0, subOut: true }),
  ],
};

const statPlayer = (id, over = {}) => {
  const [name, , positionId] = PLAYER_NAMES[id];
  return { id, name, position: ['', 'GKP', 'DEF', 'MID', 'FWD'][positionId], points: 4, bps: 12, goals: 0, assists: 0, cleanSheet: false, yellowCard: false, redCard: false, saves: 0, defcon: 0, provisionalBonus: 0, subbedOn: false, subbedOff: false, ...over };
};

const FIXTURE_STATS = {
  finished: false, finishedProvisional: false,
  home: {
    starters: [statPlayer(5, { saves: 3, points: 5 }), statPlayer(7, { points: 1, yellowCard: true }), statPlayer(1, { goals: 1, points: 9, bps: 34, provisionalBonus: 3 }), statPlayer(11, { assists: 1, points: 6, bps: 22, provisionalBonus: 2 })],
    subs: [statPlayer(15, { points: 1, subbedOn: true, onMinute: 61 })],
  },
  away: {
    starters: [statPlayer(9, { points: 2 }), statPlayer(2, { assists: 1, points: 5, bps: 18, provisionalBonus: 1 })],
    subs: [statPlayer(14, { points: 0 })],
  },
};

const PROFILE = {
  history: Array.from({ length: 21 }, (_, i) => ({ gw: i + 1, rank: 4 - Math.round(2 * Math.sin(i / 3)), points: 50 + ((i * 7) % 30) })),
  chips: { first: [{ name: 'Wildcard', gw: 8 }], second: [] },
  loserCount: 2,
  motmWins: 3,
};

const TINKERING = {
  available: true, keptScore: 58, actualNetScore: 64, transferCost: 4, netImpact: 6, chip: null, isLiveGW: true,
  buckets: {
    transfers: { total: 8, rows: [{ id: 2, name: 'Haaland', direction: 'in', delta: 12, captain: true }, { id: 10, name: 'Watkins', direction: 'out', delta: -4 }] },
    captaincy: { total: 4, changed: true, oldCaptain: { name: 'Salah' }, newCaptain: { name: 'Haaland' }, rows: [{ id: 2, name: 'Haaland', delta: 4 }] },
    bench: { total: -6, rows: [{ id: 15, name: 'Wood', tag: 'autoSub', delta: 3 }, { id: 12, name: 'Sels', tag: 'benched', delta: -1 }] },
  },
};

const FORM = {
  totalCompleted: 20,
  gwRange: [16, 17, 18, 19, 20],
  form: [
    { rank: 1, entryId: 102, name: 'Ste Hughes', team: 'Hughes Are Ya', grossScore: 312, transfers: 6, transferCost: 8, netScore: 304 },
    { rank: 2, entryId: 101, name: 'Barry Sherlock', team: 'Sherlock Homes', grossScore: 305, transfers: 5, transferCost: 4, netScore: 301 },
    { rank: 3, entryId: 104, name: 'Danny Kelly', team: 'Kelly Kong', grossScore: 298, transfers: 3, transferCost: 0, netScore: 298 },
    { rank: 4, entryId: 105, name: 'Jonny Doyle', team: 'Doyle Rules', grossScore: 281, transfers: 8, transferCost: 12, netScore: 269 },
    { rank: 5, entryId: 103, name: 'Michael Owen', team: 'Owen Me a Favour', grossScore: 270, transfers: 9, transferCost: 16, netScore: 254 },
    { rank: 6, entryId: 106, name: 'Tom Rowley', team: 'Rowley Poly', grossScore: 244, transfers: 4, transferCost: 4, netScore: 240 },
  ],
};

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * The full walk, in order, for the payload stubbed above (live gameweek, six
 * managers, four fixtures, a populated ticker). Keep in step with
 * src/app/week/weekTour.ts — a mismatch here means a step was added, removed,
 * or is being skipped because its `when` gate no longer passes.
 */
const FULL_STEPS = [
  'welcome', 'gameweek', 'live', 'tabs', 'form', 'highlight-button', 'highlight-modal',
  'ticker', 'ticker-pin', 'fixtures', 'match-modal', 'table', 'my-row', 'profile-modal',
  'pitch-modal', 'done',
];

/**
 * What survives a pre-season payload. `live` needs matches in play; `ticker-pin`
 * needs an event AND a populated table; `fixtures`/`match-modal` need fixtures;
 * `table`/`my-row` need rows; the modal steps need a manager to open.
 * `ticker` stays — the feed renders its own "events will appear here" state.
 */
const EMPTY_STEPS = [
  'welcome', 'gameweek', 'tabs', 'form', 'highlight-button', 'highlight-modal', 'ticker', 'done',
];

const EXPECTED_STEPS = EMPTY ? EMPTY_STEPS : FULL_STEPS;

/** Steps that deliberately have no anchor (centred cards). */
const ANCHORLESS = ['welcome', 'done'];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/api/seasons') return route.fulfill(json({ seasons: [{ id: '2026-27', label: '2026/27', isCurrent: true }], currentSeason: '2026-27' }));
    if (p === '/api/members') return route.fulfill(json({ members: MANAGERS.map(({ entryId, name, team }) => ({ entryId, name, team })) }));
    if (p === '/api/identity/me') return route.fulfill(json({ status: 'member', entryId: ME.entryId, name: ME.name, team: ME.team, nameKey: ME.name.toLowerCase(), season: '2026-27' }));
    if (p === '/api/week') {
      return route.fulfill(
        json(
          EMPTY
            ? { ...WEEK, isLive: false, managers: [], fixtures: [], chronologicalEvents: [], squadPlayers: {} }
            : WEEK,
        ),
      );
    }
    if (p === '/api/form') return route.fulfill(json(FORM));
    if (p.endsWith('/stats')) return route.fulfill(json(FIXTURE_STATS));
    if (p.endsWith('/picks')) return route.fulfill(json(PICKS));
    if (p.endsWith('/profile')) return route.fulfill(json(PROFILE));
    if (p.endsWith('/tinkering')) return route.fulfill(json(TINKERING));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    // SSE: let it fail so the page falls back to its polling path.
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({}));
  });

  await page.goto(`${BASE}/week`, { waitUntil: 'domcontentloaded' });

  // The walkthrough auto-offers itself ~900ms after the page reports ready.
  const card = page.locator('[role="dialog"][aria-labelledby="tour-step-title"]');
  await card.waitFor({ state: 'visible', timeout: 15000 });

  const overlay = page.locator('[data-tour-step]');
  const failures = [];
  const walked = [];

  for (let i = 1; i <= EXPECTED_STEPS.length + 2; i++) {
    await page.waitForTimeout(700); // let the scroll settle before shooting
    const id = await overlay.getAttribute('data-tour-step');
    const anchored = (await overlay.getAttribute('data-tour-anchored')) === 'true';
    const title = await page.locator('#tour-step-title').innerText();
    walked.push({ id, anchored, title });

    if (ANCHORLESS.includes(id)) {
      if (anchored) failures.push(`step "${id}" is anchored but shouldn't be`);
    } else if (!anchored) {
      failures.push(`step "${id}" lost its anchor — check its data-tour target`);
    }

    await page.screenshot({ path: `${outDir}/${String(i).padStart(2, '0')}-${id}.png` });

    const nextBtn = card.getByRole('button', { name: /^(Next|Done)$/ });
    const label = await nextBtn.innerText();
    await nextBtn.click();
    if (label === 'Done') break;
  }

  for (const s of walked) {
    console.log(`${s.anchored ? '◉' : '○'} ${s.id.padEnd(18)} ${s.title}`);
  }

  const walkedIds = walked.map((s) => s.id);
  if (walkedIds.join(',') !== EXPECTED_STEPS.join(',')) {
    failures.push(`step sequence was [${walkedIds}], expected [${EXPECTED_STEPS}]`);
  }

  // Cleanup: finishing must leave no modal open, no highlight pinned, and the
  // Standings tab restored — every `before` paired with its `after`.
  await page.waitForTimeout(500);
  const leftovers = {
    modalsOpen: await page.locator('[data-tour-blocks-autostart]').count(),
    dimmedRows: await page.locator('tr.hl-dimmed').count(),
    formStillShowing: await page.locator('[data-tour="week-form"]').count(),
    tourStillUp: await overlay.count(),
    seenFlag: await page.evaluate(() => window.localStorage.getItem('fpl-tour-seen')),
  };
  console.log('\nAfter finishing:', JSON.stringify(leftovers));
  for (const [k, v] of Object.entries(leftovers)) {
    if (k !== 'seenFlag' && v !== 0) failures.push(`tour left state behind: ${k}=${v}`);
  }
  if (leftovers.seenFlag !== '{"week":1}') failures.push(`seen flag not written: ${leftovers.seenFlag}`);

  // A device that has seen this cut must not be offered it again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const reoffered = (await overlay.count()) > 0;
  console.log('Re-offered on reload:', reoffered);
  if (reoffered) failures.push('tour re-offered itself to a device that already saw it');

  // The ? replay button must be there to get it back.
  const replay = page.getByRole('button', { name: 'Replay the Scores walkthrough' });
  if ((await replay.count()) === 0) failures.push('replay button missing');
  else {
    await replay.click();
    await page.waitForTimeout(1200);
    if ((await overlay.count()) === 0) failures.push('replay button did not start the tour');
    await page.screenshot({ path: `${outDir}/99-replayed.png` });
  }

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ ${walked.length} steps, anchors resolved, state restored.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
