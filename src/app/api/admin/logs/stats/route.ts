import { NextRequest, NextResponse } from 'next/server';
import { adminAuthorized } from '@/server/admin-auth';
import { getStats } from '@/server/logger';

export const dynamic = 'force-dynamic';

// Admin endpoint to get log stats summary — port of legacy/server.js:6785-6794.
export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(getStats());
}
