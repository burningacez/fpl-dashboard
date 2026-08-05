import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CLEARANCE,
  NAV_HEIGHT,
  SHEET_MAX_WIDTH,
  TOOLTIP_GAP,
  TOUR_SEEN_KEY,
  type TourStep,
  clearTourSeen,
  eligibleSteps,
  fitPlan,
  isTourSeen,
  loadTourSeen,
  markTourSeen,
  nextEligible,
  placeTooltip,
  rectChanged,
  revealX,
  type Rect,
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

describe('revealX', () => {
  // A phone-width table box holding a table wider than itself: the Earnings
  // table at 390px, where Paid In, Earned and Net sit off the right edge.
  const container = { top: 400, left: 0, width: 390, height: 300 };
  const reveal = (anchor: Rect) => revealX({ anchor, container });

  it('leaves a column that is already comfortably inside alone', () => {
    expect(reveal({ top: 410, left: 100, width: 60, height: 30 })).toBe(0);
  });

  it('scrolls right for a column off the right edge', () => {
    // Right edge at 520 against a usable right of 390 - 14.
    expect(reveal({ top: 410, left: 460, width: 60, height: 30 })).toBe(144);
  });

  it('scrolls left for a column off the left edge', () => {
    expect(reveal({ top: 410, left: -40, width: 60, height: 30 })).toBe(-54);
  });

  it('lines the left edges up for a column wider than the box', () => {
    expect(reveal({ top: 410, left: 200, width: 500, height: 30 })).toBe(186);
  });

  it('ignores sub-pixel overhang', () => {
    expect(reveal({ top: 410, left: 315.8, width: 60, height: 30 })).toBe(0);
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

describe('fitPlan', () => {
  const PHONE_VP = { width: 390, height: 844 };
  const FULL = { top: 0, left: 0, width: 390, height: 844 };
  const CARD_H = 180;

  const plan = (anchor: Rect, over: Partial<Parameters<typeof fitPlan>[0]> = {}) =>
    fitPlan({ anchor, viewport: PHONE_VP, container: FULL, cardHeight: CARD_H, ...over });

  it('puts the card below an anchor near the top', () => {
    expect(plan({ top: 60, left: 20, width: 350, height: 40 }).edge).toBe('bottom');
  });

  it('puts the card above an anchor near the bottom', () => {
    expect(plan({ top: 700, left: 20, width: 350, height: 60 }).edge).toBe('top');
  });

  it('leaves a comfortably placed anchor alone', () => {
    // Roughly centred in the band a bottom card leaves free.
    expect(plan({ top: 300, left: 20, width: 350, height: 60 }).delta).toBe(0);
  });

  it('scrolls an anchor hidden below the fold into the band', () => {
    const { delta } = plan({ top: 900, left: 20, width: 350, height: 60 });
    expect(delta).toBeGreaterThan(0);
  });

  it('scrolls an anchor above the fold back down', () => {
    const { delta } = plan({ top: -120, left: 20, width: 350, height: 60 });
    expect(delta).toBeLessThan(0);
  });

  it('centres a tap target even when it is already just visible', () => {
    // The tinkering-panel case: on screen, but clinging to the bottom edge
    // where it is easy to miss. Without `centre` this is left alone.
    const anchor = { top: 640, left: 20, width: 350, height: 44 };
    expect(plan(anchor).delta).toBe(0);
    expect(plan(anchor, { centre: true }).delta).not.toBe(0);
  });

  it('aligns tops for an anchor taller than the usable band', () => {
    // Taller than the viewport, so it takes the top edge and the band starts
    // below the card: the anchor's top lands exactly on the band's top.
    const { edge, delta } = plan({ top: 200, left: 0, width: 390, height: 1200 });
    expect(edge).toBe('top');
    expect(delta).toBeCloseTo(200 - (CARD_H + TOOLTIP_GAP + CLEARANCE), 0);
  });

  it('does not scroll when the container leaves no usable band', () => {
    const squashed = { top: 400, left: 0, width: 390, height: 20 };
    expect(plan({ top: 405, left: 0, width: 390, height: 10 }, { container: squashed }).delta).toBe(0);
  });

  it('only scrolls the container the anchor actually lives in', () => {
    // A modal body occupying the lower half: the reachable band is bounded by
    // the container, not the viewport.
    const body = { top: 400, left: 0, width: 390, height: 400 };
    const { delta } = plan({ top: 780, left: 20, width: 350, height: 40 }, { container: body });
    expect(delta).toBeGreaterThan(0);
  });
});
