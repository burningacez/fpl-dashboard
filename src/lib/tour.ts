/**
 * Guided walkthroughs, pure logic, shared by the engine and the tests.
 *
 * Framework-free on purpose, mirroring the identity.ts / providers.tsx split:
 * this module owns the step *shape*, the "have they seen it" bookkeeping and
 * the tooltip geometry; the React engine lives in
 * src/components/tour/TourProvider.tsx and the per-page scripts live next to
 * their page (see src/app/week/weekTour.ts).
 *
 * Two deliberate design rules, both about not rotting:
 *
 * 1. A step's anchor is a LIST of selectors, tried in order, and a step whose
 *    anchor never appears is SKIPPED rather than fatal. Every page here is
 *    driven by live FPL data, so "the top row of the table" legitimately does
 *    not exist pre-season, on a cold cache, or in an archived season. A tour
 *    must degrade to the steps it can actually show.
 * 2. Seen-state is versioned per tour. Bumping a tour's `version` re-shows it
 *    once to everyone: the escape hatch for when a page changes enough that
 *    the old walkthrough would be lying.
 */

// =============================================================================
// Step / tour shape
// =============================================================================

/**
 * How the tooltip is positioned relative to its anchor.
 * - `auto`: below the anchor, flipping above when there's no room.
 * - `sheet`, pinned to the bottom of the viewport, anchor merely outlined.
 *             The right choice for anchors that are large or already a modal,
 *             where a floating tooltip would cover the thing it describes.
 */
export type StepPlacement = 'auto' | 'sheet';

export interface TourStep {
  /** Stable id, used in tests and as the React key. */
  id: string;
  title: string;
  body: string;
  /**
   * Advance by tapping the anchor itself rather than a Next button.
   *
   * This is the difference between a walkthrough you read and one you do, and
   * it is why the engine gates clicks instead of merely dimming the page: for a
   * tap step the anchor is the ONLY thing on screen that responds.
   */
  tap?: boolean;
  /** Prompt shown for a tap step, e.g. "Tap Form". Ignored without `tap`. */
  cta?: string;
  /**
   * Housekeeping run when advancing forward off this step, so the tour can
   * close a sheet it opened without spending a whole step on "now tap the ✕".
   * Not run when stepping backwards, which replays from the start instead.
   */
  leave?: () => void;
  /**
   * Candidate CSS selectors for the anchor, most-preferred first. Omit for a
   * centred card with no anchor (intro / outro steps).
   */
  target?: string[];
  /**
   * Mutate page state so the step's subject is on screen, switch a tab, open
   * a modal. Awaited, so it may be async.
   */
  before?: () => void | Promise<void>;
  /** Undo `before`, called when leaving the step in EITHER direction. */
  after?: () => void;
  /**
   * Gate for data-dependent steps: return false and the step is skipped in
   * whichever direction the user was travelling. Use this for anything that
   * needs live data (fixtures, a populated table, an in-progress gameweek).
   */
  when?: () => boolean;
  placement?: StepPlacement;
  /** How long to wait for the anchor to appear (async modal bodies). */
  waitMs?: number;
}

export interface Tour {
  id: string;
  /** Bump to re-show this tour once to people who already saw an older cut. */
  version: number;
  steps: TourStep[];
  /**
   * Run once before the first step, and awaited, so a tour that needs to load
   * something (demo data, say) has it in place before step 1 is measured.
   * Throwing here aborts the run rather than starting a half-prepared tour.
   */
  onStart?: () => void | Promise<void>;
  /**
   * Run once when the tour ends, however it ends, finished, skipped, Escape,
   * or the page unmounting mid-run. Pair every `onStart` side effect with its
   * undo here.
   */
  onEnd?: () => void;
  /**
   * Is the page settled enough to start? Auto-start waits for this; the manual
   * replay button is enabled by it too.
   */
  ready: boolean;
  /**
   * Short standing caveat pinned inside the tooltip for the whole run, for a
   * tour narrating demo data, this is the "you're not looking at your real
   * league" reminder. It lives in the card rather than the page because the
   * card is the one thing guaranteed to be on screen at every step.
   */
  notice?: string;
  /**
   * Should this tour offer to run itself on a first visit? Manual replay stays
   * available either way, used to keep auto-start off archived seasons.
   */
  autoStart?: boolean;
}

