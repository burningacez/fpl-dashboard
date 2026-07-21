'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Form table view — legacy week.html's Form view. Rankings over the last N
 * completed gameweeks via /api/form?weeks=N (&asof=GW when viewing a past GW).
 * The legacy "weeks wheel" is a stepper here: same 1..totalCompleted range.
 */
import { useMemo, useState } from 'react';
import { Badge, DataTable, ErrorBlock, LoadingBlock, ManagerCell, type Column } from '@/components/ui';
import { useApi } from '@/hooks/useApi';

type SortState = { col: string | null; asc: boolean };

const SORT_KEYS: Record<string, (p: any) => string | number> = {
  rank: (p) => p.rank,
  manager: (p) => String(p.name).toLowerCase(),
  gross: (p) => p.grossScore,
  transfers: (p) => p.transfers,
  cost: (p) => p.transferCost,
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

export function FormView({ asof }: { asof: number | null }) {
  const [weeks, setWeeks] = useState(5);
  const [sort, setSort] = useState<SortState>({ col: null, asc: true });
  const { data, loading, error } = useApi<any>(
    `/api/form?weeks=${weeks}${asof != null ? `&asof=${asof}` : ''}`,
  );

  const maxWeeks: number = asof ?? data?.totalCompleted ?? 38;
  const gwRange: number[] = data?.gwRange ?? [];

  const rows = useMemo(() => {
    const form: any[] = data?.form ?? [];
    if (!sort.col) return form;
    const key = SORT_KEYS[sort.col];
    return [...form].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      const cmp =
        typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : (av as number) - (bv as number);
      return sort.asc ? cmp : -cmp;
    });
  }, [data, sort]);

  const onSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }));

  const columns: Column<any>[] = [
    {
      key: 'rank',
      header: <SortHeader label="#" col="rank" sort={sort} onSort={onSort} />,
      render: (p) => <span className={p.rank <= 3 ? `rank-${p.rank}` : ''}>{p.rank}</span>,
    },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (p) => <ManagerCell name={p.name} team={p.team} refOverride={{ entryId: p.entryId, name: p.name }} />,
    },
    { key: 'gross', header: <SortHeader label="Gross" col="gross" sort={sort} onSort={onSort} />, align: 'center', render: (p) => p.grossScore },
    { key: 'transfers', header: <SortHeader label="Xfr" col="transfers" sort={sort} onSort={onSort} />, align: 'center', render: (p) => p.transfers },
    {
      key: 'cost',
      header: <SortHeader label="Cost" col="cost" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => (p.transferCost > 0 ? <span className="text-negative">-{p.transferCost}</span> : 0),
    },
    { key: 'net', header: <SortHeader label="Net" col="net" sort={sort} onSort={onSort} />, align: 'center', render: (p) => <Badge tone="positive">{p.netScore}</Badge> },
  ];

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm text-muted">Last</span>
        <div className="flex items-center rounded-lg border border-edge bg-surface">
          <button
            type="button"
            aria-label="Fewer weeks"
            disabled={weeks <= 1}
            onClick={() => setWeeks((w) => Math.max(1, w - 1))}
            className="px-2.5 py-1 text-muted hover:text-body disabled:opacity-30"
          >
            −
          </button>
          <span className="min-w-16 text-center text-sm font-bold">
            {weeks} GW{weeks === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            aria-label="More weeks"
            disabled={weeks >= maxWeeks}
            onClick={() => setWeeks((w) => Math.min(maxWeeks, w + 1))}
            className="px-2.5 py-1 text-muted hover:text-body disabled:opacity-30"
          >
            +
          </button>
        </div>
        {gwRange.length > 0 && (
          <span className="ml-auto text-xs text-faint">
            GW{gwRange[0]}–GW{gwRange[gwRange.length - 1]}
          </span>
        )}
      </div>
      {loading && <LoadingBlock label="Loading form data…" />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.entryId ?? p.name}
          rowRef={(p) => ({ entryId: p.entryId, name: p.name })}
        />
      )}
    </div>
  );
}
