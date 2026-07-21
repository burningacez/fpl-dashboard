'use client';

import { useRef, useState } from 'react';

export interface ChartSeries {
  label: string;
  /** CSS colour (var(--accent) etc.) */
  color: string;
  /** x is the gameweek; missing GWs are simply skipped. */
  points: { x: number; y: number }[];
}

/**
 * Minimal two-axis SVG line chart with hover tooltips — stands in for the
 * legacy Chart.js charts (h2h points/rank trajectories, standings rank
 * history). Set invertY for rank charts so rank 1 sits at the top.
 */
export function LineChart({
  series,
  invertY = false,
  heightClass = 'h-40',
  legend = true,
  yLabel,
}: {
  series: ChartSeries[];
  invertY?: boolean;
  heightClass?: string;
  legend?: boolean;
  yLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  if (xs.length === 0) return <div className="py-4 text-center text-sm text-muted">No data yet.</div>;

  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const pad = Math.max((yMax - yMin) * 0.08, 1);
  const lo = invertY ? Math.max(yMin - pad, invertY ? 1 : yMin) : yMin - pad;
  const hi = yMax + pad;

  const xPos = (x: number) => (xs.length > 1 ? (xs.indexOf(x) / (xs.length - 1)) * 100 : 50);
  const yPos = (y: number) => {
    const t = hi === lo ? 0.5 : (y - lo) / (hi - lo);
    return invertY ? t * 100 : (1 - t) * 100;
  };

  const onMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    setHoverIdx(Math.round(frac * (xs.length - 1)));
  };

  const hoverX = hoverIdx != null ? xs[hoverIdx] : null;

  return (
    <div className="rounded-lg bg-raised p-3">
      {legend && series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div
        ref={wrapRef}
        className={`relative ${heightClass}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          {[0, 25, 50, 75, 100].map((y) => (
            <line key={y} x1={0} x2={100} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {hoverX != null && (
            <line x1={xPos(hoverX)} x2={xPos(hoverX)} y1={0} y2={100} stroke="rgba(255,255,255,0.25)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
          {series.map((s) => (
            <polyline
              key={s.label}
              points={s.points.map((p) => `${xPos(p.x).toFixed(2)},${yPos(p.y).toFixed(2)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {hoverX != null && (
          <div
            className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-edge bg-surface px-2 py-1 text-[0.65rem] shadow-lg"
            style={{ left: `${Math.min(Math.max(xPos(hoverX), 12), 88)}%` }}
          >
            <div className="font-bold">GW{hoverX}</div>
            {series.map((s) => {
              const pt = s.points.find((p) => p.x === hoverX);
              return (
                <div key={s.label} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}:</span>
                  <span className="font-semibold">{pt ? pt.y : '–'}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[0.65rem] text-faint">
        <span>GW{xs[0]}</span>
        {yLabel && <span>{yLabel}</span>}
        <span>GW{xs[xs.length - 1]}</span>
      </div>
    </div>
  );
}
