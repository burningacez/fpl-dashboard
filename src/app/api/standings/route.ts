import { NextRequest } from 'next/server';
import config from '@/server/config';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchStandingsWithTransfers } from '@/server/services/standings';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  return serveApiRoute('/api/standings', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'standings');
    return dataCache.standings || fetchStandingsWithTransfers();
  });
}
