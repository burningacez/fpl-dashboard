/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { fetchBootstrap } from '@/server/fpl/client';
import { calculateTinkeringImpact } from '@/server/services/tinkering';

export const dynamic = 'force-dynamic';

// Manager tinkering route: /api/manager/:entryId/tinkering
export async function GET(req: NextRequest, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const { entryId: entryIdParam } = await params;
    const entryId = parseInt(entryIdParam);
    if (isNaN(entryId)) {
      return NextResponse.json({ error: 'Invalid entry ID' }, { status: 400 });
    }
    const gwParam = req.nextUrl.searchParams.get('gw');

    // If GW is provided, check cache FIRST (no network calls needed)
    if (gwParam) {
      const gwNum = parseInt(gwParam);
      if (isNaN(gwNum) || gwNum < 1 || gwNum > 38) {
        return NextResponse.json({ error: 'Invalid gameweek parameter' }, { status: 400 });
      }
      const cacheKey = `${entryId}-${gwNum}`;
      if (dataCache.tinkeringCache[cacheKey]) {
        // Return cached data with updated navigation
        const cached = { ...dataCache.tinkeringCache[cacheKey] };
        return NextResponse.json(cached);
      }
    }

    // Cache miss - need to calculate
    const bootstrap = await fetchBootstrap();
    const currentGW = gwParam ? parseInt(gwParam) : bootstrap.events.find((e: any) => e.is_current)?.id || 1;
    const data = await calculateTinkeringImpact(entryId, currentGW);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
