import { NextRequest } from 'next/server';
import config from '@/server/config';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchChipsData } from '@/server/services/chips';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  return serveApiRoute('/api/chips', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'chips');
    return dataCache.chips || fetchChipsData();
  });
}
