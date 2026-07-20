/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { archiveCurrentSeason } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

// Season archive endpoint — port of legacy/server.js:6691-6731.
// Kept at the legacy path /api/archive-season (not under /admin).
export async function POST(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: 'Request error' }, { status: 400 });
  }
  // 1KB limit for archive request (legacy MAX_BODY_SIZE guard)
  if (Buffer.byteLength(body, 'utf8') > config.limits.MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  try {
    const { password } = JSON.parse(body);
    if (password !== config.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }
    const result = await archiveCurrentSeason();
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: 'Invalid request: ' + e.message }, { status: 400 });
  }
}

// Legacy served this JSON (200) for any non-POST method
function methodNotAllowed() {
  return NextResponse.json({ error: 'Use POST to archive' });
}
export async function GET() {
  return methodNotAllowed();
}
export async function PUT() {
  return methodNotAllowed();
}
export async function PATCH() {
  return methodNotAllowed();
}
export async function DELETE() {
  return methodNotAllowed();
}
