#!/usr/bin/env node
/**
 * Smoke test for the planner walkthroughs. Same contract as the other tour
 * harnesses: walk every step, tap what the step asks for, and fail if an anchor
 * goes missing, the sequence changes, the gold box loses its ring, or the run
 * leaves state behind.
 *
 * There are two scripts here rather than one, because /planner is two pages —
 * and three page states between them:
 *
 *   default        the Squad Builder, pre-season, with no saved draft — which
 *                  is exactly what a new member walks into in August
 *   --draft        the Planner on a finished pre-season draft: GW1 unlimited,
 *                  every stat zero, prices not yet moving
 *   --midseason    the Planner, on a published squad, which is the cut with
 *                  real free transfers, a played chip and populated stats
 *
 * The feed is generated rather than hand-written. demoPlanner.ts builds its
 * squad out of /api/planner/data by price shape, so the harness has to serve a
 * player universe big enough to pick a legal 2/5/5/3 from at the prices the
 * shape asks for — and generating it means the test also proves the picker
 * copes with whatever the feed happens to hold, which is the part that cannot
 * be hardcoded across seasons.
 *
 * The one thing this asserts beyond the walk: **the tour must not write.** The
 * planner autosaves plans to localStorage, so the harness seeds a real plan and
 * a real draft, and checks both are byte-identical afterwards.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/planner-tour.mjs /tmp/shots 390 844
 *   node tests/tour/planner-tour.mjs /tmp/shots 390 844 --midseason
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const MIDSEASON = args.includes('--midseason');
/**
 * Pre-season WITH a finished draft, which is the third page state: the builder
 * steps aside and the planner runs on the draft, with GW1 unlimited and every
 * points column still zero. Without this the pre-season planner cut — its own
 * `when` gates, and four steps that exist nowhere else — is never walked.
 */
const WITH_DRAFT = args.includes('--draft');
const [outDir = 'shots', W = '390', H = '844'] = args.filter((a) => !a.startsWith('--'));
const BASE = 'http://localhost:3000';

const ME = { entryId: 424_242, name: 'Barry Sherlock', team: 'Sherlock Homes' };
const SEASON = '2026-27';
/** Where the season is in the --midseason run. */
const CURRENT_GW = 12;

// =============================================================================
// A generated feed: 20 clubs, a full price ladder per position, 38 gameweeks
// =============================================================================

const CLUB_NAMES = [
  'Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton', 'Burnley',
  'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds', 'Liverpool',
  'Man City', 'Man Utd', 'Newcastle', "Nott'm Forest", 'Sunderland',
  'Tottenham', 'West Ham', 'Wolves',
];
const TEAMS = CLUB_NAMES.map((name, i) => ({
  id: i + 1,
  name,
  short_name: name.slice(0, 3).toUpperCase(),
  code: i + 1,
}));

/**
 * Prices per position, in tenths, covering the range demoPlanner's shape asks
 * for (a 14.5 forward down to a 4.0 defender) with several options at each
 * price so the 3-per-club rule always has somewhere to go.
 */
const LADDER = {
  1: [55, 50, 45, 40],
  2: [60, 55, 50, 45, 40],
  3: [145, 130, 100, 85, 75, 65, 55, 50, 45],
  4: [140, 120, 100, 80, 70, 60, 50, 40],
};

const PLAYERS = [];
let nextId = 1;
for (const [typeStr, prices] of Object.entries(LADDER)) {
  const type = Number(typeStr);
  // Two of every price in every club: plenty of legal squads, and the picker's
  // tie-break (points, then id) is what makes its choice deterministic.
  for (const price of prices) {
    for (const team of TEAMS) {
      for (let n = 0; n < 2; n++) {
        const id = nextId++;
        const scored = MIDSEASON ? Math.max(0, Math.round(price / 2) - n * 3) : 0;
        PLAYERS.push({
          id,
          web_name: `${team.short_name}${type}${price}${n ? 'b' : 'a'}`,
          first_name: 'Test',
          second_name: `Player ${id}`,
          team: team.id,
          element_type: type,
          now_cost: price,
          cost_change_event: MIDSEASON && id % 11 === 0 ? (id % 22 === 0 ? 1 : -1) : 0,
          cost_change_start: MIDSEASON && id % 7 === 0 ? (id % 14 === 0 ? 2 : -1) : 0,
          transfers_in_event: MIDSEASON ? scored * 100 : 0,
          transfers_out_event: 0,
          price_change_percent: MIDSEASON ? ((id * 37) % 199) - 99 : 0,
          total_points: scored,
          form: MIDSEASON ? (scored / 10).toFixed(1) : '0.0',
          points_per_game: MIDSEASON ? (scored / 11).toFixed(1) : '0.0',
          selected_by_percent: MIDSEASON ? (scored / 10).toFixed(1) : '0.0',
          status: 'a',
          news: '',
          chance_of_playing_next_round: 100,
          ep_next: MIDSEASON ? '4.2' : '0.0',
          minutes: MIDSEASON ? 900 : 0,
          starts: MIDSEASON ? 10 : 0,
          goals_scored: 0,
          assists: 0,
          clean_sheets: 0,
          goals_conceded: 0,
          penalties_saved: 0,
          penalties_missed: 0,
          yellow_cards: 0,
          red_cards: 0,
          saves: 0,
          bonus: 0,
          bps: 0,
          expected_goals: '0.0',
          expected_assists: '0.0',
          expected_goal_involvements: '0.0',
          ict_index: '0.0',
        });
      }
    }
  }
}

