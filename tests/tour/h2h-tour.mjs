#!/usr/bin/env node
/**
 * Smoke test for the Head to Head walkthrough. Same contract as
 * tests/tour/motm-tour.mjs: walk every step, fail if an anchor goes missing,
 * the sequence changes, the gold box loses its ring, or the run leaves state
 * behind.
 *
 * Serves a PRE-SEASON /api/h2h by default — `{ available: false }`, which is
 * what the endpoint answers until manager profiles exist — and lands on /h2h
 * with no query, which is the state a first visit is in: one manager
 * pre-selected, nothing to compare, one line of prompt text. All 14 steps must
 * still appear, off the demo season.
 *
 * The data assertions are aimed at the demo payload rather than the engine: the
 * numbers on this page are cross-referenced (the record has to add up to the
 * gameweeks compared, two managers on the same captain have to score the same),
 * and demoH2H.ts mirrors a payload shape that nothing type-checks. This is what
 * catches it drifting.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/h2h-tour.mjs /tmp/shots 390 844
 *   node tests/tour/h2h-tour.mjs /tmp/shots 390 844 --midseason
 *   node tests/tour/h2h-tour.mjs /tmp/shots 390 844 --gated
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const MIDSEASON = args.includes('--midseason');
const GATED = args.includes('--gated');
const [outDir = 'shots', W = '390', H = '844'] = args.filter((a) => !a.startsWith('--'));
const BASE = 'http://localhost:3000';

const ME = { entryId: 424_242, name: 'Barry Sherlock', team: 'Sherlock Homes' };
const OTHER = { entryId: 424_243, name: 'Real Other Manager', team: 'Real Other Team' };
const MEMBERS = [ME, OTHER];

/** Pre-season: no manager profiles yet, so the endpoint publishes nothing. */
const PRESEASON_H2H = {
  available: false,
  reason: 'Head-to-head comparisons are available once gameweeks have been played.',
};

/**
 * Mid-season: a real two-gameweek comparison, deliberately nothing like the
 * demo season, so the check after the run can tell them apart by name.
 */
const MIDSEASON_H2H = (() => {
  const gwComparison = [
    { gw: 1, m1Points: 60, m2Points: 52, m1Cumulative: 60, m2Cumulative: 52 },
    { gw: 2, m1Points: 48, m2Points: 71, m1Cumulative: 108, m2Cumulative: 123 },
  ];
  const chips = () => ({
    firstHalf: { wildcard: { status: 'available' }, freehit: { status: 'available' }, bboost: { status: 'available' }, '3xc': { status: 'available' } },
    secondHalf: { wildcard: { status: 'locked' }, freehit: { status: 'locked' }, bboost: { status: 'locked' }, '3xc': { status: 'locked' } },
  });
  return {
    manager1: { entryId: ME.entryId, name: ME.name, team: ME.team },
    manager2: { entryId: OTHER.entryId, name: OTHER.name, team: OTHER.team },
    currentGW: 2,
    headToHead: { m1Wins: 1, m2Wins: 1, draws: 0 },
    gwComparison,
    captains: {
      data: [
        { gw: 1, m1: { name: 'Salah', points: 18, chip: null }, m2: { name: 'Salah', points: 18, chip: null }, same: true },
        { gw: 2, m1: { name: 'Saka', points: 8, chip: null }, m2: { name: 'Isak', points: 24, chip: null }, same: false },
      ],
      m1Total: 26, m2Total: 42, sameCaptainCount: 1, totalGWs: 2,
    },
    transfers: { m1: { total: 3, cost: 4 }, m2: { total: 1, cost: 0 } },
    chips: { m1: chips(), m2: chips() },
    form: { m1: { avg: 54, scores: [60, 48], gws: [1, 2] }, m2: { avg: 61.5, scores: [52, 71], gws: [1, 2] } },
    totals: { m1: 108, m2: 123 },
    benchPoints: { m1: 9, m2: 14 },
    bestGW: { m1: { points: 60, gw: 1 }, m2: { points: 71, gw: 2 } },
    worstGW: { m1: { points: 48, gw: 2 }, m2: { points: 52, gw: 1 } },
    rankHistory: {
      m1: [{ gw: 1, rank: 1, points: 60 }, { gw: 2, rank: 2, points: 48 }],
      m2: [{ gw: 1, rank: 2, points: 52 }, { gw: 2, rank: 1, points: 71 }],
    },
  };
})();

