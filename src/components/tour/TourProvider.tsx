'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  type Rect,
  type Tour,
  type TourStep,
  eligibleSteps,
  fitPlan,
  isTourSeen,
  loadTourSeen,
  markTourSeen,
  nextEligible,
  rectChanged,
  revealX,
} from '@/lib/tour';
import { TourOverlay } from './TourOverlay';

/**
 * Guided-walkthrough engine.
 *
 * One provider sits in the app shell and renders at most one overlay. A page
 * offers a tour by calling `useTourHost(tour)`; the engine owns the run state,
 * anchor resolution and cleanup. Page state stays where it already lives: a
 * step drives it through plain `before`/`after` callbacks (see weekTour.ts),
 * which is why the engine never needs to synthesise clicks on real controls.
 *
 * The overlay blocks pointer events while it runs. That's deliberate: the
 * modals it opens close on a backdrop click (see ui/Modal), so letting taps
 * through would let a user dismiss the very thing a step is describing, and
 * would leave the engine's `after` cleanup out of step with reality.
 */

/** How long after the page reports ready before a first-visit tour offers itself. */
const AUTO_START_DELAY_MS = 900;
/** Default budget for an anchor to turn up (modal bodies fetch on open). */
const DEFAULT_ANCHOR_WAIT_MS = 1500;

type Phase = 'idle' | 'preparing' | 'showing';

interface TourContextValue {
  /** Called by `useTourHost` after every render of the hosting page. */
  publish: (tour: Tour | null) => void;
  /** Start (or restart) the hosted tour. */
  start: () => void;
  /** A tour is hosted by this page and its data is ready. */
  canStart: boolean;
  /** A run is in progress. */
  running: boolean;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTourControls(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTourControls must be used within <TourProvider>');
  return ctx;
}

/**
 * Offer `tour` on this page. Pass null when the page has no tour to give (e.g.
 * an archived season). Safe to call with a freshly-built object every render:
 * the tour is held in a ref and only its identity/readiness reaches state.
 */
export function useTourHost(tour: Tour | null): void {
  const { publish } = useTourControls();
  // No dependency array on purpose: the steps close over current page state,
  // so the ref must be refreshed on every render. `publish` only touches state
  // when the tour's identity or readiness actually changes.
  useEffect(() => {
    publish(tour);
  });
  useEffect(() => () => publish(null), [publish]);
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const tourRef = useRef<Tour | null>(null);
  // Identity/readiness of the hosted tour, mirrored into state so the replay
  // button and the auto-start effect can react to it.
  const [host, setHost] = useState<{ id: string; version: number; ready: boolean; autoStart: boolean } | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [index, setIndex] = useState(0);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [forceSheet, setForceSheet] = useState(false);
  /**
   * Ids of the steps whose `when` gate currently passes, in order: the basis
   * for "Step 3 of 9".
   *
   * This is STATE, republished by the hosting page, rather than something
   * derived from tourRef while rendering. React renders a parent before its
   * children, so on the pass where the page rebuilds its tour this provider has
   * already rendered: any render-time read of the ref is a pass behind. That
   * showed up as "Step 1 of 8" on a run whose demo data had just made all 16
   * steps eligible. Holding it in state means the count converges on the next
   * commit instead of being wrong for the whole step.
   */
  const [eligibleIds, setEligibleIds] = useState<string[]>([]);
  /** Which edge a sheet-placed card takes; decided by fitPlan, used by the overlay. */
  const [sheetEdge, setSheetEdge] = useState<'top' | 'bottom'>('bottom');
  /** Bumped to replay the shake when a blocked tap lands. */
  const [nudge, setNudge] = useState(0);
  /** Measured card height, reported by the overlay so fitPlan can use it. */
  const cardHeightRef = useRef(170);
  /** The card's DOM node, so the click gate can let taps inside it through. */
  const cardElRef = useRef<HTMLElement | null>(null);

  // Element the current step is pointing at, tracked every frame while showing.
  const anchorElRef = useRef<HTMLElement | null>(null);
  // Guards against a stale async transition (double-tapped Next) landing after
  // a newer one has already started.
  const runIdRef = useRef(0);
  // The step we last ran `before` for, so `after` is always paired with it.
  const liveStepRef = useRef<TourStep | null>(null);

  const publish = useCallback((tour: Tour | null) => {
    tourRef.current = tour;
    // Re-evaluated on every host render, so the counter tracks page state.
    // Identity-stable when unchanged, or this would loop: publish runs from an
    // effect with no deps.
    const next = tour ? eligibleSteps(tour.steps).map((s) => s.id) : [];
    setEligibleIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
    );
    setHost((prev) => {
      if (!tour) return prev === null ? prev : null;
      const next = {
        id: tour.id,
        version: tour.version,
        ready: tour.ready,
        autoStart: tour.autoStart !== false,
      };
      if (prev && prev.id === next.id && prev.version === next.version && prev.ready === next.ready && prev.autoStart === next.autoStart) {
        return prev;
      }
      return next;
    });
  }, []);

