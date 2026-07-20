/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { calculateSeasonAnalytics } from '@/server/services/analytics';

export const dynamic = 'force-dynamic';

// Season analytics route: /api/analytics
export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  if (!isCurrentSeason) {
    return NextResponse.json({ error: 'Analytics only available for the current season.' }, { status: 400 });
  }
  try {
    const data = await calculateSeasonAnalytics();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
