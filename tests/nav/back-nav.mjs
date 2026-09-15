#!/usr/bin/env node
/**
 * Back goes back exactly one screen, everywhere.
 *
 * The behaviour this locks in is a browser one — it is the history stack, not
 * component state — so it is checked in a real browser rather than a unit
 * test. The unit test beside it (__tests__/modal-history.test.ts) covers the
 * stack arithmetic; this covers the wiring.
 *
 * Walks the deepest stack the app has: a table row → the pitch → a player's
 * scores, then Back three times, expecting one screen to come off each time.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/nav/back-nav.mjs
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const ME = { entryId: 900002, name: 'Example Manager', team: 'Your Team' };
const MEMBERS = [
  { entryId: ME.entryId, name: ME.name, team: ME.team },
  { entryId: 424243, name: 'Other Manager', team: 'Other Team' },
];

const SAF = {
  leagueName: "Barry's Fantasy Premier League",
  completedGWs: 3,
  managers: MEMBERS.map((m, i) => ({
    entryId: m.entryId, name: m.name, team: m.team,
    safRank: i + 1, actualRank: i + 1,
    safTotal: 150 - i * 10, actualTotal: 140 - i * 10, difference: -10,
  })),
  worstTinkerer: { entryId: MEMBERS[1].entryId, name: MEMBERS[1].name, difference: -10 },
};

/** A squad just big enough to render: one keeper, ten outfield, four bench. */
const player = (id, name, positionId, isBench) => ({
  id, element: id, name, fullName: name, web_name: name,
  positionId, teamCode: 3, teamName: 'Team', multiplier: isBench ? 0 : 1,
  isBench, benchOrder: isBench ? id % 4 : 0, points: 2, totalPoints: 2,
  playStatus: 'played', minutes: 90, pointsBreakdown: [
    { identifier: 'minutes', icon: '⏱️', stat: 'Minutes played', value: 90, points: 2 },
  ],
});
const PICKS = {
  points: 44, calculatedPoints: 44, totalProvisionalBonus: 0, transfersCost: 0,
  pointsOnBench: 4, autoSubs: [],
  players: [
    player(1, 'Keeper', 1, false),
    ...[2, 3, 4, 5].map((i) => player(i, `Def ${i}`, 2, false)),
    ...[6, 7, 8, 9].map((i) => player(i, `Mid ${i}`, 3, false)),
    ...[10, 11].map((i) => player(i, `Fwd ${i}`, 4, false)),
    ...[12, 13, 14, 15].map((i) => player(i, `Sub ${i}`, 3, true)),
  ],
};

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.route('**/api/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/api/seasons') {
    return route.fulfill(json({ seasons: [{ id: '2026-27', label: '2026/27', isCurrent: true }], currentSeason: '2026-27' }));
  }
  if (p === '/api/members') return route.fulfill(json({ members: MEMBERS }));
  if (p === '/api/identity/me') {
    return route.fulfill(json({
      status: 'member', entryId: ME.entryId, name: ME.name, team: ME.team,
      nameKey: ME.name.toLowerCase(), season: '2026-27', features: { walkthroughs: false },
    }));
  }
  if (p === '/api/set-and-forget') return route.fulfill(json(SAF));
  if (p.endsWith('/picks')) return route.fulfill(json(PICKS));
  if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
  if (p === '/api/live/events') return route.abort();
  return route.fulfill(json({ available: false }));
});

const pitch = page.locator('[data-tour="modal-pitch"]');
const breakdown = page.locator('[data-tour="modal-player"]');

// Arrive from another page, so "one screen back" has somewhere to land that
// is not a blank tab.
await page.goto(`${BASE}/rules`, { waitUntil: 'domcontentloaded' });
await page.goto(`${BASE}/set-and-forget`, { waitUntil: 'domcontentloaded' });
const row = page.locator('tbody tr', { hasText: 'Other Manager' });
await row.waitFor({ timeout: 15000 });

// Row → pitch.
await row.click();
await pitch.waitFor({ timeout: 10000 });
check(await pitch.getByText('Keeper').count() > 0, 'the GW1 squad did not render in the pitch modal');

// Player → scores.
await pitch.getByRole('button').filter({ hasText: 'Keeper' }).first().click();
await breakdown.waitFor({ timeout: 10000 });

// Back once: the scores go, the pitch stays.
await page.goBack();
await page.waitForTimeout(400);
check(await breakdown.count() === 0, 'Back did not close the player scores');
check(await pitch.count() === 1, 'Back closed the pitch as well as the player scores');

// Back again: the pitch goes, the table stays.
await page.goBack();
await page.waitForTimeout(400);
check(await pitch.count() === 0, 'Back did not close the pitch');
check(new URL(page.url()).pathname === '/set-and-forget', `Back left the table (now at ${page.url()})`);

// Back again: now, and only now, the previous page.
await page.goBack();
await page.waitForTimeout(600);
check(new URL(page.url()).pathname === '/rules', `Back from the table did not reach the previous page (now at ${page.url()})`);

// Closing with ✕ must leave the history stack where it started, or the next
// Back would appear to do nothing.
await page.goForward();
await page.waitForTimeout(600);
await row.waitFor({ timeout: 15000 });
await row.click();
await pitch.waitFor({ timeout: 10000 });
await pitch.getByRole('button', { name: 'Close' }).click();
await page.waitForTimeout(400);
check(await pitch.count() === 0, '✕ did not close the pitch');
await page.goBack();
await page.waitForTimeout(600);
check(
  new URL(page.url()).pathname === '/rules',
  `after closing with ✕, Back did not go back a page (now at ${page.url()})`,
);

await browser.close();

if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => `  • ${f}`).join('\n'));
  process.exit(1);
}
console.log('PASS — Back unwinds one screen at a time: player → pitch → table → previous page.');
