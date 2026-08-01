'use client';

/**
 * The pitch itself: turf, markings and depth, with players laid flat on top.
 *
 * Shared by the scores-page pitch and the planner/builder pitches so there is
 * one definition of what a pitch looks like.
 *
 * Everything drawn here comes out of the camera in ./geometry — see that file
 * for how the perspective is set up and what it was calibrated against. This
 * component's only real job is to measure the box and hand those pixels over,
 * because the geometry is generated at the frame's true size instead of being
 * written in a 0-100 box and stretched. That stretch is what used to change the
 * taper and squash the ellipses differently at every container size; the pitch
 * now holds its shape whether it is a phone-width scores pitch or a wider
 * planner one with a different number of rows.
 *
 * Players sit above the markings, untransformed and fully legible.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { pitchMarkings, turfGradient } from './geometry';

/** Used for the server render and the first client paint, before the box has
 *  been measured. Roughly a phone-width scores pitch. */
const NOMINAL = { width: 380, height: 440 };

// Measure before paint on the client; useLayoutEffect does not run on the
// server and warns if called there.
const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useFrameSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(NOMINAL);

  useMeasureEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      if (next.width < 1 || next.height < 1) return;
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    // Measured as a border box, to match the box the markings are drawn into:
    // an absolutely positioned inset-0 child fills the padding box, and this
    // pitch has vertical padding, so a ResizeObserver's contentRect would be
    // two padding-widths short.
    const measure = () => {
      const box = node.getBoundingClientRect();
      apply(box.width, box.height);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    // The SVG is absolutely positioned, so it cannot feed back into the height,
    // which is set by the rows of players.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

function Markings({ width, height }: { width: number; height: number }) {
  const { paths, spots } = useMemo(() => pitchMarkings(width, height), [width, height]);
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{
        stroke: 'var(--pitch-line)',
        strokeWidth: 'var(--pitch-line-width)',
        fill: 'none',
        strokeLinejoin: 'round',
        strokeLinecap: 'round',
      }}
    >
      {/* The viewBox matches the frame's pixels, so the stroke is already 1:1.
          non-scaling-stroke keeps the line weight honest in the nominal frame
          rendered before the box has been measured. It is per-shape: it is not
          an inherited property, so setting it once on a wrapping <g> would
          leave every line scaled. */}
      {paths.map((d, i) => (
        <path key={i} d={d} vectorEffect="non-scaling-stroke" />
      ))}
      {spots.map((spot, i) => (
        <ellipse key={i} {...spot} style={{ fill: 'var(--pitch-line)', stroke: 'none' }} />
      ))}
    </svg>
  );
}

export function PitchSurface({ children }: { children: React.ReactNode }) {
  const [ref, size] = useFrameSize();
  const turf = useMemo(() => turfGradient(size.width, size.height), [size.width, size.height]);

  return (
    <div ref={ref} className="relative overflow-hidden py-3" style={{ background: turf }}>
      <Markings width={size.width} height={size.height} />

      {/* The far end sits in shade — atmospheric depth on top of the geometric
          kind, and unlike geometry it costs no width. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.38) 0%, rgba(0,0,0,0.14) 38%, rgba(0,0,0,0) 72%)',
        }}
      />

      <div className="relative">{children}</div>
    </div>
  );
}
