import { NextRequest, NextResponse } from 'next/server';
import { adminAuthorized } from '@/server/admin-auth';
import { getSummary, resetStats } from '@/server/traffic';
import { getClaims, getCurrentMembers } from '@/server/identity-store';
import { normalizeNameKey } from '@/lib/identity';

export const dynamic = 'force-dynamic';

// Admin endpoint for traffic analytics — same auth pattern as /api/admin/logs
// (x-admin-key header only).
function checkAuth(req: NextRequest): NextResponse | null {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  const daysParam = parseInt(req.nextUrl.searchParams.get('days') ?? '', 10);
  const rangeDays = Number.isFinite(daysParam) ? daysParam : 30; // <= 0 means whole season
  const summary = getSummary(rangeDays);

  // Decorate nameKeys with display name/team: live claims first, then the
  // members list (a released claim still has history under its nameKey).
  const [claims, members] = await Promise.all([
    getClaims(),
    getCurrentMembers().catch(() => []),
  ]);
  const decorate = (u: (typeof summary.users)[number]) => {
    const claim = claims[u.nameKey];
    const member = members.find((m) => normalizeNameKey(m.name) === u.nameKey);
    return {
      ...u,
      name: claim?.name ?? member?.name ?? u.nameKey,
      team: claim?.team ?? member?.team ?? '',
      claimedAt: claim?.claimedAt ?? null,
    };
  };

  // Claimants with no recorded views at all still get a (blank) row, so the
  // admin can open any claimed member and see that they've never been on.
  const tracked = new Set(summary.users.map((u) => u.nameKey));
  const silent = Object.values(claims)
    .filter((c) => !tracked.has(c.nameKey))
    .map((c) => ({ nameKey: c.nameKey, views: 0, firstSeen: '', lastSeen: '', days: [], pages: [] }));

  const users = [...summary.users, ...silent].map(decorate);

  return NextResponse.json({ ...summary, users });
}

export async function DELETE(req: NextRequest) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  await resetStats();
  return NextResponse.json({ success: true, message: 'Traffic stats reset' });
}
