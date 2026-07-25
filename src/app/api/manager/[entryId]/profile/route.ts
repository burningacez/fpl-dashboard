/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { dataCache } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

// Manager profile route: /api/manager/:entryId/profile
// Manager profile route - serve from pre-calculated cache
export async function GET(_req: Request, { params }: { params: Promise<{ entryId: string }> }) {
  const { entryId: entryIdParam } = await params;
  const entryId = parseInt(entryIdParam);
  const profile = dataCache.managerProfiles?.[entryId];
  if (profile) {
    return NextResponse.json(profile);
  } else {
    // Pre-season (or before this manager has any completed GWs) there's no
    // profile to show — a friendly empty state, not an error.
    return NextResponse.json({
      available: false,
      reason: 'This profile fills in once gameweeks have been played.',
    });
  }
}