  /** Run the current step's `after`, exactly once. */
  const cleanupLiveStep = useCallback(() => {
    const step = liveStepRef.current;
    liveStepRef.current = null;
    try {
      step?.after?.();
    } catch (e) {
      console.error('Tour step cleanup failed:', e);
    }
  }, []);

  // Set while a run owns the tour's onEnd, so teardown fires exactly once even
  // if stop() is reached by two routes (Done then unmount, say).
  const endRef = useRef<(() => void) | null>(null);

  const stop = useCallback(
    (markSeen: boolean) => {
      runIdRef.current += 1;
      cleanupLiveStep();
      const end = endRef.current;
      endRef.current = null;
      anchorElRef.current = null;
      setPhase('idle');
      setAnchor(null);
      setIndex(0);
      const tour = tourRef.current;
      if (markSeen && tour) markTourSeen(tour.id, tour.version);
      try {
        end?.();
      } catch (e) {
        console.error('Tour teardown failed:', e);
      }
    },
    [cleanupLiveStep],
  );

  /**
   * Scroll the anchor into the band the card leaves free, and record which edge
   * the card should take. See lib/tour.ts fitPlan for the reasoning; this is
   * only the DOM half of it.
   */
  const bringIntoBand = useCallback((el: HTMLElement, isTapStep: boolean) => {
    // Horizontally first, and separately: the columns a wide table keeps off the
    // right edge of a phone live in their own scroll box, and moving that does
    // not change anything the vertical plan measures.
    const spx = scrollParentX(el);
    if (spx) {
      const dx = revealX({ anchor: measure(el), container: rectOf(spx) });
      if (dx !== 0) spx.scrollLeft += dx;
    }

    const sp = scrollParent(el);
    const container = sp === document.scrollingElement || sp === document.body
      ? { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
      : rectOf(sp);
    const plan = fitPlan({
      anchor: measure(el),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      container,
      cardHeight: cardHeightRef.current,
      centre: isTapStep,
    });
    setSheetEdge(plan.edge);
    if (plan.delta !== 0) {
      if (sp === document.scrollingElement || sp === document.body) {
        // Instant, not smooth. A smooth scroll is still animating while the next
        // step is measured, and any stray gesture during it cancels or merges
        // with it, so the anchor settles somewhere neither the engine nor the
        // user chose. The jump is the price of the gold box being where it says.
        window.scrollBy({ top: plan.delta, behavior: 'auto' });
      } else {
        sp.scrollTop += plan.delta;
      }
    }
  }, []);

  /**
   * Move to `target`, skipping steps whose `when` gate fails, then prepare it:
   * run `before`, wait for the anchor, and show. A step whose anchor never
   * arrives is shown anchorless rather than aborting the run.
   */
  const goTo = useCallback(
    async (target: number, dir: 1 | -1) => {
      const tour = tourRef.current;
      if (!tour) return;

      const runId = ++runIdRef.current;
      cleanupLiveStep();

      const next = nextEligible(tour.steps, target, dir);
      if (next === null) {
        // Ran off the end going forward = completed; off the start = leave the
        // first step in place rather than tearing the run down.
        if (dir === 1) stop(true);
        return;
      }

      const step = tour.steps[next];
      setIndex(next);
      setPhase('preparing');
      // The previous anchor is deliberately left in place until the new one
      // resolves, so opening a modal doesn't flash the spotlight to full-dim
      // and back.
      anchorElRef.current = null;
      setForceSheet(step.placement === 'sheet');

      liveStepRef.current = step;
      try {
        await step.before?.();
      } catch (e) {
        console.error('Tour step setup failed:', e);
      }
      if (runIdRef.current !== runId) return;

      if (step.target?.length) {
        const el = await waitForAnchor(step.target, step.waitMs ?? DEFAULT_ANCHOR_WAIT_MS);
        if (runIdRef.current !== runId) return;
        anchorElRef.current = el;
        setAnchor(el ? measure(el) : null);
        if (el) bringIntoBand(el, Boolean(step.tap));
      } else {
        setAnchor(null);
      }

      if (runIdRef.current !== runId) return;
      setPhase('showing');

      // Scrolling and the edge choice both change the geometry, and the card's
      // own height changes with the copy, so settle it once more after paint.
      requestAnimationFrame(() => {
        if (runIdRef.current !== runId) return;
        const el = anchorElRef.current;
        if (el) {
          bringIntoBand(el, Boolean(step.tap));
          setAnchor(measure(el));
        }
      });
    },
    [cleanupLiveStep, stop, bringIntoBand],
  );

  const start = useCallback(() => {
    const tour = tourRef.current;
    if (!tour || !tour.ready) return;
    const runId = ++runIdRef.current;
    cleanupLiveStep();

    void (async () => {
      if (tour.onStart) {
        try {
          await tour.onStart();
        } catch (e) {
          // Better to show no tour than one describing data that failed to load.
          console.error('Tour setup failed: not starting:', e);
          return;
        }
        if (runIdRef.current !== runId) return;
      }
      endRef.current = tour.onEnd ?? null;
      // `preparing` before the first anchor resolves, so the overlay dims
      // immediately rather than after the setup await.
      setPhase('preparing');
      // Let whatever onStart changed actually render and republish before the
      // first step is measured and counted, see the `progress` comment above.
      await nextFrame();
      if (runIdRef.current !== runId) return;
      await goTo(0, 1);
    })();
  }, [cleanupLiveStep, goTo]);

  /** Forward, running the outgoing step's `leave` housekeeping first. */
  const next = useCallback(() => {
    const from = tourRef.current?.steps[index];
    if (from?.leave) {
      try {
        from.leave();
      } catch (e) {
        console.error('Tour step leave failed:', e);
      }
    }
    void goTo(index + 1, 1);
  }, [goTo, index]);

  /*
   * There is deliberately no Back.
   *
   * Stepping backwards cannot be made honest here. A step reaches its state
   * through `before`, and its `after` undoes only that one step — so walking
   * backwards past a step that opened a modal, switched a tab or seated demo
   * data lands in a state no forward run ever produced. Tap steps make it
   * worse: their effect belongs to the page, not to the step, so nothing
   * reverses it. Replaying from step one would be correct but is a strange
   * thing to hand someone who asked to go back one.
   *
   * Skip and replay from See demo is the honest pair, and it is one tap.
   */

  // ---- auto-start on a first visit -----------------------------------------
  // Keyed on the hosted tour's identity so a client-side navigation to another
  // toured page re-arms it.
  const offeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!host || !host.ready || !host.autoStart) return;
    if (phase !== 'idle') return;
    const key = `${host.id}@${host.version}`;
    if (offeredRef.current === key) return;
    if (isTourSeen(loadTourSeen(), host.id, host.version)) return;

