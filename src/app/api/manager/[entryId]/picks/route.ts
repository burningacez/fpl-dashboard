/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { fetchBootstrap } from '@/server/fpl/client';
import { fetchManagerPicksDetailed } from '@/server/services/picks';

export const dynamic = 'force-dynamic';

// Manager picks route: /api/manager/:entryId/picks
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
      if (dataCache.processedPicksCache[cacheKey]) {
        return NextResponse.json(dataCache.processedPicksCache[cacheKey]);
      }
    }

    // Cache miss or no GW param - need to fetch
    const bootstrap = await fetchBootstrap();
    const currentGW = gwParam ? parseInt(gwParam) : bootstrap.events.find((e: any) => e.is_current)?.id || 1;
    const cacheKey = `${entryId}-${currentGW}`;

    // Check cache again (for case where no GW param was provided)
    if (dataCache.processedPicksCache[cacheKey]) {
      return NextResponse.json(dataCache.processedPicksCache[cacheKey]);
    }

    // Fetch and process (pass bootstrap to avoid duplicate fetch)
    const data = await fetchManagerPicksDetailed(entryId, currentGW, bootstrap);

    // Cache result for completed GWs
    const gwEvent = bootstrap.events.find((e: any) => e.id === currentGW);
    if (gwEvent?.finished) {
      dataCache.processedPicksCache[cacheKey] = data;
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
