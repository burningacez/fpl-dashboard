/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Weekly Losers walkthrough.
 *
 * Same model as the Scores one (see src/app/week/weekTour.ts): steps drive page
 * state through `actions`, tap steps are completed by tapping the real control,
 * and the run narrates demo data so it works pre-season. This page is far
 * simpler, so the tour is eleven steps rather than thirty-one; the job is
 * explaining what the tiles mean and that they open.
 */

export interface LosersTourActions {
  openGw: (gw: number) => void;
  closeGw: () => void;
  setLiveOpen: (open: boolean) => void;
}

export interface LosersTourContext {
  ready: boolean;
  /** A gameweek is in progress, so the live tile and its modal exist. */
  hasLive: boolean;
  /** At least one gameweek has finished, so a completed tile exists. */
  hasCompleted: boolean;
  /** Gameweek the tour opens. */
  focusGw: number;
  onStart: () => Promise<void>;
  onEnd: () => void;
  actions: LosersTourActions;
}

const A = {
  grid: ['[data-tour="losers-grid"]'],
  tileDone: ['[data-tour="losers-tile-done"]'],
  tileLive: ['[data-tour="losers-tile-live"]'],
  gwTable: ['[data-tour="losers-gw-table"]'],
  gwTiebreak: ['[data-tour="modal-losers-gw"] [data-tour="losers-tiebreak"]'],
  gwClose: ['[data-tour="modal-losers-gw"] button[aria-label="Close"]'],
  liveTable: ['[data-tour="losers-live-table"]'],
};

export const LOSERS_TOUR_ID = 'losers';
/** Bump when the page changes enough that the old script would mislead. */
export const LOSERS_TOUR_VERSION = 1;

export function buildLosersTour(ctx: LosersTourContext): Tour {
  const { actions } = ctx;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Weekly Losers',
      body:
        'Every gameweek has a loser, and this page remembers all of them. Filled with example data so there is a full season to look at.',
      cta: 'Start',
    },
    {
      id: 'grid',
      title: 'The season, one tile per week',
      body:
        'One card for each gameweek of the season. Finished weeks name their loser, the week in progress shows who is heading that way, and the rest sit greyed out until they come round.',
      target: A.grid,
      placement: 'sheet',
    },
    {
      id: 'tile-done',
      title: 'A finished week',
      body:
        'Red border, the loser\'s name, and how far off the pace they were. "Tiebreaker" instead of a margin means two people tied on points and it had to be settled another way.',
      target: A.tileDone,
      when: () => ctx.hasCompleted,
    },
    {
      id: 'tile-live',
      title: 'The week in progress',
      body:
        'A gold border and Losing rather than Loser, updating itself while the gameweek runs. Whoever is named here is only provisionally bottom; it moves as the matches do.',
      target: A.tileLive,
      when: () => ctx.hasLive,
    },
    {
      id: 'open-gw',
      title: 'Tap a week for the full table',
      body: 'Any finished week opens the scores behind the verdict.',
      target: A.tileDone,
      tap: true,
      cta: 'Tap the highlighted week',
      when: () => ctx.hasCompleted,
    },
    {
      id: 'gw-table',
      title: 'Everyone, worst first',
      body:
        'The whole league for that week with the loser badged at the top. Goals, assists and transfers are here because they are what breaks a tie. Every column header sorts.',
      target: A.gwTable,
      placement: 'sheet',
      waitMs: 2000,
      when: () => ctx.hasCompleted,
    },
    {
      id: 'gw-tiebreak',
      title: 'How a tie gets settled',
      body:
        'When two managers finish level on points, this is the order it goes in. If everything ties all the way down, it comes to a coin flip, and the result is saved so it never changes.',
      target: A.gwTiebreak,
      placement: 'sheet',
      when: () => ctx.hasCompleted,
    },
    {
      id: 'gw-close',
      title: 'Close it',
      body: 'The ✕, or a tap outside the panel.',
      target: A.gwClose,
      tap: true,
      cta: 'Tap ✕',
      when: () => ctx.hasCompleted,
    },
    {
      id: 'open-live',
      title: 'Tap the live week',
      body: 'The week in progress opens the same table, as it stands right now.',
      target: A.tileLive,
      tap: true,
      cta: 'Tap the live week',
      when: () => ctx.hasLive,
    },
    {
      id: 'live-table',
      title: 'As it stands',
      body:
        'Who is bottom at this moment, badged LOSING rather than LOSER, with how many players each manager still has to play. Someone last with a full bench to come is not in trouble yet.',
      target: A.liveTable,
      placement: 'sheet',
      waitMs: 2000,
      when: () => ctx.hasLive,
      leave: () => actions.setLiveOpen(false),
    },
    {
      id: 'done',
      title: 'That is Weekly Losers',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: LOSERS_TOUR_ID,
    version: LOSERS_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
