import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NAV_HEIGHT,
  SHEET_MAX_WIDTH,
  TOOLTIP_GAP,
  TOUR_SEEN_KEY,
  type TourStep,
  clearTourSeen,
  eligibleSteps,
  isTourSeen,
  loadTourSeen,
  markTourSeen,
  nextEligible,
  placeTooltip,
  rectChanged,
} from '@/lib/tour';

const step = (id: string, when?: () => boolean): TourStep => ({ id, title: id, body: id, when });

// Minimal localStorage stub so the client-only helpers run in the node env
// (same shape as __tests__/identity.test.ts).
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal('window', { localStorage: mock });
  vi.stubGlobal('localStorage', mock);
}

// A roomy desktop viewport, wide enough that sheet mode isn't forced by width.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const CARD = { width: 330, height: 180 };

describe('step eligibility', () => {
  it('keeps ungated steps and steps whose gate passes', () => {
    const steps = [step('a'), step('b', () => false), step('c', () => true)];
    expect(eligibleSteps(steps).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('walks forward over ineligible steps', () => {
    const steps = [step('a'), step('b', () => false), step('c', () => false), step('d')];
    expect(nextEligible(steps, 1, 1)).toBe(3);
  });

  it('walks backward over ineligible steps', () => {
    const steps = [step('a'), step('b', () => false), step('c', () => false), step('d')];
    expect(nextEligible(steps, 2, -1)).toBe(0);
  });

  it('returns null when the walk runs off the end', () => {
    const steps = [step('a'), step('b', () => false)];
    expect(nextEligible(steps, 1, 1)).toBeNull();
    expect(nextEligible(steps, 4, 1)).toBeNull();
    expect(nextEligible(steps, -1, -1)).toBeNull();
  });

  it('re-evaluates gates on each call, so live data can change the route', () => {
    let hasFixtures = false;
    const steps = [step('a'), step('fixtures', () => hasFixtures), step('c')];
    expect(nextEligible(steps, 1, 1)).toBe(2);
    hasFixtures = true;
    expect(nextEligible(steps, 1, 1)).toBe(1);
  });
});

describe('seen-state', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it('starts empty and round-trips a mark', () => {
    expect(loadTourSeen()).toEqual({});
    markTourSeen('week', 1);
    expect(loadTourSeen()).toEqual({ week: 1 });
  });

  it('treats an equal or higher stored version as seen', () => {
    expect(isTourSeen({ week: 1 }, 'week', 1)).toBe(true);
    expect(isTourSeen({ week: 2 }, 'week', 1)).toBe(true);
    expect(isTourSeen({}, 'week', 1)).toBe(false);
  });

  it('re-shows a tour whose version has been bumped past what was seen', () => {
    markTourSeen('week', 1);
    expect(isTourSeen(loadTourSeen(), 'week', 2)).toBe(false);
  });

  it('preserves other tours when marking one', () => {
    markTourSeen('week', 1);
    markTourSeen('planner', 3);
    expect(loadTourSeen()).toEqual({ week: 1, planner: 3 });
  });

  it('clears one tour, or all of them', () => {
    markTourSeen('week', 1);
    markTourSeen('planner', 1);
    clearTourSeen('week');
    expect(loadTourSeen()).toEqual({ planner: 1 });
    clearTourSeen();
    expect(loadTourSeen()).toEqual({});
  });

  it('survives a corrupt or hand-edited blob', () => {
    window.localStorage.setItem(TOUR_SEEN_KEY, 'not json');
    expect(loadTourSeen()).toEqual({});
    window.localStorage.setItem(TOUR_SEEN_KEY, '[1,2,3]');
    expect(loadTourSeen()).toEqual({});
    window.localStorage.setItem(TOUR_SEEN_KEY, '{"week":"yes","planner":2}');
    expect(loadTourSeen()).toEqual({ planner: 2 });
  });

  it('does not throw when localStorage rejects a write', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => markTourSeen('week', 1)).not.toThrow();
    spy.mockRestore();
  });
});

