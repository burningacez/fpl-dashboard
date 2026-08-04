#!/usr/bin/env node
/**
 * Smoke test for the Hall of Fame walkthrough. Same contract as
 * tests/tour/losers-tour.mjs: walk every step, tap what the step asks for, and
 * fail if an anchor goes missing, the sequence changes, the gold box loses its
 * ring, or the run leaves state behind.
 *
 * Serves a PRE-SEASON /api/hall-of-fame, which answers `{ available: false }`
 * until gameweeks have been played. That is the only state this page has for
 * months, and the one the other harnesses can't cover: the page renders nothing
 * but an empty block, so the run has to stand in for the page entirely and put
 * the empty state back when it ends.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/hof-tour.mjs /tmp/shots 390 844
 *   node tests/tour/hof-tour.mjs /tmp/shots 390 844 --midseason
 *   node tests/tour/hof-tour.mjs /tmp/shots 390 844 --gated
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const MIDSEASON = args.includes('--midseason');
const GATED = args.includes('--gated');
const [outDir = 'shots', W = '390', H = '844'] = args.filter((a) => !a.startsWith('--'));
const BASE = 'http://localhost:3000';

const ME = { entryId: 424_242, name: 'Barry Sherlock', team: 'Sherlock Homes' };
const MEMBERS = [
  { entryId: ME.entryId, name: ME.name, team: ME.team },
  { entryId: 424_243, name: 'Real Other Manager', team: 'Real Other Team' },
];

const PRESEASON_REASON = 'The Hall of Fame fills in once gameweeks have been played.';
const PRESEASON_HOF = { available: false, reason: PRESEASON_REASON };

const record = (name, rest) => ({ name, names: [name], ...rest });

/** Mid-season: real records, so we can assert they come back after the tour. */
const MIDSEASON_HOF = {
  highlights: {
    highestGW: record('Real Other Manager', { score: 81, gw: 2 }),
    biggestClimb: record(ME.name, { ranksGained: 1, gw: 3 }),
    mostMotM: record('Real Other Manager', { count: 0 }),
    mostConsistent: record(ME.name, { stdDev: 6.1 }),
    highestTeamValue: record('Real Other Manager', { value: '100.4', gw: 3 }),
  },
  lowlights: {
    lowestGW: record(ME.name, { score: 34, gw: 1 }),
    mostLosses: record(ME.name, { count: 2 }),
    biggestHit: record('Real Other Manager', { cost: 4, gw: 3 }),
    biggestDrop: record(ME.name, { ranksLost: 1, gw: 2 }),
    mostTransfers: record('Real Other Manager', { count: 6 }),
    lowestTeamValue: record(ME.name, { value: '99.8', gw: 2 }),
  },
  chipAwards: { perfectBB: [], perfectTC: [], worstBB: null, worstTC: null },
};

const PRESEASON_SAF = { leagueName: "Barry's Fantasy Premier League", completedGWs: 0, managers: [] };

