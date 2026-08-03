/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Set & Forget walkthrough.
 *
 * This is the page people are most likely to look at once, not understand, and
 * never return to, so the tour leads with the premise rather than the controls:
 * what the number actually is, before what the columns are called.
 *
 * There are no modals here and only one real interaction, the sortable headers,
 * so there is a single tap step. That is honest to the page; padding it with
 * things to tap would make it longer without making it clearer.
 */

export interface SafTourActions {
  /**
   * Put the ordering back to how the page loads. Sorting itself is done by the
   * user tapping the real header, so there is nothing here to do that.
   */
  resetSort: () => void;
}

export interface SafTourContext {
  ready: boolean;
  /** The table has rows, so the column steps have something to point at. */
  hasRows: boolean;
  /** Someone lost points by tinkering, so the "should have" card is rendered. */
  hasWorst: boolean;
  completedGWs: number;
  onStart: () => Promise<void>;
  onEnd: () => void;
  actions: SafTourActions;
}

const A = {
  premise: ['[data-tour="saf-premise"]'],
  worst: ['[data-tour="saf-worst"]'],
  table: ['[data-tour="saf-table"]'],
  diffHeader: ['[data-tour="saf-sort-difference"]'],
  myRow: [
    '[data-tour="saf-table"] tbody tr.my-team-row',
    '[data-tour="saf-table"] tbody tr:first-child',
  ],
  footer: ['[data-tour="saf-footer"]'],
};

export const SAF_TOUR_ID = 'set-and-forget';
/** Bump when the page changes enough that the old script would mislead. */
export const SAF_TOUR_VERSION = 1;

export function buildSafTour(ctx: SafTourContext): Tour {
  const { actions } = ctx;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Set & Forget',
      body:
        'One question, asked of everyone: what if you had picked your team before GW1 and then never touched it again? No transfers, no captain changes, nothing. This is that season, played out. Filled with example data so there is a full one to look at.',
      cta: 'Start',
    },
    {
      id: 'premise',
      title: 'The one rule',
      body:
        'Your GW1 eleven, every week, for the whole season. Auto-subs still apply, because FPL does those for you whether you turn up or not. Everything else is frozen.',
      target: A.premise,
    },
    {
      id: 'worst',
      title: 'The one nobody wants',
      body:
        'Whoever lost the most points by getting involved. Every transfer, every armband switch, every clever plan, and they would have finished this far ahead by doing nothing at all.',
      target: A.worst,
      when: () => ctx.hasWorst,
    },
    {
      id: 'table',
      title: 'Two seasons, side by side',
      body:
        'S&F Pts is the frozen-team season, Actual is what really happened, and the two rank columns are where each manager would have finished versus where they did. The little badge is places gained by being active, which can disagree with Diff: rank is relative, so you can gain points and still be overtaken by someone who gained more.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.hasRows,
    },
    {
      id: 'diff',
      title: 'Diff is the answer',
      body:
        'Actual minus set-and-forget. Green means all that meddling earned you something. Red means the season would have gone better if you had left your GW1 team alone and gone to the pub.',
      target: A.diffHeader,
      when: () => ctx.hasRows,
    },
    {
      id: 'sort-diff',
      title: 'Sort by it',
      body: 'Every column header sorts. This one is the interesting one.',
      target: A.diffHeader,
      tap: true,
      cta: 'Tap Diff',
      when: () => ctx.hasRows,
    },
    {
      id: 'sorted',
      title: 'Best and worst tinkerers',
      body:
        'Now the table runs from the manager who gained most by being active to the one who lost most. Tap it again to flip the order.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.hasRows,
      leave: () => actions.resetSort(),
    },
    {
      id: 'my-row',
      title: 'Your row',
      body:
        'Tinted teal, as everywhere else on the site. This is the row to check before you spend a free transfer next week.',
      target: A.myRow,
      when: () => ctx.hasRows,
    },
    {
      id: 'footer',
      title: 'How far in we are',
      body:
        'Based on ' +
        ctx.completedGWs +
        ' completed gameweeks. Early in a season the differences are small and mean very little; by the spring they are the whole argument.',
      target: A.footer,
      when: () => ctx.hasRows,
    },
    {
      id: 'done',
      title: 'That is Set & Forget',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: SAF_TOUR_ID,
    version: SAF_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