describe('tooltip placement', () => {
  it('centres a card with no anchor', () => {
    expect(placeTooltip(null, DESKTOP, CARD).placement).toBe('center');
  });

  it('sits below an anchor with room underneath', () => {
    const anchor = { top: 100, left: 500, width: 200, height: 40 };
    const pos = placeTooltip(anchor, DESKTOP, CARD);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(100 + 40 + TOOLTIP_GAP);
    // Horizontally centred on the anchor.
    expect(pos.left).toBe(600 - CARD.width / 2);
  });

  it('flips above when there is no room below', () => {
    const anchor = { top: 700, left: 500, width: 200, height: 40 };
    const pos = placeTooltip(anchor, DESKTOP, CARD);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(700 - TOOLTIP_GAP - CARD.height);
  });

  it('falls back to the sheet when it fits neither above nor below', () => {
    // Tall-ish anchor pinned near the header: no room above, none below.
    const anchor = { top: NAV_HEIGHT + 10, left: 500, width: 200, height: 700 };
    expect(placeTooltip(anchor, { width: 1280, height: 800 }, CARD).placement).toBe('sheet');
  });

  it('clamps a card that would overflow either edge', () => {
    const nearLeft = placeTooltip({ top: 100, left: 0, width: 40, height: 40 }, DESKTOP, CARD);
    expect(nearLeft.left).toBe(8);
    const nearRight = placeTooltip({ top: 100, left: 1260, width: 20, height: 40 }, DESKTOP, CARD);
    expect(nearRight.left).toBe(DESKTOP.width - CARD.width - 8);
  });

  it('always uses the sheet on a phone-width viewport', () => {
    // The case a floating tooltip gets wrong: at 390px it would cover the row
    // it is describing.
    const anchor = { top: 100, left: 20, width: 350, height: 60 };
    expect(placeTooltip(anchor, PHONE, CARD).placement).toBe('sheet');
    expect(PHONE.width).toBeLessThan(SHEET_MAX_WIDTH);
  });

  it('uses the sheet for an anchor taller than half the viewport', () => {
    const modal = { top: 60, left: 300, width: 700, height: 600 };
    expect(placeTooltip(modal, DESKTOP, CARD).placement).toBe('sheet');
  });

  it('honours a forced sheet even when a floating card would fit', () => {
    const anchor = { top: 100, left: 500, width: 200, height: 40 };
    expect(placeTooltip(anchor, DESKTOP, CARD, { forceSheet: true }).placement).toBe('sheet');
  });
});

describe('sheet edge', () => {
  const edgeFor = (anchor: { top: number; left: number; width: number; height: number }) =>
    placeTooltip(anchor, PHONE, CARD, { forceSheet: true }).edge;

  it('sits at the bottom when the anchor leaves room below it', () => {
    // A table row centred in the viewport: plenty of space underneath.
    expect(edgeFor({ top: 390, left: 20, width: 350, height: 100 })).toBe('bottom');
  });

  it('moves to the top when the anchor is itself a bottom sheet', () => {
    // The mobile ui/Modal case: a bottom-pinned card would bury the modal's
    // own controls, which is the thing the step is describing.
    expect(edgeFor({ top: 550, left: 0, width: 390, height: 294 })).toBe('top');
  });

  it('stays at the bottom for an anchor taller than the viewport', () => {
    // The whole table, scrolled to centre: neither edge has room, and top
    // would cover the header rows people are being pointed at.
    expect(edgeFor({ top: -278, left: 0, width: 390, height: 1400 })).toBe('bottom');
  });

  it('moves to the top for a tall modal pinned near the bottom', () => {
    expect(edgeFor({ top: 127, left: 0, width: 390, height: 717 })).toBe('top');
  });

  it('leaves edge unset for non-sheet placements', () => {
    const anchor = { top: 100, left: 500, width: 200, height: 40 };
    expect(placeTooltip(anchor, DESKTOP, CARD).edge).toBeUndefined();
    expect(placeTooltip(null, DESKTOP, CARD).edge).toBeUndefined();
  });
});

describe('rectChanged', () => {
  const r = { top: 10, left: 10, width: 100, height: 20 };

  it('ignores sub-pixel jitter', () => {
    expect(rectChanged(r, { ...r, top: 10.2 })).toBe(false);
  });

  it('notices a real move, an appearance and a disappearance', () => {
    expect(rectChanged(r, { ...r, top: 40 })).toBe(true);
    expect(rectChanged(null, r)).toBe(true);
    expect(rectChanged(r, null)).toBe(true);
    expect(rectChanged(null, null)).toBe(false);
  });
});

describe('SSR safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes are inert without a window', () => {
    vi.stubGlobal('window', undefined);
    expect(loadTourSeen()).toEqual({});
    expect(() => markTourSeen('week', 1)).not.toThrow();
    expect(() => clearTourSeen('week')).not.toThrow();
  });
});
