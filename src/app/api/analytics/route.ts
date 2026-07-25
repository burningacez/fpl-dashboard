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
    // Typed empty envelope (not a 404): the client renders a friendly notice.
    return NextResponse.json({
      available: false,
      reason: 'Analytics were not archived for this season.',
    });
  }
  try {
    const data = await calculateSeasonAnalytics();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
