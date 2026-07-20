import { NextRequest } from 'next/server';
import config from '@/server/config';
import { dataCache } from '@/server/data-cache';
import { refreshWeekData } from '@/server/services/week';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  return serveApiRoute('/api/week', () => {
    // Week data only available for current season
    if (!isCurrentSeason) return { error: 'Live week data only available for current season' };
    return dataCache.week || refreshWeekData();
  });
}
