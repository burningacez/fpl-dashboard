'use client';

/**
 * The pitch itself: turf, markings and depth, with players laid flat on top.
 *
 * Shared by the scores-page pitch and the planner/builder pitches so there is
 * one definition of what a pitch looks like.
 *
 * Perspective follows the official FPL app rather than a naive 3D tilt. You are
 * stood behind the halfway line looking at the far goal, close enough that the
 * pitch is wider than the frame for all but its far end. So:
 *
 *  - the FAR END carries the perspective — goal, penalty area and six-yard box
 *    are trapezoids narrowing toward the goal line;
 *  - the TOUCHLINES appear only briefly at the far corners, diverging out of
 *    frame within the top third. Nearer than that they are simply off-screen.
 *
 * That second point is the whole reason for this shape. Rotating the entire
 * plane (transform: rotateX) is convincing on an empty pitch, but it keeps both
 * touchlines in frame the whole way down, converging hard enough to cut through
 * the outer players of a five-across row — which the squad builder has for both
 * defenders and midfielders. Letting the sides leave the frame gives a stronger
 * sense of depth AND leaves the full width free for players.
 *
 * Markings are SVG so the trapezoids are exact; non-scaling strokes keep the
 * line weight constant however the box is stretched. Colour and weight come
 * from the palette (--pitch-*), never from here.
 */

import type React from 'react';

/**
 * Mowing stripes that widen toward the viewer. Equal bands read as flat, so
 * each is a little deeper than the one beyond it — the cheapest depth cue there
 * is, and it costs no layout width.
 */
function turfGradient(bands = 9): string {
  const weights = Array.from({ length: bands }, (_, i) => i + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const stops: string[] = [];
  let pos = 0;
  weights.forEach((weight, i) => {
    const next = pos + (weight / total) * 100;
    const colour = i % 2 === 0 ? 'var(--pitch-from)' : 'var(--pitch-to)';
    stops.push(`${colour} ${pos.toFixed(2)}%`, `${colour} ${next.toFixed(2)}%`);
    pos = next;
  });
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}

const TURF = turfGradient();

const GOAL = 'M44,0 L44,4 M56,0 L56,4 M44,0 L56,0';
const SPOT: React.CSSProperties = { fill: 'var(--pitch-line)' };

/**
 * Markings in a 0-100 box, stretched to fit. Geometry is written as if seen
 * from the halfway line: y=0 is the far goal line, y=100 the near edge.
 */
function Markings() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        stroke: 'var(--pitch-line)',
        strokeWidth: 'var(--pitch-line-width)',
        fill: 'none',
        strokeLinejoin: 'round',
      }}
    >
      {/* vector-effect is per-shape: it is not an inherited property, so
          setting it once on a wrapping <g> leaves every line scaled by the
          viewBox stretch — which at this aspect ratio is roughly 4x. */}
      {/* Goal, standing on the goal line and narrower than the six-yard box. */}
      <path d={GOAL} vectorEffect="non-scaling-stroke" />

      {/* Goal line — the far edge of the pitch, and the only place the full
          width is in frame. */}
      <path d="M18,4 L82,4" vectorEffect="non-scaling-stroke" />

      {/* Touchlines run out from the far corners and leave the frame almost
          immediately. This is the whole trick: at anything nearer than the
          penalty area the pitch is WIDER than the viewport, so there is no side
          line to crowd a five-across row. Drawing them full height, as a
          literal rotateX would, is what cut through the outer players. */}
      <path d="M18,4 L0,26" vectorEffect="non-scaling-stroke" />
      <path d="M82,4 L100,26" vectorEffect="non-scaling-stroke" />

      {/* Corner arcs, tucked into the far corners. */}
      <path d="M18,4 A 3 2 0 0 1 15.4,6.9" vectorEffect="non-scaling-stroke" />
      <path d="M82,4 A 3 2 0 0 0 84.6,6.9" vectorEffect="non-scaling-stroke" />

      {/* Penalty area and six-yard box: both narrow toward the goal line. */}
      <path d="M31,4 L69,4 L75,23 L25,23 Z" vectorEffect="non-scaling-stroke" />
      <path d="M41,4 L59,4 L61,12 L39,12 Z" vectorEffect="non-scaling-stroke" />

      {/* Penalty spot and the D at the edge of the area. */}
      <ellipse cx="50" cy="17" rx="0.7" ry="0.5" style={SPOT} vectorEffect="non-scaling-stroke" />
      <path d="M39.5,23 A 13 6 0 0 0 60.5,23" vectorEffect="non-scaling-stroke" />

      {/* Halfway line and centre circle, right up against the viewer, so both
          run the full width of the frame. */}
      <path d="M0,93 L100,93" vectorEffect="non-scaling-stroke" />
      <ellipse cx="50" cy="93" rx="21" ry="7" vectorEffect="non-scaling-stroke" />
      <ellipse cx="50" cy="93" rx="0.7" ry="0.5" style={SPOT} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PitchSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden py-3" style={{ background: TURF }}>
      <Markings />

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

      {/* Players sit above the backdrop, untransformed and fully legible. */}
      <div className="relative">{children}</div>
    </div>
  );
}
