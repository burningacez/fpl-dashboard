import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getClaims, saveClaims, getSwitchCode, rotateSwitchCode, codeMatches } from '@/server/identity-store';
import { ensureDeviceToken, setDeviceCookie } from '@/server/identity-cookie';
import { applySwitch } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * Switch teams: validate the admin-issued code, release this device's claim,
 * and ROTATE the code so it can't be reused. The client then reopens the
 * picker to claim a new team.
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
    const { code } = JSON.parse(body) as { code?: string };
    const actual = await getSwitchCode();
    if (!codeMatches(code, actual)) {
      const res = NextResponse.json({ error: 'Invalid code' }, { status: 401 });
      if (isNew) setDeviceCookie(res, token);
      return res;
    }

    const registry = await getClaims();
    const { registry: next } = applySwitch(registry, token);
    await saveClaims(next);
    await rotateSwitchCode(); // single-use: the code is now dead

    const res = NextResponse.json({ success: true });
    if (isNew) setDeviceCookie(res, token);
    return res;
  } catch (e) {
    return NextResponse.json({ error: 'Invalid request: ' + (e as Error).message }, { status: 400 });
  }
}
