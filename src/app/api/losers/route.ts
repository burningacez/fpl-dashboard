import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchWeeklyLosers } from '@/server/services/losers';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/losers', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'losers');
    return dataCache.losers || fetchWeeklyLosers();
  });
}
