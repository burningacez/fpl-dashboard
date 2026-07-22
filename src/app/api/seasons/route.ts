import { NextResponse } from 'next/server';
import { getAvailableSeasons } from '@/server/data-cache';
import { getCurrentSeason } from '@/server/season-state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const seasons = await getAvailableSeasons();
  return NextResponse.json({ currentSeason: getCurrentSeason(), seasons });
}
