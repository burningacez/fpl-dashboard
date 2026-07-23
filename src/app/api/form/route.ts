/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { fetchFormData } from '@/server/services/form';
import { dataCache } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

// Form table - league rankings over last N completed gameweeks
// Optional ?asof=N parameter: compute form ending at GW N instead of the latest
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const weeks = Math.max(1, Math.min(38, parseInt(url.searchParams.get('weeks') as any) || 5));
  const asofParam = url.searchParams.get('asof');
  const asof = asofParam ? parseInt(asofParam) : null;

  try {
    const result = await fetchFormData(weeks, asof);
    return NextResponse.json(result);
  } catch (error: any) {
    // The FPL API is unreachable (e.g. a stale league id or "the game is being
    // updated" during the July season reset). Degrade gracefully like the
    // cache-backed routes do rather than 500-ing the whole table: serve the
    // last cached form result for this window if we have one, otherwise an
    // empty table carrying the reason.
    const cacheKey = (asof ? `${weeks}_asof${asof}` : weeks) as any;
    const cached = dataCache.formResultsCache[cacheKey];
    if (cached) {
      return NextResponse.json({ ...cached.data, _stale: true });
    }
    return NextResponse.json({
      leagueName: dataCache.league?.league?.name ?? '',
      form: [],
      weeks,
      totalCompleted: 0,
      gwRange: [],
      asOfGW: asof || null,
      error: 'Form data is temporarily unavailable: ' + error.message,
    });
  }
}
