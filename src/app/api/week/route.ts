import { NextRequest } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { refreshWeekData } from '@/server/services/week';
import { getArchivedWeek } from '@/server/services/archived-week';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/week', () => {
    // Archived seasons serve the snapshot's final gameweek (read-only, no SSE)
    if (!isCurrentSeason) return getArchivedWeek(requestedSeason!);
    return dataCache.week || refreshWeekData();
  });
}
