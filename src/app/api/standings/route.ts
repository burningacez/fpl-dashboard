import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchStandingsWithTransfers } from '@/server/services/standings';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/standings', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'standings');
    return dataCache.standings || fetchStandingsWithTransfers();
  });
}
