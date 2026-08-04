/**
 * The planner walkthroughs — two of them, because /planner is two pages
 * wearing one URL.
 *
 * Pre-season it is a squad builder: FPL publishes nothing manager-specific
 * until the GW1 deadline, so a first-time visitor lands on an empty builder
 * with fifteen slots to fill. Once there are fifteen players it is a five-week
 * planner. A single script covering both would be forty steps long and would
 * open with eight steps a mid-season visitor has no use for, so the page hosts
 * whichever one matches what is on screen (see page.tsx) and each records its
 * own seen-state.
 *
 * Both were argued out at prototypes/planner-tour.html first; the step lists
 * here are that prototype's, and the anchors are the ones it named.
 *
 * The `when` gates carry the other split: pre-season and in-season are
 * genuinely different pages — `Unlimited` versus derived free transfers, a
 * practice draft versus a published squad, and points, form and price movement
 * that are all zero until GW1. One rule learned the hard way in the prototype:
 * a gate must not depend on state the tour itself changes (which gameweek is
 * selected, say), because eligibility is recounted on every render and the
 * step count would shift mid-run.
 */
import type { Tour, TourStep } from '@/lib/tour';
import { POSITION_NAMES, formatPrice } from '@/lib/squad-rules';
import type { DemoSubjects } from './demoPlanner';

export const PLANNER_BUILDER_TOUR_ID = 'planner-builder';
export const PLANNER_TOUR_ID = 'planner';
/** Bump when the page changes enough that the old script would mislead. */
export const PLANNER_BUILDER_TOUR_VERSION = 1;
export const PLANNER_TOUR_VERSION = 1;

/** Anchors, so a rename shows up here rather than as a silently skipped step. */
const A = {
  builderTiles: ['[data-tour="builder-tiles"]'],
  builderHint: ['[data-tour="builder-hint"]'],
  builderPitch: ['[data-tour="builder-pitch"]'],
  builderBench: ['[data-tour="builder-bench"]'],
  builderActions: ['[data-tour="builder-actions"]'],
  builderDone: ['[data-tour="builder-done"]'],
  detailFdr: ['[data-tour="detail-fdr"]'],
  detailBar: ['[data-tour="pitch-detail-bar"]'],
  browserBudget: ['[data-tour="browser-budget"]'],
  browserRows: ['[data-tour="browser-rows"]'],
  playerFixtures: ['[data-tour="player-fixtures"]'],
  playerLedger: ['[data-tour="player-ledger"]'],
  playerActions: ['[data-tour="player-actions"]'],
  actTransfer: ['[data-tour="act-transfer"]'],
  sandbox: ['[data-tour="sandbox"]'],
  rebase: ['[data-tour="rebase"]'],
  gwBar: ['[data-tour="gw-bar"]'],
  deadline: ['[data-tour="deadline"]'],
  planStats: ['[data-tour="plan-stats"]'],
  tileFt: ['[data-tour="tile-ft"]'],
  tileHit: ['[data-tour="tile-hit"]'],
  chipBar: ['[data-tour="chip-bar"]'],
  chipTc: ['[data-tour="chip-3xc"]'],
  pitch: ['[data-tour="pitch"]'],
  pitchBench: ['[data-tour="pitch-bench"]'],
  footer: ['[data-tour="transfer-footer"]'],
  viewFixtures: ['[data-tour="view-fixtures"]'],
  viewPrices: ['[data-tour="view-prices"]'],
  fdrMatrix: ['[data-tour="fdr-matrix"]'],
  fdrAttr: ['[data-tour="fdr-attr"]'],
  pricesList: ['[data-tour="prices-list"]'],
  pricesRecent: ['[data-tour="prices-recent"]'],
  pricesEmpty: ['[data-tour="prices-empty"]'],
};

const player = (el: number) => [`[data-tour="plr-${el}"]`];
const emptySlot = (type: number) => [`[data-tour="builder-empty-${type}"]`];
const browserIn = (el: number) => [`[data-tour="browser-in-${el}"]`];
const browserRow = (el: number) => [`[data-tour="browser-row-${el}"]`];

// =============================================================================
// Squad Builder
// =============================================================================

export interface BuilderTourContext {
  ready: boolean;
  /**
   * Null until the first run: the demo squad is what names the subjects, and it
   * is built by `onStart`. The engine awaits onStart and lets the host
   * republish before it measures step one, so every step that needs a subject
   * has one by the time it is walked — and if the demo cannot be built, onStart
   * throws and no run starts at all.
   */
  subjects: DemoSubjects | null;
  /** Fill the demo draft's last gap, so the completed-squad steps have a squad. */
  completeDraft: () => void;
  /**
   * Dismiss the player card. Its open state belongs to SquadBuilder rather
   * than the page, so the honest way to close it from here is to click its own
   * ✕ — the same call the Scores walkthrough makes for the pitch breakdown.
   */
  closeCard: () => void;
  onStart: () => Promise<void>;
  onEnd: () => void;
}

