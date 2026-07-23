import { NextRequest } from 'next/server';
import { buildCupData } from '@/server/services/cup';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/cup', () => {
    if (!isCurrentSeason) {
      return (
        getSeasonData(requestedSeason, 'cup') || {
          cupStarted: false,
          archived: true,
          message: 'No cup data archived for this season',
        }
      );
    }
    // Serve the frozen cup snapshot the refresh already built (like every other
    // cached route). buildCupData() only runs on a cold cache — never on a
    // concluded season, so we don't re-hit the FPL API for settled results.
    return dataCache.cup || buildCupData();
  });
}
