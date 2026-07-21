import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getSwitchCode, rotateSwitchCode, isAdmin } from '@/server/identity-store';

export const dynamic = 'force-dynamic';

/** GET (?password=) → current switch code. Owner-visible at all times. */
export async function GET(req: NextRequest) {
  if (!isAdmin(req.nextUrl.searchParams.get('password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  return NextResponse.json({ code: await getSwitchCode() });
}

/** POST { password } → regenerate the code manually. */
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
    const { password } = JSON.parse(body);
    if (!isAdmin(password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }
    return NextResponse.json({ code: await rotateSwitchCode() });
  } catch (e) {
    return NextResponse.json({ error: 'Invalid request: ' + (e as Error).message }, { status: 400 });
  }
}
