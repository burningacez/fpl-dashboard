import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getClaims, saveClaims, getCurrentMembers } from '@/server/identity-store';
import { ensureDeviceToken, setDeviceCookie } from '@/server/identity-cookie';
import { findClaimForDevice, resolveAgainstMembers, claimToIdentity, type MemberIdentity } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * The claim held by this device, resolved against the current league (self-heal
 * renames and season rollover by nameKey). Mints a device cookie on first hit.
 * Returns { status: 'member' | 'ex-member' | 'unclaimed', ...identity }.
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
          ? resolveAgainstMembers(identity, members, config.CURRENT_SEASON)
          : { identity, status: 'member' as const, changed: false };

      const id = (resolved.identity ?? identity) as MemberIdentity;

      if (resolved.changed && resolved.status === 'member') {
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

  const res = NextResponse.json(body);
  if (isNew) setDeviceCookie(res, token);
  return res;
}
