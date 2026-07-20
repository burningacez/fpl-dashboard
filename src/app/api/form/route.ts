/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { fetchFormData } from '@/server/services/form';

export const dynamic = 'force-dynamic';

// Form table - league rankings over last N completed gameweeks
// Optional ?asof=N parameter: compute form ending at GW N instead of the latest
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const weeks = Math.max(1, Math.min(38, parseInt(url.searchParams.get('weeks') as any) || 5));
    const asofParam = url.searchParams.get('asof');
    const asof = asofParam ? parseInt(asofParam) : null;

    const result = await fetchFormData(weeks, asof);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to load form data: ' + error.message }, { status: 500 });
  }
}
