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
    // Only the drawn bracket is cached; the pre-cup placeholder is always
    // recomputed so it reflects live state (season progress, real entrant count,
    // FPL's qualification schedule) instead of a stale snapshot. Serving the
    // cached not-started payload across a code change was showing prod the old
    // hardcoded start gameweek. Once the cup starts, the bracket is served from
    // cache as before (never re-hitting the FPL API for settled results).
    return dataCache.cup?.cupStarted ? dataCache.cup : buildCupData();
  });
}
