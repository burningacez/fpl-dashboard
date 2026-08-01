/**
 * Pitch geometry: one camera, every marking derived from it.
 *
 * The markings used to be hand-typed trapezoids in a 0-100 box that was then
 * stretched to whatever size the container happened to be. Nothing agreed with
 * anything else, and the taper changed shape with the box. Here the pitch is
 * described once, in metres, and projected.
 *
 * Coordinates: x runs across the pitch (0 on the centre line, +x to the right),
 * z runs into the screen from the FAR goal line (z = 0) toward the viewer, and
 * `up` is height above the turf. You are stood behind the near end looking at
 * the far goal, so the goalkeeper is at the top and the forwards nearest you.
 *
 * Two dials, and they do different jobs:
 *
 *  - `distance` is a true single-vanishing-point projection across the pitch:
 *    px per metre is f / (distance - z), so the goal line is narrow, the
 *    touchlines splay out of frame, and the penalty area tapers. This is what
 *    makes it look like a pitch rather than a diagram.
 *
 *  - `foreshorten` is the camera's tilt: one metre of depth is drawn as this
 *    many metres of width. Integrating dy/dz = k·s(z) gives the row placement
 *    below. Keeping it explicit is what stops the centre circle going wrong —
 *    a circle on the ground projects to an ellipse whose height/width IS k, so
 *    at k = 0.7 it is always visibly flatter than it is wide. Solving for the
 *    tilt implicitly (by pinning the halfway line to a fraction of the height)
 *    is exactly how it ended up taller than wide on a phone.
 *
 * Calibrated against the official FPL app: its goal line spans 87% of the frame
 * and its centre circle measures 536x295 px. Note that its own numbers are not
 * self-consistent — the width taper implies a camera ~100 m out, the depth
 * profile ~700 m — so we match the shapes and let the halfway line land where
 * the geometry puts it (about 62% down) rather than copying their 78%.
 */

/** The real thing, in metres. */
export const PITCH = {
  halfWidth: 34,
  penaltyHalfWidth: 20.16,
  penaltyDepth: 16.5,
  sixHalfWidth: 9.16,
  sixDepth: 5.5,
  goalHalfWidth: 3.66,
  goalHeight: 2.44,
  penaltySpot: 11,
  circleRadius: 9.15,
  /** Really 1 m, which is 5 px on a phone. Drawn at 2 m so it reads as a
   *  quarter circle rather than a nick in the line — the official app does the
   *  same, at roughly this radius. */
  cornerRadius: 2,
  halfway: 52.5,
} as const;

export const CAMERA = {
  /** Metres from the camera to the far goal line. Sets how hard it tapers. */
  distance: 105,
  /** Camera tilt: one metre of depth drawn as this much width. */
  foreshorten: 0.7,
  /** Far goal line, as a fraction of the frame width — on a frame tall enough
   *  to take it. See `targetDepth`. */
  goalLineSpan: 0.874,
  /** Metres of pitch that must stay in frame, measured from the far goal line.
   *  A shade past the halfway line, like the official app.
   *
   *  Scaling off the width alone means a wide, short frame zooms in until the
   *  halfway line and centre circle drop off the bottom edge, which leaves the
   *  near half of the pitch as featureless turf. So the scale is whichever of
   *  the two is smaller: the one that spans the width, or the one that fits
   *  this much depth. A wide frame then shows more grass outside the touchlines
   *  at the far end, which is what a wider camera should show, instead of
   *  cropping the markings away. */
  targetDepth: 62,
  /** Far goal line, as a fraction of the frame height. Leaves room above it
   *  for the goal frame, which stands up off the turf. */
  goalLineY: 0.05,
} as const;

export type Point = [number, number];

export interface PitchCamera {
  /** World (metres) to screen (px within the frame). */
  project: (x: number, z: number, up?: number) => Point;
  /** Screen px per metre across the pitch, at depth z. */
  across: (z: number) => number;
  /** Screen y of the line at depth z. */
  rowY: (z: number) => number;
  /** Depth, in metres, of the bottom edge of the frame. */
  maxDepth: number;
}

export function pitchCamera(width: number, height: number): PitchCamera {
  const { distance, foreshorten: k, goalLineSpan, goalLineY, targetDepth } = CAMERA;
  const yGoal = goalLineY * height;
  // px per metre at the goal line: enough to span the width, or to fit
  // `targetDepth` into the height — whichever is the tighter constraint.
  const toSpanWidth = (goalLineSpan * width) / (2 * PITCH.halfWidth);
  const toFitDepth = (height - yGoal) / (k * distance * Math.log(distance / (distance - targetDepth)));
  const goalScale = Math.min(toSpanWidth, toFitDepth);
  const f = goalScale * distance;
  // A vertical metre is foreshortened by cos(tilt) where sin(tilt) = k, so a
  // standing object (the goal frame) leans back consistently with the ground.
  const upScale = Math.sqrt(1 - k * k);

  const across = (z: number) => f / (distance - z);
  const rowY = (z: number) => yGoal + k * f * Math.log(distance / (distance - z));
  const project = (x: number, z: number, up = 0): Point => {
    const s = across(z);
    return [width / 2 + x * s, rowY(z) - up * s * upScale];
  };
  // rowY inverted at y = height.
  const maxDepth = distance * (1 - Math.exp(-(height - yGoal) / (k * f)));

  return { project, across, rowY, maxDepth };
}

const fmt = (pts: readonly Point[]) =>
  'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');

