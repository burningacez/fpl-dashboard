'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { useIsMe } from '@/components/providers';
import { type ManagerRef } from '@/lib/identity';

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
// Manager cell — name + team, tinted my-team cyan when it's the logged-in user.
// =============================================================================

export function ManagerCell({ name, team, refOverride }: { name: string; team?: string; refOverride?: ManagerRef }) {
  const isMe = useIsMe();
  const mine = isMe(refOverride ?? { name });
  return (
    <div>
      <span className={`font-bold ${mine ? 'my-team-name' : ''}`}>
        {name}
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
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Manager reference per row — drives the my-team highlight automatically. */
  rowRef?: (row: T) => ManagerRef | string | null;
  /** Extra classes per row (e.g. 'winner-row', 'loser-row'). */
  rowClass?: (row: T, index: number) => string;
  /** When set, the whole row becomes clickable. */
  onRowClick?: (row: T, index: number) => void;
}) {
  const isMe = useIsMe();
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
            const mine = rowRef ? isMe(rowRef(row)) : false;
            const extra = rowClass ? rowClass(row, i) : '';
            const clickable = onRowClick ? 'cursor-pointer' : '';
            return (
              <tr
                key={rowKey(row, i)}
                className={`${mine ? 'my-team-row' : ''} ${extra} ${clickable}`.trim()}
                onClick={onRowClick ? () => onRowClick(row, i) : undefined}
              >
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
  sub,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: 'accent' | 'positive' | 'negative' | 'me';
  /** Optional line under the value, for a delta or a qualifier. */
  sub?: React.ReactNode;
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
      {sub}
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

/**
 * Friendly empty state for "no data yet" situations (pre-season pages,
 * archived seasons missing a dataset) — neutral tone, not an error.
 */
export function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-6 text-center text-muted">{message}</div>
  );
}

// =============================================================================
// Sortable column header + two-line name — shared by the table pages
// (each used to carry an identical private copy).
// =============================================================================

export type SortState = { col: string | null; asc: boolean };

export function SortHeader({
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

/**
 * Render a name on two lines when it contains a space (split at the first
 * space) so multi-word names fill a reserved two-line slot instead of
 * wrapping awkwardly or truncating.
 */
export function renderTwoLineName(name: string): React.ReactNode {
  const i = name.indexOf(' ');
  if (i === -1) return name;
  return (
    <>
      {name.slice(0, i)}
      <br />
      {name.slice(i + 1)}
    </>
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
  anchor,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /** `data-tour` name for the modal box, so a walkthrough step can point at it. */
  anchor?: string;
}) {
  if (typeof document === 'undefined') return null;
  // Portal to <body> so a backdrop-filter/transform ancestor can't turn this
  // fixed overlay into a mis-positioned box (see IdentityModal).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      // A modal being open suppresses a first-visit walkthrough auto-starting
      // on top of it (e.g. arriving on a /week?entry= deep link).
      data-tour-blocks-autostart
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-tour={anchor}
        data-tour-scroll
        // The top padding belongs to the sticky header below, not to this box:
        // giving the header a negative top margin instead would leave it
        // overlapping the first line of content by exactly that margin.
        className={`max-h-[85vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-y-auto rounded-t-2xl border border-edge bg-surface px-5 pb-5 sm:rounded-2xl`}
      >
        {/*
          Sticky, and the heading is the only thing allowed to shrink: a long
          title (a full player name, say) then truncates inside its own column
          instead of widening the row and pushing the close button out of
          reach. Staying put while the body scrolls keeps ✕ on screen for the
          tall modals too.
        */}
        <div className="sticky top-0 z-10 -mx-5 mb-4 flex items-start justify-between gap-3 border-b border-edge bg-surface px-5 pb-3 pt-5">
          <h2 className="min-w-0 flex-1 text-lg font-extrabold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 shrink-0 rounded-md px-2 py-1 text-muted hover:bg-raised"
          >
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
  anchorPrefix,
}: {
  tabs: { id: string; label: React.ReactNode; badge?: React.ReactNode }[];
  active: string;
  onChange: (id: string) => void;
  /** When set, each tab gets `data-tour="<prefix>-<id>"` for walkthrough steps. */
  anchorPrefix?: string;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-lg border border-edge bg-surface p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          data-tour={anchorPrefix ? `${anchorPrefix}-${t.id}` : undefined}
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
