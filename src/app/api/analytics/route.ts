/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { getSeasonData } from '@/server/data-cache';
import { calculateSeasonAnalytics } from '@/server/services/analytics';
import { requestedSeasonParam } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

// Season analytics route: /api/analytics
export async function GET(req: NextRequest) {
  const { requestedSeason, isCurrentSeason } = requestedSeasonParam(req);

  if (!isCurrentSeason) {
    const archived = getSeasonData(requestedSeason, 'analytics');
    if (archived) return NextResponse.json({ ...archived, archived: true });
    return NextResponse.json(
      { error: 'Analytics were not archived for this season.' },
      { status: 404 },
    );
  }
  try {
    const data = await calculateSeasonAnalytics();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
