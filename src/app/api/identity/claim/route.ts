import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getCurrentSeason } from '@/server/season-state';
import { getClaims, saveClaims, getCurrentMembers } from '@/server/identity-store';
import { ensureDeviceToken, setDeviceCookie } from '@/server/identity-cookie';
import { decideClaim } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * Claim a team for this device. Enforces single ownership server-side:
 * - 409 { reason: 'taken' }  — another device already holds this team.
 * - 409 { reason: 'locked' } — this device already holds a team (use the
 *   switch code to change).
 * - 400 — entryId isn't a current-season member.
 */
export async function POST(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: 'Request error' }, { status: 400 });
  }
  if (Buffer.byteLength(body, 'utf8') > config.limits.MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }

  const { token, isNew } = ensureDeviceToken(req);

  try {
    const { entryId } = JSON.parse(body) as { entryId?: number };
    const members = await getCurrentMembers();
    const member = members.find((m) => m.entryId === Number(entryId));
    if (!member) {
      return NextResponse.json({ error: 'Not a current league member' }, { status: 400 });
    }

    const registry = await getClaims();
    const decision = decideClaim(registry, token, member, getCurrentSeason());
    if (!decision.ok) {
      const res = NextResponse.json({ error: 'Cannot claim', reason: decision.reason }, { status: 409 });
      if (isNew) setDeviceCookie(res, token);
      return res;
    }

    await saveClaims(decision.registry);
    const r = decision.record!;
    const res = NextResponse.json({
      status: 'member',
      entryId: r.entryId,
      name: r.name,
      team: r.team,
      nameKey: r.nameKey,
      season: r.season,
    });
    if (isNew) setDeviceCookie(res, token);
    return res;
  } catch (e) {
    return NextResponse.json({ error: 'Invalid request: ' + (e as Error).message }, { status: 400 });
  }
}