    const timer = setTimeout(() => {
      // Re-check: the page may have opened a modal from a deep link in the
      // meantime, and starting on top of that would fight the user.
      if (document.querySelector('[data-tour-blocks-autostart]')) return;
      offeredRef.current = key;
      start();
    }, AUTO_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [host, phase, start]);

  // ---- keep the spotlight glued to its anchor ------------------------------
  // A rAF loop rather than scroll/resize listeners: the anchor moves for
  // reasons no event covers, a live score changing a row's height, a modal body
  // finishing its fetch and reflowing.
  //
  // Runs while `preparing` too, not only while `showing`: the previous step's
  // anchor is deliberately left on screen until the new one resolves, and if
  // anything moves in that window a frozen rect leaves the gold box outlining
  // blank space.
  useEffect(() => {
    if (phase === 'idle') return;
    let frame = 0;
    const tick = () => {
      const el = anchorElRef.current;
      if (el) {
        const rect = el.isConnected ? measure(el) : null;
        setAnchor((prev) => (rectChanged(prev, rect) ? rect : prev));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  // ---- click gate ----------------------------------------------------------
  /**
   * While a tour runs, the only tappable things on the page are the current
   * step's anchor and the tour card itself. Everything else is swallowed in the
   * capture phase, before any React handler sees it, and the gold box shakes.
   *
   * Gating this way rather than by covering the screen with an overlay is what
   * makes tap-to-advance possible at all: the anchor stays clickable wherever it
   * sits in the stacking order, with no z-index juggling, and the modals the
   * tour opens cannot be dismissed by a stray tap on their backdrop.
   */
  useEffect(() => {
    if (phase === 'idle') return;

    const isAllowed = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      if (cardElRef.current?.contains(target)) return true;
      const step = tourRef.current?.steps[index];
      if (!step?.tap) return false;
      const anchorEl = anchorElRef.current;
      return Boolean(anchorEl && (anchorEl === target || anchorEl.contains(target)));
    };

    const swallow = (e: Event) => {
      // Only real taps are gated. The tour itself dispatches clicks to tidy up
      // (closing the player breakdown, whose open state belongs to PitchView),
      // and swallowing those would leave the engine fighting its own cleanup.
      if (!e.isTrusted) return;
      if (isAllowed(e.target)) {
        // The page handles this click itself; advance once React has committed
        // whatever it opened, so the next step measures the real DOM.
        if (e.type === 'click') {
          const runId = runIdRef.current;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (runIdRef.current === runId) next();
            }),
          );
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click') setNudge((n) => n + 1);
    };

    const types: (keyof DocumentEventMap)[] = ['pointerdown', 'mousedown', 'touchstart', 'click'];
    types.forEach((t) => document.addEventListener(t, swallow, true));
    return () => types.forEach((t) => document.removeEventListener(t, swallow, true));
  }, [phase, index, next]);

  // While a tour runs, let scroll containers over-scroll. Without it the last
  // element in a modal (the tinkering panel, at the foot of the pitch) can only
  // ever reach the bottom edge of its viewport, so a step asking you to tap it
  // leaves it awkwardly out on the rim.
  useEffect(() => {
    if (phase === 'idle') return;
    document.body.classList.add('tour-running');
    return () => document.body.classList.remove('tour-running');
  }, [phase]);

  // ---- keyboard ------------------------------------------------------------
  /**
   * Keys that scroll the page, or move focus off the card and onto something
   * the click gate is busy protecting. While a tour runs the engine owns the
   * scroll position, so these do nothing at all.
   */
  const INERT_KEYS = new Set([
    'Tab', ' ', 'Spacebar', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
  ]);

  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      const mustTap = Boolean(tourRef.current?.steps[index]?.tap);
      if (e.key === 'Escape') {
        e.preventDefault();
        stop(true);
      } else if ((e.key === 'ArrowRight' || e.key === 'Enter') && !mustTap) {
        // A tap step is completed by tapping the thing, not by pressing on.
        e.preventDefault();
        next();
      } else if (INERT_KEYS.has(e.key)) {
        e.preventDefault();
      }
    };
    // Capture, so a key lands here before whatever has focus acts on it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, index, stop, next]);

  // ---- scroll lock ---------------------------------------------------------
  /**
   * The page must not move under the spotlight. `fitPlan` has already put the
   * anchor in the band the card leaves free, and the gold box is positioned in
   * viewport coordinates: a scroll the engine did not perform slides the
   * subject out from under its own outline.
   *
   * Wheel and touchmove are cancelled rather than the document being given
   * `overflow: hidden`, because the engine's own scrolling — window.scrollBy
   * and scrollTop on a modal body — has to keep working. Cancelling the input
   * events leaves programmatic scrolling untouched.
   *
   * Both need an explicit `passive: false`: on document targets browsers
   * default these two to passive, where preventDefault is ignored with a
   * console warning. That is exactly how the first cut of this leaked — the
   * touchstart branch of the click gate looked like it was blocking drag
   * scrolling on a phone and was quietly doing nothing.
   */
  useEffect(() => {
    if (phase === 'idle') return;
    const block = (e: Event) => {
      // The card is the one thing allowed to scroll, and only while it has
      // somewhere to scroll to: long copy on a short screen has to stay
      // reachable, but a card with no overflow passes the gesture straight
      // through to the page underneath. That was the leak, and the thumb is
      // resting on the card already because that is where Next is: tap Next,
      // drag from the same spot, and the page moved out from under the
      // spotlight. The card also has overscroll-contain, so a scroll that
      // reaches its end does not chain to the page either.
      const t = e.target;
      const card = cardElRef.current;
      if (t instanceof Node && card?.contains(t) && card.scrollHeight > card.clientHeight + 1) return;
      e.preventDefault();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: false };
    window.addEventListener('wheel', block, opts);
    window.addEventListener('touchmove', block, opts);
    return () => {
      window.removeEventListener('wheel', block, opts);
      window.removeEventListener('touchmove', block, opts);
    };
  }, [phase]);

  // Leaving the page mid-run must still undo whatever the live step opened and
  // whatever the tour set up. No setState here, this runs during teardown.
  useEffect(
    () => () => {
      cleanupLiveStep();
      const end = endRef.current;
      endRef.current = null;
      try {
        end?.();
      } catch (e) {
        console.error('Tour teardown failed:', e);
      }
    },
    [cleanupLiveStep],
  );

  // The hosting page went away (client-side navigation, or its data dropped out
  // from under it) while a run was in progress, end it rather than leave an
  // overlay pointing at a page that no longer exists.
  useEffect(() => {
    if (!host && phase !== 'idle') stop(false);
  }, [host, phase, stop]);

  const tour = tourRef.current;
  const running = phase !== 'idle';
  const steps = tour?.steps ?? [];
  const step: TourStep | undefined = running ? steps[index] : undefined;
  // Clamped to 1: a step that has just become ineligible under the newest
  // publish would otherwise briefly read "Step 0 of n".
  const position = step ? Math.max(1, eligibleIds.indexOf(step.id) + 1) : 0;

  return (
    <TourContext.Provider
      value={{ publish, start, canStart: Boolean(host?.ready), running }}
    >
      {children}
      {running && step && (
        <TourOverlay
          step={step}
          anchor={anchor}
          forceSheet={forceSheet}
          // Position among the ELIGIBLE steps, so the count never mentions
          // steps this run is skipping over.
          position={position}
          total={eligibleIds.length}
          preparing={phase === 'preparing'}
          notice={tour?.notice}
          sheetEdge={sheetEdge}
          nudge={nudge}
          onMeasure={(h) => { cardHeightRef.current = h; }}
          cardRef={cardElRef}
          onNext={next}
          onSkip={() => stop(true)}
        />
      )}
    </TourContext.Provider>
  );
}

/**
 * Trigger for the hosted tour. Hidden entirely when there is nothing to run,
 * including when the page's tour is preview-gated away from this user, so it
 * can be dropped in unconditionally and needs no gate of its own.
 */
export function TourButton({
  className = '',
  label = 'See demo',
  title = label,
}: {
  className?: string;
  label?: string;
  title?: string;
}) {
  const { start, canStart, running } = useTourControls();
  if (!canStart || running) return null;
  return (
    <button
      type="button"
      onClick={start}
      title={title}
      aria-label={title}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong px-3 py-1 text-xs font-bold text-muted transition-colors hover:border-accent hover:text-accent ${className}`}
    >
      <span aria-hidden>▶</span>
      {label}
    </button>
  );
}

// =============================================================================
// DOM helpers
// =============================================================================

function measure(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const rectOf = measure;

/**
 * Nearest ancestor that actually scrolls: a modal body, or the document.
 *
 * The anchor can be inside ui/Modal's own `overflow-y-auto` box rather than the
 * page, and scrolling the wrong one moves nothing.
 */
function scrollParent(el: HTMLElement): HTMLElement {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.body;
}

/**
 * Nearest ancestor that scrolls sideways, or null. That is a wide table's own
 * box (ui/DataTable wraps every table in `overflow-x-auto`), never the document:
 * the page itself never scrolls horizontally here.
 */
function scrollParentX(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const ox = getComputedStyle(p).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p;
    p = p.parentElement;
  }
  return null;
}

/** Resolve after the browser has painted, so React has committed and run effects. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** First selector that resolves to a visible element. */
function findAnchor(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      continue; // A malformed selector shouldn't take the run down.
    }
    if (el instanceof HTMLElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

/**
 * Poll for an anchor until `timeout`. Modal bodies mount before their fetch
 * resolves, so a step describing loaded content has to wait for it, and a
 * step whose anchor genuinely isn't there (no fixtures this week, empty table)
 * has to give up quietly.
 */
function waitForAnchor(selectors: string[], timeout: number): Promise<HTMLElement | null> {
  const immediate = findAnchor(selectors);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const started = performance.now();
    const poll = () => {
      const el = findAnchor(selectors);
      if (el) {
        resolve(el);
        return;
      }
      if (performance.now() - started >= timeout) {
        resolve(null);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}
