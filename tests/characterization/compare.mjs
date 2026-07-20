#!/usr/bin/env node
/**
 * Characterization compare — deep-diff two capture directories produced by
 * capture.mjs (legacy vs rewrite), ignoring a small allowlist of volatile
 * fields. Exit code 1 when any endpoint differs.
 *
 * Usage:
 *   node tests/characterization/compare.mjs tests/characterization/fixtures/legacy tests/characterization/fixtures/next
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error('Usage: compare.mjs <legacyDir> <nextDir>');
  process.exit(1);
}

// Volatile fields that legitimately differ between two capture runs.
const VOLATILE_KEYS = new Set([
  'lastRefresh',
  'lastWeekRefresh',
  'lastUpdated',
  'lastUpdate',
  'timestamp',
  'ts',
  'archivedAt',
  'generatedAt',
  'lastSuccessTime',
  'lastErrorTime',
]);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

function diffPaths(a, b, prefix = '', out = [], limit = 25) {
  if (out.length >= limit) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${prefix}: array length ${a.length} vs ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++) diffPaths(a[i], b[i], `${prefix}[${i}]`, out, limit);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) {
        out.push(`${prefix}.${k}: missing in legacy (rewrite adds it)`);
        continue;
      }
      if (!(k in b)) {
        out.push(`${prefix}.${k}: missing in rewrite`);
        continue;
      }
      diffPaths(a[k], b[k], `${prefix}.${k}`, out, limit);
      if (out.length >= limit) return out;
    }
    return out;
  }
  if (a !== b) out.push(`${prefix}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

// Deliberate rewrite deviations: entryId added for my-team highlighting.
const EXPECTED_ADDITIONS = /\.(entryId|entry)\b.*missing in legacy/;

const main = async () => {
  const files = (await readdir(dirA)).filter((f) => f.endsWith('.json'));
  let failures = 0;

  for (const f of files) {
    let a, b;
    try {
      a = JSON.parse(await readFile(path.join(dirA, f), 'utf8'));
      b = JSON.parse(await readFile(path.join(dirB, f), 'utf8'));
    } catch (e) {
      console.log(`✗ ${f}: ${e.message}`);
      failures++;
      continue;
    }
    const diffs = diffPaths(strip(a), strip(b), f.replace('.json', '')).filter(
      (d) => !EXPECTED_ADDITIONS.test(d),
    );
    if (diffs.length === 0) {
      console.log(`✓ ${f}`);
    } else {
      failures++;
      console.log(`✗ ${f}:`);
      diffs.forEach((d) => console.log(`    ${d}`));
    }
  }

  console.log(failures === 0 ? '\nAll endpoints match.' : `\n${failures} endpoint(s) differ.`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
