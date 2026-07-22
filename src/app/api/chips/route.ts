import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchChipsData } from '@/server/services/chips';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/chips', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'chips');
    return dataCache.chips || fetchChipsData();
  });
}
