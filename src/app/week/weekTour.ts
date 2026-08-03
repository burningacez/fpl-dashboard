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

/** `[data-tour]` anchors, with a positional fallback where one is unavoidable. */
const A = {
  gw: ['[data-tour="week-gw"]'],
  liveBadge: ['[data-tour="week-live"]'],
  tabs: ['[data-tour="week-tabs"]'],
  form: ['[data-tour="week-form"]'],
  highlight: ['[data-tour="week-highlight"]'],
  ticker: ['[data-tour="week-ticker"]'],
  fixtures: ['[data-tour="week-fixtures"]'],
  table: ['[data-tour="week-table"]'],
  // Your row if we can identify you, otherwise the top of the table. Positional
  // by nature: "the row that is mine" isn't something a static attribute knows.
  myRow: [
    '[data-tour="week-table"] tbody tr.my-team-row',
    '[data-tour="week-table"] tbody tr:first-child',
  ],
  managerCell: [
    '[data-tour="week-table"] tbody tr.my-team-row td:nth-child(2) button',
    '[data-tour="week-table"] tbody tr:first-child td:nth-child(2) button',
  ],
  modalHighlight: ['[data-tour="modal-highlight"]'],
  modalMatch: ['[data-tour="modal-match"]'],
  modalProfile: ['[data-tour="modal-profile"]'],
  modalPitch: ['[data-tour="modal-pitch"]'],
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
        "This is the busiest page on the site, live gameweek points for the whole league, and a way into everyone's team. We've filled it with example data so you can see the lot working, even before a ball has been kicked. About a minute, and you can skip out at any point.",
    },
    {
      id: 'gameweek',
      title: 'The gameweek picker',
      body:
        'The gameweek you are viewing, GW' +
        ctx.shownGW +
        ' in this example. Tap it to spin back through any completed gameweek, and the whole page follows: table, fixtures and everyone\'s pitch.',
      target: A.gw,
    },
    {
      id: 'live',
      title: 'Live right now',
      body:
        'This badge means matches are in play. Scores on this page update themselves while it is showing: no need to refresh.',
      target: A.liveBadge,
      when: () => ctx.viewingLive && ctx.live,
    },
    {
      id: 'tabs',
      title: 'Standings and Form',
      body:
        'Two ways to read the league: Standings is the classic table, Form ranks everyone on their recent gameweeks instead of the season total.',
      target: A.tabs,
    },
    {
      id: 'form',
      title: 'Form',
      body:
        'Here it is; who is actually hot right now, which is often a very different list from the table. Tap the Standings tab to come back.',
      target: A.form,
      placement: 'sheet',
      before: () => actions.setView('form'),
      after: () => actions.setView('scores'),
    },
    {
      id: 'highlight-button',
      title: 'Highlight managers',
      body:
        'The star button is the "who else has him?" tool. Pick a player or a club and the table dims everyone who does not qualify.',
      target: A.highlight,
    },
    {
      id: 'highlight-modal',
      title: 'Two ways to filter',
      body:
        'Choose a player and then Owned, Started or Benched, handy for settling who actually had the captain in. Or pick a club to find everyone carrying its keeper and defenders.',
      target: A.modalHighlight,
      placement: 'sheet',
      before: () => actions.setHlOpen(true),
      after: () => actions.setHlOpen(false),
    },
    {
      id: 'ticker',
      title: 'The live event feed',
      body:
        'Goals, assists, cards and bonus changes land here as they happen, newest first. A teal dot means the event touched your team.',
      target: A.ticker,
      when: () => ctx.viewingLive,
    },
    {
      id: 'ticker-pin',
      title: 'Tap an event to see who it hit',
      body:
        'We have pinned one for you. The table now dims down to the managers who own that player, with a ▲ or ▼ badge on their gameweek score showing exactly what it was worth to them.',
      target: A.table,
      placement: 'sheet',
      when: () => ctx.viewingLive && ctx.focusEventKey !== null && hasManagers(),
      before: () => actions.setSelectedEventKey(ctx.focusEventKey),
      after: () => actions.setSelectedEventKey(null),
    },
    {
      id: 'fixtures',
      title: "This gameweek's fixtures",
      body: 'Live scores and kick-off times across the strip. Tap any match for the detail.',
      target: A.fixtures,
      when: hasFixtures,
    },
    {
      id: 'match-modal',
      title: 'Inside a match',
      body:
        'Both line-ups side by side with points and event icons, plus defensive contributions, keeper saves and the provisional bonus. Your own players are tinted teal so you can find them at a glance.',
      target: A.modalMatch,
      placement: 'sheet',
      waitMs: 2500,
      when: hasFixtures,
      before: () => actions.setOpenFixture(firstFixture()),
      after: () => actions.setOpenFixture(null),
    },
    {
      id: 'table',
      title: 'The league table',
      body:
        'Rank with movement arrows against last week, gameweek score (any transfer hit shown in red), captain with vice underneath, bench points and the season total. Every column header sorts.',
      target: A.table,
      placement: 'sheet',
      when: hasManagers,
    },
    {
      id: 'my-row',
      title: 'Your row',
      body:
        'Once you have claimed your team in the top right, your row is tinted teal on every table on the site. The pills under a name show an active chip and how many players they still have to play.',
      target: A.myRow,
      when: hasManagers,
    },
    {
      id: 'profile-modal',
      title: 'Tap a name for their season',
      body:
        'A manager profile: rank history, best and worst gameweeks, chips used and how the season has actually gone for them.',
      target: A.modalProfile,
      placement: 'sheet',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
      before: () => actions.setOpenProfile(ctx.focusManager),
      after: () => actions.setOpenProfile(null),
    },
    {
      id: 'pitch-modal',
      title: 'Tap the row for their pitch',
      body:
        'The full squad laid out on the pitch, with live points per player, auto-subs called out, and a tinkering summary of what their transfers and captain choices have cost or won them.',
      target: A.modalPitch,
      placement: 'sheet',
      waitMs: 2500,
      when: () => Boolean(ctx.focusManager),
      before: () =>
        actions.setOpenEntry({ id: ctx.focusManager.entryId, name: ctx.focusManager.name }),
      after: () => actions.setOpenEntry(null),
    },
    {
      id: 'done',
      title: "That's Scores",
      body:
        "That's the example league done; your own is right behind it. Everything else on the site hangs off the menu top right, and the ? next to the gameweek replays this any time.",
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
