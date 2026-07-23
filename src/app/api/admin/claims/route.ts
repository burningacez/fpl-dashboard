import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getClaims, saveClaims, isAdmin } from '@/server/identity-store';
import { isClaimActive } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * GET (?password=) → current claim holders (no device tokens exposed).
 * `active: false` marks a stale claim — one whose device hasn't checked in
 * recently (or ever, for pre-liveness records). Stale claims don't block a
 * re-claim; they're listed so the admin can see and prune leftovers.
 */
export async function GET(req: NextRequest) {
  if (!isAdmin(req.nextUrl.searchParams.get('password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const registry = await getClaims();
  const claims = Object.values(registry)
    .map((c) => ({
      nameKey: c.nameKey,
      name: c.name,
      team: c.team,
      claimedAt: c.claimedAt,
      lastSeenAt: c.lastSeenAt ?? null,
      active: isClaimActive(c),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ claims });
}

/** DELETE { password, nameKey } → release a stuck member's claim. */
export async function DELETE(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: 'Request error' }, { status: 400 });
  }
  if (Buffer.byteLength(body, 'utf8') > config.limits.MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  try {
    const { password, nameKey } = JSON.parse(body) as { password?: string; nameKey?: string };
    if (!isAdmin(password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }
    const registry = await getClaims();
    if (nameKey && registry[nameKey]) {
      const next = { ...registry };
      delete next[nameKey];
      await saveClaims(next);
      return NextResponse.json({ success: true, released: nameKey });
    }
    return NextResponse.json({ success: false, error: 'No such claim' }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: 'Invalid request: ' + (e as Error).message }, { status: 400 });
  }
}
