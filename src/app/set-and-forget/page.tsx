'use client';

import React, { useMemo, useState } from 'react';
import {
  Card,
  type Column,
  DataTable,
  ErrorBlock,
  LoadingBlock,
  ManagerCell,
  PageHeader,
} from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';

/**
 * Set & Forget — port of legacy/set-and-forget.html.
 * What everyone would have scored keeping their GW1 team all season.
 */

type SortCol = 'safRank' | 'actualRank' | 'name' | 'safTotal' | 'actualTotal' | 'difference';

const SORT_KEYS: Record<SortCol, (m: any) => number | string> = {
  safRank: (m) => m.safRank,
  actualRank: (m) => m.actualRank,
  name: (m) => String(m.name).toLowerCase(),
  safTotal: (m) => m.safTotal,
  actualTotal: (m) => m.actualTotal,
  difference: (m) => m.difference,
};

function RankChangeBadge({ change }: { change: number }) {
  if (change > 0) {
    return (
      <span className="ml-1 inline-block rounded-md bg-positive-soft px-1.5 py-0.5 text-[0.7rem] font-semibold text-positive">
        +{change}
      </span>
    );
  }
  if (change < 0) {
    return (
      <span className="ml-1 inline-block rounded-md bg-negative-soft px-1.5 py-0.5 text-[0.7rem] font-semibold text-negative">
        {change}
      </span>
    );
  }
  return (
    <span className="ml-1 inline-block rounded-md bg-raised px-1.5 py-0.5 text-[0.7rem] font-semibold text-faint">
      =
    </span>
  );
}

export default function SetAndForgetPage() {
  const { data, loading, error } = useApi<any>('/api/set-and-forget');
  const { me } = useMyTeam();

  // Legacy default sort: safRank ascending; Diff defaults to descending.
  const [sort, setSort] = useState<{ col: SortCol; asc: boolean }>({ col: 'safRank', asc: true });

  const onSort = (col: SortCol) => {
    setSort((cur) =>
      cur.col === col ? { col, asc: !cur.asc } : { col, asc: col !== 'difference' },
    );
  };

  const sortedManagers = useMemo(() => {
    if (!data?.managers) return [];
    const key = SORT_KEYS[sort.col];
    return [...data.managers].sort((a, b) => {
      const aVal = key(a);
      const bVal = key(b);
      if (typeof aVal === 'string') {
        return sort.asc
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      }
      return sort.asc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [data, sort]);

  const sortHeader = (label: string, col: SortCol) => (
    <button
      type="button"
      onClick={() => onSort(col)}
      className="inline-flex cursor-pointer select-none items-center gap-1 uppercase tracking-[0.06em] hover:text-body"
    >
      {label}
      {sort.col === col && <span aria-hidden>{sort.asc ? '↑' : '↓'}</span>}
    </button>
  );

  const columns: Column<any>[] = [
    { key: 'safRank', header: sortHeader('S&F#', 'safRank'), align: 'center', render: (m) => m.safRank },
    {
      key: 'actualRank',
      header: sortHeader('Act#', 'actualRank'),
      align: 'center',
      render: (m) => (
        <span className="whitespace-nowrap">
          {m.actualRank}
          <RankChangeBadge change={m.actualRank - m.safRank} />
        </span>
      ),
    },
    {
      key: 'manager',
      header: sortHeader('Manager', 'name'),
      render: (m) => <ManagerCell name={m.name} team={m.team} refOverride={{ entryId: m.entryId, name: m.name }} />,
    },
    {
      key: 'safTotal',
      header: sortHeader('S&F Pts', 'safTotal'),
      align: 'center',
      render: (m) => <span className="font-bold">{m.safTotal}</span>,
    },
    {
      key: 'actualTotal',
      header: sortHeader('Actual', 'actualTotal'),
      align: 'center',
      render: (m) => <span className="font-bold">{m.actualTotal}</span>,
    },
    {
      key: 'difference',
      header: sortHeader('Diff', 'difference'),
      align: 'center',
      render: (m) => (
        <span
          className={`font-bold ${
            m.difference > 0 ? 'text-positive' : m.difference < 0 ? 'text-negative' : ''
          }`}
        >
          {m.difference > 0 ? '+' : ''}
          {m.difference}
        </span>
      ),
    },
  ];

  const worst = data?.worstTinkerer;
  // Legacy: only show "should have set and forgot" if someone actually lost points.
  const showWorstCard = Boolean(worst && worst.difference < 0);

  const hasData = Boolean(data && !data.error && data.managers && data.managers.length > 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title="Set & Forget" subtitle={data?.leagueName || 'Set and Forget'} />

      {loading && <LoadingBlock />}
      {error && <ErrorBlock message={error} />}
      {!loading && !error && data?.error && <ErrorBlock message={data.error} />}

      {!loading && !error && data && !data.error && !hasData && (
        <p className="py-10 text-center text-muted">
          No data available yet. Check back after GW1 is complete.
        </p>
      )}

      {hasData && (
        <>
          <Card className="mb-6 border-l-4 border-l-accent text-sm text-muted">
            Scores if everyone kept their GW1 team all season. Auto-subs applied.
          </Card>

          {showWorstCard && (
            <div className="mb-6 grid gap-4 sm:max-w-sm">
              <Card
                className="border-negative/40 bg-negative-soft text-center"
                highlightMe={isMyTeam(me, { entryId: worst.entryId, name: worst.name })}
              >
                <div className="text-xs font-bold uppercase tracking-wide text-muted">
                  Should Have Set &amp; Forgot
                </div>
                <div className="mt-1 text-lg font-bold">{worst.name}</div>
                <div className="text-2xl font-extrabold text-negative">{worst.difference}</div>
                <div className="mt-1 text-xs text-faint">Points lost from tinkering</div>
              </Card>
            </div>
          )}

          <DataTable
            columns={columns}
            rows={sortedManagers}
            rowKey={(m) => m.entryId}
            rowRef={(m) => ({ entryId: m.entryId, name: m.name })}
          />

          <p className="mt-4 text-center text-xs text-faint">
            Based on {data.completedGWs} completed gameweek{data.completedGWs !== 1 ? 's' : ''}
          </p>
        </>
      )}
    </main>
  );
}
