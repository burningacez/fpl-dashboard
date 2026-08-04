import { describe, expect, it } from 'vitest';
import { buildDemoLosers } from '@/app/losers/demoLosers';

/**
 * The Weekly Losers walkthrough narrates demo data, so the demo has to satisfy
 * the same invariant the real payload does: the verdict on a tile and the row
 * the modal badges LOSER are the same manager, and the margin the tile shows is
 * a real margin. When they disagree the tour teaches the page wrong — a tile
 * saying "By 17" that opens onto two managers level on points, with the badge on
 * the one the tiebreakers spared.
 */

/** The per-GW modal's sort, from src/app/losers/page.tsx. */
function modalOrder(managers: any[], showAttacking: boolean): any[] {
  return [...managers].sort((a, b) => {
    if (a.points !== b.points) return a.points - b.points;
    if (showAttacking) {
      if ((a.goals || 0) !== (b.goals || 0)) return (a.goals || 0) - (b.goals || 0);
      if ((a.assists || 0) !== (b.assists || 0)) return (a.assists || 0) - (b.assists || 0);
    }
    return (b.transfers || 0) - (a.transfers || 0);
  });
}

/** The tile's reading of `context`, from renderTile in src/app/losers/page.tsx. */
function tileSub(context: string): string {
  return context.startsWith('Lost by') ? `By ${context.match(/\d+/)?.[0] ?? ''}` : 'Tiebreaker';
}

const demo = buildDemoLosers(null, 'Example League');

describe('demo losers payload', () => {
  it('names the manager the modal puts at the top of the table', () => {
    for (const loser of demo.losers.losers) {
      const managers = demo.losers.allGameweeks[loser.gameweek].managers;
      for (const showAttacking of [true, false]) {
        const worst = modalOrder(managers, showAttacking)[0];
        expect(worst.name, `GW${loser.gameweek} (attacking: ${showAttacking})`).toBe(loser.name);
        expect(worst.entry).toBe(loser.entry);
      }
    }
  });

  it('only claims a margin when nobody is level with the loser', () => {
    for (const loser of demo.losers.losers) {
      const managers = demo.losers.allGameweeks[loser.gameweek].managers;
      const [worst, runnerUp] = modalOrder(managers, true);
      const tied = runnerUp.points === worst.points;
      expect(tileSub(loser.context), `GW${loser.gameweek}`).toBe(
        tied ? 'Tiebreaker' : `By ${runnerUp.points - worst.points}`,
      );
    }
  });

  it('opens the walkthrough on a week that really was settled on a tiebreak', () => {
    const focus = demo.losers.losers.find((l: any) => l.gameweek === demo.focusGw);
    expect(focus, `no loser recorded for focus GW${demo.focusGw}`).toBeTruthy();
    expect(tileSub(focus.context)).toBe('Tiebreaker');

    const [worst, runnerUp] = modalOrder(demo.losers.allGameweeks[demo.focusGw].managers, true);
    expect(runnerUp.points).toBe(worst.points);
    // Level on points, level on goals and assists, so transfers is what sinks
    // them — which is what the tour's tiebreaker step says happens.
    expect(worst.goals).toBe(runnerUp.goals);
    expect(worst.assists).toBe(runnerUp.assists);
    expect(worst.transfers).toBeGreaterThan(runnerUp.transfers);
    expect(focus.context).toBe('More transfers');
  });
});
