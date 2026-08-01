import { describe, expect, it } from 'vitest';
import { CAMERA, PITCH, pitchCamera, pitchMarkings, turfGradient } from '@/components/pitch/geometry';

const PHONE = { width: 380, height: 440 };
const WIDE = { width: 620, height: 420 };

/** Half the on-screen width of the pitch at depth z. */
const halfWidthAt = (cam: ReturnType<typeof pitchCamera>, z: number) =>
  cam.project(PITCH.halfWidth, z)[0] - cam.project(0, z)[0];

describe('pitch camera', () => {
  it('puts the far goal line across 87% of the frame', () => {
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const [left] = cam.project(-PITCH.halfWidth, 0);
    const [right] = cam.project(PITCH.halfWidth, 0);
    expect((right - left) / PHONE.width).toBeCloseTo(CAMERA.goalLineSpan, 3);
  });

  it('keeps the halfway line and centre circle in frame on any frame shape', () => {
    // A wide, short frame used to zoom in far enough to crop them off the
    // bottom, leaving the near half as bare turf.
    for (const [width, height] of [
      [380, 440],
      [620, 420],
      [760, 465],
      [900, 400],
      [380, 540],
    ]) {
      const cam = pitchCamera(width, height);
      const circleNearEdge = cam.rowY(PITCH.halfway + PITCH.circleRadius);
      expect(cam.maxDepth).toBeGreaterThanOrEqual(CAMERA.targetDepth - 0.01);
      expect(circleNearEdge).toBeLessThan(height);
      // ...and never more than the frame's width across the goal line.
      const goalLine = cam.project(PITCH.halfWidth, 0)[0] - cam.project(-PITCH.halfWidth, 0)[0];
      expect(goalLine).toBeLessThanOrEqual(CAMERA.goalLineSpan * width + 0.01);
    }
  });

  it('widens toward the viewer, so the pitch leaves the frame at the sides', () => {
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const widths = [0, 10, 20, 30, 40, 52.5].map((z) => halfWidthAt(cam, z));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    // The far end is in frame, the halfway line is not.
    expect(widths[0] * 2).toBeLessThan(PHONE.width);
    expect(widths[widths.length - 1] * 2).toBeGreaterThan(PHONE.width);
  });

  it('draws the markings in depth order, from the goal line to the halfway line', () => {
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const rows = [0, PITCH.sixDepth, PITCH.penaltyDepth, PITCH.halfway].map(cam.rowY);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
    expect(cam.rowY(PITCH.halfway) / PHONE.height).toBeCloseTo(0.62, 1);
    expect(cam.maxDepth).toBeGreaterThan(PITCH.halfway);
  });
});

describe('centre circle', () => {
  // The bug this guards against: solving for the camera tilt implicitly made a
  // metre of depth bigger than a metre of width, and the circle came out taller
  // than it was wide. Its flattening is the foreshortening constant, full stop.
  it('is flatter than it is wide, by exactly the foreshortening', () => {
    for (const frame of [PHONE, WIDE]) {
      const cam = pitchCamera(frame.width, frame.height);
      const width = 2 * PITCH.circleRadius * cam.across(PITCH.halfway);
      const height =
        cam.rowY(PITCH.halfway + PITCH.circleRadius) - cam.rowY(PITCH.halfway - PITCH.circleRadius);
      expect(height / width).toBeCloseTo(CAMERA.foreshorten, 1);
      expect(height).toBeLessThan(width);
    }
  });

  it('keeps its shape when the container changes shape', () => {
    const ratio = (w: number, h: number) => {
      const cam = pitchCamera(w, h);
      const width = 2 * PITCH.circleRadius * cam.across(PITCH.halfway);
      const height =
        cam.rowY(PITCH.halfway + PITCH.circleRadius) - cam.rowY(PITCH.halfway - PITCH.circleRadius);
      return height / width;
    };
    expect(ratio(PHONE.width, PHONE.height)).toBeCloseTo(ratio(WIDE.width, WIDE.height), 5);
  });

  it('sits nearer the viewer than the halfway line, as a projected circle does', () => {
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const far = cam.rowY(PITCH.halfway - PITCH.circleRadius);
    const near = cam.rowY(PITCH.halfway + PITCH.circleRadius);
    expect((far + near) / 2).toBeGreaterThan(cam.rowY(PITCH.halfway));
  });
});

