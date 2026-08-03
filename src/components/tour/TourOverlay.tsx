'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Rect, type TourStep, placeTooltip } from '@/lib/tour';

/**
 * The visible half of the walkthrough: a spotlight cut out of a dimmed
 * backdrop, plus the tooltip card.
 *
 * z-index note: the site header is z-40 and ui/Modal is z-50, and steps
 * deliberately open those modals, so this has to sit above both.
 */

/** Width of the floating (non-sheet) card. */
const CARD_WIDTH = 330;
/** Breathing room between the anchor's edge and the spotlight ring. */
const SPOTLIGHT_PAD = 6;

export function TourOverlay({
  step,
  anchor,
  forceSheet,
  position,
  total,
  preparing,
  notice,
  sheetEdge,
  nudge,
  onMeasure,
  cardRef,
  onNext,
  onBack,
  onSkip,
}: {
  step: TourStep;
  anchor: Rect | null;
  forceSheet: boolean;
  position: number;
  total: number;
  preparing: boolean;
  notice?: string;
  /** Edge chosen by the engine's fitPlan, which also scrolled to suit it. */
  sheetEdge: 'top' | 'bottom';
  /** Changes when a blocked tap lands, replaying the shake. */
  nudge: number;
  /** Report the card's height so the engine can work out the usable band. */
  onMeasure: (height: number) => void;
  cardRef: React.MutableRefObject<HTMLElement | null>;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const localCardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [cardHeight, setCardHeight] = useState(180);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);

  // Measure the card before painting so the very first placement is right
  // rather than visibly correcting itself.
  useLayoutEffect(() => {
    const h = localCardRef.current?.offsetHeight;
    if (h) {
      setCardHeight(h);
      onMeasure(h);
    }
  }, [step.id, anchor?.width, viewport?.width, onMeasure]);

  useEffect(() => {
    const read = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  // Drive the tour from the keyboard without hunting for the button.
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [step.id]);

  if (typeof document === 'undefined' || !viewport) return null;

  const pos = placeTooltip(anchor, viewport, { width: CARD_WIDTH, height: cardHeight }, { forceSheet });
  const sheet = pos.placement === 'sheet';
  // fitPlan already picked the edge and scrolled the anchor into the band it
  // leaves free, so its answer wins over placeTooltip's own guess.
  const edge = sheet ? sheetEdge : pos.edge;
  const centered = pos.placement === 'center';
  const last = position >= total;

  const cardStyle: React.CSSProperties = sheet
    ? {}
    : centered
      ? {}
      : { top: pos.top, left: pos.left, width: CARD_WIDTH };

  const cardClass = sheet
    ? edge === 'top'
      ? 'absolute inset-x-0 top-0 rounded-b-2xl border-b px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]'
      : 'absolute inset-x-0 bottom-0 rounded-t-2xl border-t px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4'
    : centered
      ? 'absolute left-1/2 top-1/2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-5'
      : 'absolute rounded-2xl border p-4';

  return createPortal(
    <div
      // pointer-events-none is load-bearing: the click gate in TourProvider
      // decides what is tappable, and it can only do that if the anchor is
      // actually reachable underneath. The card re-enables events for itself.
      className="pointer-events-none fixed inset-0 z-[60]"
      role="presentation"
      // Read by tests/tour/week-tour.mjs: a step that declares a target but
      // reports anchored="false" has lost its anchor to a page restructure.
      data-tour-step={step.id}
      data-tour-anchored={anchor ? 'true' : 'false'}
    >
      {/* Backdrop + spotlight. One element does both: the huge box-shadow
          spread dims everything outside the anchor's box. */}
      {anchor ? (
        <div
          aria-hidden
          key={`spot-${nudge}`}
          className="tour-spot pointer-events-none absolute rounded-xl"
          style={{
            top: anchor.top - SPOTLIGHT_PAD,
            left: anchor.left - SPOTLIGHT_PAD,
            width: anchor.width + SPOTLIGHT_PAD * 2,
            height: anchor.height + SPOTLIGHT_PAD * 2,
            // One box-shadow does all three jobs: the gold ring, the dim over
            // everything else, and the glow. Tailwind's `ring-2` is itself a
            // box-shadow, so it cannot be combined with an inline one; setting
            // both silently loses the ring, which is how this first shipped.
            boxShadow:
              '0 0 0 2px var(--accent), 0 0 0 9999px rgba(9, 11, 15, 0.72), 0 0 16px 2px rgba(245, 158, 11, 0.45)',
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-[rgba(9,11,15,0.72)]" />
      )}

      <div
        ref={(n) => {
          localCardRef.current = n;
          cardRef.current = n;
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-body"
        style={cardStyle}
        className={`${cardClass} pointer-events-auto border-edge bg-surface shadow-2xl transition-opacity ${
          preparing ? 'opacity-90' : 'opacity-100'
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[0.65rem] font-bold uppercase tracking-wider text-accent">
              Step {position} of {total}
            </span>
            {notice && (
              <span className="truncate rounded-full bg-accent-soft px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-accent">
                {notice}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onSkip}
            className="-mr-1 rounded-md px-2 py-0.5 text-xs font-bold text-faint hover:bg-raised hover:text-muted"
          >
            Skip tour
          </button>
        </div>

        <h2 id="tour-step-title" className="text-base font-extrabold">
          {step.title}
        </h2>
        <p id="tour-step-body" className="mt-1.5 text-sm leading-relaxed text-muted">
          {step.body}
        </p>

        {step.tap && step.cta && (
          <p className="mt-3 flex items-center gap-2 text-sm font-bold text-accent">
            <span aria-hidden className="tour-tap-hint">☝</span>
            {step.cta}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden>
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={`h-1 flex-1 rounded-full ${i < position ? 'bg-accent' : 'bg-raised'}`}
              />
            ))}
          </div>
          {position > 1 && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm font-bold text-muted hover:bg-raised hover:text-body"
            >
              Back
            </button>
          )}
          {/* No Next on a tap step: the anchor is the only way forward. */}
          {!step.tap && (
            <button
              ref={nextRef}
              type="button"
              onClick={last ? onSkip : onNext}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-bold text-accent-fg hover:bg-accent-hover"
            >
              {last ? 'Done' : step.cta ?? 'Next'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
