import { NextResponse } from 'next/server';
import { getCurrentMembers } from '@/server/identity-store';

export const dynamic = 'force-dynamic';

/**
 * League member list for the "who are you?" picker. Delegates to the single
 * source of truth in identity-store, which reads the standings cache and falls
 * back to a live league fetch when that cache is empty (e.g. pre-season, when
 * members live in `new_entries` and standings.results is still empty).
 *
 * Previously this route duplicated that logic but guarded with `if (s)` — an
 * empty standings array is truthy, so it returned zero members instead of
 * falling through to the live fetch. That drift is why it worked with no Redis
 * (null cache) but not in production (empty-array cache persisted in Redis).
 */
export async function GET() {
  try {
    return NextResponse.json({ members: await getCurrentMembers() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