const EVENTS = Array.from({ length: 38 }, (_, i) => {
  const id = i + 1;
  return {
    id,
    deadline_time: `2026-${String(8 + Math.floor(i / 4)).padStart(2, '0')}-${String((i % 4) * 7 + 1).padStart(2, '0')}T17:30:00Z`,
    finished: MIDSEASON ? id < CURRENT_GW : false,
    is_current: MIDSEASON && id === CURRENT_GW,
    is_next: MIDSEASON ? id === CURRENT_GW + 1 : id === 1,
  };
});

/** A round-robin, rotated per gameweek, so every club has a real fixture run. */
const FIXTURES = [];
let fixtureId = 1;
for (const event of EVENTS) {
  const rotated = [...TEAMS.slice(0, 1), ...TEAMS.slice(1).slice(event.id % 19), ...TEAMS.slice(1).slice(0, event.id % 19)];
  for (let i = 0; i < 10; i++) {
    const home = rotated[i];
    const away = rotated[19 - i];
    FIXTURES.push({
      id: fixtureId++,
      event: event.id,
      team_h: event.id % 2 ? home.id : away.id,
      team_a: event.id % 2 ? away.id : home.id,
      team_h_difficulty: 2 + ((home.id + event.id) % 4),
      team_a_difficulty: 2 + ((away.id + event.id) % 4),
      kickoff_time: event.deadline_time,
    });
  }
}

const PLANNER_DATA = {
  currentGw: MIDSEASON ? CURRENT_GW : 0,
  nextGw: MIDSEASON ? CURRENT_GW + 1 : 1,
  events: EVENTS,
  teams: TEAMS,
  players: PLAYERS,
  fixtures: FIXTURES,
};

/** Pre-season: FPL publishes no picks, so the builder is what you get. */
const PRESEASON_SQUAD = {
  preSeason: true,
  entryId: ME.entryId,
  builderEnabled: true,
  firstGw: 1,
  firstDeadline: EVENTS[0].deadline_time,
  budget: 1000,
};

/** Mid-season: a real published squad, so the planner proper renders. */
function midseasonSquad() {
  const take = (type, count) =>
    PLAYERS.filter((p) => p.element_type === type)
      .filter((p, i) => i % 7 === 0)
      .slice(0, count);
  const picks = [
    ...take(1, 1), ...take(2, 4), ...take(3, 4), ...take(4, 2), // XI
    ...take(1, 2).slice(1), ...take(2, 5).slice(4), ...take(3, 5).slice(4), ...take(4, 3).slice(2), // bench
  ].map((p, i) => ({
    element: p.id,
    purchasePrice: p.now_cost,
    sellingPrice: p.now_cost,
    position: i + 1,
    isCaptain: i === 0,
    isViceCaptain: i === 1,
  }));
  return {
    preSeason: false,
    entryId: ME.entryId,
    gw: CURRENT_GW,
    bank: 15,
    value: picks.reduce((s, p) => s + p.sellingPrice, 0),
    activeChip: null,
    chipsUsed: [{ name: 'freehit', event: 6 }],
    picks,
    approximatePrices: false,
    freeTransfers: 1,
    freeTransfersDerivation: { confident: true, transfersByGw: {} },
  };
}

