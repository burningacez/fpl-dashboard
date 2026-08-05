#!/usr/bin/env node
/**
 * The engine's guards, checked on a live page rather than in a unit test,
 * because every one of them is a browser behaviour:
 *
 *   1. There is no Back button. See the note in TourProvider for why.
 *   2. While a tour runs, the page behind it cannot be scrolled or reached —
 *      not by wheel, touch drag, scroll keys, Tab, or an off-target tap — and
 *      all of that is undone when the run ends.
 *
 * Engine-level, so /week stands in for every toured page: one provider, one
 * overlay, one set of listeners.
 *
 * Usage (against `npm run dev` or `npm start` on :3000):
 *   node tests/tour/guards.mjs
 *
 * Two things this has to be careful about, both of which produced false
 * failures first time round:
 *
 *  • The engine scrolls the page itself, smoothly, to bring each anchor into
 *    the band the card leaves free. Sampling scrollY while that is in flight
 *    reads the engine's own movement as a leak, so every measurement waits for
 *    the position to stop changing first.
 *  • Pre-season /week is shorter than the viewport at the opening step, so a
 *    scroll test there passes whatever the code does. Each test asserts there
 *    was somewhere to scroll to before believing a zero.
 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3000';
const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
const ME = { entryId: 900002, name: 'Example Manager', team: 'Your Team' };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const cdp = await page.context().newCDPSession(page);

await page.route('**/api/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/api/seasons') return route.fulfill(json({ seasons: [{ id: '2026-27', label: '2026/27', isCurrent: true }], currentSeason: '2026-27' }));
  if (p === '/api/members') return route.fulfill(json({ members: [{ entryId: ME.entryId, name: ME.name, team: ME.team }] }));
  if (p === '/api/identity/me') return route.fulfill(json({ status: 'member', ...ME, nameKey: 'example manager', season: '2026-27', features: { walkthroughs: true } }));
  if (p === '/api/week') return route.fulfill(json({ available: false, reason: 'pre-season' }));
  if (p === '/api/traffic/track') return route.fulfill({ status: 204, body: '' });
  if (p === '/api/live/events') return route.abort();
  return route.fulfill(json({ available: false, reason: 'not stubbed' }));
});

await page.goto(`${BASE}/week`, { waitUntil: 'domcontentloaded' });
const card = page.locator('[role="dialog"][aria-labelledby="tour-step-title"]');
await card.waitFor({ state: 'visible', timeout: 15000 });

const failures = [];
const y = () => page.evaluate(() => window.scrollY);
const room = () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);

/** Wait until the engine has stopped scrolling, then return the position. */
async function settled() {
  let last = await y();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(180);
    const now = await y();
    if (Math.abs(now - last) < 1) return now;
    last = now;
  }
  return last;
}

// --- 1. no Back ------------------------------------------------------------
// Back only ever appeared from step 2 onwards, so walk a few steps.
for (let i = 0; i < 4; i++) {
  if (await card.getByRole('button', { name: /^Back$/ }).count()) failures.push(`Back button present at step ${i + 1}`);
  const next = card.getByRole('button', { name: /^(Next|Start|Finish|Done)$/ });
  if (await next.count()) await next.first().click();
  await page.waitForTimeout(400);
}

// --- 2. nothing behind moves ----------------------------------------------
const scrollRoom = await room();
if (scrollRoom < 200) failures.push(`page only has ${scrollRoom}px of scroll room — the scroll tests would pass vacuously`);

async function mustNotMove(label, act) {
  const before = await settled();
  await act();
  await page.waitForTimeout(400);
  const after = await y();
  if (Math.abs(after - before) > 2) failures.push(`${label} scrolled the page (${before} → ${after})`);
}

/**
 * Both gestures go through CDP's synthesizeScrollGesture rather than
 * page.mouse.wheel: that helper injects a wheel event straight into the
 * renderer, where it scrolls regardless of a blocking handler, so it reports a
 * leak that a real wheel does not have. synthesizeScrollGesture drives the same
 * input pipeline as real hardware and does honour preventDefault.
 */
const scrollGesture = (source) =>
  cdp.send('Input.synthesizeScrollGesture', {
    x: 195, y: 600, yDistance: -400, gestureSourceType: source, speed: 3000,
  });

await mustNotMove('wheel', () => scrollGesture('mouse'));

await mustNotMove('touch drag', () => scrollGesture('touch'));

/**
 * The same two gestures, started ON the tour card.
 *
 * This is where the lock leaked: the card is exempt so long copy stays
 * scrollable, but a card with nothing to scroll passed the gesture through to
 * the page, and the card is exactly where the thumb already is, because that is
 * where Next is. Tap Next, drag from the same spot, and the page slid out from
 * under the gold box.
 */
const cardBox = await card.boundingBox();
const cardGesture = (source) =>
  cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(cardBox.x + cardBox.width / 2),
    y: Math.round(cardBox.y + cardBox.height / 2),
    yDistance: -400,
    gestureSourceType: source,
    speed: 3000,
  });

await mustNotMove('wheel over the tour card', () => cardGesture('mouse'));
await mustNotMove('touch drag from the tour card', () => cardGesture('touch'));

for (const key of ['PageDown', 'End', 'Space', 'ArrowDown']) {
  await mustNotMove(key, () => page.keyboard.press(key));
}

// The listeners must be live AND non-passive, or preventDefault is ignored.
const prevented = await page.evaluate(() => ({
  wheel: !document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })),
  touchmove: !document.body.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true })),
}));
if (!prevented.wheel) failures.push('wheel event not cancelled — listener missing or passive');
if (!prevented.touchmove) failures.push('touchmove event not cancelled — listener missing or passive');

// Tab must not walk focus out of the card and onto a page control.
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
if (await page.evaluate(() => {
  const el = document.activeElement;
  const dialog = document.querySelector('[role="dialog"][aria-labelledby="tour-step-title"]');
  return !(el === document.body || (dialog && dialog.contains(el)));
})) failures.push('Tab moved focus onto a control behind the tour');

// The click gate: a tap on something that is not the anchor changes nothing.
const titleBefore = await card.locator('#tour-step-title').innerText();
await page.locator('header button, header a').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(300);
if ((await card.locator('#tour-step-title').innerText()) !== titleBefore) failures.push('a tap on the header changed the tour');

// --- 3. and it all comes back afterwards ----------------------------------
// Ending the run takes the demo data away, which leaves the pre-season page
// shorter than the viewport — so "did it scroll" has nothing to say here. The
// assertion that means something is that the guards were taken off.
await page.getByRole('button', { name: /Skip tour/i }).click();
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
const after = await page.evaluate(() => ({
  wheelStillBlocked: !document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })),
  touchStillBlocked: !document.body.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true })),
  bodyClass: document.body.className,
}));
if (after.wheelStillBlocked) failures.push('wheel still blocked after the tour ended');
if (after.touchStillBlocked) failures.push('touchmove still blocked after the tour ended');
if (after.bodyClass.includes('tour-running')) failures.push('tour-running left on <body>');
// And the keyboard guard is off: Tab moves focus again.
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
if (await page.evaluate(() => document.activeElement === document.body)) {
  failures.push('Tab still does nothing after the tour ended');
}

await browser.close();

if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ no Back button. With ${scrollRoom}px of scroll room: wheel, touch drag (page and card), PageDown/End/Space/ArrowDown, Tab and off-target taps all inert — and scrolling works again once the tour ends.`);
