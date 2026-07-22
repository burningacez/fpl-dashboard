/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { buildWeekHistoryOnDemand } from '@/server/services/refresh';
import { fetchStandingsAsOfGW } from '@/server/services/standings-history';
import { fetchBootstrap, fetchFixtures } from '@/server/fpl/client';

export const dynamic = 'force-dynamic';

// That GW's fixtures, shaped like the live /api/week `fixtures` so the same
// match row renders for past gameweeks. Cached per GW (final scores never change).
async function fixturesForGW(gw: number): Promise<any[]> {
  const cacheKey = `weekHistoryFixtures_${gw}`;
  const cached = (dataCache as any)[cacheKey];
  if (cached && Date.now() - cached.ts < 3600000) return cached.data;

  const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
  const teamById = new Map<number, any>(bootstrap.teams.map((t: any) => [t.id, t]));
  const summary = fixtures
    .filter((f: any) => f.event === gw)
    .map((f: any) => ({
      id: f.id,
      home: teamById.get(f.team_h)?.short_name || 'HOM',
      away: teamById.get(f.team_a)?.short_name || 'AWY',
      homeScore: f.team_h_score,
      awayScore: f.team_a_score,
      started: f.started,
      finished: f.finished || f.finished_provisional,
      kickoff: f.kickoff_time,
      minutes: f.minutes,
    }))
    .sort((a: any, b: any) => (new Date(a.kickoff) as any) - (new Date(b.kickoff) as any));

  (dataCache as any)[cacheKey] = { data: summary, ts: Date.now() };
  return summary;
}

// Merge cumulative season totals + standings rank onto the week's managers so
// the past-GW table renders identical columns to the live view (Total + rank).
async function withOverall(data: any, gw: number): Promise<any> {
  try {
    const { standings } = await fetchStandingsAsOfGW(gw);
    const byId = new Map(standings.map((s) => [s.entryId, s]));
    const managers = (data.managers ?? []).map((m: any) => {
      const s = byId.get(m.entryId);
      return s ? { ...m, overallPoints: s.netScore, overallRank: s.rank } : m;
    });
    return { ...data, managers };
  } catch {
    // Totals are best-effort; fall back to the bare week data if the season
    // history can't be fetched.
    return data;
  }
}

// Historical week data route: /api/week/history?gw=N
// Serves from pre-built cache when available, falls back to on-demand computation.
export async function GET(req: NextRequest) {
  try {
    const gwParam = req.nextUrl.searchParams.get('gw');
    if (!gwParam) {
      return NextResponse.json({ error: 'gw parameter is required' }, { status: 400 });
    }
    const gw = parseInt(gwParam);
    if (isNaN(gw) || gw < 1 || gw > 38) {
      return NextResponse.json({ error: 'Invalid gameweek' }, { status: 400 });
    }

    const currentGW = dataCache.week?.currentGW || gw;

    // Serve from pre-built cache (populated at startup/daily refresh); otherwise
    // build on-demand for this single GW.
    let data = dataCache.weekHistoryCache[gw];
    if (!data) {
      console.log(`[WeekHistory] Cache miss for GW ${gw}, building on-demand...`);
      data = await buildWeekHistoryOnDemand(gw);
    }

    const [enriched, fixtures] = await Promise.all([withOverall(data, gw), fixturesForGW(gw)]);
    return NextResponse.json({ ...enriched, fixtures, currentGW });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
