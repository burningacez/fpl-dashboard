'use client';

/**
 * Manager profile modal (legacy openProfile/renderProfile) — quick stats,
 * per-half chip usage, rank-history chart (SVG instead of Chart.js) and
 * season records. Opened from the manager column on the Live page.
 *
 * Endpoint: /api/manager/:id/profile.
 */

import React from 'react';
import { EmptyBlock, ErrorBlock, LoadingBlock, Modal } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useSeason } from '@/components/providers';
import { LineChart } from '@/components/charts/LineChart';
import { DEFAULT_SEASON, getSeasonConfig } from '@/lib/season-config';

// ---------------------------------------------------------------------------
// Rank-history chart (reversed y axis: rank 1 at the top)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RankChart({ history }: { history: any[] }) {
  if (!history || history.length === 0) {
    return <div className="py-4 text-center text-sm text-muted">No rank history yet.</div>;
  }
  return (
    <LineChart
      invertY
      legend={false}
      heightClass="h-36"
      yLabel="rank 1 at top"
      series={[{ label: 'Rank', color: 'var(--accent)', points: history.map((h: any) => ({ x: h.gw, y: h.rank })) }]}
    />
  );
}

function StatBox({
  value,
  label,
  sub,
  highlight = true,
}: {
  value: React.ReactNode;
  label: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg bg-raised px-2 py-3 text-center">
      <div className={`text-xl font-extrabold ${highlight ? 'text-accent' : 'text-body'}`}>{value}</div>
      <div className="mt-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">{label}</div>
      {sub && <div className="mt-0.5 text-[0.65rem] text-faint">{sub}</div>}
    </div>
  );
}