export function buildPlannerBuilderTour(ctx: BuilderTourContext): Tour {
  const { subjects } = ctx;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Squad Builder',
      body:
        'Pick 15 players from £100.0m. The planner then uses them as your base squad until FPL publishes your real one at the GW1 deadline. Filled with an example draft of 13.',
      cta: 'Start',
    },
    {
      id: 'pitch',
      title: 'The squad so far',
      body:
        'Picked players in position rows, a dashed square for every slot still empty. Each shirt carries the name, the price and one detail line.',
      target: A.builderPitch,
      placement: 'sheet',
    },
    {
      id: 'detail-tap',
      title: 'The detail line',
      body:
        'Five options: this week’s opponent, difficulty of the next three weeks, price pressure, expected points, form.',
      target: A.detailFdr,
      tap: true,
      cta: 'Tap FDR',
    },
    {
      id: 'fdr-read',
      title: 'FDR',
      body:
        'Each shirt now shows its next three gameweeks, coloured 1 (easy) to 5 (hard). A dashed cell is a blank gameweek; two cells in an amber box is a double.',
      target: A.builderPitch,
      placement: 'sheet',
    },
    {
      id: 'empty-tap',
      title: 'Adding a player',
      body: 'An empty shirt opens the player list filtered to that position.',
      target: subjects ? emptySlot(subjects.emptyPosition) : undefined,
      tap: true,
      cta: subjects ? `Tap the empty ${POSITION_NAMES[subjects.emptyPosition].toLowerCase()}` : 'Tap the empty shirt',
    },
    {
      id: 'cap',
      title: 'The budget it gives you',
      body: subjects
        ? `${formatPrice(subjects.builderCap)}, not everything you have left to spend: it holds back the cheapest option for each slot still empty, so you cannot buy your way into a squad you are then unable to finish. The list is filtered to it — Max lifts that if you want to see the rest.`
        : 'Less than everything you have left to spend: it holds back the cheapest option for each slot still empty, so you cannot buy your way into a squad you are then unable to finish.',
      target: A.browserBudget,
    },
    {
      id: 'pick',
      title: 'In',
      body: 'Adds him and closes the list. Tapping his name opens his card instead.',
      target: subjects ? browserIn(subjects.builderPick.id) : undefined,
      tap: true,
      cta: subjects ? `Tap In on ${subjects.builderPick.web_name}` : 'Tap In',
    },
    {
      id: 'fifteenth',
      title: 'Fifteen picked',
      body:
        'With the last slot filled too: 15 players, no rule broken, and whatever is left sits in the bank. Plan with this squad is now enabled.',
      target: A.builderTiles,
      before: () => ctx.completeDraft(),
    },
    {
      id: 'split',
      title: 'XI and bench',
      body:
        'The top eleven start. The four below are the bench in substitution order, keeper first. Bench players carry the same detail line as starters.',
      target: A.builderBench,
    },
    {
      id: 'plr-tap',
      title: 'Player card',
      body: 'Opens from any shirt.',
      target: subjects ? player(subjects.benchPlayer.id) : undefined,
      tap: true,
      cta: subjects ? `Tap ${subjects.benchPlayer.web_name}` : 'Tap a player',
    },
    {
      id: 'card-acts',
      title: 'Swap and Remove',
      body:
        'Swap selects this player; the next one you tap changes places with him. That covers benching a starter, promoting a substitute and reordering the bench. Remove returns his price to the budget.',
      target: A.playerActions,
      placement: 'sheet',
      leave: () => ctx.closeCard(),
    },
    {
      id: 'auto',
      title: 'Auto-pick lineup, Clear squad',
      body:
        'Auto-pick arranges a legal eleven. Clear squad empties the draft and restores the £100.0m.',
      target: A.builderActions,
    },
    {
      id: 'done-btn',
      title: 'Plan with this squad',
      body:
        'Hands the draft to the planner as its base squad. The draft saves itself in this browser as you go.',
      target: A.builderDone,
    },
    {
      id: 'finish',
      title: 'Done',
      body:
        'The example draft goes and your own squad comes back. See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: PLANNER_BUILDER_TOUR_ID,
    version: PLANNER_BUILDER_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}

// =============================================================================
// Planner
// =============================================================================

