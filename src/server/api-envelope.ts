/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import config from './config';
import { dataCache } from './data-cache';
import { getApiStatus } from './fpl/client';
import { getCurrentSeason } from './season-state';

/**
 * Shared ?season= handling for the season-aware routes: no param (or the
 * active season) means live data; anything else is served from the archive.
 */
export function requestedSeasonParam(req: NextRequest): {
  requestedSeason: string | null;
  isCurrentSeason: boolean;
} {
  const requestedSeason = req.nextUrl.searchParams.get('season');
  return {
    requestedSeason,
    isCurrentSeason: !requestedSeason || requestedSeason === getCurrentSeason(),
  };
}

/**
 * Shared response envelope for the cache-backed API routes — transliteration
 * of the apiRoutes dispatch in legacy/server.js (:7866-7935): API-status
 * injection when the FPL API is down, cached-data fallback on handler error,
 * and a 503 with a next-kickoff hint when no cache is available.
 */
export async function serveApiRoute(pathname: string, handler: () => any): Promise<NextResponse> {
  const apiStatus = getApiStatus();
  try {
    const data = await handler();
    // Add API status to response if API is down but we have cached data
    if (!apiStatus.available && data && !data.error) {
      data._apiStatus = {
        cached: true,
        message: apiStatus.errorMessage || 'FPL API temporarily unavailable',
        lastRefresh: dataCache.lastRefresh,
      };
    }
    return NextResponse.json(data);
  } catch (error: any) {
    // Try to serve cached data as fallback
    const cacheMap: Record<string, any> = {
      '/api/standings': dataCache.standings,
      '/api/losers': dataCache.losers,
      '/api/motm': dataCache.motm,
      '/api/chips': dataCache.chips,
      '/api/earnings': dataCache.earnings,
      '/api/week': dataCache.week,
      '/api/league': dataCache.league,
      '/api/hall-of-fame': dataCache.hallOfFame,
      '/api/set-and-forget': dataCache.setAndForget,
      '/api/cup': dataCache.cup,
    };

    const cachedData = cacheMap[pathname];
    if (cachedData) {
      console.log(`[API] Serving cached data for ${pathname} due to error: ${error.message}`);
      const response = { ...cachedData };
      response._apiStatus = {
        cached: true,
        message: apiStatus.errorMessage || 'FPL API temporarily unavailable',
        lastRefresh: dataCache.lastRefresh,
      };
      return NextResponse.json(response);
    } else {
      // Try to get next kickoff time for helpful error message
      let nextKickoffInfo: any = null;
      try {
        // Use a simple fetch to get fixtures if possible
        const fixturesRes = await fetch(`${config.FPL_API_BASE_URL}/fixtures/`, {
          signal: AbortSignal.timeout(3000),
        });
        if (fixturesRes.ok) {
          const fixtures: any[] = await fixturesRes.json();
          const upcoming = fixtures
            .filter((f) => !f.finished && f.kickoff_time)
            .sort((a, b) => new Date(a.kickoff_time).getTime() - new Date(b.kickoff_time).getTime());
          if (upcoming.length > 0) {
            const nextKickoff = new Date(upcoming[0].kickoff_time);
            const availableTime = new Date(nextKickoff.getTime() - 15 * 60 * 1000); // 15 mins before
            nextKickoffInfo = {
              kickoff: upcoming[0].kickoff_time,
              availableFrom: availableTime.toISOString(),
            };
          }
        }
      } catch {
        /* ignore - just won't have kickoff info */
      }

      return NextResponse.json(
        {
          error: 'Data temporarily unavailable',
          message: apiStatus.errorMessage || error.message,
          cached: false,
          nextKickoff: nextKickoffInfo,
        },
        { status: 503 },
      );
    }
  }
}
