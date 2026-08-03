'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Rect, type TourStep, placeTooltip } from '@/lib/tour';

/**
 * The visible half of the walkthrough: a spotlight cut out of a dimmed
 * backdrop, plus the tooltip card.
 *
 * z-index note — the site header is z-40 and ui/Modal is z-50, and steps
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
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [cardHeight, setCardHeight] = useState(180);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);

  // Measure the card before painting so the very first placement is right
  // rather than visibly correcting itself.
  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [step.id, anchor?.width, viewport?.width]);

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
  const centered = pos.placement === 'center';
  const last = position >= total;

  const cardStyle: React.CSSProperties = sheet
    ? {}
    : centered
      ? {}
      : { top: pos.top, left: pos.left, width: CARD_WIDTH };

  const cardClass = sheet
    ? pos.edge === 'top'
      ? 'absolute inset-x-0 top-0 rounded-b-2xl border-b px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]'
      : 'absolute inset-x-0 bottom-0 rounded-t-2xl border-t px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4'
    : centered
      ? 'absolute left-1/2 top-1/2 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-5'
      : 'absolute rounded-2xl border p-4';

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
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
          className="pointer-events-none absolute rounded-xl ring-2 ring-accent"
          style={{
            top: anchor.top - SPOTLIGHT_PAD,
            left: anchor.left - SPOTLIGHT_PAD,
            width: anchor.width + SPOTLIGHT_PAD * 2,
            height: anchor.height + SPOTLIGHT_PAD * 2,
            boxShadow: '0 0 0 9999px rgba(9, 11, 15, 0.72)',
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-[rgba(9,11,15,0.72)]" />
      )}

      {/* Swallow every tap. Steps open modals that close on a backdrop click,
          so click-through would dismiss the subject of the step and desync the
          engine's cleanup. The card sits above this. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-body"
        style={cardStyle}
        className={`${cardClass} border-edge bg-surface shadow-2xl transition-opacity ${
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
          <button
            ref={nextRef}
            type="button"
            onClick={last ? onSkip : onNext}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-bold text-accent-fg hover:bg-accent-hover"
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
