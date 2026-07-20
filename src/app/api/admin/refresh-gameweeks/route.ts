/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import config from '@/server/config';
import { dataCache, rebuildStatus, saveDataCache } from '@/server/data-cache';
import { fetchBootstrap, fetchFixtures, fetchLeagueData, fetchLiveGWData, fetchManagerPicks } from '@/server/fpl/client';
import { fetchManagerPicksDetailed } from '@/server/services/picks';
import { buildWeekHistoryOnDemand } from '@/server/services/refresh';

export const dynamic = 'force-dynamic';

// Targeted gameweek refresh - clears caches for specific GWs and rebuilds them —
// port of legacy/server.js:6935-7062.
export async function POST(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: 'Request error' }, { status: 400 });
  }
  if (Buffer.byteLength(body, 'utf8') > config.limits.MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  try {
    const { password, gameweeks } = JSON.parse(body);
    if (password !== config.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    if (!Array.isArray(gameweeks) || gameweeks.length === 0 || gameweeks.some((gw) => typeof gw !== 'number' || gw < 1 || gw > 38)) {
      // NOTE: legacy called serveJSON(res, {...}, 400) but serveJSON ignores
      // the third argument, so this was actually served with status 200.
      return NextResponse.json({ error: 'Provide gameweeks as an array of numbers (1-38)' });
    }

    if (rebuildStatus.inProgress) {
      return NextResponse.json({ error: 'A rebuild is already in progress' });
    }

    const league = dataCache.league || (await fetchLeagueData());
    const managers = league.standings?.results || [];

    // Clear caches for the specified gameweeks
    let clearedPicks = 0,
      clearedProcessed = 0,
      clearedTinkering = 0;
    for (const gw of gameweeks) {
      delete dataCache.liveDataCache[gw];
      delete dataCache.weekHistoryCache[gw];
      for (const m of managers) {
        const key = `${m.entry}-${gw}`;
        if (dataCache.picksCache[key]) {
          delete dataCache.picksCache[key];
          clearedPicks++;
        }
        if (dataCache.processedPicksCache[key]) {
          delete dataCache.processedPicksCache[key];
          clearedProcessed++;
        }
        if (dataCache.tinkeringCache[key]) {
          delete dataCache.tinkeringCache[key];
          clearedTinkering++;
        }
      }
    }

    console.log(`[Admin] Cleared GW ${gameweeks.join(', ')} caches: ${clearedPicks} picks, ${clearedProcessed} processed, ${clearedTinkering} tinkering`);

    // Re-fetch and rebuild the cleared gameweeks (fire and forget — the
    // response below returns immediately, rebuild runs in background)
    (async () => {
      try {
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        void fixtures;

        for (const gw of gameweeks) {
          console.log(`[Admin] Rebuilding GW ${gw}...`);

          // Re-fetch live data
          const liveData = await fetchLiveGWData(gw);
          dataCache.liveDataCache[gw] = liveData;

          // Re-fetch picks for all managers
          for (const m of managers) {
            const cacheKey = `${m.entry}-${gw}`;
            try {
              const picks = await fetchManagerPicks(m.entry, gw);
              dataCache.picksCache[cacheKey] = picks;
            } catch (e: any) {
              console.log(`[Admin] Failed to fetch GW${gw} picks for ${m.player_name}: ${e.message}`);
            }
          }

          // Re-process picks for all managers
          for (const m of managers) {
            const cacheKey = `${m.entry}-${gw}`;
            try {
              const processed = await fetchManagerPicksDetailed(m.entry, gw, bootstrap);
              dataCache.processedPicksCache[cacheKey] = processed;
            } catch (e: any) {
              console.log(`[Admin] Failed to process GW${gw} picks for ${m.player_name}: ${e.message}`);
            }
          }

          // Rebuild week history for this GW
          delete dataCache.weekHistoryCache[gw];
          try {
            await buildWeekHistoryOnDemand(gw);
          } catch (e: any) {
            console.log(`[Admin] Failed to rebuild GW${gw} week history: ${e.message}`);
          }

          console.log(`[Admin] GW ${gw} rebuild complete`);
        }

        // Persist updated caches to Redis
        await saveDataCache();
        console.log(`[Admin] GW ${gameweeks.join(', ')} refresh complete and saved to Redis`);
      } catch (e: any) {
        console.error(`[Admin] GW refresh failed:`, e.message);
      }
    })();

    // Rebuild in background
    return NextResponse.json({
      success: true,
      message: `Rebuilding GW ${gameweeks.join(', ')} in the background`,
      cleared: { picks: clearedPicks, processed: clearedProcessed, tinkering: clearedTinkering },
    });
  } catch (e: any) {
    console.error('[Admin] Refresh gameweeks failed:', e);
    return NextResponse.json({ error: 'Refresh failed: ' + e.message }, { status: 500 });
  }
}

// Legacy served this JSON (200) for any non-POST method
function methodNotAllowed() {
  return NextResponse.json({ error: 'Use POST method with admin password' });
}
export async function GET() {
  return methodNotAllowed();
}
export async function PUT() {
  return methodNotAllowed();
}
export async function PATCH() {
  return methodNotAllowed();
}
export async function DELETE() {
  return methodNotAllowed();
}
