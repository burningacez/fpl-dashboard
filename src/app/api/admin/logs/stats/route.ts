import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { getStats } from '@/server/logger';

export const dynamic = 'force-dynamic';

// Admin endpoint to get log stats summary — port of legacy/server.js:6785-6794.
export async function GET(req: NextRequest) {
  const authPassword = req.nextUrl.searchParams.get('password') || req.headers.get('x-admin-password');
  if (authPassword !== config.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(getStats());
}
