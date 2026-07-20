import { NextRequest } from 'next/server';
import config from '@/server/config';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  const isCurrentSeason = !requestedSeason || requestedSeason === config.CURRENT_SEASON;

  return serveApiRoute('/api/hall-of-fame', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'hallOfFame');
    return dataCache.hallOfFame || { error: 'Hall of Fame data is being calculated. Please refresh in a moment.' };
  });
}
