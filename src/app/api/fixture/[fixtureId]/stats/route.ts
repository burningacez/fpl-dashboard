/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { API_CACHE_TTL } from '@/server/fpl/client';
import { getFixtureStats } from '@/server/services/fixture-stats';

export const dynamic = 'force-dynamic';

// Module-level caches, port of the legacy globals (legacy/server.js:820-821).
// globalThis-scoped so they survive dev-mode module reloads, matching the
// process-lifetime semantics of the legacy `let` bindings.
declare global {
  var __fplFixtureStatsTempCache: Record<number, { data: any; ts: number }> | undefined; // { fixtureId: { data, ts } }
  var __fplFixtureStatsInFlight: Record<number, Promise<any>> | undefined; // { fixtureId: Promise }
}
const fixtureStatsTempCache = (globalThis.__fplFixtureStatsTempCache ??= {});
const fixtureStatsInFlight = (globalThis.__fplFixtureStatsInFlight ??= {});

// Fixture stats route: /api/fixture/:fixtureId/stats
export async function GET(_req: Request, { params }: { params: Promise<{ fixtureId: string }> }) {
  try {
    const { fixtureId: fixtureIdParam } = await params;
    const fixtureId = parseInt(fixtureIdParam);

    // Serve from permanent cache (finished fixtures)
    if (dataCache.fixtureStatsCache[fixtureId]) {
      return NextResponse.json(dataCache.fixtureStatsCache[fixtureId]);
    }

    // Stale-while-revalidate: serve cached data immediately, refresh in background
    const tempCached = fixtureStatsTempCache[fixtureId];
    if (tempCached) {
      // If past TTL, trigger background refresh (deduped)
      if ((Date.now() - tempCached.ts) >= API_CACHE_TTL && !fixtureStatsInFlight[fixtureId]) {
        fixtureStatsInFlight[fixtureId] = getFixtureStats(fixtureId)
          .then((data: any) => {
            if (data.finished) {
              dataCache.fixtureStatsCache[fixtureId] = data;
              delete fixtureStatsTempCache[fixtureId];
            } else if (!data.error) {
              fixtureStatsTempCache[fixtureId] = { data, ts: Date.now() };
            }
          })
          .catch(() => {})
          .finally(() => {
            delete fixtureStatsInFlight[fixtureId];
          });
      }
      return NextResponse.json(tempCached.data);
    }

    // No cache at all (first request) → must wait for data
    if (!fixtureStatsInFlight[fixtureId]) {
      fixtureStatsInFlight[fixtureId] = getFixtureStats(fixtureId).finally(() => {
        delete fixtureStatsInFlight[fixtureId];
      });
    }
    const data = await fixtureStatsInFlight[fixtureId];

    // Cache finished fixtures permanently, live fixtures for 30s
    if (data.finished) {
      dataCache.fixtureStatsCache[fixtureId] = data;
    } else if (!data.error) {
      fixtureStatsTempCache[fixtureId] = { data, ts: Date.now() };
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
