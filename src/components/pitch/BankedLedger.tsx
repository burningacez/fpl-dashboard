'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { POSITION_NAMES } from '@/lib/squad-rules';
import {
  BANKED_LABELS,
  bankedSegments,
  type LedgerTotals,
  type PlayerLedger,
} from './ledger';

/**
 * The contribution bar: one stacked bar of started / armband / off the bench.
 *
 * Segments are separated by a 2px gap in the surface colour rather than a
 * border, so two adjacent colours never blend into a third at small sizes —
 * which is the size this mostly renders at, under a player's name on the pitch.
 */
export function BankedBar({
  row,
  className = '',
}: {
  row: { started: number; captain: number; offBench: number };
  className?: string;
}) {
  const segments = bankedSegments(row);
  if (segments.length === 0) return null;
  return (
    <span className={`flex gap-[2px] overflow-hidden rounded-full ${className}`} aria-hidden>
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`${segment.className} first:rounded-l-full last:rounded-r-full`}
          style={{ flexGrow: segment.value }}
        />
      ))}
    </span>
  );
}

/** A colour chip + label, so a category is never identified by colour alone. */
function LegendKey({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${className}`} aria-hidden />
      {label} <strong className="font-bold text-body">{value}</strong>
    </span>
  );
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

/**
 * What the squad banked, and what it left behind.
 *
 * The bar and the three keys under it are the whole argument of this screen:
 * the big number is not a sum of season totals, it is these three things. The
 * bench line sits below a rule because it is the one number here that is NOT
 * part of the total — it never entered the score.
 */
export function BankedSummary({ totals }: { totals: LedgerTotals }) {
  return (
    <div className="mb-4 rounded-xl border border-edge bg-raised p-3.5" data-tour="saf-banked-summary">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.06em] text-muted">
          Set &amp; Forget total
        </span>
        <span className="text-2xl font-extrabold tabular-nums">{totals.banked}</span>
      </div>

      <BankedBar row={totals} className="mb-2.5 h-2.5" />

      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5">
        <LegendKey className="bg-banked-started" label={BANKED_LABELS.started} value={`${totals.started}`} />
        <LegendKey className="bg-banked-captain" label={BANKED_LABELS.captain} value={signed(totals.captain)} />
        <LegendKey className="bg-banked-bench" label={BANKED_LABELS.offBench} value={signed(totals.offBench)} />
      </div>

      {totals.wasted > 0 && (
        <div className="mt-3 flex items-center gap-2 border-t border-edge pt-2.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-negative" aria-hidden />
          <span className="text-xs text-muted">Scored on the bench, never banked</span>
          <strong className="ml-auto text-sm font-extrabold text-negative tabular-nums">{totals.wasted}</strong>
        </div>
      )}
    </div>
  );
}

const CELL = 'px-1 py-2 text-right tabular-nums';

/**
 * The receipt: every player, what they banked, and where it came from.
 *
 * Sortable because the question people actually arrive with is a superlative —
 * who carried this squad, who did the armband pay off on, how much did the
 * bench cost me — and each of those is one column sorted descending. The footer
 * adds up to the S&F total in the table behind the modal, which is the point:
 * the ledger explains that number rather than offering a second opinion on it.
 */
export function LedgerTable({
  ledger,
  totals,
  players,
  onSelectPlayer,
}: {
  ledger: PlayerLedger[];
  totals: LedgerTotals;
  /** Pitch players, for names and positions — the ledger carries only ids. */
  players: any[];
  /**
   * Opens a player, exactly as tapping their shirt on the pitch does. A row IS
   * the player, so it behaves like one; the panel it opens is the same
   * component, from the same state, so the two views can never drift.
   */
  onSelectPlayer?: (player: any) => void;
}) {
  type SortCol = 'banked' | 'captain' | 'offBench' | 'wasted';
  const [sort, setSort] = useState<SortCol>('banked');

  const meta = Object.fromEntries(players.map((p) => [p.id, p]));
  const rows = [...ledger].sort((a, b) => b[sort] - a[sort]);

  const header = (label: string, col: SortCol, dotClass?: string) => (
    <th className={`${CELL} whitespace-nowrap`} aria-sort={sort === col ? 'descending' : 'none'}>
      <button
        type="button"
        onClick={() => setSort(col)}
        className={`inline-flex cursor-pointer items-center gap-1 uppercase tracking-[0.06em] ${
          sort === col ? 'text-body' : 'hover:text-body'
        }`}
      >
        {dotClass && <span className={`h-1.5 w-1.5 rounded-sm ${dotClass}`} aria-hidden />}
        {label}
        {sort === col && <span aria-hidden>↓</span>}
      </button>
    </th>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-raised" data-tour="saf-ledger">
      <table className="data-table">
        <thead>
          <tr>
            <th className="px-3 py-2 text-left">Player</th>
            {header('Banked', 'banked')}
            {header('C', 'captain', 'bg-banked-captain')}
            {header('Bench', 'offBench', 'bg-banked-bench')}
            {header('Lost', 'wasted')}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const player = meta[row.id];
            const position = player?.position ?? POSITION_NAMES[player?.positionId] ?? '';
            // What this player's season was made of, in the words the columns
            // can't carry: weeks in the XI, weeks coming on, weeks watching.
            const weeks = [
              row.weeksStarted > 0 && `${row.weeksStarted} start${row.weeksStarted === 1 ? '' : 's'}`,
              row.weeksSubbedOn > 0 && `${row.weeksSubbedOn} on`,
              row.weeksStarted === 0 && row.weeksSubbedOn === 0 && 'never played',
            ].filter(Boolean);

            return (
              <tr
                key={row.id}
                onClick={player && onSelectPlayer ? () => onSelectPlayer(player) : undefined}
                className={player && onSelectPlayer ? 'cursor-pointer' : undefined}
              >
                <td className="px-3 py-2">
                  <span className="font-semibold">{player?.name ?? `#${row.id}`}</span>
                  <span className="block text-[0.65rem] text-faint">
                    {[position, ...weeks].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className={`${CELL} font-extrabold`}>{row.banked}</td>
                <td className={CELL}>
                  {row.captain > 0 ? (
                    <span className="font-bold text-banked-captain">{signed(row.captain)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className={CELL}>
                  {row.offBench > 0 ? (
                    <span className="font-bold text-banked-bench">{signed(row.offBench)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className={CELL}>
                  {row.wasted > 0 ? (
                    <span className="font-bold text-negative">{row.wasted}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-edge/60">
            <td className="px-3 py-2 text-[0.7rem] font-extrabold uppercase tracking-[0.04em] text-muted">
              Total
            </td>
            <td className={`${CELL} text-[0.95rem] font-extrabold`}>{totals.banked}</td>
            <td className={`${CELL} font-extrabold text-banked-captain`}>{signed(totals.captain)}</td>
            <td className={`${CELL} font-extrabold text-banked-bench`}>{signed(totals.offBench)}</td>
            <td className={`${CELL} font-extrabold text-negative`}>{totals.wasted}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
