'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type ReactNode } from 'react';

/**
 * Tinkering Impact — "what did this week's moves earn you vs keeping last
 * week's team?"
 *
 * Renders the v2 ledger payload from /api/manager/{id}/tinkering. The expanded
 * view is a reconciliation where every line is a real addend:
 *
 *   Kept last week's team        58
 *   Transfers                    +9
 *   Captaincy                    −4
 *   Bench calls                  +2
 *   Transfer hits                −4
 *   Your score                   61   ← same number as the week table row
 *
 * The buckets are guaranteed server-side to sum to (actual − kept), so the
 * breakdown always adds up to the headline.
 */

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function impactColor(n: number): string {
  return n > 0 ? 'text-positive' : n < 0 ? 'text-negative' : 'text-muted';
}

function PlayerRow({ label, delta }: { label: ReactNode; delta: number }) {
  return (
    <div className="flex justify-between py-0.5 pl-3 text-muted">
      <span>{label}</span>
      <span className={`font-semibold ${impactColor(delta)}`}>{signed(delta)}</span>
    </div>
  );
}

function BucketLine({ label, total, rows }: { label: ReactNode; total: number; rows: ReactNode[] }) {
  return (
    <div className="border-t border-edge py-1">
      <div className="flex justify-between py-0.5 font-semibold">
        <span>{label}</span>
        <span className={impactColor(total)}>{signed(total)}</span>
      </div>
      {rows}
    </div>
  );
}

export function TinkeringImpact({ entryId, gw }: { entryId: number; gw: number }) {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/manager/${entryId}/tinkering?gw=${gw}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entryId, gw]);

  if (!data) return null;
  if (!data.available) {
    return data.reason === 'gw1' ? (
      <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
        No moves to judge in GW1 — there&apos;s no previous team to compare against.
      </p>
    ) : null;
  }

  const { keptScore, actualNetScore, transferCost, netImpact, chip, buckets, isLiveGW } = data;
  const transfers = buckets?.transfers ?? { total: 0, rows: [] };
  const captaincy = buckets?.captaincy ?? { total: 0, changed: false, rows: [] };
  const bench = buckets?.bench ?? { total: 0, rows: [] };

  const madeChanges =
    transfers.rows.length > 0 || captaincy.changed || captaincy.rows.length > 0 || bench.rows.length > 0 || transferCost > 0;

  const transferRows = transfers.rows.map((r: any) => (
    <PlayerRow
      key={`t${r.id}`}
      label={`${r.direction === 'in' ? 'In:' : 'Out:'} ${r.name}${r.captain ? ' (C)' : ''}`}
      delta={r.delta}
    />
  ));

  const captaincyRows = [
    captaincy.changed && captaincy.oldCaptain && captaincy.newCaptain && (
      <div key="c-change" className="py-0.5 pl-3 text-muted">
        Armband: {captaincy.oldCaptain.name} → {captaincy.newCaptain.name}
      </div>
    ),
    ...captaincy.rows.map((r: any) => <PlayerRow key={`c${r.id}`} label={r.name} delta={r.delta} />),
  ].filter(Boolean) as ReactNode[];

  const BENCH_LABEL: Record<string, string> = {
    started: 'Started',
    benched: 'Benched',
    autoSub: 'Auto-sub:',
  };
  const benchRows = bench.rows.map((r: any) => (
    <PlayerRow key={`b${r.id}`} label={`${BENCH_LABEL[r.tag] ?? ''} ${r.name}`} delta={r.delta} />
  ));

  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface p-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-sm font-bold"
      >
        <span>
          🔧 Your moves
          {chip && (
            <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[0.6rem] text-accent">{chip.label}</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={impactColor(netImpact)}>{signed(netImpact)} pts</span>
          <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 rounded-lg bg-raised px-3 py-2 text-xs">
          {!madeChanges ? (
            <p className="py-1 text-muted">No changes this week — same team, captain and lineup as last week.</p>
          ) : (
            <>
              <div className="flex justify-between py-0.5">
                <span>Kept last week&apos;s team</span>
                <span>{keptScore} pts</span>
              </div>
              {(transfers.rows.length > 0 || transfers.total !== 0) && (
                <BucketLine label="Transfers" total={transfers.total} rows={transferRows} />
              )}
              {(captaincyRows.length > 0 || captaincy.total !== 0) && (
                <BucketLine label="Captaincy" total={captaincy.total} rows={captaincyRows} />
              )}
              {(bench.rows.length > 0 || bench.total !== 0) && (
                <BucketLine label="Bench calls" total={bench.total} rows={benchRows} />
              )}
              {transferCost > 0 && <BucketLine label="Transfer hits" total={-transferCost} rows={[]} />}
              <div className="flex justify-between border-t border-edge pt-1 font-bold">
                <span>Your score</span>
                <span>
                  {actualNetScore} pts{' '}
                  <span className={impactColor(netImpact)}>({signed(netImpact)})</span>
                </span>
              </div>
            </>
          )}
          {chip && <p className="mt-1.5 text-[0.65rem] text-muted">{chip.note}</p>}
          {isLiveGW && (
            <p className="mt-1 text-[0.65rem] text-muted">Live gameweek — includes provisional bonus, may still change.</p>
          )}
        </div>
      )}
    </div>
  );
}
