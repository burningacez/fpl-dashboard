/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Tour, TourStep } from '@/lib/tour';

/**
 * The Scores-page walkthrough.
 *
 * Kept beside the page rather than in a global registry so the steps sit next
 * to the thing they describe; when someone restructures this page they are
 * looking at this file already.
 *
 * Steps drive page state through `actions` (plain setState calls) instead of
 * synthesising clicks on the real controls. That matters: the modals here mount
 * their body before their fetch resolves and close on a backdrop click, so
 * click-synthesis would be both racy and dismissable. Calling the setter is
 * what the button would have done anyway.
 *
 * The walkthrough runs against demo data (see demoWeek.ts), which is what makes
 * it worth having: people arrive pre-season, when the real page has no scores,
 * no fixtures and an empty table, so a tour on live data would show barely a
 * third of its steps at exactly the moment it matters. `onStart` swaps the
 * example league in and `onEnd` puts the real one back.
 *
 * The `when` gates are therefore a safety net rather than the main event, they
 * keep the tour coherent if demo data ever fails to load, instead of pointing
 * at things that aren't on screen.
 */

export interface WeekTourActions {
  setView: (v: 'scores' | 'form') => void;
  setHlOpen: (open: boolean) => void;
  setOpenFixture: (fixture: any) => void;
  setOpenProfile: (manager: any) => void;
  setOpenEntry: (entry: { id: number; name: string } | null) => void;
  setSelectedEventKey: (key: string | null) => void;
  /**
   * Dismiss the player breakdown. That sheet's open state belongs to PitchView,
   * not the page, so the only honest way to close it from here is to click its
   * own ✕ rather than reach into the component.
   */
  closePlayer: () => void;
}

export interface WeekTourContext {
  ready: boolean;
  /** Viewing the current gameweek of the current season. */
  viewingLive: boolean;
  /** Matches in play (always true of the example gameweek). */
  live: boolean;
  managers: any[];
  fixtures: any[];
  /** Ticker event to pin for the "who did this hit" step, if there is one. */
  focusEventKey: string | null;
  /**
   * Row the modal steps open. In demo mode this is the example row seated with
   * the user's own name, so "this is you" is literally true.
   */
  focusManager: any | null;
  shownGW: number;
  /** Enter/leave demo mode. Awaited before step 1; undone however the tour ends. */
  onStart: () => Promise<void>;
  onEnd: () => void;
  actions: WeekTourActions;
}

/**
 * `[data-tour]` anchors, most-preferred selector first.
 *
 * Most are attributes on the real components. A couple are positional by nature:
 * "the row that is mine" and "the first event in the ticker" are not things a
 * static attribute can know, so they fall back to nth-child.
 */
const A = {
  gw: ['[data-tour="week-gw"]'],
  liveBadge: ['[data-tour="week-live"]'],
  tabScores: ['[data-tour="week-tab-scores"]'],
  tabForm: ['[data-tour="week-tab-form"]'],
  form: ['[data-tour="week-form"]'],
  highlight: ['[data-tour="week-highlight"]'],
  ticker: ['[data-tour="week-ticker"]'],
  tickerFirst: ['[data-tour="week-ticker"] .lt-event'],
  tickerClear: ['[data-tour="week-ticker-clear"]'],
  fixtureFirst: ['[data-tour="week-fixtures"] button'],
  table: ['[data-tour="week-table"]'],
  myRow: [
    '[data-tour="week-table"] tbody tr.my-team-row',
    '[data-tour="week-table"] tbody tr:first-child',
  ],
  managerCell: [
    '[data-tour="week-table"] tbody tr.my-team-row td:nth-child(2) button',
    '[data-tour="week-table"] tbody tr:first-child td:nth-child(2) button',
  ],
  modalHighlight: ['[data-tour="modal-highlight"]'],
  closeHighlight: ['[data-tour="modal-highlight"] button[aria-label="Close"]'],
  matchLineups: ['[data-tour="match-lineups"]'],
  matchDefcon: ['[data-tour="match-defcon"]'],
  matchBonus: ['[data-tour="match-bonus"]'],
  profileStats: ['[data-tour="profile-stats"]'],
  profileChips: ['[data-tour="profile-chips"]'],
  profileRecords: ['[data-tour="profile-records"]'],
  pitch: ['[data-tour="pitch"]'],
  pitchBench: ['[data-tour="pitch-bench"]'],
  pitchCaptain: ['[data-tour="pitch-captain"]'],
  playerRows: ['[data-tour="player-rows"]'],
  movesToggle: ['[data-tour="moves-toggle"]'],
  movesBody: ['[data-tour="moves-body"]'],
};

