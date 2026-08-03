import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSeason } from '@/server/season-state';
import { getClaims, saveClaims, getCurrentMembers } from '@/server/identity-store';
import { ensureDeviceToken, setDeviceCookie } from '@/server/identity-cookie';
import {
  findClaimForDevice,
  resolveAgainstMembers,
  claimToIdentity,
  claimNeedsTouch,
  type MemberIdentity,
} from '@/lib/identity';
import { previewAllowed } from '@/server/preview-access';

export const dynamic = 'force-dynamic';

/**
 * The claim held by this device, resolved against the current league (self-heal
 * renames and season rollover by nameKey). Mints a device cookie on first hit.
 * Returns { status: 'member' | 'ex-member' | 'unclaimed', ...identity, features }.
 *
 * Also the claim's liveness heartbeat: each check-in re-stamps lastSeenAt
 * (throttled to once per CLAIM_TOUCH_INTERVAL_MS), which is what keeps the
 * claim "active" and therefore un-evictable by other devices.
 *
 * `features` carries the preview-gated flags for whoever this is, decided here
 * because a client-side check would ship the gate, and the allowlist, to
 * anyone who reads the bundle (see server/preview-access.ts). This endpoint
 * already runs on every page load and already knows who the caller is, so it is
 * the natural place for per-user feature flags to arrive.
 */
export async function GET(req: NextRequest) {
  const { token, isNew } = ensureDeviceToken(req);

  let body: {
    status: 'member' | 'ex-member' | 'unclaimed';
    entryId?: number;
    name?: string;
    team?: string;
    nameKey?: string;
    season?: string;
  } = { status: 'unclaimed' };

  if (!isNew) {
    const registry = await getClaims();
    const held = findClaimForDevice(registry, token);
    if (held) {
      const identity = claimToIdentity(held.record);
      let members: Awaited<ReturnType<typeof getCurrentMembers>> = [];
      try {
        members = await getCurrentMembers();
      } catch {
        members = [];
      }
      // Only resolve when we actually have a member list; a failed fetch must
      // not demote a real holder to ex-member.
      const resolved =
        members.length > 0
          ? resolveAgainstMembers(identity, members, getCurrentSeason())
          : { identity, status: 'member' as const, changed: false };

      const id = (resolved.identity ?? identity) as MemberIdentity;

      // Persist when the resolved identity changed (rename/rollover) or the
      // liveness heartbeat is due. Ex-members heartbeat too — their device is
      // demonstrably alive, so their claim must not become evictable.
      const changed = resolved.changed && resolved.status === 'member';
      if (changed || claimNeedsTouch(held.record)) {
        const next = { ...registry };
        // Re-key if the nameKey changed (rename), preserving single ownership.
        delete next[held.nameKey];
        next[id.nameKey] = {
          entryId: id.entryId,
          name: id.name,
          nameKey: id.nameKey,
          team: id.team,
          deviceToken: token,
          season: id.season,
          claimedAt: held.record.claimedAt,
          lastSeenAt: new Date().toISOString(),
        };
        await saveClaims(next);
      }

      body = {
        status: resolved.status === 'ex-member' ? 'ex-member' : 'member',
        entryId: id.entryId,
        name: id.name,
        team: id.team,
        nameKey: id.nameKey,
        season: id.season,
      };
    }
  }

  // Entry id 0 for a device with no claim: a gated feature won't admit it (it
  // can't be on the allowlist), and a released one is open to everyone anyway,
  // which is what we want for the walkthrough, whose whole audience is people
  // who haven't got their bearings yet.
  const res = NextResponse.json({
    ...body,
    features: {
      scoresWalkthrough: previewAllowed('scores-walkthrough', body.entryId ?? 0),
    },
  });
  if (isNew) setDeviceCookie(res, token);
  return res;
}
