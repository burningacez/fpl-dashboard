/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getLogs, clearLogs } from '@/server/logger';

export const dynamic = 'force-dynamic';

// Admin endpoint to get logs (requires password in query or header) —
// port of legacy/server.js:6753-6782.
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

  const url = req.nextUrl;
  const filters = {
    level: url.searchParams.get('level') || undefined,
    category: url.searchParams.get('category') || undefined,
    search: url.searchParams.get('search') || undefined,
    since: url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!, 10) : undefined,
    limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 500,
    offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0,
  };
  return NextResponse.json(getLogs(filters));
}

export async function DELETE(req: NextRequest) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  await clearLogs();
  return NextResponse.json({ success: true, message: 'Logs cleared' });
}

// Legacy served this JSON (200) for other methods (after the password check)
function methodNotAllowed(req: NextRequest) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ error: 'Use GET or DELETE' });
}
export async function POST(req: NextRequest) {
  return methodNotAllowed(req);
}
export async function PUT(req: NextRequest) {
  return methodNotAllowed(req);
}
export async function PATCH(req: NextRequest) {
  return methodNotAllowed(req);
}
