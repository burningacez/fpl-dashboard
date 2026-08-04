#!/usr/bin/env node
/**
 * Smoke test for the Manager of the Month walkthrough. Same contract as
 * tests/tour/losers-tour.mjs: walk every step, tap what the step asks for, and
 * fail if an anchor goes missing, the sequence changes, the gold box loses its
 * ring, or the run leaves state behind.
 *
 * Serves a PRE-SEASON /api/motm (every period present, none of them played),
 * which is the state the page is in for months and where every tile says "Not
 * started". All 11 steps must still appear, off the demo season.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/motm-tour.mjs /tmp/shots 390 844
 *   node tests/tour/motm-tour.mjs /tmp/shots 390 844 --midseason
 *   node tests/tour/motm-tour.mjs /tmp/shots 390 844 --gated
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

/** The nine periods of the 2026-27 config, which the stubbed season is. */
const RANGES = [[1, 5], [6, 9], [10, 13], [14, 17], [18, 21], [22, 25], [26, 29], [30, 33], [34, 38]];

const emptyPeriods = () =>
  Object.fromEntries(
    RANGES.map(([startGW, endGW], i) => [
      i + 1,
      { rankings: [], startGW, endGW, periodComplete: false, periodGWs: [], isLive: false },
    ]),
  );

/** Pre-season: the periods exist, none of them has a gameweek behind it. */
const PRESEASON_MOTM = {
  leagueName: "Barry's Fantasy Premier League",
  periods: emptyPeriods(),
  winners: [],
  completedGWs: [],
  isLive: false,
};

/**
 * Mid-season: period 1 finished with real names, so we can assert they return.
 * The other member wins it, since the winner is the only name a tile shows and
 * that is what the check after the run reads.
 */
const MIDSEASON_MOTM = (() => {
  const periods = emptyPeriods();
  periods[1] = {
    ...periods[1],
    periodComplete: true,
    periodGWs: [1, 2, 3, 4, 5],
    rankings: [...MEMBERS].reverse().map((m, i) => ({
      name: m.name, team: m.team, entryId: m.entryId,
      netScore: 260 - i * 12, grossScore: 264 - i * 12, transferCost: 4, transfers: 3,
      highestGW: 70 - i * 4, lowestTwo: [41 - i, 44 - i], goals: 8 - i, assists: 5 - i, rank: i + 1,
    })),
  };
  return { leagueName: "Barry's Fantasy Premier League", periods, winners: [], completedGWs: [1, 2, 3, 4, 5], isLive: false };
})();

const EXPECTED_STEPS = [
  'welcome', 'grid', 'tile-done', 'tile-live', 'open-period', 'rankings', 'tiebreak',
  'my-row', 'open-live', 'live-rankings', 'done',
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
    if (p === '/api/motm') return route.fulfill(json(MIDSEASON ? MIDSEASON_MOTM : PRESEASON_MOTM));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({ available: false }));
  });

  await page.goto(`${BASE}/motm`, { waitUntil: 'domcontentloaded' });

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

    // Net is gross minus the transfer hit, which is the one arithmetic claim the
    // rankings step makes. Read it off the rendered row rather than the payload.
    if (id === 'rankings') {
      const rows = await page.locator('[data-tour="motm-rankings"] tbody tr').evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s/g, ''))),
      );
      if (rows.length === 0) failures.push('rankings table rendered no rows');
      for (const cells of rows) {
        // #, Manager, Net, Gross, goals, assists, Trf, Best, Low
        const net = Number(cells[2]);
        const gross = Number(cells[3]);
        const hit = Number((cells[6].match(/\(-(\d+)\)/) ?? [0, 0])[1]);
        if (net !== gross - hit) {
          failures.push(`net ${net} is not gross ${gross} minus the hit ${hit} (row ${cells.join('|')})`);
        }
      }
    }

    // A period with a gameweek still being played has no winner, so nothing in
    // its table may carry the winner row.
    if (id === 'live-rankings') {
      const winners = await page.locator('[data-tour="motm-rankings"] tbody tr.winner-row').count();
      if (winners > 0) failures.push(`live period highlighted ${winners} winner row(s)`);
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
  if (after.seenFlag !== '{"motm":1}') failures.push(`seen flag not written: ${after.seenFlag}`);
  // Tile names are split across two lines by renderTwoLineName, so compare on
  // whitespace-normalised text rather than raw innerText.
  const flat = after.bodyText.replace(/\s+/g, ' ');
  if (flat.includes('Danny Kelly')) failures.push('demo data still on screen after the tour ended');
  if (MIDSEASON && !flat.includes('Real Other Manager')) {
    failures.push('real season did not come back after the tour');
  }
  if (!MIDSEASON && !flat.includes('Not started')) {
    failures.push('pre-season grid did not come back after the tour');
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if ((await overlay.count()) > 0) failures.push('tour re-offered itself to a device that already saw it');
  if ((await demoBtn.count()) === 0) failures.push('See demo button missing');

  await browser.close();
  report(failures, `${walked.length} steps on a ${MIDSEASON ? 'mid-season' : 'PRE-SEASON'} payload, anchors resolved, real data restored.`);
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
