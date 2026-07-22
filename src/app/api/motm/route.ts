import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { fetchMotmData } from '@/server/services/motm';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/motm', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'motm');
    return dataCache.motm || fetchMotmData();
  });
}