/** Steps whose `when` gate currently passes. */
export function eligibleSteps(steps: TourStep[]): TourStep[] {
  return steps.filter((s) => !s.when || s.when());
}

/**
 * Next eligible step index travelling in `dir`, or null when the walk runs off
 * either end. Pure so the skip-over-ineligible-steps walk is directly testable.
 */
export function nextEligible(steps: TourStep[], from: number, dir: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < steps.length; i += dir) {
    const step = steps[i];
    if (!step.when || step.when()) return i;
  }
  return null;
}

// =============================================================================
// Seen-state, per device, versioned per tour
// =============================================================================

/**
 * localStorage, not the server. This is a UI nicety, not ownership: it should
 * follow the browser (same as VISITOR_FLAG_KEY / TRAFFIC_OPTOUT_KEY) and it
 * must never block first paint on a fetch. The cost is that clearing site data
 * re-offers the tour, which is the harmless direction to be wrong in.
 */
export const TOUR_SEEN_KEY = 'fpl-tour-seen';

/** tourId → the version of that tour the user has finished or dismissed. */
export type TourSeen = Record<string, number>;

export function loadTourSeen(): TourSeen {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TOUR_SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Keep only numeric entries: a hand-edited or older blob shouldn't throw.
    const out: TourSeen = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Has this device already seen this cut of the tour? Pure. */
export function isTourSeen(seen: TourSeen, id: string, version: number): boolean {
  const at = seen[id];
  return typeof at === 'number' && at >= version;
}

export function markTourSeen(id: string, version: number): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...loadTourSeen(), [id]: version };
    window.localStorage.setItem(TOUR_SEEN_KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage full: the tour just offers itself again later.
  }
}

