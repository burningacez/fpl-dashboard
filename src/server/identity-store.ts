import 'server-only';
import crypto from 'node:crypto';
import { redisGet, redisSet } from './redis';
import { isAdminPassword } from './admin-auth';
import { dataCache } from './data-cache';
import { fetchLeagueData } from './fpl/client';
import { fetchLeagueRosterThrottled, inPreSeason } from './services/roster';
import { pickCode, type ClaimRegistry, type Member } from '@/lib/identity';

/**
 * Server-side identity ownership store.
 *
 * Two tiny blobs in Redis (whole-value read-modify-write — fine for a ~20-person
 * league), mirrored in memory so dev without Redis still works (non-persistent).
 * There is deliberately no locking; concurrent claims for the SAME team within
 * the same millisecond are vanishingly unlikely here, and the claim decision is
 * idempotent enough that the worst case is a last-writer-wins on the registry.
 *
 * - `identity-claims`      → ClaimRegistry (nameKey → holder + device token)
 * - `identity-switch-code` → { code, updatedAt }
 */

const CLAIMS_KEY = 'identity-claims';
const CODE_KEY = 'identity-switch-code';

interface SwitchCode {
  code: string;
  updatedAt: string;
}

// In-memory mirror (source of truth when Redis is unconfigured).
let claimsMemory: ClaimRegistry | null = null;
let codeMemory: SwitchCode | null = null;

function generateCode(): string {
  return pickCode((maxExclusive) => crypto.randomInt(maxExclusive));
}

export function newDeviceToken(): string {
  return crypto.randomUUID();
}

export async function getClaims(): Promise<ClaimRegistry> {
  const stored = await redisGet<ClaimRegistry>(CLAIMS_KEY);
  if (stored && typeof stored === 'object') {
    claimsMemory = stored;
    return stored;
  }
  return claimsMemory ?? {};
}

export async function saveClaims(registry: ClaimRegistry): Promise<void> {
  claimsMemory = registry;
  await redisSet(CLAIMS_KEY, registry);
}

export async function getSwitchCode(): Promise<string> {
  const stored = await redisGet<SwitchCode>(CODE_KEY);
  if (stored?.code) {
    codeMemory = stored;
    return stored.code;
  }
  if (codeMemory?.code) return codeMemory.code;
  // First read ever — generate and persist a code.
  return rotateSwitchCode();
}

export async function rotateSwitchCode(): Promise<string> {
  const next: SwitchCode = { code: generateCode(), updatedAt: new Date().toISOString() };
  codeMemory = next;
  await redisSet(CODE_KEY, next);
  return next.code;
}

/** Constant-ish comparison for the human-entered code (trim + case-insensitive). */
export function codeMatches(input: string | null | undefined, actual: string): boolean {
  return typeof input === 'string' && input.trim().toUpperCase() === actual.toUpperCase();
}

/** Admin password check, mirroring the other admin endpoints. */
export function isAdmin(password: unknown): boolean {
  return isAdminPassword(password);
}

/**
 * Current-season league members — same source as /api/members: the standings
 * cache, with a live league fetch as a cold-start fallback.
 *
 * Pre-season the order is reversed: entrants join right up to the GW1 deadline,
 * so the roster is read live (throttled to one FPL call per 30s, shared with
 * the roster poller) and the standings snapshot is only the fallback. Waiting
 * for the snapshot would mean a joiner is invisible to the picker until the
 * next roster poll lands.
 */
export async function getCurrentMembers(): Promise<Member[]> {
  if (await inPreSeason()) {
    try {
      const live = await fetchLeagueRosterThrottled();
      const rows = live.standings?.results ?? [];
      if (rows.length) {
        return rows.map((m) => ({ entryId: m.entry, name: m.player_name, team: m.entry_name }));
      }
    } catch (error) {
      console.warn('[Members] Live pre-season roster read failed:', (error as Error).message);
    }
  }

  const cached = dataCache.standings?.standings as
    | { entryId: number; name: string; team: string }[]
    | undefined;
  if (cached?.length) {
    return cached.map((m) => ({ entryId: m.entryId, name: m.name, team: m.team }));
  }
  const ld = await fetchLeagueData();
  return ld.standings.results.map((m) => ({ entryId: m.entry, name: m.player_name, team: m.entry_name }));
}
