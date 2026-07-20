import { NextResponse } from 'next/server';
import config from '@/server/config';
import { getAvailableSeasons } from '@/server/data-cache';

export const dynamic = 'force-dynamic';

export async function GET() {
  const seasons = await getAvailableSeasons();
  return NextResponse.json({ currentSeason: config.CURRENT_SEASON, seasons });
}
