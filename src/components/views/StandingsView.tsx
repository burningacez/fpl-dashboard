'use client';

/**
 * Standings view — port of legacy/standings.html, embedded as a tab on the
 * Live page (legacy week.html's Standings view). When viewGW is set it shows
 * the table as of that gameweek via /api/standings/history.
 *
 * Endpoint: /api/standings → { leagueName, standings[], currentGW }.
 * Columns per legacy: # (with rank movement), Manager (+ team + £value pill),
 * Gross, Trf (with -hit cost), Net. Sortable headers per legacy. Clicking a
 * manager opens the profile modal (legacy fetched /api/manager/:id/profile),
 * with quick stats, rank-history chart (SVG instead of Chart.js) and season
 * records. Deep link ?profile=<entryId> supported.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  DataTable,
  ErrorBlock,
  LoadingBlock,
  ManagerCell,
  Modal,
  type Column,
} from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { LineChart } from '@/components/charts/LineChart';

// ---------------------------------------------------------------------------
// Sorting (legacy sortTable)
// ---------------------------------------------------------------------------

type SortState = { col: string | null; asc: boolean };

const SORT_KEYS: Record<string, (p: any) => string | number> = {
  rank: (p) => p.rank,
  manager: (p) => String(p.name).toLowerCase(),
  gross: (p) => p.grossScore,
  transfers: (p) => p.totalTransfers,
  net: (p) => p.netScore,
};

function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className="cursor-pointer select-none uppercase tracking-[0.06em] hover:text-body"
    >
      {label}
      {sort.col === col ? (sort.asc ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rank movement indicator (legacy .movement up/down/same)
// ---------------------------------------------------------------------------

function Movement({ movement, gw }: { movement: number | undefined; gw: number }) {
  if (movement === undefined) return null;
  if (movement !== 0) {
    const up = movement > 0;
    return (
      <span
        className={`ml-1 inline-flex items-center text-[0.65rem] font-semibold ${up ? 'text-positive' : 'text-negative'}`}
      >
        <span className="mr-0.5 text-[0.55rem]">{up ? '▲' : '▼'}</span>
        {Math.abs(movement)}
      </span>
    );
  }
  if (gw > 1) return <span className="ml-1 text-[0.65rem] text-faint">-</span>;
  return null;
}

// ---------------------------------------------------------------------------
// Rank-history chart — replaces the legacy Chart.js line chart with an inline
// SVG (reversed y axis: rank 1 at the top).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Profile modal (legacy openProfile/renderProfile)
// ---------------------------------------------------------------------------

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

function ProfileModal({
  manager,
  fallbackRank,
  onClose,
}: {
  manager: any;
  fallbackRank: number | string;
  onClose: () => void;
}) {
  const { data, loading, error } = useApi<any>(`/api/manager/${manager.entryId}/profile`);
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
    >
      {loading && <LoadingBlock label="Loading profile data…" />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {data && !data.error && records && (
        <>
          <div className="mb-5 grid grid-cols-3 gap-2">
            <StatBox value={`#${currentRank}`} label="League Rank" sub={`(best: #${records.bestRank || '-'})`} />
            <StatBox value={records.avgScore} label="Avg GW Score" />
            <StatBox value={data.motmWins} label="MotM Wins" highlight={data.motmWins > 0} />
          </div>

          <div className="mb-5">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">League Rank History</h3>
            <RankChart history={data.history} />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Season Records</h3>
              <StatsList
                items={[
                  {
                    label: 'Best GW',
                    value: (
                      <span className="text-accent">
                        {records.highestGW.points} pts <small>(GW{records.highestGW.gw})</small>
                      </span>
                    ),
                  },
                  {
                    label: 'Worst GW',
                    value: (
                      <span className="text-negative">
                        {records.lowestGW.points} pts <small>(GW{records.lowestGW.gw})</small>
                      </span>
                    ),
                  },
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
                  { label: 'Total Made', value: records.totalTransfers },
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function StandingsView({ viewGW }: { viewGW: number | null }) {
  const { data, loading, error } = useApi<any>(
    viewGW == null ? '/api/standings' : `/api/standings/history?gw=${viewGW}`,
  );
  const [sort, setSort] = useState<SortState>({ col: null, asc: true });
  const [profile, setProfile] = useState<any | null>(null);

  const standingsGW: number = data?.currentGW || 0;

  const rows = useMemo(() => {
    const standings: any[] = data?.standings || [];
    if (!sort.col) return standings;
    const key = SORT_KEYS[sort.col];
    return [...standings].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return sort.asc
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      }
      return sort.asc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [data, sort]);

  const onSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }));

  const setProfileParam = (entryId: number | null) => {
    const url = new URL(window.location.href);
    if (entryId != null) url.searchParams.set('profile', String(entryId));
    else url.searchParams.delete('profile');
    window.history.replaceState(null, '', url.toString());
  };

  const openProfile = (m: any) => {
    setProfile(m);
    setProfileParam(m.entryId);
  };
  const closeProfile = () => {
    setProfile(null);
    setProfileParam(null);
  };

  // Deep link: ?profile=<entryId> (legacy handleUrlParams)
  useEffect(() => {
    if (!data?.standings) return;
    const id = new URLSearchParams(window.location.search).get('profile');
    if (!id) return;
    const m = data.standings.find((s: any) => s.entryId === Number(id));
    if (m) setProfile(m);
  }, [data]);

  // Escape closes the modal (legacy keydown handler)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeProfile();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: Column<any>[] = [
    {
      key: 'rank',
      header: <SortHeader label="#" col="rank" sort={sort} onSort={onSort} />,
      render: (p) => (
        <span className={p.rank <= 3 ? `rank-${p.rank}` : ''}>
          {p.rank}
          <Movement movement={p.movement} gw={standingsGW} />
        </span>
      ),
    },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (p) => (
        <button type="button" onClick={() => openProfile(p)} className="cursor-pointer text-left">
          <ManagerCell name={p.name} team={p.team} refOverride={{ entryId: p.entryId }} />
          <span className="mt-1 inline-block rounded-full bg-positive-soft px-2 py-0.5 text-[0.6rem] font-semibold text-positive">
            £{p.teamValue}m
          </span>
        </button>
      ),
    },
    {
      key: 'gross',
      header: <SortHeader label="Gross" col="gross" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => p.grossScore,
    },
    {
      key: 'transfers',
      header: <SortHeader label="Trf" col="transfers" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => (
        <>
          {p.totalTransfers}
          {p.transferCost > 0 && <span className="text-negative"> (-{p.transferCost})</span>}
        </>
      ),
    },
    {
      key: 'net',
      header: <SortHeader label="Net" col="net" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => <Badge tone="positive">{p.netScore}</Badge>,
    },
  ];

  return (
    <div>
      <p className="mb-3 text-xs text-faint">
        {viewGW != null ? `Standings as of GW${viewGW}. ` : ''}Click any manager for profile stats.
      </p>
      {loading && <LoadingBlock label="Loading standings…" />}
      {error && <ErrorBlock message={error} />}
      {data && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.entryId}
          rowRef={(p) => ({ entryId: p.entryId, name: p.name })}
        />
      )}
      {profile && (
        <ProfileModal
          manager={profile}
          fallbackRank={data?.standings?.find((s: any) => s.entryId === profile.entryId)?.rank ?? '-'}
          onClose={closeProfile}
        />
      )}
    </div>
  );
}
