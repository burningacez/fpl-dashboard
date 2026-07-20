/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { fetchBootstrap, fetchLeagueData, fetchManagerHistory } from '@/server/fpl/client';

export const dynamic = 'force-dynamic';

// Historical standings route: /api/standings/history?gw=N
// Returns season standings as of the end of the specified gameweek
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

    // Check cache
    const cacheKey = `standingsHistory_${gw}`;
    if ((dataCache as any)[cacheKey] && (Date.now() - (dataCache as any)[cacheKey].ts) < 60000) {
      return NextResponse.json((dataCache as any)[cacheKey].data);
    }

    const [leagueData] = await Promise.all([
      fetchLeagueData(),
      fetchBootstrap(),
    ]);
    const managers = leagueData.standings.results;

    const standings: any[] = await Promise.all(
      managers.map(async (m: any) => {
        const history = await fetchManagerHistory(m.entry);
        // Sum up through the requested GW
        const gwData = history.current.filter((h: any) => h.event <= gw);
        const totalTransfers = gwData.reduce((sum: number, h: any) => sum + h.event_transfers, 0);
        const transferCost = gwData.reduce((sum: number, h: any) => sum + h.event_transfers_cost, 0);

        // Anchor to FPL's cumulative total_points at the requested
        // GW (always net of hits) rather than summing gw.points and
        // re-subtracting cost — that path is sensitive to whether
        // FPL returns gw.points as gross or net.
        const gwEntry = gwData[gwData.length - 1];
        const netScore = gwEntry?.total_points || 0;
        const grossScore = netScore + transferCost;

        // Team value from the requested GW (or latest available before it)
        const teamValue = gwEntry ? (gwEntry.value / 10).toFixed(1) : '100.0';

        return {
          entryId: m.entry, name: m.player_name, team: m.entry_name,
          grossScore, totalTransfers, transferCost, netScore, teamValue,
        };
      }),
    );

    standings.sort((a, b) => b.netScore - a.netScore);
    standings.forEach((s, i) => (s.rank = i + 1));

    const result = { leagueName: leagueData.league.name, standings, asOfGW: gw };
    (dataCache as any)[cacheKey] = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to load historical standings: ' + error.message }, { status: 500 });
  }
}
