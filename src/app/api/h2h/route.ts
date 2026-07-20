/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { fetchH2HComparison } from '@/server/services/h2h';

export const dynamic = 'force-dynamic';

// Head-to-head comparison route: /api/h2h?m1=ENTRY_ID&m2=ENTRY_ID
export async function GET(req: NextRequest) {
  try {
    const m1 = parseInt(req.nextUrl.searchParams.get('m1') as any);
    const m2 = parseInt(req.nextUrl.searchParams.get('m2') as any);
    if (isNaN(m1) || isNaN(m2) || m1 === m2) {
      return NextResponse.json(
        { error: 'Two different manager entry IDs (m1 and m2) are required' },
        { status: 400 },
      );
    }
    const data = await fetchH2HComparison(m1, m2);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
