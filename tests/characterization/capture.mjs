#!/usr/bin/env node
/**
 * Characterization capture — snapshot every JSON API endpoint of a RUNNING
 * app instance (legacy or rewrite) into a directory of .json files.
 *
 * Usage:
 *   node tests/characterization/capture.mjs http://localhost:3001 tests/characterization/fixtures/legacy
 *   node tests/characterization/capture.mjs http://localhost:3000 tests/characterization/fixtures/next
 *
 * Then diff the two directories with compare.mjs. Run both captures within a
 * short window while NO live matches are in progress, so both apps compute
 * from the same upstream FPL state.
 *
 * Optional third arg: a comma-separated list of manager entry IDs to snapshot
 * (defaults to reading them from /api/standings), e.g. "1405359,70252".
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [base, outDir, entryIdsArg] = process.argv.slice(2);
if (!base || !outDir) {
  console.error('Usage: capture.mjs <baseUrl> <outDir> [entryIds]');
  process.exit(1);
}

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { __nonJson: text.slice(0, 200) } };
  }
};

const save = async (name, payload) => {
  const file = path.join(outDir, `${name}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2));
  console.log(`saved ${name} (HTTP ${payload.status})`);
};

const STATIC_ENDPOINTS = [
  ['seasons', '/api/seasons'],
  ['league', '/api/league'],
  ['standings', '/api/standings'],
  ['losers', '/api/losers'],
  ['motm', '/api/motm'],
  ['chips', '/api/chips'],
  ['earnings', '/api/earnings'],
  ['hall-of-fame', '/api/hall-of-fame'],
  ['set-and-forget', '/api/set-and-forget'],
  ['week', '/api/week'],
  ['analytics', '/api/analytics'],
  ['cup', '/api/cup'],
  ['form', '/api/form'],
  ['standings-history', '/api/standings/history'],
];

const main = async () => {
  for (const [name, p] of STATIC_ENDPOINTS) {
    await save(name, await get(p));
  }

  // Discover managers + completed GWs from standings/week
  const standings = (await get('/api/standings')).body;
  const entryIds = entryIdsArg
    ? entryIdsArg.split(',').map(Number)
    : (standings?.standings || []).map((m) => m.entryId).filter(Boolean);

  const week = (await get('/api/week')).body;
  const currentGw = week?.currentGW ?? week?.gw ?? null;
  const historyGws = currentGw
    ? [1, Math.max(1, currentGw - 2), Math.max(1, currentGw - 1)].filter((v, i, a) => a.indexOf(v) === i)
    : [1];

  for (const gw of historyGws) {
    await save(`week-history-gw${gw}`, await get(`/api/week/history?gw=${gw}`));
  }

  for (const id of entryIds) {
    await save(`manager-${id}-picks`, await get(`/api/manager/${id}/picks`));
    await save(`manager-${id}-profile`, await get(`/api/manager/${id}/profile`));
    await save(`manager-${id}-tinkering`, await get(`/api/manager/${id}/tinkering`));
  }

  if (entryIds.length >= 2) {
    await save('h2h-sample', await get(`/api/h2h?manager1=${entryIds[0]}&manager2=${entryIds[1]}`));
  }

  console.log(`\nCapture complete → ${outDir}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
