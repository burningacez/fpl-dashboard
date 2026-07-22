import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getSummary, resetStats } from '@/server/traffic';
import { getClaims, getCurrentMembers } from '@/server/identity-store';
import { normalizeNameKey } from '@/lib/identity';

export const dynamic = 'force-dynamic';

// Admin endpoint for traffic analytics — same auth pattern as /api/admin/logs.
function checkAuth(req: NextRequest): NextResponse | null {
  const authPassword = req.nextUrl.searchParams.get('password') || req.headers.get('x-admin-password');
  if (authPassword !== config.ADMIN_PASSWORD) {
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
  const users = summary.users.map((u) => {
    const claim = claims[u.nameKey];
    const member = members.find((m) => normalizeNameKey(m.name) === u.nameKey);
    return {
      ...u,
      name: claim?.name ?? member?.name ?? u.nameKey,
      team: claim?.team ?? member?.team ?? '',
    };
  });

  return NextResponse.json({ ...summary, users });
}

export async function DELETE(req: NextRequest) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  await resetStats();
  return NextResponse.json({ success: true, message: 'Traffic stats reset' });
}
