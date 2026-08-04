import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Earnings walkthrough.
 *
 * There is nothing to open and nothing to sort on this page, so there are no tap
 * steps: it is a table and three tiles, and the tour explains where the money
 * comes from and what Net means. Adding something to tap would make it longer
 * without making it clearer.
 */

export interface EarningsTourContext {
  ready: boolean;
  /** The table has rows, so the column steps have something to point at. */
  hasRows: boolean;
  /**
   * Whether the real season's pot is settled. When it is not, the page the user
   * came from shows a dash in place of every £ value, and the run has to say so.
   */
  cashConfirmed: boolean;
  onStart: () => Promise<void>;
  onEnd: () => void;
}

const A = {
  pot: ['[data-tour="earnings-pot"]'],
  paidOut: ['[data-tour="earnings-paid-out"]'],
  payouts: ['[data-tour="earnings-payouts"]'],
  table: ['[data-tour="earnings-table"]'],
  // Falls back to the top row for a visitor with no claimed team, who has no
  // row of their own anywhere.
  myRow: [
    '[data-tour="earnings-table"] tbody tr.my-team-row',
    '[data-tour="earnings-table"] tbody tr:first-child',
  ],
};

export const EARNINGS_TOUR_ID = 'earnings';
/** Bump when the page changes enough that the old script would mislead. */
export const EARNINGS_TOUR_VERSION = 1;

export function buildEarningsTour(ctx: EarningsTourContext): Tour {
  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Earnings',
      body:
        'What the league has taken in and paid out, manager by manager. Filled with example data: a finished season for an example league of six, so every column has something in it.',
      cta: 'Start',
    },
    {
      id: 'pot',
      title: 'The pot',
      body: 'Every entry fee, plus one weekly loser fine for each gameweek in the season. The line underneath is that sum.',
      target: A.pot,
    },
    {
      id: 'pending',
      title: 'Why your page shows dashes',
      body:
        'The pot depends on the final entrant count, so it is not declared until every entry is in. Until then this page shows a dash in place of every £ value. The counts, weekly losses and MotM wins, still show.',
      target: A.pot,
      when: () => !ctx.cashConfirmed,
    },
    {
      id: 'paid-out',
      title: 'Paid out',
      body: 'Prize money awarded so far. League prizes are only added once the season is complete.',
      target: A.paidOut,
    },
    {
      id: 'payouts',
      title: 'Where it goes',
      body: 'The three league places, the cup, and Manager of the Month, which pays out once per period.',
      target: A.payouts,
    },
    {
      id: 'table',
      title: 'One row per manager',
      body:
        'Weekly Losses is how many gameweeks they finished bottom, with the fines beside it. MotM is periods won and the prize money for them. League and Cup stay empty until those are settled.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.hasRows,
    },
    {
      id: 'net',
      title: 'Net is the answer',
      body:
        'Paid In is the entry fee plus fines, Earned is prize money, and Net is Earned minus Paid In. Green is up on the season, red is down. The table is sorted by it, and scrolls sideways to reach those three columns on a narrow screen.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.hasRows,
    },
    {
      id: 'my-row',
      title: 'Your row',
      body: 'Tinted teal, as everywhere else on the site.',
      target: A.myRow,
      placement: 'sheet',
      when: () => ctx.hasRows,
    },
    {
      id: 'done',
      title: 'That is Earnings',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: EARNINGS_TOUR_ID,
    version: EARNINGS_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
