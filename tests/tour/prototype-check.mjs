#!/usr/bin/env node
/**
 * Drives the standalone tour prototype (the artifact HTML) end to end: walks
 * every step by making the tap the step asks for, screenshots each one, and
 * checks the click gate actually blocks everything else.
 *
 *   node tests/tour/prototype-check.mjs prototypes/scores-tour.html /tmp/shots [width height]
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [file, outDir = 'shots', W = '390', H = '844'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: prototype-check.mjs <html-file> <outDir> [width height]');
  process.exit(1);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({
    viewport: { width: Number(W), height: Number(H) },
    deviceScaleFactor: 2,
    hasTouch: true,
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const failures = [];
  const card = page.locator('#tourCard');
  await card.waitFor({ state: 'visible', timeout: 5000 });

  // --- the gate: a tap somewhere irrelevant must change nothing -------------
  const before = await page.locator('#tourTitle').innerText();
  await page.locator('.burger').click({ force: true });
  await page.locator('.gw-stepper__val').click({ force: true });
  await page.waitForTimeout(250);
  if ((await page.locator('#tourTitle').innerText()) !== before) {
    failures.push('an off-target tap advanced the tour');
  }
  if ((await page.locator('#sheets .sheet').count()) > 0) {
    failures.push('an off-target tap opened a sheet');
  }

  // --- walk every step -----------------------------------------------------
  const seen = [];
  for (let n = 1; n <= 60; n++) {
    await page.waitForTimeout(230);
    if (await page.locator('#tour').evaluate((el) => el.hidden)) break; // finished
    const counter = await page.locator('#tourCount').innerText();
    const title = await page.locator('#tourTitle').innerText();
    const edge = await card.getAttribute('data-edge');
    const hasSpot = (await page.locator('.tour__spot').count()) > 0;
    const cta = (await page.locator('#tourCta').isVisible()) ? await page.locator('#tourCtaText').innerText() : '';
    seen.push({ counter, title, edge, hasSpot, cta });

    // The gold box must be inside the phone, and must not be hidden behind the
    // card — that is the "make sure the thing to be seen is shown" contract.
    if (hasSpot) {
      const box = await page.locator('.tour__spot').boundingBox();
      const phone = await page.locator('#phone').boundingBox();
      const cardBox = await card.boundingBox();
      if (box.y + box.height < phone.y || box.y > phone.y + phone.height) {
        failures.push(`${title}: gold box is off-screen`);
      }
      const overlap = Math.min(box.y + box.height, cardBox.y + cardBox.height) - Math.max(box.y, cardBox.y);
      if (overlap > Math.min(box.height, cardBox.height) * 0.5) {
        failures.push(`${title}: card covers the gold box (overlap ${Math.round(overlap)}px)`);
      }
    }

    await page.screenshot({ path: `${outDir}/${String(n).padStart(2, '0')}.png` });

    const nextBtn = page.locator('#tourNext');
    if (await nextBtn.isVisible()) {
      const label = await nextBtn.innerText();
      await nextBtn.click();
      if (label === 'Done') break;
    } else {
      // A tap step: the only permitted target is the current anchor.
      const spot = page.locator('.tour__spot');
      if ((await spot.count()) === 0) { failures.push(`${title}: tap step with no anchor`); break; }
      const b = await spot.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
  }

  for (const s of seen) {
    console.log(`${s.hasSpot ? '◉' : '○'} ${s.edge.padEnd(6)} ${s.counter.replace(/\s*Example data/, '').padEnd(18)} ${s.title}${s.cta ? `  → ${s.cta}` : ''}`);
  }

  // --- after the tour: demo data gone, See demo available ------------------
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    tourHidden: document.getElementById('tour').hidden,
    sheets: document.querySelectorAll('#sheets .sheet').length,
    banner: document.querySelectorAll('[data-tour="banner"]').length,
    demoBtn: document.querySelectorAll('[data-tour="demo-btn"]').length,
    dimmed: document.querySelectorAll('tr.is-dim').length,
  }));
  console.log('\nAfter:', JSON.stringify(after));
  if (!after.tourHidden) failures.push('tour overlay still up');
  if (after.sheets !== 0) failures.push('a sheet was left open');
  if (after.banner !== 0) failures.push('example-data banner still showing');
  if (after.dimmed !== 0) failures.push('table left dimmed');
  if (after.demoBtn !== 1) failures.push('See demo button missing after the tour');

  if (errors.length) failures.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ ${seen.length} steps, gate holds, gold box always visible, state restored.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