export const WEEK_TOUR_ID = 'week';
/** Bump when the page changes enough that the old script would mislead. */
export const WEEK_TOUR_VERSION = 1;

export function buildWeekTour(ctx: WeekTourContext): Tour {
  const { actions } = ctx;
  const hasManagers = () => ctx.managers.length > 0;
  const hasFixtures = () => ctx.fixtures.length > 0;
  const firstFixture = () => ctx.fixtures.find((f) => f.started) ?? ctx.fixtures[0];

  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Welcome to Scores',
      body:
        "The busiest page on the site: live points for the whole league, and a way into everyone's team. It is filled with example data so you can see all of it working, even before a ball is kicked.",
      cta: 'Start',
    },
    {
      id: 'gameweek',
      title: 'The gameweek',
      body:
        'Which gameweek you are looking at, GW' +
        ctx.shownGW +
        ' in this example. Tap it any time to spin back through completed weeks, and the whole page follows.',
      target: A.gw,
    },
    {
      id: 'live',
      title: 'Live right now',
      body:
        'Matches are in play. Scores update themselves while this is showing; you never need to refresh.',
      target: A.liveBadge,
      when: () => ctx.viewingLive && ctx.live,
    },
    {
      id: 'tab-form',
      title: 'Two ways to read the league',
      body: 'Standings is the season table. Form ranks everyone on their recent gameweeks instead.',
      target: A.tabForm,
      tap: true,
      cta: 'Tap Form',
    },
    {
      id: 'form',
      title: 'Form',
      body:
        'Who is actually hot right now. Often a very different order from the table, with transfer hits taken off.',
      target: A.form,
      placement: 'sheet',
    },
    {
      id: 'tab-back',
      title: 'Back to the table',
      body: 'The tabs swap the view underneath and leave everything else in place.',
      target: A.tabScores,
      tap: true,
      cta: 'Tap Standings',
    },
    {
      id: 'highlight-button',
      title: 'The "who else has him?" tool',
      body: 'The star button filters the table down to the managers who own a given player or club.',
      target: A.highlight,
      tap: true,
      cta: 'Tap Highlight',
    },
    {
      id: 'highlight-modal',
      title: 'Filter by player, or by club',
      body:
        'Pick a player and the table keeps only the managers who have him. Owned counts him anywhere in the squad, Started only if he was in the eleven, Benched only if he was left out. Or pick a club to find everyone carrying its keeper and defenders.',
      target: A.modalHighlight,
      placement: 'sheet',
    },
    {
      id: 'highlight-close',
      title: 'Close it',
      body: 'Every panel on this page closes the same way: the ✕, or a tap outside it.',
      target: A.closeHighlight,
      tap: true,
      cta: 'Tap ✕',
    },
    {
      id: 'ticker',
      title: 'The live feed',
      body:
        'Goals, assists, cards and bonus changes as they land, newest first. A teal dot means it touched your team.',
      target: A.ticker,
      when: () => ctx.viewingLive,
    },
    {
      id: 'ticker-tap',
      title: 'Tap an event',
      body: 'Any event will show you who in the league it hit, and by how much.',
      target: A.tickerFirst,
      tap: true,
      cta: 'Tap the first event',
      when: () => ctx.viewingLive && ctx.focusEventKey !== null && hasManagers(),
    },
    {
      id: 'ticker-effect',
      title: 'Who it hit',
      body:
        'The managers who own that player are washed in gold and everyone else fades back, with a badge on each score showing what the event was worth to them. Captains and Triple Captain are already counted.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.viewingLive && hasManagers(),
    },
    {
      id: 'ticker-clear',
      title: 'Clear the pin',
      body: 'Clearing puts the full table back.',
      target: A.tickerClear,
      tap: true,
      cta: 'Tap Clear',
      when: () => ctx.viewingLive && ctx.focusEventKey !== null,
    },
    {
      id: 'fixtures',
      title: "This week's matches",
      body: 'Live scores and kick-off times. Tap one for the detail.',
      target: A.fixtureFirst,
      tap: true,
      cta: 'Tap a match',
      waitMs: 2500,
      when: hasFixtures,
    },
    {
      id: 'match-lineups',
      title: 'Inside a match',
      body:
        'Both line-ups in full, with points as they stand and icons for goals, assists and cards. Your own players are teal, so you can see your stake in a game at a glance.',
      target: A.matchLineups,
      placement: 'sheet',
      waitMs: 2500,
      when: hasFixtures,
    },
    {
      id: 'match-defcon',
      title: 'Defensive contribution',
      body:
        'Tackles, interceptions and blocks, counted per player. Hit the threshold and it scores, which is why a quiet defender can still return.',
      target: A.matchDefcon,
      placement: 'sheet',
      when: hasFixtures,
    },
    {
      id: 'match-bonus',
      title: 'Bonus before it lands',
      body:
        'The projected 3, 2 and 1 with the BPS behind each one, so you can see the points still in play while the match is running. Keeper saves get their own section too.',
      target: A.matchBonus,
      placement: 'sheet',
      when: hasFixtures,
      leave: () => actions.setOpenFixture(null),
    },
    {
      id: 'table',
      title: 'The league table',
      body:
        'Rank with movement against last week, gameweek score with any hit in red, captain and vice, bench points, season total. Tap a column header to sort by it.',
      target: A.table,
      placement: 'sheet',
      when: hasManagers,
    },
    {
      id: 'my-row',
      title: 'Your row',
      body:
        'Yours is tinted teal on every table on the site. The pills under your name are squad value, season goals and assists, and how many players you have left to play, plus a chip when you have one active that week.',
      target: A.myRow,
      when: hasManagers,
    },
    {
      id: 'profile-open',
      title: 'Tap a name for their season',
      body: "The name opens a manager profile, yours or anyone else's.",
      target: A.managerCell,
      tap: true,
      cta: 'Tap your name',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'profile-stats',
      title: 'Season at a glance',
      body: 'Current and best rank, average gameweek score, and Manager of the Month wins.',
      target: A.profileStats,
      placement: 'sheet',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'profile-chips',
      title: 'Chips, by half',
      body:
        'Green is still available, grey is used with the gameweek it went, red expired unused, dashed not open yet. Both halves of the season are tracked separately.',
      target: A.profileChips,
      placement: 'sheet',
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'profile-records',
      title: 'Records and transfers',
      body:
        'Best and worst gameweeks, weekly-loser count, and what all those transfers have actually cost in points.',
      target: A.profileRecords,
      placement: 'sheet',
      when: () => Boolean(ctx.focusManager),
      leave: () => actions.setOpenProfile(null),
    },
    {
      id: 'pitch-open',
      title: 'Tap the row for the team',
      body: 'The name gives you the season; the row gives you the eleven.',
      target: A.myRow,
      tap: true,
      cta: 'Tap your row',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'pitch',
      title: 'The pitch',
      body:
        'The full squad in formation with live points per player. The captain carries a C and their score is already doubled.',
      target: A.pitch,
      placement: 'sheet',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'pitch-autosub',
      title: 'Auto-subs, called out',
      body:
        'A green arrow came on, and whoever dropped out is faded on the bench. FPL does this for you when someone does not play, and this is where you see it happen.',
      target: A.pitchBench,
      placement: 'sheet',
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'player-open',
      title: 'Tap any player',
      body: 'Every player opens their own scoring breakdown.',
      target: A.pitchCaptain,
      tap: true,
      cta: 'Tap the captain',
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'player-rows',
      title: 'Where the points came from',
      body:
        'Every scoring line with the raw stat beside it, provisional bonus with its BPS, and the captain multiplier applied at the bottom.',
      target: A.playerRows,
      placement: 'sheet',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
      leave: () => actions.closePlayer(),
    },
    {
      id: 'moves-open',
      title: 'Was it worth tinkering?',
      body:
        'This is the one nobody expects. It scores your week against the team you would have had if you had done nothing at all.',
      target: A.movesToggle,
      tap: true,
      cta: 'Tap Your moves',
      when: () => Boolean(ctx.focusManager),
    },
    {
      id: 'moves-body',
      title: 'Your moves, judged',
      body:
        "Last week's team as a baseline, then transfers, captaincy and bench calls each given a number, minus the hit. The total says whether the meddling paid.",
      target: A.movesBody,
      placement: 'sheet',
      when: () => Boolean(ctx.focusManager),
      leave: () => actions.setOpenEntry(null),
    },
    {
      id: 'done',
      title: 'That is Scores',
      body:
        'The example league goes away now and your own comes back. Everything else on the site hangs off the menu, top right, and See demo replays this any time.',
      cta: 'Finish',
    },
  ];

  return {
    id: WEEK_TOUR_ID,
    version: WEEK_TOUR_VERSION,
    steps,
    ready: ctx.ready,
    // Pinned in the tooltip for the whole run. The page's own banner scrolls out
    // of view as the tour moves down the page; this doesn't.
    notice: 'Example data',
    onStart: ctx.onStart,
    onEnd: ctx.onEnd,
  };
}
