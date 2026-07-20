import { dataCache } from '@/server/data-cache';
import { getApiStatus } from '@/server/fpl/client';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET() {
  return serveApiRoute('/api/status', () => {
    const apiStatus = getApiStatus();
    return {
      apiAvailable: apiStatus.available,
      errorMessage: apiStatus.errorMessage,
      lastError: apiStatus.lastError,
      lastErrorTime: apiStatus.lastErrorTime,
      lastSuccessTime: apiStatus.lastSuccessTime,
      cacheAvailable: {
        standings: !!dataCache.standings,
        losers: !!dataCache.losers,
        motm: !!dataCache.motm,
        week: !!dataCache.week,
        hallOfFame: !!dataCache.hallOfFame,
      },
      lastRefresh: dataCache.lastRefresh,
      lastWeekRefresh: dataCache.lastWeekRefresh,
    };
  });
}
