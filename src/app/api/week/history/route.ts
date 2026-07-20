/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { buildWeekHistoryOnDemand } from '@/server/services/refresh';

export const dynamic = 'force-dynamic';

// Historical week data route: /api/week/history?gw=N
// Serves from pre-built cache when available, falls back to on-demand computation.
export async function GET(req: NextRequest) {
  try {
    const gwParam = req.nextUrl.searchParams.get('gw');
    if (!gwParam) {
      return NextResponse.json({ error: 'gw parameter is required' }, { status: 400 });
    }
    const gw = parseInt(gwParam);
    if (isNaN(gw) || gw < 1 || gw > 38) {
      return NextResponse.json({ error: 'Invalid gameweek' }, { status: 400 });
    }

    const currentGW = dataCache.week?.currentGW || gw;

    // Serve from pre-built cache (populated at startup/daily refresh)
    const cached = dataCache.weekHistoryCache[gw];
    if (cached) {
      return NextResponse.json({ ...cached, currentGW });
    }

    // Cache miss — build on-demand for this single GW
    console.log(`[WeekHistory] Cache miss for GW ${gw}, building on-demand...`);
    const data = await buildWeekHistoryOnDemand(gw);
    return NextResponse.json({ ...data, currentGW });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
