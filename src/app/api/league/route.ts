/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from 'next/server';
import { dataCache, archivedSeasons, getSeasonData } from '@/server/data-cache';
import { fetchLeagueData } from '@/server/fpl/client';
import { serveApiRoute, requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  return serveApiRoute('/api/league', () => {
    if (!isCurrentSeason) {
      const archived = getSeasonData(requestedSeason, 'standings');
      if (archived) return { league: { name: archivedSeasons[requestedSeason!]?.leagueName || 'Unknown' } };
    }
    return dataCache.league || fetchLeagueData();
  });
}