// Steps, in order, for each scenario. A missing or reordered id is a failure:
// tour scripts are a second source of truth about the page, and nothing else in
// CI notices when a restructure orphans an anchor.
const BUILDER_STEPS = [
  'welcome', 'pitch', 'detail-tap', 'fdr-read', 'empty-tap', 'cap', 'pick',
  'fifteenth', 'split', 'plr-tap', 'card-acts', 'auto', 'done-btn', 'finish',
];
const PLANNER_STEPS_PRE = [
  'welcome', 'sandbox', 'gwbar', 'tiles', 'unlimited', 'gw-tap', 'deadline', 'ft',
  'chips', 'chip-tap', 'detail-tap', 'pitch', 'lines', 'plr-tap', 'card-fix',
  'card-zeros', 'card-acts', 'transfer-tap', 'browser-budget', 'buy', 'footer',
  'hit', 'fixtures-tap', 'matrix', 'attr', 'prices-tap', 'prices-empty', 'done',
];
const PLANNER_STEPS_MID = [
  'welcome', 'rebase', 'gwbar', 'tiles', 'gw-tap', 'deadline', 'ft', 'chips',
  'chip-tap', 'detail-tap', 'pitch', 'lines', 'plr-tap', 'card-fix', 'card-live',
  'card-acts', 'transfer-tap', 'browser-budget', 'buy', 'footer', 'hit',
  'fixtures-tap', 'matrix', 'attr', 'prices-tap', 'predicted', 'recent-tap',
  'recent', 'done',
];
const ANCHORLESS = ['welcome', 'finish', 'done'];

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** A real plan and a real draft, which the walkthrough must leave alone. */
const REAL_PLAN_KEY = `fpl-planner-${ME.entryId}-${SEASON}`;
const REAL_DRAFT_KEY = `fpl-planner-draft-${ME.entryId}-${SEASON}`;
/**
 * A legal 15 out of the generated feed, for the --draft scenario: 2/5/5/3, at
 * most three from a club, inside the budget. Cheapest-first, so it always fits.
 */
function legalDraftOrder() {
  const clubs = new Map();
  const order = [];
  for (const [type, count] of [[1, 2], [2, 5], [3, 5], [4, 3]]) {
    const pool = PLAYERS.filter((p) => p.element_type === type).sort((a, b) => a.now_cost - b.now_cost);
    for (const p of pool) {
      if (order.filter((o) => o.element_type === type).length >= count) break;
      if ((clubs.get(p.team) ?? 0) >= 3) continue;
      clubs.set(p.team, (clubs.get(p.team) ?? 0) + 1);
      order.push(p);
    }
  }
  // FPL lineup order: a legal XI first (1 GK, 4 DEF, 4 MID, 2 FWD), bench after.
  const of = (t) => order.filter((p) => p.element_type === t);
  const xi = [...of(1).slice(0, 1), ...of(2).slice(0, 4), ...of(3).slice(0, 4), ...of(4).slice(0, 2)];
  const bench = [...of(1).slice(1), ...of(2).slice(4), ...of(3).slice(4), ...of(4).slice(2)];
  return [...xi, ...bench].map((p) => p.id);
}

const REAL_DRAFT = JSON.stringify({
  version: 1, entryId: ME.entryId, season: SEASON, order: legalDraftOrder(), updatedAt: 1,
});