export interface PlannerTourContext {
  ready: boolean;
  /** Null until the first run — see BuilderTourContext.subjects. */
  subjects: DemoSubjects | null;
  /** Before the GW1 deadline: the base squad is a draft and GW1 is free. */
  preSeason: boolean;
  /** First planned gameweek — the one the page opens on. */
  firstGw: number;
  /** True while the demo's rebase banner is showing (in-season only). */
  hasRebase: boolean;
  /**
   * Which halves of the Prices view exist. Neither is a property of the season:
   * the Predicted tab appears only once the feed carries non-zero
   * price_change_percent values, and Recent has rows only once prices have
   * actually moved. The steps follow the page rather than the calendar.
   */
  hasPredictedPrices: boolean;
  hasPriceChanges: boolean;
  onStart: () => Promise<void>;
  onEnd: () => void;
}

export function buildPlannerTour(ctx: PlannerTourContext): Tour {
  const { subjects, preSeason } = ctx;
  const secondGw = ctx.firstGw + 1;

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Team Planner',
      body:
        'Plans the next five gameweeks from your squad: transfers, chips, captaincy, and what each does to your money and your points. Running on an example squad and plan; nothing is saved.',
      cta: 'Start',
    },
    {
      id: 'sandbox',
      title: 'The base squad',
      body:
        'Before the first deadline the planner runs on the draft from the squad builder. It switches to your real squad when GW1 locks.',
      target: A.sandbox,
      when: () => preSeason,
    },
    {
      id: 'rebase',
      title: 'Plan out of date',
      body:
        'Shown when your squad has changed since the plan was saved. Rebase restarts the plan from the current squad; the old plan is kept until you do.',
      target: A.rebase,
      when: () => ctx.hasRebase,
    },
    {
      id: 'gwbar',
      title: 'Gameweek selector',
      body:
        'Everything below belongs to the selected week. The marks under each number are the chip code, the transfer count, and a red dot for a validation problem.',
      target: A.gwBar,
    },
    {
      id: 'tiles',
      title: 'Bank, value, free transfers, hit',
      body:
        'Each figure as it will stand entering the selected week, with every earlier week already applied. The line under each is the change from the week before.',
      target: A.planStats,
      placement: 'sheet',
    },
    {
      id: 'unlimited',
      title: 'GW1 is free',
      body:
        'Before the GW1 deadline changes are unlimited and cost nothing. Free transfers start accruing at GW2.',
      target: A.tileFt,
      when: () => preSeason,
    },
    {
      id: 'gw-tap',
      title: 'Selecting a week',
      body:
        'This one already has a transfer planned in it. Its deadline is shown underneath.',
      target: [`[data-tour="gw-${secondGw}"]`],
      tap: true,
      cta: `Tap GW${secondGw}`,
    },
    {
      id: 'deadline',
      title: 'The deadline you are planning for',
      body:
        'Everything planned into this week has to be done on FPL before this. The planner is a sketchpad — it cannot make the moves for you.',
      target: A.deadline,
    },
    {
      id: 'ft',
      title: 'Free transfers',
      body:
        'FPL does not publish this, so it is derived from your transfer history. − and + correct it, and every later week recalculates. “check” means the derivation was not confident.',
      target: A.tileFt,
    },
    {
      id: 'chips',
      title: 'Chips',
      body:
        'One of each per half-season, one chip per week. Setting one here is a plan; it still has to be played on FPL. Struck through means already played, or already planned in another week of the same half.',
      target: A.chipBar,
    },
    {
      id: 'chip-tap',
      title: 'Planning a chip',
      body: 'Triple Captain on this week. The gameweek bar picks up a TC mark.',
      target: A.chipTc,
      tap: true,
      cta: 'Tap TC',
    },
    {
      id: 'detail-tap',
      title: 'The detail line',
      body: 'The same bar as the builder, with the same five options.',
      target: A.detailFdr,
      tap: true,
      cta: 'Tap FDR',
    },
    {
      id: 'pitch',
      title: 'The XI',
      body:
        'Formation with captain and vice marked, three gameweeks of difficulty under each shirt, bench below drawn the same way.',
      target: A.pitch,
      placement: 'sheet',
    },
    {
      id: 'lines',
      title: 'The other four options',
      body: preSeason
        ? 'Opponent is this week’s fixture. Price, xP and Form all read zero pre-season: FPL publishes no points, form or price movement until GW1.'
        : 'Opponent is this week’s fixture. Price is how close he is to a rise or a fall, xP is FPL’s expected points for next week, Form is points per game over the last 30 days.',
      target: A.detailBar,
    },
    {
      id: 'plr-tap',
      title: 'Player card',
      body: 'Opens from any shirt.',
      target: subjects ? player(subjects.transferOut.id) : undefined,
      tap: true,
      cta: subjects ? `Tap ${subjects.transferOut.web_name}` : 'Tap a player',
    },
    {
      id: 'card-fix',
      title: 'Next five fixtures',
      body: 'Counted from the selected gameweek, not from today.',
      target: A.playerFixtures,
    },
    {
      id: 'card-live',
      title: 'Price, form, season',
      body:
        'How close he is to a price change and which way, the net transfers behind it, form, points per game and ownership. Season totals on the right.',
      target: A.playerLedger,
      when: () => !preSeason,
    },
    {
      id: 'card-zeros',
      title: 'Zero until GW1',
      body:
        'Every figure here fills in from GW1. Pre-season only the price and the fixtures above it are populated.',
      target: A.playerLedger,
      when: () => preSeason,
    },
    {
      id: 'card-acts',
      title: 'Four actions',
      body:
        'Bench or start him, captain, vice, transfer out. An unavailable action states the reason: captaincy for a bench player, a swap with no legal partner.',
      target: A.playerActions,
      placement: 'sheet',
    },
    {
      id: 'transfer-tap',
      title: 'Transfer out',
      body:
        'Opens the list filtered to his position, with clubs you already have three of removed.',
      target: A.actTransfer,
      tap: true,
      cta: 'Tap Transfer',
    },
    {
      id: 'browser-budget',
      title: 'Budget',
      body:
        'Your bank plus his selling price, not what he cost. FPL returns only half of any rise since you bought him, and the planner uses selling price throughout.',
      target: A.browserBudget,
    },
    {
      id: 'buy',
      title: 'In',
      body: 'Completes the transfer for this week. Later weeks inherit it.',
      target: subjects ? browserIn(subjects.transferIn.id) : undefined,
      tap: true,
      cta: subjects ? `Tap In on ${subjects.transferIn.web_name}` : 'Tap In',
    },
    {
      id: 'footer',
      title: 'This week’s changes',
      body:
        'Each transfer with an undo, and Reset GW to clear the week. Saved ✓ means written to this browser: the plan is per device, per season, and never sent to FPL.',
      target: A.footer,
    },
    {
      id: 'hit',
      title: 'Points hit',
      body:
        'One free transfer, two used, so the second costs 4 points — shown here and in red at the foot of the page. The bank moved at the same time.',
      target: A.tileHit,
    },
    {
      id: 'fixtures-tap',
      title: 'Fixtures and Prices',
      body: 'Neither depends on your squad.',
      target: A.viewFixtures,
      tap: true,
      cta: 'Tap Fixtures',
    },
    {
      id: 'matrix',
      title: 'Difficulty matrix',
      body:
        'Every club, every remaining week. Upper case is home, lower case away, colour is difficulty. Clubs are sorted by how attractive their run is. DGW marks a double gameweek, BGW a blank.',
      target: A.fdrMatrix,
      placement: 'sheet',
    },
    {
      id: 'attr',
      title: 'Attr.',
      body:
        'Average difficulty over the weeks shown, adjusted down for a double and up for a blank, with the number of games it is based on. Lower is better.',
      target: A.fdrAttr,
    },
    {
      id: 'prices-tap',
      title: 'Prices',
      body: 'Who is close to a rise, and who is close to a fall.',
      target: A.viewPrices,
      tap: true,
      cta: 'Tap Prices',
    },
    {
      id: 'prices-empty',
      title: 'Empty until GW1',
      body:
        'Prices do not move pre-season, so this says so rather than showing a page of zeros. From GW1 it lists who is closest to a change tonight, and every change already applied.',
      target: A.pricesEmpty,
      when: () => !ctx.hasPriceChanges && !ctx.hasPredictedPrices,
    },
    {
      id: 'predicted',
      title: 'Predicted',
      body:
        'Progress towards each player’s next price change: 100% is the threshold, changes land at midnight UK, ringed means imminent.',
      target: A.pricesList,
      when: () => ctx.hasPredictedPrices,
    },
    {
      id: 'recent-tap',
      title: 'Recent',
      body: 'The other half of the page: changes already applied.',
      target: A.pricesRecent,
      tap: true,
      cta: 'Tap Recent',
      // Only when there is a toggle to tap: without predicted values the page
      // shows Recent on its own and there is no pair of tabs.
      when: () => ctx.hasPredictedPrices,
    },
    {
      id: 'recent',
      title: 'Changes already applied',
      body:
        'The new price and the step it took. This is the list to check when your squad value has moved overnight.',
      target: A.pricesList,
      when: () => ctx.hasPriceChanges,
    },
    {
      id: 'done',
      title: 'Done',
      body:
        'The example squad and plan go, and your own come back untouched — nothing here was saved. The transfers still have to be made on FPL, before the deadline.',
      cta: 'Finish',
    },
  ];

  return {
    id: PLANNER_TOUR_ID,
    version: PLANNER_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