/** Forget one tour (or all of them), so it offers itself again. */
export function clearTourSeen(id?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (!id) {
      window.localStorage.removeItem(TOUR_SEEN_KEY);
      return;
    }
    const next = loadTourSeen();
    delete next[id];
    window.localStorage.setItem(TOUR_SEEN_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

// =============================================================================
// Tooltip geometry
// =============================================================================

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type ResolvedPlacement = 'below' | 'above' | 'sheet' | 'center';

export interface TooltipPosition {
  placement: ResolvedPlacement;
  /** Viewport coordinates. Unset for `sheet` / `center`, which the CSS pins. */
  top?: number;
  left?: number;
  /** Which edge a `sheet` is pinned to. Unset for other placements. */
  edge?: 'top' | 'bottom';
}

/** Below this width the viewport is treated as a phone: sheet placement wins. */
export const SHEET_MAX_WIDTH = 640;
/** An anchor taller than this share of the viewport also forces sheet mode. */
export const SHEET_HEIGHT_RATIO = 0.5;
/** Gap between anchor and tooltip. */
export const TOOLTIP_GAP = 12;
/** The sticky site header the tooltip must not hide under. */
export const NAV_HEIGHT = 64;

/**
 * Decide where the tooltip card goes.
 *
 * Sheet mode is the interesting case and the reason this is a pure function
 * worth testing: on a phone, or against a tall anchor, a floating tooltip
 * lands on top of the very thing it is pointing at. Pinning it to the bottom
 * of the screen and merely outlining the anchor is the only layout that
 * reliably works at 390px wide: which is how this league actually reads the
 * site.
 */
export function placeTooltip(
  anchor: Rect | null,
  viewport: Viewport,
  card: { width: number; height: number },
  opts: { forceSheet?: boolean; gap?: number; navHeight?: number } = {},
): TooltipPosition {
  if (!anchor) return { placement: 'center' };

  const gap = opts.gap ?? TOOLTIP_GAP;
  const navHeight = opts.navHeight ?? NAV_HEIGHT;

  if (
    opts.forceSheet ||
    viewport.width < SHEET_MAX_WIDTH ||
    anchor.height > viewport.height * SHEET_HEIGHT_RATIO
  ) {
    return { placement: 'sheet', edge: sheetEdge(anchor, viewport, card.height) };
  }

  const left = clamp(anchor.left + anchor.width / 2 - card.width / 2, 8, Math.max(8, viewport.width - card.width - 8));
  const belowTop = anchor.top + anchor.height + gap;
  if (belowTop + card.height <= viewport.height - 8) {
    return { placement: 'below', top: belowTop, left };
  }

  const aboveTop = anchor.top - gap - card.height;
  if (aboveTop >= navHeight + 8) {
    return { placement: 'above', top: aboveTop, left };
  }

  return { placement: 'sheet' };
}

/**
 * Which edge a sheet-mode card should sit on.
 *
 * Bottom by default; it is closer to the thumb. But on a phone ui/Modal is
 * ITSELF a bottom sheet (`items-end sm:items-center`), so a bottom-pinned card
 * lands squarely on top of the modal a step has just opened and hides the
 * controls it is describing. When there isn't room for the card below the
 * anchor and there is more room above it, move to the top edge instead.
 */
function sheetEdge(anchor: Rect, viewport: Viewport, cardHeight: number): 'top' | 'bottom' {
  const below = viewport.height - (anchor.top + anchor.height);
  const above = anchor.top;
  return below < cardHeight && above > below ? 'top' : 'bottom';
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Breathing room kept between the anchor and the edges of its band. */
export const CLEARANCE = 14;

export interface FitPlan {
  /** Which edge the card should take. */
  edge: 'top' | 'bottom';
  /** Pixels to add to the scroll container's scrollTop. */
  delta: number;
}

/**
 * Decide where the card goes and how far to scroll so the anchor ends up in the
 * band the card does NOT cover.
 *
 * `scrollIntoView({ block: 'center' })` is not enough on a phone: it centres the
 * anchor in the whole viewport, which is exactly where a bottom sheet card sits,
 * so the subject ends up behind the thing describing it. This works out the
 * usable band first and puts the anchor inside that.
 *
 * `centre` is set for every step the user has to tap. Merely dragging a target
 * into view is not good enough there: a control resting one pixel inside the
 * bottom edge is easy to miss and annoying to hit, which is what happened to the
 * tinkering panel at the foot of the pitch sheet. Anything you are asked to tap
 * gets pulled to the middle of the band.
 *
 * All coordinates are viewport-relative, as getBoundingClientRect gives them.
 */
export function fitPlan(args: {
  anchor: Rect;
  viewport: Viewport;
  /** Viewport rect of the scroll container the anchor lives in. */
  container: Rect;
  cardHeight: number;
  centre?: boolean;
  gap?: number;
  clearance?: number;
}): FitPlan {
  const { anchor, viewport, container, cardHeight } = args;
  const gap = args.gap ?? TOOLTIP_GAP;
  const clearance = args.clearance ?? CLEARANCE;

  const spaceAbove = anchor.top;
  const spaceBelow = viewport.height - (anchor.top + anchor.height);
  // The card takes the side with more slack. Ties go to the bottom, which is
  // where a thumb already is.
  const edge: 'top' | 'bottom' = spaceAbove > spaceBelow + 24 ? 'top' : 'bottom';

  const bandTop = edge === 'top' ? cardHeight + gap : 0;
  const bandBottom = viewport.height - (edge === 'bottom' ? cardHeight + gap : 0);

  // Only the part of the band this container can actually scroll the anchor into.
  const reachTop = Math.max(bandTop, container.top) + clearance;
  const reachBottom = Math.min(bandBottom, container.top + container.height) - clearance;
  const reach = reachBottom - reachTop;

  const wantCentre = (reachTop + reachBottom) / 2;
  const isCentre = anchor.top + anchor.height / 2;

  let delta = 0;
  if (reach <= 0) {
    delta = 0;
  } else if (anchor.height >= reach) {
    delta = anchor.top - reachTop; // taller than the band: line the tops up
  } else if (args.centre) {
    delta = isCentre - wantCentre; // tap target: dead centre, always
  } else if (anchor.top < reachTop) {
    delta = anchor.top - reachTop; // hidden above
  } else if (anchor.top + anchor.height > reachBottom) {
    delta = anchor.top + anchor.height - reachBottom; // hidden below
  } else if (Math.abs(isCentre - wantCentre) > reach * 0.28) {
    delta = isCentre - wantCentre; // visible but drifted to an edge
  }

  return { edge, delta: Math.abs(delta) > 0.5 ? delta : 0 };
}

/** Have two rects diverged enough to be worth a re-render? */
export function rectChanged(a: Rect | null, b: Rect | null, epsilon = 0.5): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  return (
    Math.abs(a.top - b.top) > epsilon ||
    Math.abs(a.left - b.left) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  );
}
