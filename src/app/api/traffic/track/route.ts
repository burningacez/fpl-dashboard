import { NextRequest, NextResponse } from 'next/server';
import { ensureDeviceToken, setDeviceCookie } from '@/server/identity-cookie';
import { isBotUserAgent, normalizeTrackedPath } from '@/lib/traffic';
import { trackView } from '@/server/traffic';

export const dynamic = 'force-dynamic';

/**
 * Page-view beacon target. Called by TrafficTracker (navigator.sendBeacon)
 * on every client-side navigation. Deliberately unauthenticated — it only
 * increments counters, and the path allowlist plus bot filter keep junk out.
 */
export async function POST(req: NextRequest) {
  const body = await req.text().catch(() => '');
  let path: unknown;
  try {
    path = (JSON.parse(body) as { path?: unknown }).path;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const normalized = normalizeTrackedPath(path);
  if (!normalized || isBotUserAgent(req.headers.get('user-agent'))) {
    return new NextResponse(null, { status: 204 });
  }

  const { token, isNew } = ensureDeviceToken(req);
  trackView(normalized, token);

  const res = new NextResponse(null, { status: 204 });
  if (isNew) setDeviceCookie(res, token);
  return res;
}
