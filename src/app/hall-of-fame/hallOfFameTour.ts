import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Hall of Fame walkthrough.
 *
 * Same model as the other tours (see src/app/losers/losersTour.ts): demo data so
 * it works pre-season, and tap steps completed by tapping the real card. Every
 * card here works the same way, so the run opens one of them rather than one of
 * each: the job is explaining what a card holds, that they open, how a shared
 * record reads, and that the lowlights are the same thing in reverse.
 */

export interface HofTourActions {
  /** Close the award modal a tap step opened. */
  closeAward: () => void;
}

export interface HofTourContext {
  ready: boolean;
  /** The highlights grid has cards, so the card steps have something to point at. */
  hasHighlights: boolean;
  /** The lowlights grid has cards. */
  hasLowlights: boolean;
  onStart: () => Promise<void>;
  onEnd: () => void;
  actions: HofTourActions;
}

const A = {
  highlights: ['[data-tour="hof-highlights"]'],
  card: ['[data-tour="hof-card"]'],
  award: ['[data-tour="modal-hof-award"]'],
  tied: ['[data-tour="hof-tied"]'],
  // Records are keyed by name, so a visitor with no claimed team holds nothing
  // and the teal card doesn't exist. Falls back to the card beside it.
  mine: ['[data-tour="hof-highlights"] .my-team-card', '[data-tour="hof-card"]'],
  lowlights: ['[data-tour="hof-lowlights"]'],
};

export const HOF_TOUR_ID = 'hall-of-fame';
/** Bump when the page changes enough that the old script would mislead. */
export const HOF_TOUR_VERSION = 1;

export function buildHofTour(ctx: HofTourContext): Tour {
  const { actions } = ctx;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Hall of Fame',
      body:
        'Every record the league keeps, from the best single gameweek to the worst use of a chip. Filled with example data so there is a full season to look at.',
      cta: 'Start',
    },
    {
      id: 'highlights',
      title: 'Highlights',
      body: 'The records worth having, each one on a card with a teal top border.',
      target: A.highlights,
      placement: 'sheet',
      when: () => ctx.hasHighlights,
    },
    {
      id: 'card',
      title: 'What is on a card',
      body: 'The award, who holds it, the number that won it, and when it happened.',
      target: A.card,
      when: () => ctx.hasHighlights,
    },
    {
      id: 'open-card',
      title: 'Tap a card',
      body: 'Every card opens for the definition behind the number.',
      target: A.card,
      tap: true,
      cta: 'Tap the highlighted card',
      when: () => ctx.hasHighlights,
    },
    {
      id: 'award',
      title: 'Behind the card',
      body: 'What the record measures and how it is worked out, then the number and who holds it.',
      target: A.award,
      placement: 'sheet',
      waitMs: 2000,
      when: () => ctx.hasHighlights,
      leave: () => actions.closeAward(),
    },
    {
      id: 'tied',
      title: 'Shared records',
      body:
        'Where a record is tied the card names one holder and counts the rest. Opening it lists all of them.',
      target: A.tied,
      when: () => ctx.hasHighlights,
    },
    {
      id: 'mine',
      title: 'Records you hold',
      body: 'Tinted teal, as everywhere else on the site.',
      target: A.mine,
      when: () => ctx.hasHighlights,
    },
    {
      id: 'lowlights',
      title: 'Lowlights',
      body:
        'The same cards for the records nobody wants, with a red top border: lowest score, most weekly losses, biggest points hit, worst chip week.',
      target: A.lowlights,
      placement: 'sheet',
      when: () => ctx.hasLowlights,
    },
    {
      id: 'done',
      title: 'That is the Hall of Fame',
      body:
        'The example season goes away now and the real one comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: HOF_TOUR_ID,
    version: HOF_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