/** A circle on the turf, sampled and projected. Projected circles are conics,
 *  not ellipses about their own centre, so they are sampled rather than handed
 *  to <ellipse> — which is also what lets an arc stop exactly on a line. */
function groundArc(
  cx: number,
  cz: number,
  r: number,
  from: number,
  to: number,
  project: PitchCamera['project'],
  steps: number,
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push(project(cx + r * Math.cos(a), cz + r * Math.sin(a)));
  }
  return pts;
}

/**
 * One consequence of setting the tilt by hand rather than taking whatever a
 * strict pinhole gives: a ground line running away from the viewer is very
 * slightly bowed on screen instead of dead straight. Over the stretch of any
 * such line that is actually in frame that comes to about half a pixel against
 * a 3px stroke, so they are drawn as straight chords between projected ends.
 * Curves that matter — the circles and arcs — are sampled properly.
 * (Pinned by the "lines that run into the distance" test.)
 */
export interface PitchMarkings {
  /** Stroked paths, in frame pixels. */
  paths: string[];
  /** Filled spots (penalty spot, centre spot). */
  spots: Array<{ cx: number; cy: number; rx: number; ry: number }>;
}

export function pitchMarkings(width: number, height: number): PitchMarkings {
  const cam = pitchCamera(width, height);
  const { project, across } = cam;
  const P = PITCH;
  const paths: string[] = [];
  const line = (pts: readonly Point[], close = false) => paths.push(fmt(pts) + (close ? ' Z' : ''));

  // Goal line, and the touchlines running back toward the viewer. They leave
  // the frame within the top eighth on their own — nearer than that the pitch
  // is simply wider than the viewport, which is what keeps the full width free
  // for a five-across row instead of cutting through the outer players.
  const nearEdge = Math.min(cam.maxDepth, P.halfway + 40);
  line([project(-P.halfWidth, 0), project(P.halfWidth, 0)]);
  line([project(-P.halfWidth, 0), project(-P.halfWidth, nearEdge)]);
  line([project(P.halfWidth, 0), project(P.halfWidth, nearEdge)]);

  // Corner arcs: quarter circles that start on the goal line and end on the
  // touchline, by construction rather than by eye.
  line(groundArc(-P.halfWidth, 0, P.cornerRadius, 0, Math.PI / 2, project, 12));
  line(groundArc(P.halfWidth, 0, P.cornerRadius, Math.PI, Math.PI / 2, project, 12));

  // Penalty area and six-yard box, open at the goal line.
  line([
    project(-P.penaltyHalfWidth, 0),
    project(-P.penaltyHalfWidth, P.penaltyDepth),
    project(P.penaltyHalfWidth, P.penaltyDepth),
    project(P.penaltyHalfWidth, 0),
  ]);
  line([
    project(-P.sixHalfWidth, 0),
    project(-P.sixHalfWidth, P.sixDepth),
    project(P.sixHalfWidth, P.sixDepth),
    project(P.sixHalfWidth, 0),
  ]);

  // The D: the part of the 9.15 m circle round the penalty spot that falls
  // outside the area, so it meets the box edge exactly where it should.
  const dStart = Math.asin((P.penaltyDepth - P.penaltySpot) / P.circleRadius);
  line(groundArc(0, P.penaltySpot, P.circleRadius, dStart, Math.PI - dStart, project, 20));

  // Halfway line and centre circle.
  line([project(-P.halfWidth, P.halfway), project(P.halfWidth, P.halfway)]);
  line(groundArc(0, P.halfway, P.circleRadius, 0, Math.PI * 2, project, 40), true);

  // The goal stands up off the turf, so it gets real height.
  line([project(-P.goalHalfWidth, 0, P.goalHeight), project(-P.goalHalfWidth, 0)]);
  line([project(P.goalHalfWidth, 0, P.goalHeight), project(P.goalHalfWidth, 0)]);
  line([project(-P.goalHalfWidth, 0, P.goalHeight), project(P.goalHalfWidth, 0, P.goalHeight)]);

  // Spots are circles on the ground too, so they flatten by the same amount.
  const spot = (z: number, r: number) => {
    const [cx, cy] = project(0, z);
    const rx = Math.max(1.2, r * across(z));
    return { cx, cy, rx, ry: rx * CAMERA.foreshorten };
  };

  return { paths, spots: [spot(P.penaltySpot, 0.45), spot(P.halfway, 0.45)] };
}

/** Mowing stripes at a fixed depth, so they widen toward the viewer because of
 *  the projection rather than because of a hand-picked weighting. */
export function turfGradient(width: number, height: number, metresPerBand = 8): string {
  const cam = pitchCamera(width, height);
  const bands = Math.max(1, Math.ceil(cam.maxDepth / metresPerBand));
  const stops: string[] = [];
  let previous = 0;
  for (let band = 0; band < bands; band++) {
    const z = Math.min((band + 1) * metresPerBand, cam.maxDepth);
    // The last band runs to the bottom edge whatever the rounding says.
    const next = band === bands - 1 ? 100 : Math.min(100, (cam.rowY(z) / height) * 100);
    const colour = band % 2 === 0 ? 'var(--pitch-from)' : 'var(--pitch-to)';
    stops.push(`${colour} ${previous.toFixed(2)}%`, `${colour} ${next.toFixed(2)}%`);
    previous = next;
  }
  return `linear-gradient(180deg, ${stops.join(', ')})`;
}
