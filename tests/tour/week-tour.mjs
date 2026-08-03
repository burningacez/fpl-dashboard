#!/usr/bin/env node
/**
 * Smoke test for the /week walkthrough: walks every step, screenshots each one,
 * and checks the run cleans up after itself.
 *
 * This exists because tour steps are a second source of truth about the UI.
 * Nothing else in CI notices when a restructure orphans a `data-tour` anchor:
 * the engine degrades quietly by design, so a broken step just silently stops
 * appearing. Run this after touching the Scores page, its modals, or the shape
 * of the /api/week payload that demoWeek.ts mirrors.
 *
 * The walkthrough supplies its own demo data (src/app/week/demoWeek.ts), so
 * this deliberately does NOT stub the data endpoints, it stubs only enough of
 * the shell (identity, members, seasons) for the page to render, and serves a
 * PRE-SEASON /api/week: no scores, no fixtures, no events, empty table. That is
 * the case that matters, because it is when new members actually arrive, and
 * all 16 steps must still have something to point at.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/week-tour.mjs /tmp/shots 1280 900         # desktop, pre-season
 *   node tests/tour/week-tour.mjs /tmp/shots 390 844          # phone, pre-season
 *   node tests/tour/week-tour.mjs /tmp/shots 1280 900 --midseason
 *   node tests/tour/week-tour.mjs /tmp/shots 1280 900 --visitor
 *   node tests/tour/week-tour.mjs /tmp/shots 1280 900 --gated
 *
 * Exits non-zero if a step's anchor goes missing, if the step sequence changes,
 * if the run leaves state behind, or, in --midseason, if the real league does
 * not come back afterwards.
 *
 * `--gated` covers the preview gate instead of the walk: a gated-out user must
 * see nothing AND record nothing, so that flipping the feature to released
 * shows it to them once on their very next page view even though they have used
 * the page before. That is the whole release story, and it is only true because
 * a seen-flag is written by running the tour rather than by visiting the page.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
/** Serve a populated /api/week, to prove demo mode overlays and then reverts. */
const MIDSEASON = args.includes('--midseason');
/** No claimed identity, so the demo table can't be personalised. */
const VISITOR = args.includes('--visitor');
/**
 * Run the preview-gate scenario instead of the walk: check that a gated-out
 * user sees nothing at all AND records nothing, then flip the flag to simulate
 * release and check they're shown it once on their very next page view.
 */
const GATED = args.includes('--gated');
const [outDir = 'shots', W = '1280', H = '900'] = args.filter((a) => !a.startsWith('--'));
const width = Number(W);
const height = Number(H);
const BASE = 'http://localhost:3000';

const ME = { entryId: 424_242, name: 'Barry Sherlock', team: 'Sherlock Homes' };

/** The real league's members, deliberately NOT the demo names. */
const MEMBERS = [
  { entryId: ME.entryId, name: ME.name, team: ME.team },
  { entryId: 424_243, name: 'Real Other Manager', team: 'Real Other Team' },
];

/**
 * Pre-season: the roster exists, nothing else does. This is what /week looks
 * like before GW1, and running the tour on it is the whole point of demo mode.
 */
const PRESEASON_WEEK = {
  leagueName: "Barry's Fantasy Premier League",
  currentGW: 1,
  isLive: false,
  managers: [],
  chronologicalEvents: [],
  changeEvents: [],
  fixtures: [],
  squadPlayers: {},
  plTeams: [],
};

/** Mid-season: a real table, so we can assert it returns once the tour ends. */
const MIDSEASON_WEEK = {
  ...PRESEASON_WEEK,
  currentGW: 12,
  managers: MEMBERS.map((m, i) => ({
    ...m,
    overallRank: i + 1, movement: 0, gwScore: 40 + i, transferCost: 0,
    captainName: 'Somebody', benchPoints: 1, overallPoints: 400 + i,
    starting11: [], benchPlayerIds: [], autoSubsIn: [], autoSubsOut: [],
  })),
};

/**
 * The full walk. Every step must appear whichever /api/week payload is served:
 * that invariance IS the feature. A short walk here means a `when` gate is
 * reading real data where it should be reading the demo payload.
 */
const EXPECTED_STEPS = [
  'welcome', 'gameweek', 'live', 'tab-form', 'form', 'tab-back', 'highlight-button',
  'highlight-modal', 'highlight-close', 'ticker', 'ticker-tap', 'ticker-effect',
  'ticker-clear', 'fixtures', 'match-lineups', 'match-defcon', 'match-bonus', 'table',
  'my-row', 'profile-open', 'profile-stats', 'profile-chips', 'profile-records',
  'pitch-open', 'pitch', 'pitch-autosub', 'player-open', 'player-rows', 'moves-open',
  'moves-body', 'done',
];

