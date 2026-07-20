/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { dataCache, rebuildStatus } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

// Admin endpoint to check rebuild status — port of legacy/server.js:6734-6750.
// Legacy has no password check or method branching on this route.
export async function GET() {
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
