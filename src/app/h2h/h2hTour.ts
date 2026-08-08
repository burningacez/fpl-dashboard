import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Head to Head walkthrough.
 *
 * Same model as the other tours (see src/app/losers/losersTour.ts): the run
 * narrates demo data so it works pre-season, and the job is explaining a page
 * that is nine cards of the same two managers read nine different ways.
 *
 * There are no tap steps, for the same reason there are none on Earnings: this
 * page opens nothing. The only controls are the two selects, and a native
 * dropdown is not something the engine can spotlight — it renders outside the
 * document. So the run points at the selector bar and says what it does rather
 * than pretending to drive it.
 *
 * The one thing worth saying twice is the colouring, which is the page's only
 * non-obvious idea: the two sides are coloured by who they are and who is
 * winning, not by which slot they sit in.
 */

export interface H2HTourContext {
  ready: boolean;
  /** A comparison is on screen, so every card step has something to point at. */
  hasComparison: boolean;
  /** Captain picks were recorded, so that card is a table rather than a notice. */
  hasCaptains: boolean;
  /**
   * The viewer has a claimed team, so one side of the comparison is theirs and
   * is tinted teal. A visitor without one sees the plain winner/loser pairing,
   * and telling them to look for their own colour would send them hunting for
   * something that isn't there.
   */
  hasClaim: boolean;
  /** The gameweek this season's chips reset at, from the season config. */
  chipSecondHalfStartGw: number;
  onStart: () => Promise<void>;
  onEnd: () => void;
}

const A = {
  selectors: ['[data-tour="h2h-selectors"]'],
  scoreboard: ['[data-tour="h2h-scoreboard"]'],
  record: ['[data-tour="h2h-record"]'],
  stats: ['[data-tour="h2h-stats"]'],
  transfers: ['[data-tour="h2h-transfers"]'],
  points: ['[data-tour="h2h-points-chart"]'],
  rank: ['[data-tour="h2h-rank-chart"]'],
  table: ['[data-tour="h2h-gw-table"]'],
  captains: ['[data-tour="h2h-captains"]'],
  chips: ['[data-tour="h2h-chips"]'],
  // The teal name in the scoreboard, for a viewer who has a claimed team.
  // Falls back to the scoreboard itself, which is where the colours live either
  // way, so the step is never left anchorless.
  mine: ['[data-tour="h2h-scoreboard"] .my-team-name', '[data-tour="h2h-scoreboard"]'],
};

export const H2H_TOUR_ID = 'h2h';
/** Bump when the page changes enough that the old script would mislead. */
export const H2H_TOUR_VERSION = 1;

export function buildH2HTour(ctx: H2HTourContext): Tour {
  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Head to Head',
      body:
        'Any two managers in the league, compared every way the season records them. Filled with example data, so there is a full season behind every card.',
      cta: 'Start',
    },
    {
      id: 'pick',
      title: 'Pick the two',
      body:
        'Both slots list everyone in the league, and yours is marked (You). Land here without a link and you are already in the left slot, so it is one tap to compare yourself with anyone.',
      target: A.selectors,
    },
    {
      id: 'scoreboard',
      title: 'The result',
      body:
        'Total points for the season, then the gameweek record underneath: won, drawn and lost, counted a gameweek at a time. Those are two different questions, and they do not always agree.',
      target: A.scoreboard,
      when: () => ctx.hasComparison,
    },
    {
      id: 'colours',
      title: 'What the colours mean',
      body: ctx.hasClaim
        ? 'You are teal wherever you appear, in either slot. The other manager is green when they are ahead and amber when they are not, so the colour tells you who is winning before you have read a number.'
        : 'Green is whoever is ahead and amber is whoever is behind, so the colour tells you who is winning before you have read a number. Claim your team and your own side turns teal wherever it appears.',
      target: A.mine,
      when: () => ctx.hasComparison,
    },
    {
      id: 'record',
      title: 'The gameweek record',
      body:
        'The same wins, draws and losses as a bar, so a season that was close all the way looks different from one that was not. The grey middle is the weeks they scored exactly the same.',
      target: A.record,
      when: () => ctx.hasComparison,
    },
    {
      id: 'stats',
      title: 'Season stats',
      body:
        'Form is the average of the last five gameweeks. Best and Worst name the gameweek as well as the score. The better of each pair is the one printed larger, and for Worst that means the higher number.',
      target: A.stats,
      when: () => ctx.hasComparison,
    },
    {
      id: 'transfers',
      title: 'Transfers and bench',
      body:
        'Total Made is the whole season, Hit Cost is what those transfers cost in points, and Bench Points is what was left on the bench. Fewer hits is better; bench points are simply what got away.',
      target: A.transfers,
      when: () => ctx.hasComparison,
    },
    {
      id: 'points-chart',
      title: 'Gameweek by gameweek',
      body:
        'Both managers\' scores across the season, in their own colours. Drag across it for the exact pair at any gameweek.',
      target: A.points,
      when: () => ctx.hasComparison,
    },
    {
      id: 'rank-chart',
      title: 'League rank',
      body:
        'The only card here that is not just the two of them: rank is against the whole league, so a line can fall while the score goes up. It is drawn upside down on purpose, with first place at the top.',
      target: A.rank,
      when: () => ctx.hasComparison,
    },
    {
      id: 'gw-table',
      title: 'The same thing as numbers',
      body:
        'Every gameweek in order, each manager\'s score with the higher one in bold, and their league rank that week beside it. It scrolls.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.hasComparison,
    },
    {
      id: 'captains',
      title: 'Captains',
      body:
        'Who each of them backed every week and what it returned, doubled. Weeks they picked the same player are dimmed, and counted above. A TC badge is the Triple Captain chip, which is why the same player can score half as much again on one side.',
      target: A.captains,
      placement: 'sheet',
      when: () => ctx.hasComparison && ctx.hasCaptains,
    },
    {
      id: 'chips',
      title: 'Chips',
      body:
        `Each chip twice, first half then second: the season splits at GW${ctx.chipSecondHalfStartGw}, when FPL hands out a fresh set. A number is the gameweek it was played, ✓ is still to use, ✗ is a first-half chip that expired unplayed, and 🔒 is a second-half chip before the split.`,
      target: A.chips,
      placement: 'sheet',
      when: () => ctx.hasComparison,
    },
    {
      id: 'share',
      title: 'The link is the comparison',
      body:
        'Change either manager and everything above redraws. The address bar keeps both of them, so copying the link sends someone this exact comparison rather than an empty page.',
      target: A.selectors,
    },
    {
      id: 'done',
      title: 'That is Head to Head',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: H2H_TOUR_ID,
    version: H2H_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
