#!/usr/bin/env node
/**
 * Smoke test for the Earnings walkthrough. Same contract as
 * tests/tour/losers-tour.mjs: walk every step, fail if an anchor goes missing,
 * the sequence changes, the gold box loses its ring, or the run leaves state
 * behind.
 *
 * Serves a PRE-SEASON /api/earnings (no managers, nothing fined, nothing won),
 * which is where a first visit lands. The season config the page reads is the
 * app's own, so on a season whose pot is not declared yet the run also has the
 * `pending` step in it, explaining the dashes on the real page.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/earnings-tour.mjs /tmp/shots 390 844
 *   node tests/tour/earnings-tour.mjs /tmp/shots 390 844 --midseason
 *   node tests/tour/earnings-tour.mjs /tmp/shots 390 844 --gated
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

/** Pre-season: the endpoint answers, nothing has been paid or won. */
const PRESEASON_EARNINGS = {
  leagueName: "Barry's Fantasy Premier League",
  managers: [],
  seasonComplete: false,
  completedGWs: 0,
};

/** Mid-season: real rows, so we can assert they come back after the tour. */
const MIDSEASON_EARNINGS = {
  leagueName: "Barry's Fantasy Premier League",
  seasonComplete: false,
  completedGWs: 3,
  managers: MEMBERS.map((m, i) => ({
    entryId: m.entryId, name: m.name, team: m.team,
    weeklyLosses: i, weeklyLossesCost: i * 5, motmWins: 0, motmEarnings: 0,
    leagueFinish: 0, cupWin: 0, totalPaid: 30 + i * 5, totalEarnings: 0,
    netEarnings: -(30 + i * 5),
  })),
};

/**
 * The `pending` step only exists while the season's pot is undeclared
 * (`cashConfirmed` in season-config.ts), so it is compared out rather than
 * expected: this harness should not start failing the day the pot is confirmed.
 */
const EXPECTED_STEPS = ['welcome', 'pot', 'paid-out', 'payouts', 'table', 'net', 'my-row', 'done'];
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
    if (p === '/api/earnings') return route.fulfill(json(MIDSEASON ? MIDSEASON_EARNINGS : PRESEASON_EARNINGS));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({ available: false }));
  });

  await page.goto(`${BASE}/earnings`, { waitUntil: 'domcontentloaded' });

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
  for (let i = 1; i <= EXPECTED_STEPS.length + 3; i++) {
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

    // Money is the whole page: a step describing the pot while the page shows a
    // dash would be narrating nothing.
    if (id === 'pot') {
      const text = await page.locator('[data-tour="earnings-pot"]').innerText();
      if (!/£\d/.test(text)) failures.push(`pot tile has no £ value: "${text.replace(/\s+/g, ' ')}"`);
    }

    // The Net column sits off the right edge of a phone, so the step is only
    // honest if the engine has scrolled the table sideways to it.
    if (id === 'net') {
      const box = await page.locator('[data-tour="earnings-net"]').boundingBox();
      const vw = page.viewportSize().width;
      if (!box) {
        failures.push('Net column header not found');
      } else if (box.x < 0 || box.x + box.width > vw) {
        failures.push(`Net column is off screen at x=${Math.round(box.x)} in a ${vw}px viewport`);
      }

      // Net is Earned minus Paid In, which is the arithmetic the step claims.
      const rows = await page.locator('[data-tour="earnings-table"] tbody tr').evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s/g, ''))),
      );
      if (rows.length === 0) failures.push('earnings table rendered no rows');
      const money = (s) => Number(s.replace(/[£,]/g, '').replace('−', '-'));
      let netSum = 0;
      for (const cells of rows) {
        // Manager, Weekly Losses, MotM, League, Cup, Paid In, Earned, Net
        const paid = money(cells[5]);
        const earned = money(cells[6]);
        const net = money(cells[7]);
        if (net !== earned + paid) {
          failures.push(`net ${net} is not earned ${earned} minus paid in ${-paid} (row ${cells.join('|')})`);
        }
        netSum += net;
      }
      // Every pound paid in is paid back out in the example season, so the net
      // column has to sum to zero.
      if (netSum !== 0) failures.push(`net column sums to ${netSum}, not zero`);
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

  const ids = walked.map((s) => s.id).filter((id) => id !== 'pending');
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
  if (after.seenFlag !== '{"earnings":1}') failures.push(`seen flag not written: ${after.seenFlag}`);
  const flat = after.bodyText.replace(/\s+/g, ' ');
  if (flat.includes('Danny Kelly')) failures.push('demo data still on screen after the tour ended');
  // The demo swaps the season's money rules in as well as the payload, so the
  // real ones have to come back with it.
  if (flat.includes('6 × £30')) failures.push('demo pot rules still on screen after the tour ended');
  if (MIDSEASON && !flat.includes('Real Other Manager')) {
    failures.push('real season did not come back after the tour');
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
