'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { useMyTeam } from '@/components/providers';
import { isMyTeam, type ManagerRef } from '@/lib/identity';

export { WheelStepper, type WheelStepperProps } from './WheelStepper';

// =============================================================================
// Card
// =============================================================================

export function Card({
  children,
  className = '',
  highlightMe = false,
}: {
  children: React.ReactNode;
  className?: string;
  highlightMe?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-edge bg-surface p-4 ${highlightMe ? 'my-team-card' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
    </div>
  );
}

// =============================================================================
// Badges
// =============================================================================

export function YouBadge() {
  return (
    <span className="ml-2 inline-block rounded-full bg-me px-1.5 py-0.5 align-middle text-[0.6rem] font-extrabold tracking-wide text-base">
      YOU
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'negative' | 'accent' | 'me';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-raised text-muted',
    positive: 'bg-positive-soft text-positive',
    negative: 'bg-negative-soft text-negative',
    accent: 'bg-accent-soft text-accent',
    me: 'bg-me-soft text-me',
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${tones[tone]}`}>{children}</span>
  );
}

// =============================================================================
// Manager cell — name + team, with YOU badge when it's the logged-in user.
// =============================================================================

export function ManagerCell({ name, team, refOverride }: { name: string; team?: string; refOverride?: ManagerRef }) {
  const { me } = useMyTeam();
  const mine = isMyTeam(me, refOverride ?? { name });
  return (
    <div>
      <span className={`font-bold ${mine ? 'my-team-name' : ''}`}>
        {name}
        {mine && <YouBadge />}
      </span>
      {team && <div className="text-xs text-muted">{team}</div>}
    </div>
  );
}

// =============================================================================
// DataTable
// =============================================================================

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  render: (row: T, index: number) => React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowRef,
  rowClass,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Manager reference per row — drives the my-team highlight automatically. */
  rowRef?: (row: T) => ManagerRef | string | null;
  /** Extra classes per row (e.g. 'winner-row', 'loser-row'). */
  rowClass?: (row: T, index: number) => string;
}) {
  const { me } = useMyTeam();
  const alignCls = { left: 'text-left', right: 'text-right', center: 'text-center' };
  return (
    <div className="overflow-x-auto rounded-xl border border-edge">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={alignCls[c.align ?? 'left']}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const mine = rowRef ? isMyTeam(me, rowRef(row)) : false;
            const extra = rowClass ? rowClass(row, i) : '';
            return (
              <tr key={rowKey(row, i)} className={`${mine ? 'my-team-row' : ''} ${extra}`.trim()}>
                {columns.map((c) => (
                  <td key={c.key} className={alignCls[c.align ?? 'left']}>
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// StatTile
// =============================================================================

export function StatTile({
  label,
  value,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: 'accent' | 'positive' | 'negative' | 'me';
}) {
  const toneCls =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'negative'
        ? 'text-negative'
        : tone === 'me'
          ? 'text-me'
          : 'text-accent';
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <div className="text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 text-xl font-extrabold ${toneCls}`}>{value}</div>
    </div>
  );
}

// =============================================================================
// Loading / error states
// =============================================================================

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-raised ${className}`} />;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col gap-3 py-8">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-40 w-full" />
      <p className="text-center text-sm text-muted">{label}</p>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-negative/40 bg-negative-soft p-4 text-negative">
      Failed to load: {message}
    </div>
  );
}

// =============================================================================
// Modal
// =============================================================================

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (typeof document === 'undefined') return null;
  // Portal to <body> so a backdrop-filter/transform ancestor can't turn this
  // fixed overlay into a mis-positioned box (see IdentityModal).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`max-h-[85vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-y-auto rounded-t-2xl border border-edge bg-surface p-5 sm:rounded-2xl`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-extrabold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-muted hover:bg-raised">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// =============================================================================
// Tabs
// =============================================================================

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: React.ReactNode; badge?: React.ReactNode }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-lg border border-edge bg-surface p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-bold transition-colors ${
            active === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-raised hover:text-body'
          }`}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}
