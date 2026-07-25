import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/hall-of-fame', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'hallOfFame');
    return (
      dataCache.hallOfFame || {
        available: false,
        reason: 'The Hall of Fame fills in once gameweeks have been played.',
      }
    );
  });
}
