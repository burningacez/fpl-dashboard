'use client';

/**
 * Shared stepper + wheel picker. Used for the /week gameweek selector and the
 * /week Form tab window-size selector. Renders a bordered pill of ◀ / label /
 * ▶ buttons; tapping the label opens a compact scroll-snap wheel anchored
 * right under the pill, from which any value in [min, max] can be picked.
 */

import React, { useEffect, useRef, type ReactNode } from 'react';

const ITEM_HEIGHT = 32; // px, must match the h/style below
const VISIBLE = 5;

export interface WheelStepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** Optional per-value disable check (e.g. future gameweeks). */
  isDisabled?: (v: number) => boolean;
  /** Content for the centre pill label. Defaults to the raw value. */
  formatLabel?: (v: number) => ReactNode;
  /** Content for each item in the wheel. Defaults to `formatLabel`. */
  formatItem?: (v: number) => ReactNode;
  /** aria-label / trigger tooltip. */
  ariaLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WheelStepper({
  value,
  min,
  max,
  onChange,
  isDisabled,
  formatLabel,
  formatItem,
  ariaLabel = 'Pick a value',
  open,
  onOpenChange,
}: WheelStepperProps) {
  const label = formatLabel ?? ((v: number) => v);
  const item = formatItem ?? label;

  return (
    <span className="relative inline-flex items-stretch rounded-lg border border-edge bg-surface">
      <button
        type="button"
        aria-label="Previous"
        disabled={value <= min || (isDisabled?.(value - 1) ?? false)}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex items-center rounded-l-lg px-3 text-sm text-muted hover:bg-raised hover:text-accent disabled:pointer-events-none disabled:opacity-30"
      >
        ◀
      </button>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="border-x border-edge px-3 py-0.5 hover:bg-raised"
      >
        {label(value)}
      </button>
      <button
        type="button"
        aria-label="Next"
        disabled={value >= max || (isDisabled?.(value + 1) ?? false)}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex items-center rounded-r-lg px-3 text-sm text-muted hover:bg-raised hover:text-accent disabled:pointer-events-none disabled:opacity-30"
      >
        ▶
      </button>
      {open && (
        <Wheel
          value={value}
          min={min}
          max={max}
          isDisabled={isDisabled}
          renderItem={item}
          onPick={(v) => {
            onChange(v);
            onOpenChange(false);
          }}
          onClose={() => onOpenChange(false)}
        />
      )}
    </span>
  );
}

function Wheel({
  value,
  min,
  max,
  isDisabled,
  renderItem,
  onPick,
  onClose,
}: {
  value: number;
  min: number;
  max: number;
  isDisabled?: (v: number) => boolean;
  renderItem: (v: number) => ReactNode;
  onPick: (v: number) => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  useEffect(() => {
    const el = itemRefs.current[value];
    if (el) el.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on outside click / Escape. Anything inside the surrounding pill
  // (◀ / label / ▶) is treated as inside so the toggle can close it cleanly.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const pill = wrapRef.current?.parentElement;
      if (pill && !pill.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const listHeight = ITEM_HEIGHT * VISIBLE;
  const centerPad = (listHeight - ITEM_HEIGHT) / 2;
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div
      ref={wrapRef}
      className="absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 rounded-lg border border-edge bg-surface p-1 shadow-lg"
    >
      <div className="relative" style={{ height: listHeight }}>
        <div
          className="pointer-events-none absolute inset-x-0 z-10 rounded-md border border-accent/60 bg-accent-soft"
          style={{ top: centerPad, height: ITEM_HEIGHT }}
        />
        <div
          className="h-full snap-y snap-mandatory overflow-y-auto"
          style={{ scrollPaddingTop: centerPad, scrollPaddingBottom: centerPad }}
        >
          <div className="flex flex-col" style={{ paddingTop: centerPad, paddingBottom: centerPad }}>
            {values.map((v) => {
              const disabled = isDisabled?.(v) ?? false;
              const selected = v === value;
              return (
                <button
                  key={v}
                  ref={(el) => {
                    itemRefs.current[v] = el;
                  }}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(v)}
                  style={{ height: ITEM_HEIGHT }}
                  className={`flex snap-center items-center justify-center gap-1.5 whitespace-nowrap px-3 text-sm font-bold transition-colors ${
                    selected
                      ? 'text-accent'
                      : disabled
                        ? 'text-faint'
                        : 'text-muted hover:text-body'
                  }`}
                >
                  {renderItem(v)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