const REAL_PLAN = JSON.stringify({
  version: 1, entryId: ME.entryId, season: SEASON, baseGw: 0,
  baseSquadHash: 'do-not-touch', updatedAt: 1, weeks: { 3: { transfers: [], chip: 'wildcard' } },
});

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: Number(W), height: Number(H) }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const failures = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/seasons') {
      return route.fulfill(json({ seasons: [{ id: SEASON, label: '2026/27', isCurrent: true }], currentSeason: SEASON }));
    }
    if (p === '/api/members') return route.fulfill(json({ members: [{ ...ME }] }));
    if (p === '/api/identity/me') {
      return route.fulfill(json({
        status: 'member', entryId: ME.entryId, name: ME.name, team: ME.team,
        nameKey: ME.name.toLowerCase(), season: SEASON, features: { walkthroughs: true },
      }));
    }
    if (p === '/api/planner/data') return route.fulfill(json(PLANNER_DATA));
    if (p.startsWith('/api/planner/squad/')) {
      return route.fulfill(json(MIDSEASON ? midseasonSquad() : PRESEASON_SQUAD));
    }
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({ available: false, reason: 'not stubbed' }));
  });

  // Seed the writes the tour must not touch. Pre-season there is also a saved
  // draft, so the builder opens on a complete squad rather than forcing itself.
  await page.addInitScript(
    ({ planKey, plan, draftKey, draft }) => {
      window.localStorage.setItem(planKey, plan);
      if (draft) window.localStorage.setItem(draftKey, draft);
    },
    {
      planKey: REAL_PLAN_KEY,
      plan: REAL_PLAN,
      draftKey: REAL_DRAFT_KEY,
      draft: WITH_DRAFT ? REAL_DRAFT : null,
    },
  );

  await page.goto(`${BASE}/planner`, { waitUntil: 'domcontentloaded' });

  const card = page.locator('[role="dialog"][aria-labelledby="tour-step-title"]');
  const overlay = page.locator('[data-tour-step]');
  await card.waitFor({ state: 'visible', timeout: 20000 });

  const expected = MIDSEASON ? PLANNER_STEPS_MID : WITH_DRAFT ? PLANNER_STEPS_PRE : BUILDER_STEPS;

  if ((await page.locator('main').getByText(/Example data/i).count()) === 0) {
    failures.push('demo-mode page banner missing');
  }

  const walked = [];
  for (let i = 1; i <= expected.length + 3; i++) {
    await page.waitForTimeout(320);
    if ((await overlay.count()) === 0) break;
    const id = await overlay.getAttribute('data-tour-step');
    const anchored = (await overlay.getAttribute('data-tour-anchored')) === 'true';
    const title = await page.locator('#tour-step-title').innerText();
    walked.push({ id, anchored, title });

    if (ANCHORLESS.includes(id)) {
      if (anchored) failures.push(`step "${id}" is anchored but shouldn't be`);
    } else if (!anchored) {
      failures.push(`step "${id}" lost its anchor: check its data-tour target`);
    }
    if ((await card.getByText(/Example data/i).count()) === 0) {
      failures.push(`step "${id}": no example-data notice on screen`);
    }
    if (anchored) {
      const shadow = await page.locator('.tour-spot').evaluate((el) => getComputedStyle(el).boxShadow);
      if (!shadow.includes('245, 158, 11')) failures.push(`step "${id}": gold box has no accent ring`);
    }
    // No Back, anywhere, ever.
    if (await card.getByRole('button', { name: /^Back$/ }).count()) {
      failures.push(`step "${id}": a Back button is showing`);
    }

    await page.screenshot({ path: `${outDir}/${String(i).padStart(2, '0')}-${id}.png` });

    const nextBtn = card.getByRole('button', { name: /^(Next|Done|Start|Finish)$/ });
    if (await nextBtn.count()) {
      const label = await nextBtn.innerText();
      await nextBtn.click();
      if (/Done|Finish/.test(label)) break;
    } else {
      const spot = page.locator('.tour-spot');
      if ((await spot.count()) === 0) { failures.push(`step "${id}": tap step with no gold box`); break; }
      const b = await spot.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
  }

  for (const s of walked) console.log(`${s.anchored ? '◉' : '○'} ${String(s.id).padEnd(15)} ${s.title}`);

  const ids = walked.map((s) => s.id);
  if (ids.join(',') !== expected.join(',')) {
    failures.push(`step sequence was\n    [${ids.join(', ')}]\n  expected\n    [${expected.join(', ')}]`);
  }

  // --- the run must have written nothing and left nothing behind ------------
  await page.waitForTimeout(700);
  const after = await page.evaluate(
    ({ planKey, draftKey }) => ({
      tourStillUp: document.querySelectorAll('[data-tour-step]').length,
      bannerStillUp: document.body.innerText.includes('Example data') ? 1 : 0,
      modalsOpen: document.querySelectorAll('[data-tour-blocks-autostart]').length,
      seenFlag: window.localStorage.getItem('fpl-tour-seen'),
      plan: window.localStorage.getItem(planKey),
      draft: window.localStorage.getItem(draftKey),
    }),
    { planKey: REAL_PLAN_KEY, draftKey: REAL_DRAFT_KEY },
  );
  console.log('\nAfter finishing:', JSON.stringify({ ...after, plan: after.plan?.slice(0, 40) }));

  for (const k of ['tourStillUp', 'bannerStillUp', 'modalsOpen']) {
    if (after[k] !== 0) failures.push(`tour left state behind: ${k}=${after[k]}`);
  }
  const wantSeen = MIDSEASON || WITH_DRAFT ? '{"planner":1}' : '{"planner-builder":1}';
  if (after.seenFlag !== wantSeen) failures.push(`seen flag is ${after.seenFlag}, expected ${wantSeen}`);
  // The whole reason this page's demo is a sandbox rather than an overlay.
  // `updatedAt` is excluded on purpose: restoring a plan on a plain page load
  // rewrites its timestamp, with or without a walkthrough. What must survive is
  // the plan — its base and every planned week.
  const stripStamp = (raw) => {
    if (!raw) return raw;
    const { updatedAt, ...rest } = JSON.parse(raw);
    return JSON.stringify(rest);
  };
  if (stripStamp(after.plan) !== stripStamp(REAL_PLAN)) {
    failures.push(`the walkthrough changed the real plan:\n    ${after.plan}`);
  }
  if (stripStamp(after.draft) !== stripStamp(WITH_DRAFT ? REAL_DRAFT : null)) {
    failures.push(`the walkthrough changed the real draft:\n    ${after.draft}`);
  }
  if (consoleErrors.length) failures.push(`page errors: ${consoleErrors.slice(0, 2).join(' | ')}`);

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ ${walked.length} steps on ${MIDSEASON ? 'a published squad' : 'a PRE-SEASON draft'}, anchors resolved, nothing written.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
