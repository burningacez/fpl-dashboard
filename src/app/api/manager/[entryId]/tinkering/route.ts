/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { fetchBootstrap } from '@/server/fpl/client';
import { calculateTinkeringImpact } from '@/server/services/tinkering';

export const dynamic = 'force-dynamic';

// Manager tinkering route: /api/manager/:entryId/tinkering
// The service handles caching (and always computes fresh navigation), so the
// route just validates params and delegates.
export async function GET(req: NextRequest, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const { entryId: entryIdParam } = await params;
    const entryId = parseInt(entryIdParam);
    if (isNaN(entryId)) {
      return NextResponse.json({ error: 'Invalid entry ID' }, { status: 400 });
    }
    const gwParam = req.nextUrl.searchParams.get('gw');

    let gw: number;
    if (gwParam) {
      gw = parseInt(gwParam);
      if (isNaN(gw) || gw < 1 || gw > 38) {
        return NextResponse.json({ error: 'Invalid gameweek parameter' }, { status: 400 });
      }
    } else {
      const bootstrap = await fetchBootstrap();
      gw = bootstrap.events.find((e: any) => e.is_current)?.id || 1;
    }

    const data = await calculateTinkeringImpact(entryId, gw);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
