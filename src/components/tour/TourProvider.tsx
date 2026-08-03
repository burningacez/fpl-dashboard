'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  type Rect,
  type Tour,
  type TourStep,
  isTourSeen,
  loadTourSeen,
  markTourSeen,
  nextEligible,
  rectChanged,
} from '@/lib/tour';
import { TourOverlay } from './TourOverlay';

/**
 * Guided-walkthrough engine.
 *
 * One provider sits in the app shell and renders at most one overlay. A page
 * offers a tour by calling `useTourHost(tour)`; the engine owns the run state,
 * anchor resolution and cleanup. Page state stays where it already lives — a
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
 * an archived season). Safe to call with a freshly-built object every render —
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

  // Element the current step is pointing at, tracked every frame while showing.
  const anchorElRef = useRef<HTMLElement | null>(null);
  // Guards against a stale async transition (double-tapped Next) landing after
  // a newer one has already started.
  const runIdRef = useRef(0);
  // The step we last ran `before` for, so `after` is always paired with it.
  const liveStepRef = useRef<TourStep | null>(null);

  const publish = useCallback((tour: Tour | null) => {
    tourRef.current = tour;
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

  const stop = useCallback(
    (markSeen: boolean) => {
      runIdRef.current += 1;
      cleanupLiveStep();
      anchorElRef.current = null;
      setPhase('idle');
      setAnchor(null);
      setIndex(0);
      const tour = tourRef.current;
      if (markSeen && tour) markTourSeen(tour.id, tour.version);
    },
    [cleanupLiveStep],
  );

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
        el?.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
      } else {
        setAnchor(null);
      }

      if (runIdRef.current !== runId) return;
      setPhase('showing');
    },
    [cleanupLiveStep, stop],
  );

  const start = useCallback(() => {
    const tour = tourRef.current;
    if (!tour || !tour.ready) return;
    runIdRef.current += 1;
    cleanupLiveStep();
    void goTo(0, 1);
  }, [cleanupLiveStep, goTo]);

  const next = useCallback(() => {
    void goTo(index + 1, 1);
  }, [goTo, index]);

  const back = useCallback(() => {
    void goTo(index - 1, -1);
  }, [goTo, index]);

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
  // reasons no event covers — smooth scrolling, a live score changing a row's
  // height, a modal body finishing its fetch and reflowing.
  useEffect(() => {
    if (phase !== 'showing') return;
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

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop(true);
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, stop, next, back]);

  // Leaving the page mid-run must still undo whatever the live step opened.
  useEffect(() => () => cleanupLiveStep(), [cleanupLiveStep]);

  const tour = tourRef.current;
  const running = phase !== 'idle';
  const steps = tour?.steps ?? [];
  const step: TourStep | undefined = running ? steps[index] : undefined;

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
          // Position within the eligible steps, so "3 of 9" doesn't count
          // steps that this gameweek's data has skipped over.
          position={countEligibleUpTo(steps, index)}
          total={countEligible(steps)}
          preparing={phase === 'preparing'}
          onNext={next}
          onBack={back}
          onSkip={() => stop(true)}
        />
      )}
    </TourContext.Provider>
  );
}

/**
 * Replay button. Rendered by a page that hosts a tour; hidden entirely when
 * there's nothing to run, so it can be dropped in unconditionally.
 */
export function TourButton({ className = '', label = 'How this page works' }: { className?: string; label?: string }) {
  const { start, canStart, running } = useTourControls();
  if (!canStart || running) return null;
  return (
    <button
      type="button"
      onClick={start}
      title={label}
      aria-label={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-edge-strong text-sm font-bold text-muted transition-colors hover:border-accent hover:text-accent ${className}`}
    >
      ?
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
 * resolves, so a step describing loaded content has to wait for it — and a
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

function countEligible(steps: TourStep[]): number {
  return steps.reduce((n, s) => n + (!s.when || s.when() ? 1 : 0), 0);
}

function countEligibleUpTo(steps: TourStep[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < steps.length; i++) {
    const s = steps[i];
    if (!s.when || s.when()) n += 1;
  }
  return n;
}
