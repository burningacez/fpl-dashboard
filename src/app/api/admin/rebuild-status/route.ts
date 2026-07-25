/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { adminAuthorized } from '@/server/admin-auth';
import { dataCache, rebuildStatus } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

// Admin endpoint to check rebuild status — port of legacy/server.js:6734-6750.
// Legacy served this without auth; it leaks cache internals, so the rewrite
// requires the x-admin-key header like every other admin GET.
export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const elapsed = rebuildStatus.startTime
    ? ((Date.now() - (rebuildStatus.startTime as any)) / 1000).toFixed(1) + 's'
    : null;
  return NextResponse.json({
    ...rebuildStatus,
    elapsed,
    cacheStats: {
      picksCache: Object.keys(dataCache.picksCache).length,
      liveDataCache: Object.keys(dataCache.liveDataCache).length,
      processedPicksCache: Object.keys(dataCache.processedPicksCache).length,
      weekHistoryCache: Object.keys(dataCache.weekHistoryCache).length,
      tinkeringCache: Object.keys(dataCache.tinkeringCache).length,
    },
  });
}