/** Steps that deliberately have no anchor (centred cards). */
const ANCHORLESS = ['welcome', 'done'];

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const failures = [];
  // Any request to a data endpoint while demo mode is meant to be serving it is
  // a leak: the modals should never reach the network mid-tour.
  const leakedRequests = [];
  let tourRunning = false;
  // Stands in for PREVIEW_GATED['guided-walkthroughs'] being flipped to false.
  let released = !GATED;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === '/api/seasons') {
      return route.fulfill(json({ seasons: [{ id: '2026-27', label: '2026/27', isCurrent: true }], currentSeason: '2026-27' }));
    }
    if (p === '/api/members') return route.fulfill(json({ members: MEMBERS }));
    if (p === '/api/identity/me') {
      // `features` is decided server-side by preview-access.ts; the client only
      // ever sees this boolean. `released` is flipped mid-run by the gate
      // scenario to simulate the feature going public.
      const base = VISITOR
        ? { status: 'unclaimed' }
        : { status: 'member', entryId: ME.entryId, name: ME.name, team: ME.team, nameKey: ME.name.toLowerCase(), season: '2026-27' };
      return route.fulfill(json({ ...base, features: { walkthroughs: released } }));
    }
    if (p === '/api/week') return route.fulfill(json(MIDSEASON ? MIDSEASON_WEEK : PRESEASON_WEEK));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort(); // SSE → page falls back to polling

    // Everything else is a modal/child endpoint. Demo mode should be answering
    // these itself; reaching here during a run means the interception missed.
    if (tourRunning) leakedRequests.push(p);
    return route.fulfill(json({ available: false, reason: 'not stubbed' }));
  });

  await page.goto(`${BASE}/week`, { waitUntil: 'domcontentloaded' });

  const card = page.locator('[role="dialog"][aria-labelledby="tour-step-title"]');
  const overlay = page.locator('[data-tour-step]');
  const demoBtn = page.getByRole('button', { name: /See a guided demo/i });

  if (GATED) {
    // --- gated: the feature does not exist for this user ---------------------
    await page.waitForTimeout(3500); // well past the auto-offer delay
    if ((await overlay.count()) > 0) failures.push('gated user was shown the walkthrough');
    if ((await demoBtn.count()) > 0) failures.push('gated user was shown the See demo button');
    const flag = await page.evaluate(() => window.localStorage.getItem('fpl-tour-seen'));
    // This is the load-bearing assertion for "release it later and everyone
    // still gets it once": a gated-out device must record NOTHING, so it looks
    // exactly like a first-time visitor once the gate opens.
    if (flag !== null) failures.push(`gated user recorded a seen flag: ${flag}`);
    await page.screenshot({ path: `${outDir}/gated-01-hidden.png` });

    // --- release it, same device, next page view -----------------------------
    released = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await card.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      failures.push('after release, a returning user was NOT offered the walkthrough');
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/gated-02-after-release.png` });
    if ((await demoBtn.count()) > 0) {
      failures.push('See demo button showing while the tour is running');
    }

    await browser.close();
    if (failures.length) {
      console.error(`\n${failures.length} failure(s):`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log('✓ gated: hidden and unrecorded; offered once on the next view after release.');
    return;
  }

  // The walkthrough auto-offers itself shortly after the page reports ready.
  await card.waitFor({ state: 'visible', timeout: 15000 });
  tourRunning = true;

  // Demo mode must announce itself, nobody should mistake the example league
  // for their own. Both places: the page banner, and the pill inside the card
  // (the page banner scrolls away as the tour moves down the page).
  if ((await page.locator('main').getByText(/Example data/i).count()) === 0) {
    failures.push('demo-mode page banner missing');
  }
  if ((await card.getByText(/Example data/i).count()) === 0) {
    failures.push('demo-mode notice pill missing from the tour card');
  }

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
      failures.push(`step "${id}" lost its anchor, check its data-tour target`);
    }

    // The "your row is tinted teal" step has to be showing the user's actual
    // row, not a claim about one, that's what seating them in the demo table
    // is for, and pre-season it's the only row they have anywhere.
    // The profile sheet renders nothing at all without a `records` block, so a
    // body missing these means the demo payload has drifted from what
    // ProfileModal reads. Matched with getByText, not innerText: these labels
    // are upper-cased by CSS, so a substring check against innerText silently
    // never matches.
    if (id === 'profile-stats') {
      const body = page.locator('[data-tour="modal-profile"]');
      for (const want of ['League Rank', 'Chips', 'Season Records', 'Transfers']) {
        try {
          await body.getByText(want).first().waitFor({ timeout: 3000 });
        } catch {
          failures.push(`profile modal is missing "${want}", demo payload shape drifted`);
        }
      }
    }

    if (id === 'my-row' && !VISITOR) {
      const seated = await page.locator('tr.my-team-row').count();
      if (seated === 0) failures.push('my-row step: demo table has no my-team-row');
      const named = await page.locator('tr.my-team-row').filter({ hasText: ME.name }).count();
      if (named === 0) failures.push(`my-row step: demo table not seated with "${ME.name}"`);
    }

    // The example-data caveat must be on screen at EVERY step, not just the
    // first; this is the one that stops the tour quietly looking like real data.
    if ((await card.getByText(/Example data/i).count()) === 0) {
      failures.push(`step "${id}": no example-data notice on screen`);
    }

    // The counter has to agree with the walk. It is computed from the step gates
    // at transition time, and those read page state, so a stale read shows up
    // here as the wrong total (it once read "1 of 8" on a 16-step run because
    // the demo data hadn't been republished yet).
    // innerText is upper-cased by the label's text-transform, hence /i.
    const counter = await card.getByText(/^Step \d+ of \d+$/).innerText();
    const [, pos, total] = counter.match(/Step (\d+) of (\d+)/i) ?? [];
    if (Number(total) !== EXPECTED_STEPS.length) {
      failures.push(`step "${id}": counter says "${counter}", expected a total of ${EXPECTED_STEPS.length}`);
    }
    if (Number(pos) !== i) {
      failures.push(`step "${id}": counter says position ${pos}, expected ${i}`);
    }

    // The gold box must actually be gold. Tailwind's ring utilities are
    // box-shadows, so an inline boxShadow silently replaces them; this caught
    // exactly that.
    if (anchored) {
      const shadow = await page.locator('.tour-spot').evaluate((el) => getComputedStyle(el).boxShadow);
      if (!shadow.includes('245, 158, 11')) {
        failures.push(`step "${id}": gold box has no accent ring (box-shadow: ${shadow.slice(0, 80)})`);
      }
    }

    await page.screenshot({ path: `${outDir}/${String(i).padStart(2, '0')}-${id}.png` });

    // A tap step has no Next: the only way on is tapping the highlighted thing.
    const nextBtn = card.getByRole('button', { name: /^(Next|Done|Start|Finish)$/ });
    if (await nextBtn.count()) {
      const label = await nextBtn.innerText();
      await nextBtn.click();
      if (/Done|Finish/.test(label)) break;
    } else {
      const spot = page.locator('.tour-spot');
      if ((await spot.count()) === 0) {
        failures.push(`step "${id}": tap step with no gold box to tap`);
        break;
      }
      const b = await spot.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
  }

  for (const s of walked) {
    console.log(`${s.anchored ? '◉' : '○'} ${s.id.padEnd(18)} ${s.title}`);
  }

  const walkedIds = walked.map((s) => s.id);
  if (walkedIds.join(',') !== EXPECTED_STEPS.join(',')) {
    failures.push(`step sequence was [${walkedIds}], expected [${EXPECTED_STEPS}]`);
  }

  tourRunning = false;
  await page.waitForTimeout(800);

  // Cleanup: no modal open, no highlight pinned, Standings tab restored, demo
  // banner gone, and: the important one: the REAL league back on screen.
  const state = await page.evaluate(() => ({
    modalsOpen: document.querySelectorAll('[data-tour-blocks-autostart]').length,
    dimmedRows: document.querySelectorAll('tr.hl-dimmed').length,
    formStillShowing: document.querySelectorAll('[data-tour="week-form"]').length,
    tourStillUp: document.querySelectorAll('[data-tour-step]').length,
    bannerStillUp: document.body.innerText.includes('Example data') ? 1 : 0,
    seenFlag: window.localStorage.getItem('fpl-tour-seen'),
    bodyText: document.body.innerText,
  }));
  console.log(
    '\nAfter finishing:',
    JSON.stringify({ ...state, bodyText: undefined }),
  );
  for (const k of ['modalsOpen', 'dimmedRows', 'formStillShowing', 'tourStillUp', 'bannerStillUp']) {
    if (state[k] !== 0) failures.push(`tour left state behind: ${k}=${state[k]}`);
  }
  if (state.seenFlag !== '{"week":1}') failures.push(`seen flag not written: ${state.seenFlag}`);

  // Demo names must be gone once the tour ends, whichever payload is real.
  if (state.bodyText.includes('Danny Kelly') || state.bodyText.includes('Kelly Kong')) {
    failures.push('demo data still on screen after the tour ended');
  }
  if (MIDSEASON && !state.bodyText.includes('Real Other Manager')) {
    failures.push('real league did not come back after the tour');
  }
  if (leakedRequests.length) {
    failures.push(`modal endpoints hit the network mid-tour: ${[...new Set(leakedRequests)].join(', ')}`);
  }

  // A device that has seen this cut must not be offered it again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const reoffered = (await overlay.count()) > 0;
  console.log('Re-offered on reload:', reoffered);
  if (reoffered) failures.push('tour re-offered itself to a device that already saw it');
  // The idle page: real data, no overlay, and the See demo button available.
  await page.screenshot({ path: `${outDir}/98-idle-with-button.png` });

  // The ? replay button must be there to get it back.
  if ((await demoBtn.count()) === 0) failures.push('See demo button missing');
  else {
    await demoBtn.click();
    await page.waitForTimeout(1500);
    if ((await overlay.count()) === 0) failures.push('See demo button did not start the tour');
    await page.screenshot({ path: `${outDir}/99-replayed.png` });
  }

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ ${walked.length} steps on a ${MIDSEASON ? 'mid-season' : 'PRE-SEASON'} payload` +
      `${VISITOR ? ' (visitor)' : ''}, anchors resolved, real data restored.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
