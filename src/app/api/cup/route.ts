import { NextRequest } from 'next/server';
import { buildCupData } from '@/server/services/cup';
import { getSeasonData } from '@/server/data-cache';
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
    return buildCupData();
  });
}
