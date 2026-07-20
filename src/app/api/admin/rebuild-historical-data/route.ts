/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { dataCache, rebuildStatus } from '@/server/data-cache';
import { refreshAllData } from '@/server/services/refresh';
import { refreshWeekData } from '@/server/services/week';

export const dynamic = 'force-dynamic';

// Admin endpoint to rebuild all historical gameweek data —
// port of legacy/server.js:6799-6932.
// Clears all caches and re-fetches fresh data from FPL API
// This runs ASYNC - returns immediately and rebuilds in background
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
    if (password !== config.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // Check if rebuild is already in progress
    if (rebuildStatus.inProgress) {
      return NextResponse.json({
        success: false,
        error: 'Rebuild already in progress',
        status: rebuildStatus,
      });
    }

    console.log('[Admin] Starting async rebuild of all historical gameweek data...');

    // Count items before clearing
    const picksCount = Object.keys(dataCache.picksCache).length;
    const liveDataCount = Object.keys(dataCache.liveDataCache).length;
    const processedCount = Object.keys(dataCache.processedPicksCache).length;
    const tinkeringCount = Object.keys(dataCache.tinkeringCache).length;

    // Initialize rebuild status (legacy reassigns the object wholesale; the
    // singleton is mutated in place here, with the same resulting keys)
    Object.assign(rebuildStatus, {
      inProgress: true,
      startTime: Date.now(),
      phase: 'clearing',
      progress: 'Clearing caches...',
      error: null,
      result: null,
      cleared: { picksCount, liveDataCount, processedCount, tinkeringCount },
    } as any);

    // Clear ALL historical caches
    dataCache.picksCache = {};
    dataCache.liveDataCache = {};
    dataCache.processedPicksCache = {};
    dataCache.tinkeringCache = {};
    dataCache.formResultsCache = {};

    // Note: API-level caches (apiBootstrapCache, apiFixturesCache, apiLiveGWCache)
    // are NOT cleared here. They are short-lived (30s TTL) performance caches.
    // refreshAllData() already calls fetchBootstrapFresh() for fresh bootstrap data.
    // Clearing apiLiveGWCache would force re-fetching live data for ALL completed
    // GWs from the FPL API (hundreds of calls), when that data never changes.

    console.log(`[Admin] Cleared caches: ${picksCount} picks, ${liveDataCount} liveData, ${processedCount} processed, ${tinkeringCount} tinkering`);

    // Run rebuild in background (don't await - fire and forget)
    (async () => {
      try {
        rebuildStatus.phase = 'refreshing';
        rebuildStatus.progress = 'Fetching data from FPL API...';

        const refreshResult = await refreshAllData('admin-rebuild-historical');

        // Also refresh week data to use newly calculated points
        await refreshWeekData();

        const duration = ((Date.now() - (rebuildStatus.startTime as any)) / 1000).toFixed(1);

        if (!refreshResult.success) {
          console.error(`[Admin] Rebuild failed after ${duration}s:`, refreshResult.error);
          rebuildStatus.inProgress = false;
          rebuildStatus.phase = 'failed';
          rebuildStatus.error = refreshResult.error || 'Unknown error';
          return;
        }

        console.log(`[Admin] Rebuild complete in ${duration}s`);

        rebuildStatus.inProgress = false;
        rebuildStatus.phase = 'complete';
        rebuildStatus.progress = null;
        rebuildStatus.result = {
          duration: duration + 's',
          rebuilt: {
            picksCache: Object.keys(dataCache.picksCache).length,
            liveDataCache: Object.keys(dataCache.liveDataCache).length,
            processedPicksCache: Object.keys(dataCache.processedPicksCache).length,
            tinkeringCache: Object.keys(dataCache.tinkeringCache).length,
          },
        };
      } catch (e: any) {
        console.error('[Admin] Rebuild failed:', e);
        rebuildStatus.inProgress = false;
        rebuildStatus.phase = 'failed';
        rebuildStatus.error = e.message;
      }
    })();

    // Return immediately - rebuild runs in background
    return NextResponse.json({
      success: true,
      message: 'Rebuild started - poll /api/admin/rebuild-status for progress',
      cleared: { picksCount, liveDataCount, processedCount, tinkeringCount },
    });
  } catch (e: any) {
    console.error('[Admin] Rebuild historical data failed:', e);
    return NextResponse.json({ error: 'Rebuild failed: ' + e.message }, { status: 500 });
  }
}

// Legacy served this JSON (200) for any non-POST method
function methodNotAllowed() {
  return NextResponse.json({ error: 'Use POST method with admin password' });
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