const EXPECTED_STEPS = [
  'welcome', 'pick', 'scoreboard', 'colours', 'record', 'stats', 'transfers',
  'points-chart', 'rank-chart', 'gw-table', 'captains', 'chips', 'share', 'done',
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
    if (p === '/api/h2h') return route.fulfill(json(MIDSEASON ? MIDSEASON_H2H : PRESEASON_H2H));
    if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
    if (p === '/api/live/events') return route.abort();
    return route.fulfill(json({ available: false }));
  });

  // Mid-season arrives with both managers already in the URL, which is the only
  // way this page has a comparison on it without someone using the selects.
  const url = MIDSEASON ? `${BASE}/h2h?m1=${ME.entryId}&m2=${OTHER.entryId}` : `${BASE}/h2h`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

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

    // The two selects have to be showing the example pair, or the walkthrough is
    // describing a comparison the controls above it don't claim to be showing.
    if (id === 'pick') {
      const picked = await page.locator('[data-tour="h2h-selectors"] select').evaluateAll((els) =>
        els.map((el) => el.options[el.selectedIndex]?.text.trim()),
      );
      if (picked.some((t) => !t || /^Select manager/.test(t))) {
        failures.push(`selects show [${picked}] rather than the example pair`);
      }
      if (!picked[0]?.includes('(You)')) failures.push(`left slot is "${picked[0]}", not the viewer`);
      if (picked[0] === picked[1]) failures.push('both slots show the same manager');
    }

    // The scoreboard's W/D/L has to account for every gameweek in the table
    // below it: they are the same 21 gameweeks counted two different ways.
    if (id === 'scoreboard') {
      const wdl = await page.locator('[data-tour="h2h-scoreboard"]').innerText();
      const m = wdl.match(/(\d+)W\s*(\d+)D\s*(\d+)L/);
      const rows = await page.locator('[data-tour="h2h-gw-table"] tbody tr').count();
      if (!m) failures.push(`scoreboard has no W/D/L line: ${wdl.replace(/\s+/g, ' ')}`);
      else if (Number(m[1]) + Number(m[2]) + Number(m[3]) !== rows) {
        failures.push(`record ${m[1]}W ${m[2]}D ${m[3]}L covers ${Number(m[1]) + Number(m[2]) + Number(m[3])} gameweeks, table has ${rows}`);
      }
    }

    // The step says the colour names the viewer, so the viewer's side has to be
    // wearing it. A visitor with no claimed team has no teal side and the step
    // says something else, but this run is signed in.
    if (id === 'colours') {
      const teal = await page.locator('[data-tour="h2h-scoreboard"] .my-team-name').count();
      if (teal !== 1) failures.push(`scoreboard tints ${teal} names as the viewer, expected 1`);
    }

    // Every segment of the record bar is a share of the same total, so they have
    // to fill it. The draws segment must be there too: a bar with no grey in it
    // is a bar whose middle the step is describing for nothing.
    if (id === 'record') {
      const widths = await page.locator('[data-tour="h2h-record"] .h-7 > div').evaluateAll((els) =>
        els.map((el) => parseFloat(el.style.width)),
      );
      const total = widths.reduce((a, b) => a + b, 0);
      if (widths.length !== 3) failures.push(`record bar has ${widths.length} segments, expected 3`);
      if (Math.abs(total - 100) > 0.5) failures.push(`record bar segments sum to ${total.toFixed(1)}%`);
    }

    // Two managers on the same captain in the same week scored the same points,
    // unless one of them tripled it — which is the one thing the TC badge means
    // and the only reason the step mentions it.
    if (id === 'captains') {
      const rows = await page.locator('[data-tour="h2h-captains"] tbody tr').evaluateAll((trs) =>
        trs.map((tr) => {
          const [a, , b] = [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim());
          const parse = (s) => {
            const m = s.match(/^(?:TC\s*)?(.+?)\s*\((\d+)\)(?:\s*TC)?$/);
            return m ? { name: m[1], points: Number(m[2]), tc: /TC/.test(s) } : null;
          };
          return { m1: parse(a), m2: parse(b), raw: `${a} | ${b}` };
        }),
      );
      if (rows.length === 0) failures.push('captain table rendered no rows');
      let sameSeen = 0;
      let tcSeen = 0;
      for (const r of rows) {
        if (!r.m1 || !r.m2) { failures.push(`unparseable captain row: ${r.raw}`); continue; }
        if (r.m1.tc || r.m2.tc) tcSeen++;
        if (r.m1.name !== r.m2.name) continue;
        sameSeen++;
        if (!r.m1.tc && !r.m2.tc && r.m1.points !== r.m2.points) {
          failures.push(`same captain scored differently with no TC: ${r.raw}`);
        }
        // Captain doubles, Triple Captain triples, so the tripled side is worth
        // exactly half as much again as the doubled one.
        if (r.m1.tc !== r.m2.tc) {
          const [tc, plain] = r.m1.tc ? [r.m1.points, r.m2.points] : [r.m2.points, r.m1.points];
          if (tc !== plain * 1.5) failures.push(`TC row is ${tc} against ${plain}, expected ${plain * 1.5}: ${r.raw}`);
        }
      }
      if (sameSeen === 0) failures.push('no gameweek where both picked the same captain');
      if (tcSeen === 0) failures.push('no Triple Captain week, so the TC badge is unexplained');
    }

    // The chip step names four states. Three of them can exist at the demo's
    // gameweek (the fourth, locked, only before the split) and all three have to
    // actually be on screen.
    if (id === 'chips') {
      const titles = await page.locator('[data-tour="h2h-chips"] span[title]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('title')),
      );
      for (const want of [/^Used GW\d+$/, /^Expired$/, /^Available$/]) {
        if (!titles.some((t) => want.test(t))) failures.push(`chip grid has no ${want} icon: ${titles.join(',')}`);
      }
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
    search: window.location.search,
  }));
  console.log('\nAfter finishing:', JSON.stringify({ ...after, bodyText: undefined }));
  for (const k of ['modalsOpen', 'tourStillUp', 'bannerStillUp']) {
    if (after[k] !== 0) failures.push(`tour left state behind: ${k}=${after[k]}`);
  }
  if (after.seenFlag !== '{"h2h":1}') failures.push(`seen flag not written: ${after.seenFlag}`);
  if (after.bodyText.includes('Danny Kelly')) failures.push('demo data still on screen after the tour ended');
  if (MIDSEASON) {
    if (!after.bodyText.includes('Real Other Manager')) failures.push('real comparison did not come back after the tour');
    // The run drove the selects for fourteen steps; the address bar it left
    // behind is what the user came in with, and is what they'd share.
    for (const id of [ME.entryId, OTHER.entryId]) {
      if (!after.search.includes(String(id))) failures.push(`tour rewrote the URL: ${after.search}`);
    }
  } else if (!after.bodyText.includes('Select two managers to compare')) {
    failures.push('pre-season prompt did not come back after the tour');
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
