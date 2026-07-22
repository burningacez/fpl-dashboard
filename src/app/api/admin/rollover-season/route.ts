import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { rolloverSeason } from '@/server/services/rollover';

export const dynamic = 'force-dynamic';

/**
 * Admin: start a new season. Archives the current season, flips the active
 * season pointer, and resets caches — see rolloverSeason for the sequence.
 * Body: { password, nextSeason, skipSnapshot? }
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

  try {
    const { password, nextSeason, skipSnapshot } = JSON.parse(body) as {
      password?: string;
      nextSeason?: string;
      skipSnapshot?: boolean;
    };
    if (password !== config.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }
    if (!nextSeason || typeof nextSeason !== 'string') {
      return NextResponse.json({ error: 'nextSeason is required' }, { status: 400 });
    }

    const result = await rolloverSeason(nextSeason, { skipSnapshot: Boolean(skipSnapshot) });
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ error: 'Rollover failed: ' + (e as Error).message }, { status: 500 });
  }
}
