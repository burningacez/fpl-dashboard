import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { getCurrentSeason } from '@/server/season-state';

export const dynamic = 'force-dynamic';

/**
 * Public league summary for barrye.co.uk's front page.
 *
 * Deliberately the smallest thing that can be true: aggregate numbers only.
 * No manager names, no entry ids, no team names — the homepage is a public
 * index and has no business carrying the league's roster around. Everything
 * here is read straight out of the already-materialised caches, so the route
 * makes no FPL API call and does no per-request computation; on a cold process
 * it answers `available: false` rather than triggering a rebuild.
 *
 * Answers `{ available: false }` with a 200 rather than an error status: the
 * caller's correct behaviour in every failure mode is "render the page without
 * the graph", and that shouldn't need error handling on the other side.
 */

const GW_WINDOW = 10;

// The front page is served from the apex; www is a separate origin to a browser.
const ALLOWED_ORIGINS = new Set([
  'https://barrye.co.uk',
  'https://www.barrye.co.uk',
]);

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin');
  return {
    // Five minutes is far longer than the data moves outside a match window,
    // and inside one the homepage is not the place people watch scores.
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    ...(origin && ALLOWED_ORIGINS.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {}),
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}

export async function GET(req: NextRequest) {
  const headers = corsHeaders(req);

  try {
    const history = dataCache.weekHistoryCache || {};
    const gws = Object.keys(history)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    // Pre-season, and on a cold process before the first refresh lands, there
    // is genuinely nothing to plot. Say so instead of inventing a flat line.
    if (gws.length === 0) {
      return NextResponse.json(
        { available: false, season: getCurrentSeason() },
        { headers },
      );
    }

    // The best score anyone in the league managed each gameweek. A real series
    // with real variance that belongs to nobody in particular — which is what
    // a page with no signed-in viewer can honestly show.
    const series = gws.slice(-GW_WINDOW).map((gw) => {
      const managers: Array<{ gwScore?: number }> = history[gw]?.managers || [];
      const scores = managers
        .map((m) => m.gwScore)
        .filter((s): s is number => typeof s === 'number');
      return { gw, top: scores.length ? Math.max(...scores) : 0 };
    });

    const entrants = dataCache.standings?.standings?.length ?? null;

    return NextResponse.json(
      {
        available: true,
        season: getCurrentSeason(),
        currentGW: dataCache.week?.currentGW ?? gws[gws.length - 1],
        entrants,
        series,
      },
      { headers },
    );
  } catch {
    return NextResponse.json({ available: false }, { headers });
  }
}
