'use client';

import { useEffect, useRef } from 'react';

/**
 * Makes an overlay a real "screen" as far as the browser back button is
 * concerned: opening one pushes a history entry, and Back pops exactly that
 * entry and closes exactly that overlay — never the whole page underneath.
 *
 * The stacking case is the one that used to break: pitch modal → tap a player
 * → player breakdown → Back. Each open pushes its own entry tagged with a
 * unique id, and the tag on the *current* entry says which overlay owns it, so
 * a popstate only closes the overlay whose tag has just disappeared. The ones
 * below it see their own tag still in place and stay open.
 *
 * Closing by ✕ or backdrop instead has to unwind the entry we pushed, or the
 * next Back would land on a dead entry and appear to do nothing — hence the
 * back() on release. Two things make that unwind conditional:
 *
 *  - it only fires while our entry really is the current one, so a route
 *    change (which replaces the state) or a Back that already consumed the
 *    entry doesn't trigger a spurious extra step backwards;
 *  - it is deferred by a tick, so React re-mounting the same overlay — which
 *    Strict Mode does to every effect in development — re-adopts the entry it
 *    already owns instead of tearing it down and pushing a duplicate.
 */

const MODAL_KEY = '__modal';

let seq = 0;

/** Unwinds scheduled by release(), keyed by tag so a re-mount can cancel one. */
const pendingUnwinds = new Map<string, ReturnType<typeof setTimeout>>();

/** The slice of `window` this needs, so the logic is testable without a DOM. */
export interface HistoryWindow {
  history: {
    state: unknown;
    pushState: (state: unknown, title: string) => void;
    back: () => void;
  };
}

function tagOf(win: HistoryWindow): unknown {
  try {
    return (win.history.state as Record<string, unknown> | null)?.[MODAL_KEY];
  } catch {
    return undefined;
  }
}

/**
 * Claims one tagged history entry for an overlay — pushing it, or adopting the
 * one this tag already owns — and returns the two decisions that follow from
 * it: whether a given popstate belongs to this overlay, and what closing it by
 * other means should do to the entry.
 */
export function acquireModalEntry(win: HistoryWindow, tag: string) {
  const pending = pendingUnwinds.get(tag);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingUnwinds.delete(tag);
  }
  // Spread the existing state so Next's own router keys survive the push.
  if (tagOf(win) !== tag) {
    const base = (win.history.state as Record<string, unknown> | null) ?? {};
    win.history.pushState({ ...base, [MODAL_KEY]: tag }, '');
  }
  let consumed = false;

  return {
    /** True when this popstate popped *our* entry, so this overlay closes. */
    shouldClose(): boolean {
      // Our tag still current? Then an overlay above us was the one popped.
      if (tagOf(win) === tag) return false;
      consumed = true;
      return true;
    },
    /** Called when the overlay closed some other way (✕, backdrop, a route). */
    release(): void {
      if (consumed) return;
      pendingUnwinds.set(
        tag,
        setTimeout(() => {
          pendingUnwinds.delete(tag);
          if (tagOf(win) === tag) win.history.back();
        }, 0),
      );
    },
  };
}

export function useModalHistory(onClose: () => void) {
  // Kept in a ref so a re-render with a fresh closure never re-runs the effect
  // — re-running it would push a second entry for the same overlay.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // One tag for the life of this overlay, re-adopted across a Strict Mode
  // remount rather than replaced.
  const tagRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (tagRef.current === null) tagRef.current = `m${++seq}`;
    const entry = acquireModalEntry(window, tagRef.current);
    const onPop = () => {
      if (entry.shouldClose()) closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      entry.release();
    };
  }, []);
}

/**
 * Renderless form of {@link useModalHistory}, for overlays whose open state
 * lives in a parent that stays mounted (a dropdown, say): mount it only while
 * the overlay is open and Back closes that overlay alone.
 */
export function BackCloses({ onClose }: { onClose: () => void }) {
  useModalHistory(onClose);
  return null;
}