function StatsList({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <ul>
      {items.map((it) => (
        <li
          key={it.label}
          className="flex items-center justify-between border-b border-edge py-2 text-sm last:border-b-0"
        >
          <span className="text-muted">{it.label}</span>
          <span className="font-semibold">{it.value}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Chips — per-half chip usage, shown as coloured 2-letter tokens.
// green = available, red = expired unused, grey = used, dashed = not yet open.
// ---------------------------------------------------------------------------

const CHIP_CODES: { key: string; code: string; label: string }[] = [
  { key: 'wildcard', code: 'WC', label: 'Wildcard' },
  { key: 'freehit', code: 'FH', label: 'Free Hit' },
  { key: 'bboost', code: 'BB', label: 'Bench Boost' },
  { key: '3xc', code: 'TC', label: 'Triple Captain' },
  { key: 'manager', code: 'AM', label: 'Assistant Manager' },
];

const CHIP_TOKEN_CLS: Record<string, string> = {
  available: 'bg-positive-soft text-positive',
  expired: 'bg-negative-soft text-negative',
  used: 'bg-edge-strong text-muted',
  locked: 'border border-dashed border-edge-strong text-faint',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChipToken({ code, label, chip, locksAtGw }: { code: string; label: string; chip: any; locksAtGw: number }) {
  const status: string = chip?.status ?? 'available';
  const statusLabel =
    status === 'used'
      ? `Used${chip?.gw ? ` (GW${chip.gw})` : ''}`
      : status === 'available'
        ? 'Available'
        : status === 'expired'
          ? 'Expired (unused)'
          : `Not open until GW${locksAtGw}`;
  return (
    <div
      title={`${label}: ${statusLabel}`}
      className={`flex h-11 flex-col items-center justify-center rounded-lg text-center ${CHIP_TOKEN_CLS[status] ?? CHIP_TOKEN_CLS.available}`}
    >
      <span className="text-sm font-extrabold leading-none">{code}</span>
      {status === 'used' && chip?.gw && (
        <span className="mt-0.5 text-[0.55rem] font-semibold leading-none">GW{chip.gw}</span>
      )}
    </div>
  );
}

function ChipHalf({
  title,
  half,
  locksAtGw,
}: {
  title: string;
  half: Record<string, unknown> | undefined;
  locksAtGw: number;
}) {
  // Only render chip slots the payload knows about, but always show the core
  // four; the Assistant Manager slot appears when the season tracks it.
  const codes = CHIP_CODES.filter((c) => c.key !== 'manager' || (half && c.key in half));
  return (
    <div>
      <div className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">{title}</div>
      <div className={`grid gap-1.5 ${codes.length > 4 ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {codes.map((c) => (
          <ChipToken key={c.key} code={c.code} label={c.label} chip={half?.[c.key]} locksAtGw={locksAtGw} />
        ))}
      </div>
    </div>
  );
}

function ChipLegend() {
  const dot = (cls: string) => <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
  return (
    <div className="flex items-center gap-2 text-[0.6rem] text-faint">
      <span className="flex items-center gap-1">{dot('bg-positive')} Available</span>
      <span className="flex items-center gap-1">{dot('bg-edge-strong')} Used</span>
      <span className="flex items-center gap-1">{dot('bg-negative')} Expired</span>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChipsSection({ chips, secondHalfStartGw, totalWeeks }: { chips: any; secondHalfStartGw: number; totalWeeks: number }) {
  if (!chips?.firstHalf && !chips?.secondHalf) return null;
  return (
    <div className="mb-5" data-tour="profile-chips">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Chips</h3>
        <ChipLegend />
      </div>
      <div className="space-y-3">
        <ChipHalf
          title={`Gameweeks 1–${secondHalfStartGw - 1}`}
          half={chips.firstHalf}
          locksAtGw={secondHalfStartGw}
        />
        <ChipHalf
          title={`Gameweeks ${secondHalfStartGw}–${totalWeeks}`}
          half={chips.secondHalf}
          locksAtGw={secondHalfStartGw}
        />
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GwRecord({ record, tone }: { record: any; tone: 'accent' | 'negative' }) {
  // Pre-season (or a manager with no completed GW yet) has no records — show a
  // dash instead of dereferencing a missing object.
  if (!record || record.points == null) return <span className="text-faint">–</span>;
  return (
    <span className={tone === 'accent' ? 'text-accent' : 'text-negative'}>
      {record.points} pts <small>(GW{record.gw})</small>
    </span>
  );
}

export function ProfileModal({
  manager,
  fallbackRank,
  onClose,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manager: any;
  fallbackRank: number | string;
  onClose: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, loading, error, empty } = useApi<any>(`/api/manager/${manager.entryId}/profile`);
  const { season, currentSeason } = useSeason();
  const cfg = getSeasonConfig(season ?? currentSeason) ?? getSeasonConfig(DEFAULT_SEASON)!;
  const records = data?.records;
  const currentRank = records?.currentRank || fallbackRank || '-';

  return (
    <Modal
      title={
        <span>
          {manager.name}
          <span className="block text-sm font-normal text-muted">{manager.team}</span>
        </span>
      }
      onClose={onClose}
      anchor="modal-profile"
    >
      {loading && <LoadingBlock label="Loading profile data…" />}
      {error && <ErrorBlock message={error} />}
      {empty && <EmptyBlock message={empty} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {data && !data.error && records && (
        <>
          <div className="mb-5 grid grid-cols-3 gap-2" data-tour="profile-stats">
            <StatBox value={`#${currentRank}`} label="League Rank" sub={`(best: #${records.bestRank || '-'})`} />
            <StatBox value={records.avgScore ?? '–'} label="Avg GW Score" />
            <StatBox value={data.motmWins} label="MotM Wins" highlight={data.motmWins > 0} />
          </div>

          {data.chips && (
            <ChipsSection
              chips={data.chips}
              secondHalfStartGw={cfg.chipSecondHalfStartGw}
              totalWeeks={cfg.totalWeeks}
            />
          )}

          <div className="mb-5" data-tour="profile-chart">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">League Rank History</h3>
            <RankChart history={data.history} />
          </div>

          <div className="grid gap-5 sm:grid-cols-2" data-tour="profile-records">
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Season Records</h3>
              <StatsList
                items={[
                  { label: 'Best GW', value: <GwRecord record={records.highestGW} tone="accent" /> },
                  { label: 'Worst GW', value: <GwRecord record={records.lowestGW} tone="negative" /> },
                  {
                    label: 'Weekly Loser',
                    value: <span className={data.loserCount > 0 ? 'text-negative' : ''}>{data.loserCount}x</span>,
                  },
                ]}
              />
            </div>
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Transfers</h3>
              <StatsList
                items={[
                  { label: 'Total Made', value: records.totalTransfers ?? 0 },
                  {
                    label: 'Point Hits',
                    value:
                      records.transferHits > 0 ? (
                        <span className="text-negative">-{records.transferHits} pts</span>
                      ) : (
                        'None'
                      ),
                  },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
