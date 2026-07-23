/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { fetchBootstrap, fetchFixtures } from '@/server/fpl/client';
import { PLANNER_ENABLED } from '@/lib/features';
import type { Bootstrap } from '@/server/fpl/types';

export const dynamic = 'force-dynamic';

/**
 * Slimmed bootstrap + upcoming-fixtures feed for the team planner.
 * The full bootstrap is ~2MB; this projection is ~200KB. Next gzips the
 * response, and we memoise the projection on the bootstrap object identity
 * so it is rebuilt at most once per 30s FPL cache window.
 */

let memo: { key: Bootstrap; value: any } | null = null;

function project(bootstrap: Bootstrap, fixtures: any[]): any {
  const currentGw = bootstrap.events.find((e) => e.is_current)?.id ?? 1;
  const nextGw = bootstrap.events.find((e) => e.is_next)?.id ?? currentGw + 1;

  return {
    currentGw,
    nextGw,
    events: bootstrap.events.map((e) => ({
      id: e.id,
      deadline_time: e.deadline_time,
      finished: e.finished,
      is_current: e.is_current,
      is_next: e.is_next,
    })),
    teams: bootstrap.teams.map((t) => ({ id: t.id, name: t.name, short_name: t.short_name, code: (t as any).code })),
    players: bootstrap.elements.map((p) => ({
      id: p.id,
      web_name: p.web_name,
      team: p.team,
      element_type: p.element_type,
      now_cost: p.now_cost,
      total_points: p.total_points,
      form: p.form,
      points_per_game: p.points_per_game,
      selected_by_percent: p.selected_by_percent,
      status: p.status,
      news: p.news,
      chance_of_playing_next_round: p.chance_of_playing_next_round,
      ep_next: p.ep_next,
    })),
    fixtures: fixtures
      .filter((f) => f.event === null || f.event >= currentGw)
      .map((f) => ({
        id: f.id,
        event: f.event,
        team_h: f.team_h,
        team_a: f.team_a,
        team_h_difficulty: f.team_h_difficulty,
        team_a_difficulty: f.team_a_difficulty,
        kickoff_time: f.kickoff_time,
      })),
  };
}

export async function GET() {
  // Withheld from the live app until released — see src/lib/features.ts.
  if (!PLANNER_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    if (!memo || memo.key !== bootstrap) {
      memo = { key: bootstrap, value: project(bootstrap, fixtures) };
    }
    return NextResponse.json(memo.value);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
