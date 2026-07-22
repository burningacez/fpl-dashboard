'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { TRAFFIC_OPTOUT_KEY } from '@/lib/traffic';

interface DayRow {
  date: string;
  views: number;
  uniques: number;
  newDevices: number;
  returning: number;
}

interface PageRow {
  path: string;
  views: number;
}

interface UserRow {
  nameKey: string;
  name: string;
  team: string;
  views: number;
  lastSeen: string;
  pages: PageRow[];
}

interface TrafficData {
  season: string;
  startedAt: string;
  totals: { views: number; uniqueDevices: number };
  days: DayRow[];
  pages: PageRow[];
  users: UserRow[];
}

const RANGES: { label: string; days: number }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'Season', days: 0 },
];

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** Traffic analytics viewer: daily views, top pages, per-member activity. */
export function TrafficCard({ password }: { password: string }) {
  const [range, setRange] = useState(7);
  const [data, setData] = useState<TrafficData | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [optedOut, setOptedOut] = useState(false);

  useEffect(() => {
    try {
      setOptedOut(window.localStorage.getItem(TRAFFIC_OPTOUT_KEY) === '1');
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/traffic?password=${encodeURIComponent(password)}&days=${range}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setData(d);
      setError(false);
    } catch {
      setError(true);
    }
  }, [password, range]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleOptOut = () => {
    const next = !optedOut;
    try {
      if (next) window.localStorage.setItem(TRAFFIC_OPTOUT_KEY, '1');
      else window.localStorage.removeItem(TRAFFIC_OPTOUT_KEY);
      setOptedOut(next);
    } catch {
      /* localStorage unavailable */
    }
  };

  const reset = async () => {
    if (!window.confirm('Reset all traffic stats for this season?')) return;
    await fetch(`/api/admin/traffic?password=${encodeURIComponent(password)}`, { method: 'DELETE' });
    load();
  };

  const maxDayViews = Math.max(1, ...(data?.days.map((d) => d.views) ?? []));
  const maxPageViews = Math.max(1, ...(data?.pages.map((p) => p.views) ?? []));
  const rangeNew = data?.days.reduce((n, d) => n + d.newDevices, 0) ?? 0;
  const rangeViews = data?.days.reduce((n, d) => n + d.views, 0) ?? 0;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">Traffic</h2>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setRange(r.days)}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${
                range === r.days ? 'border-accent bg-accent text-accent-fg' : 'border-edge hover:bg-raised'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-negative">Failed to load traffic stats.</p>}
      {!data && !error && <p className="text-sm text-muted">Loading…</p>}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-raised p-2">
              <div className="text-xl font-extrabold">{rangeViews}</div>
              <div className="text-xs text-muted">page views</div>
            </div>
            <div className="rounded-lg bg-raised p-2">
              <div className="text-xl font-extrabold">{data.totals.uniqueDevices}</div>
              <div className="text-xs text-muted">devices (season)</div>
            </div>
            <div className="rounded-lg bg-raised p-2">
              <div className="text-xl font-extrabold">{rangeNew}</div>
              <div className="text-xs text-muted">new visitors</div>
            </div>
          </div>

          <div className="mb-1 text-sm font-semibold text-muted">By day</div>
          {data.days.length === 0 ? (
            <p className="mb-4 text-sm text-muted">No views recorded yet.</p>
          ) : (
            <div className="mb-4 flex flex-col gap-1">
              {data.days.map((d) => (
                <div key={d.date} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-muted">{dayLabel(d.date)}</span>
                  <div className="h-4 flex-1 overflow-hidden rounded-sm bg-raised">
                    <div className="h-full rounded-sm bg-accent/70" style={{ width: `${(d.views / maxDayViews) * 100}%` }} />
                  </div>
                  <span className="w-40 shrink-0 text-right text-muted">
                    <b className="text-body">{d.views}</b> views · {d.uniques} device{d.uniques === 1 ? '' : 's'}
                    {d.newDevices > 0 && <span className="text-positive"> · {d.newDevices} new</span>}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-1 text-sm font-semibold text-muted">Top pages</div>
          <div className="mb-4 flex flex-col gap-1">
            {data.pages.map((p) => (
              <div key={p.path} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 truncate font-mono">{p.path}</span>
                <div className="h-4 flex-1 overflow-hidden rounded-sm bg-raised">
                  <div className="h-full rounded-sm bg-accent/70" style={{ width: `${(p.views / maxPageViews) * 100}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right font-bold">{p.views}</span>
              </div>
            ))}
          </div>

          <div className="mb-1 text-sm font-semibold text-muted">Members</div>
          {data.users.length === 0 ? (
            <p className="text-sm text-muted">No views from claimed members in this range.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {data.users.map((u) => (
                <div key={u.nameKey} className="rounded-lg border border-edge bg-raised px-3 py-2">
                  <button
                    onClick={() => setExpanded(expanded === u.nameKey ? null : u.nameKey)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <span>
                      <span className="block text-sm font-semibold">{u.name}</span>
                      <span className="block text-xs text-muted">{u.team}</span>
                    </span>
                    <span className="text-right text-xs text-muted">
                      <b className="block text-sm text-body">{u.views} views</b>
                      last seen {dayLabel(u.lastSeen)}
                    </span>
                  </button>
                  {expanded === u.nameKey && (
                    <div className="mt-2 flex flex-col gap-0.5 border-t border-edge/50 pt-2">
                      {u.pages.map((p) => (
                        <div key={p.path} className="flex justify-between text-xs text-muted">
                          <span className="font-mono">{p.path}</span>
                          <span>{p.views}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-edge/50 pt-3 text-xs">
            <label className="flex items-center gap-1.5 text-muted">
              <input type="checkbox" checked={optedOut} onChange={toggleOptOut} />
              Don&apos;t count this browser
            </label>
            <span className="flex gap-2">
              <button onClick={load} className="rounded-md border border-edge px-2.5 py-1 hover:bg-raised">
                Refresh
              </button>
              <button onClick={reset} className="rounded-md border border-negative/50 px-2.5 py-1 text-negative hover:bg-negative-soft">
                Reset stats
              </button>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
