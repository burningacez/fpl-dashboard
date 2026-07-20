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
    return NextResponse.json({ error: 'Profile not found. Data may still be loading.' }, { status: 404 });
  }
}
