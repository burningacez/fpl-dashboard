/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { fetchStandingsAsOfGW } from '@/server/services/standings-history';

export const dynamic = 'force-dynamic';

// Historical standings route: /api/standings/history?gw=N
// Returns season standings as of the end of the specified gameweek
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

    const result = await fetchStandingsAsOfGW(gw);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to load historical standings: ' + error.message }, { status: 500 });
  }
}
