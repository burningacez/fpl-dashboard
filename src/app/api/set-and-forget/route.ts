import { NextRequest } from 'next/server';
import { dataCache, getSeasonData } from '@/server/data-cache';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/set-and-forget', () => {
    if (!isCurrentSeason) return getSeasonData(requestedSeason, 'setAndForget');
    return (
      dataCache.setAndForget || {
        available: false,
        reason: 'Set & Forget unlocks once gameweeks have been played.',
      }
    );
  });
}
