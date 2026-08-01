/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { fetchBootstrap, fetchFixtures } from '@/server/fpl/client';
import type { Bootstrap } from '@/server/fpl/types';

export const dynamic = 'force-dynamic';

/**
 * Slimmed bootstrap + upcoming-fixtures feed for the team planner.
 * The full bootstrap is ~2MB; this projection is a fraction of that. Next gzips
 * the response, and we memoise the projection on the bootstrap object identity
 * so it is rebuilt at most once per 30s FPL cache window.
 *
 * The per-player season totals are here rather than behind a per-player
 * endpoint because the browser sorts on them across every player at once, so
 * they have to be client-side anyway. They compress well — repeated small
 * integers — and the alternative (a request per player tapped) would be far
 * worse for a page whose whole job is comparing players.
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
      first_name: p.first_name,
      second_name: p.second_name,
      team: p.team,
      element_type: p.element_type,
      now_cost: p.now_cost,
      cost_change_event: p.cost_change_event,
      cost_change_start: p.cost_change_start,
      transfers_in_event: p.transfers_in_event,
      transfers_out_event: p.transfers_out_event,
      // Parsed to a signed number: magnitude = progress to threshold (100),
      // sign = assumed direction (positive rise / negative fall).
      price_change_percent: parseFloat(p.price_change_percent) || 0,
      total_points: p.total_points,
      form: p.form,
      points_per_game: p.points_per_game,
      selected_by_percent: p.selected_by_percent,
      status: p.status,
      news: p.news,
      chance_of_playing_next_round: p.chance_of_playing_next_round,
      ep_next: p.ep_next,
      // Season totals for the player detail card and the browser's sorts.
      // Numbers default to 0 rather than undefined so sorting never has to
      // special-case a missing field; the decimals stay strings, as FPL sends
      // them, and are parsed at the point of use.
      minutes: p.minutes ?? 0,
      starts: p.starts ?? 0,
      goals_scored: p.goals_scored ?? 0,
      assists: p.assists ?? 0,
      clean_sheets: p.clean_sheets ?? 0,
      goals_conceded: p.goals_conceded ?? 0,
      penalties_saved: p.penalties_saved ?? 0,
      penalties_missed: p.penalties_missed ?? 0,
      yellow_cards: p.yellow_cards ?? 0,
      red_cards: p.red_cards ?? 0,
      saves: p.saves ?? 0,
      bonus: p.bonus ?? 0,
      bps: p.bps ?? 0,
      expected_goals: p.expected_goals ?? '0.0',
      expected_assists: p.expected_assists ?? '0.0',
      expected_goal_involvements: p.expected_goal_involvements ?? '0.0',
      ict_index: p.ict_index ?? '0.0',
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