/** "M x,y L x,y ..." back into points. */
const parse = (d: string): Array<[number, number]> =>
  d
    .replace(/[MLZ]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number) as [number, number]);

describe('corner arcs', () => {
  // The old arcs were an elliptical arc with hand-picked radii in a stretched
  // box: they bulged the wrong way and stopped short of the touchline.
  it('start on the goal line and end on the touchline', () => {
    const { paths } = pitchMarkings(PHONE.width, PHONE.height);
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const goalLineEnd = cam.project(-PITCH.halfWidth + PITCH.cornerRadius, 0);
    const touchlineEnd = cam.project(-PITCH.halfWidth, PITCH.cornerRadius);

    const arc = paths
      .map(parse)
      .find(
        (pts) =>
          pts.length > 5 &&
          Math.hypot(pts[0][0] - goalLineEnd[0], pts[0][1] - goalLineEnd[1]) < 0.2,
      );
    expect(arc).toBeDefined();

    const last = arc![arc!.length - 1];
    expect(last[0]).toBeCloseTo(touchlineEnd[0], 0);
    expect(last[1]).toBeCloseTo(touchlineEnd[1], 0);

    // ...and it bulges into the pitch, not out through the corner.
    const middle = arc![Math.floor(arc!.length / 2)];
    const [cornerX, cornerY] = cam.project(-PITCH.halfWidth, 0);
    expect(middle[0]).toBeGreaterThan(cornerX);
    expect(middle[1]).toBeGreaterThan(cornerY);
  });
});

describe('lines that run into the distance', () => {
  // Trading a strict pinhole for a controllable tilt means a ground line
  // running away from the viewer is very slightly bowed on screen, so drawing
  // it as a straight chord is an approximation. It is worth a fraction of a
  // pixel against a 3px stroke — this pins that down in case the camera moves.
  it('are straight to well within the stroke width', () => {
    const cam = pitchCamera(PHONE.width, PHONE.height);
    const deviation = (x: number, from: number, to: number) => {
      const a = cam.project(x, from);
      const b = cam.project(x, to);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const length = Math.hypot(dx, dy);
      let worst = 0;
      for (let i = 0; i <= 100; i++) {
        const p = cam.project(x, from + ((to - from) * i) / 100);
        worst = Math.max(worst, Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length);
      }
      return worst;
    };
    // The touchline is only in frame for its first stretch; the box sides are
    // in frame for all of theirs.
    expect(deviation(-PITCH.halfWidth, 0, 14)).toBeLessThan(1);
    expect(deviation(-PITCH.penaltyHalfWidth, 0, PITCH.penaltyDepth)).toBeLessThan(1);
    expect(deviation(-PITCH.sixHalfWidth, 0, PITCH.sixDepth)).toBeLessThan(1);
  });
});

describe('markings and turf', () => {
  it('emits finite geometry for every path', () => {
    const { paths, spots } = pitchMarkings(PHONE.width, PHONE.height);
    expect(paths.length).toBeGreaterThan(10);
    for (const d of paths) expect(d).not.toMatch(/NaN|Infinity/);
    for (const spot of spots) {
      expect(Number.isFinite(spot.cx) && Number.isFinite(spot.cy)).toBe(true);
      expect(spot.ry).toBeLessThan(spot.rx);
    }
  });

  it('mows bands that deepen toward the viewer and cover the frame', () => {
    const gradient = turfGradient(PHONE.width, PHONE.height);
    const stops = [...gradient.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(100);
    // Each band is deeper on screen than the one beyond it. The first band is
    // skipped: it also carries the strip above the goal line, and the last runs
    // to the bottom edge, so neither is a clean band.
    const bands: number[] = [];
    for (let i = 0; i < stops.length; i += 2) bands.push(stops[i + 1] - stops[i]);
    for (let i = 2; i < bands.length - 1; i++) expect(bands[i]).toBeGreaterThan(bands[i - 1]);
    expect(bands.length).toBeGreaterThan(4);
  });
});