const EXPECTED_STEPS = [
  'welcome', 'highlights', 'card', 'open-card', 'award', 'tied', 'mine', 'lowlights', 'done',
];
const ANCHORLESS = ['welcome', 'done'];

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: Number(W), height: Number(H) }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const failures = [];
  let released = !GATED;

  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/seasons') {
      return route.fulfill(json({ seasons: [{ id: '2026-27', label: '2026/27', isCurrent: true }], currentSeason: '2026-27' }));
    }
    if (p === '/api/members') return route.fulfill(json({ members: MEMBERS }));
    if (p === '/api/identity/me') {
      return route.fulfill(json({
        status: 'member', entryId: ME.entryId, name: ME.name, team: ME.team,
        nameKey: ME.name.toLowerCase(), season: '2026-27',
        features: { walkthroughs: released },
      }));
    }
    if (p === '/api/hall-of-fame') return route.fulfill(json(MIDSEASON ? MIDSEASON_HOF : PRESEASON_HOF));
    if (p === '/api/set-and-forget') return route.fulfill(json(PRESEASON_SAF));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({ available: false }));
  });

  await page.goto(`${BASE}/hall-of-fame`, { waitUntil: 'domcontentloaded' });

  const card = page.locator('[role="dialog"][aria-labelledby="tour-step-title"]');
  const overlay = page.locator('[data-tour-step]');
  const demoBtn = page.getByRole('button', { name: /See a guided demo/i });

  if (GATED) {
    await page.waitForTimeout(3500);
    if ((await overlay.count()) > 0) failures.push('gated user was shown the walkthrough');
    if ((await demoBtn.count()) > 0) failures.push('gated user was shown the See demo button');
    const flag = await page.evaluate(() => window.localStorage.getItem('fpl-tour-seen'));
    if (flag !== null) failures.push(`gated user recorded a seen flag: ${flag}`);
    released = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await card.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      failures.push('after release, a returning user was NOT offered the walkthrough');
    }
    await browser.close();
    report(failures, 'gated: hidden and unrecorded; offered once on the next view after release.');
    return;
  }

  await card.waitFor({ state: 'visible', timeout: 15000 });

  if ((await page.locator('main').getByText(/Example data/i).count()) === 0) {
    failures.push('demo-mode page banner missing');
  }

  const walked = [];
  for (let i = 1; i <= EXPECTED_STEPS.length + 2; i++) {
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

    // The award modal has to have loaded its content, or the step is pointing at
    // an empty box: the description and the holder are both part of the claim.
    if (id === 'award') {
      const text = await page.locator('[data-tour="modal-hof-award"]').innerText();
      if (!/highest single gameweek score/i.test(text)) failures.push('award modal has no definition in it');
      if (!/pts/.test(text)) failures.push('award modal has no value in it');
    }

    // The tie step claims the card counts the holders it doesn't name.
    if (id === 'tied') {
      const text = await page.locator('[data-tour="hof-tied"]').innerText();
      if (!/\+\d+ others/.test(text)) failures.push(`tied card names no shared holders: "${text.replace(/\s+/g, ' ')}"`);
    }

    // "Records you hold" is only true if the card really is the user's.
    if (id === 'mine') {
      const mine = await page.locator('[data-tour="hof-highlights"] .my-team-card').count();
      if (mine === 0) failures.push('no card is highlighted as the user\'s');
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

  for (const s of walked) console.log(`${s.anchored ? '◉' : '○'} ${s.id.padEnd(14)} ${s.title}`);

  const ids = walked.map((s) => s.id);
  if (ids.join(',') !== EXPECTED_STEPS.join(',')) {
    failures.push(`step sequence was [${ids}], expected [${EXPECTED_STEPS}]`);
  }

  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    modalsOpen: document.querySelectorAll('[data-tour-blocks-autostart]').length,
    tourStillUp: document.querySelectorAll('[data-tour-step]').length,
    bannerStillUp: document.body.innerText.includes('Example data') ? 1 : 0,
    seenFlag: window.localStorage.getItem('fpl-tour-seen'),
    bodyText: document.body.innerText,
  }));
  console.log('\nAfter finishing:', JSON.stringify({ ...after, bodyText: undefined }));
  for (const k of ['modalsOpen', 'tourStillUp', 'bannerStillUp']) {
    if (after[k] !== 0) failures.push(`tour left state behind: ${k}=${after[k]}`);
  }
  if (after.seenFlag !== '{"hall-of-fame":1}') failures.push(`seen flag not written: ${after.seenFlag}`);
  const flat = after.bodyText.replace(/\s+/g, ' ');
  if (flat.includes('Danny Kelly')) failures.push('demo data still on screen after the tour ended');
  if (MIDSEASON && !flat.includes('Real Other Manager')) {
    failures.push('real records did not come back after the tour');
  }
  // The pre-season page is the empty state, and the run has to hand it back.
  if (!MIDSEASON && !flat.includes(PRESEASON_REASON)) {
    failures.push('pre-season empty state did not come back after the tour');
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if ((await overlay.count()) > 0) failures.push('tour re-offered itself to a device that already saw it');
  if ((await demoBtn.count()) === 0) failures.push('See demo button missing');

  await browser.close();
  report(failures, `${walked.length} steps on a ${MIDSEASON ? 'mid-season' : 'PRE-SEASON'} payload, anchors resolved, real page restored.`);
}

function report(failures, ok) {
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ ${ok}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
