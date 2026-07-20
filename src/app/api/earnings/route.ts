import { NextRequest } from 'next/server';
import config from '@/server/config';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchProfitLossData } from '@/server/services/earnings';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  return serveApiRoute('/api/earnings', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'earnings');
    return dataCache.earnings || fetchProfitLossData();
  });
}
