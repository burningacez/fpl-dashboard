import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Manager of the Month walkthrough.
 *
 * Same model as the Weekly Losers one (see src/app/losers/losersTour.ts): the
 * run narrates demo data so it works pre-season, tap steps are completed by
 * tapping the real tile, and the job is explaining what a period is, what wins
 * one, and what the columns behind a tile mean.
 */

export interface MotmTourActions {
  /** Close the rankings modal a tap step opened. */
  closePeriod: () => void;
}

export interface MotmTourContext {
  ready: boolean;
  /** At least one period has finished, so a winner tile exists. */
  hasComplete: boolean;
  /** A gameweek is in progress, so a live period tile exists. */
  hasLive: boolean;
  /** Periods in the season, as the page header counts them. */
  periodCount: number;
  /** Goals and assists are tiebreakers this season, and are shown as columns. */
  showAttacking: boolean;
  onStart: () => Promise<void>;
  onEnd: () => void;
  actions: MotmTourActions;
}

const A = {
  grid: ['[data-tour="motm-grid"]'],
  tileDone: ['[data-tour="motm-tile-done"]'],
  tileLive: ['[data-tour="motm-tile-live"]'],
  rankings: ['[data-tour="modal-motm-period"] [data-tour="motm-rankings"]'],
  // Falls back to the top row for a visitor with no claimed team, who has no
  // row of their own anywhere.
  myRow: [
    '[data-tour="motm-rankings"] tbody tr.my-team-row',
    '[data-tour="motm-rankings"] tbody tr:first-child',
  ],
};

export const MOTM_TOUR_ID = 'motm';
/** Bump when the page changes enough that the old script would mislead. */
export const MOTM_TOUR_VERSION = 1;

export function buildMotmTour(ctx: MotmTourContext): Tour {
  const { actions } = ctx;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Manager of the Month',
      body:
        'The season is split into ' +
        ctx.periodCount +
        ' periods, and each one is won by the highest net score across its gameweeks. Filled with example data so there is a full season to look at.',
      cta: 'Start',
    },
    {
      id: 'grid',
      title: 'The season, one tile per period',
      body:
        'Finished periods name their winner, the period in progress names whoever leads it, and the rest say Not started until their first gameweek is played.',
      target: A.grid,
      placement: 'sheet',
    },
    {
      id: 'tile-done',
      title: 'A finished period',
      body: 'The gameweeks it covered, the winner, and how many net points clear of second they finished.',
      target: A.tileDone,
      when: () => ctx.hasComplete,
    },
    {
      id: 'tile-live',
      title: 'The period in progress',
      body:
        'Leading rather than Winner, with a LIVE badge while a gameweek is being played. The name here changes as scores come in.',
      target: A.tileLive,
      when: () => ctx.hasLive,
    },
    {
      id: 'open-period',
      title: 'Tap a period for the rankings',
      body: 'Every tile opens the full table behind it.',
      target: A.tileDone,
      tap: true,
      cta: 'Tap the highlighted period',
      when: () => ctx.hasComplete,
    },
    {
      id: 'rankings',
      title: 'Everyone, best first',
      body:
        'Net is what the period is won on: gross points minus transfer hits. Gross is before those hits and Trf is transfers made, with the hit in red. Best is the manager\'s highest single gameweek in the period and Low their worst. The winner\'s row is highlighted.',
      target: A.rankings,
      placement: 'sheet',
      waitMs: 2000,
      when: () => ctx.hasComplete,
    },
    {
      id: 'tiebreak',
      title: 'How a tie gets settled',
      body: ctx.showAttacking
        ? 'Level on net score goes to most goals, then most assists, then fewest transfers, then the best single gameweek, then whoever\'s worst weeks were better. A coin flip settles anything left, and it is saved so it never changes.'
        : 'Level on net score goes to fewest transfers, then the best single gameweek, then whoever\'s worst weeks were better. A coin flip settles anything left, and it is saved so it never changes.',
      target: A.rankings,
      placement: 'sheet',
      when: () => ctx.hasComplete,
    },
    {
      id: 'my-row',
      title: 'Your row',
      body: 'Tinted teal, as everywhere else on the site.',
      target: A.myRow,
      placement: 'sheet',
      when: () => ctx.hasComplete,
      leave: () => actions.closePeriod(),
    },
    {
      id: 'open-live',
      title: 'Tap the live period',
      body: 'The period in progress opens the same table, as it stands right now.',
      target: A.tileLive,
      tap: true,
      cta: 'Tap the live period',
      when: () => ctx.hasLive,
    },
    {
      id: 'live-rankings',
      title: 'Nothing settled yet',
      body:
        'The same columns, counting the gameweek being played. No row is highlighted, because a period has no winner until its last gameweek is finished.',
      target: A.rankings,
      placement: 'sheet',
      waitMs: 2000,
      when: () => ctx.hasLive,
      leave: () => actions.closePeriod(),
    },
    {
      id: 'done',
      title: 'That is Manager of the Month',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: MOTM_TOUR_ID,
    version: MOTM_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
