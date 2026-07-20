'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Chips tracker — port of legacy/chips.html.
 * Endpoint /api/chips → { leagueName, managers[], currentGW }.
 * Each manager: { name, team, entryId, chips: { firstHalf, secondHalf } }
 * where each half maps chipType → { status: used|expired|available|locked, gw? }.
 */
import { DataTable, ManagerCell, PageHeader, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';
import { useApi } from '@/hooks/useApi';

const CHIP_META: { key: string; label: string; icon: string }[] = [
  { key: 'wildcard', label: 'Wildcard', icon: '🃏' },
  { key: 'freehit', label: 'Free Hit', icon: '🎯' },
  { key: 'bboost', label: 'Bench Boost', icon: '💺' },
  { key: '3xc', label: 'Triple Captain', icon: '👑' },
];

function ChipCell({ chip }: { chip: any }) {
  const status = chip?.status ?? 'available';
  const cls =
    status === 'used'
      ? 'bg-negative-soft text-negative'
      : status === 'available'
        ? 'bg-positive-soft text-positive'
        : 'bg-raised text-faint';
  const label = status === 'used' ? `GW${chip.gw}` : status === 'available' ? 'Available' : status === 'expired' ? 'Expired' : 'Locked';
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${cls}`}>{label}</span>;
}

export default function ChipsPage() {
  const { data, loading, error } = useApi<any>('/api/chips');
  const managers: any[] = data?.managers ?? [];

  const columns: Column<any>[] = [
    { key: 'manager', header: 'Manager', render: (m) => <ManagerCell name={m.name} team={m.team} refOverride={{ entryId: m.entryId }} /> },
    ...(['firstHalf', 'secondHalf'] as const).flatMap((half) =>
      CHIP_META.map((c) => ({
        key: `${half}-${c.key}`,
        header: (
          <span title={`${c.label} (${half === 'firstHalf' ? '1st' : '2nd'} half)`}>
            {c.icon}
            <span className="ml-1 text-[0.6rem] text-faint">{half === 'firstHalf' ? '1' : '2'}</span>
          </span>
        ),
        align: 'center' as const,
        render: (m: any) => <ChipCell chip={m.chips?.[half]?.[c.key]} />,
      })),
    ),
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title={data?.leagueName ?? 'Chips'} subtitle="Chip usage across all managers (1 = first half, 2 = second half)" />
      {loading && <LoadingBlock label="Loading chips…" />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {managers.length > 0 && (
        <DataTable columns={columns} rows={managers} rowKey={(m) => m.entryId ?? m.name} rowRef={(m) => ({ entryId: m.entryId, name: m.name })} />
      )}
    </main>
  );
}
