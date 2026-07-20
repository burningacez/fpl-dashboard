import { NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';
import { fetchLeagueData } from '@/server/fpl/client';

export const dynamic = 'force-dynamic';

/**
 * League member list for the "who are you?" picker. Always current-season
 * (identity persists across archived-season views). Falls back to a live
 * league fetch on cold start before the standings cache is built.
 */
export async function GET() {
  try {
    const s = dataCache.standings?.standings;
    if (s) {
      return NextResponse.json({
        members: s.map((m: { entryId: number; name: string; team: string }) => ({
          entryId: m.entryId,
          name: m.name,
          team: m.team,
        })),
      });
    }
    const ld = await fetchLeagueData();
    return NextResponse.json({
      members: ld.standings.results.map((m) => ({
        entryId: m.entry,
        name: m.player_name,
        team: m.entry_name,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
