'use client';

/**
 * Player detail card for the planner, sized to fit a phone without scrolling.
 *
 * The whole card is one screen: identity in the modal title, twelve numbers in
 * a two-column ledger (what the player is worth right now on the left, what
 * he's returned this season on the right), the fixture strip, and a single row
 * of actions. Price gets an indicator rather than a section — direction and
 * how close the change is, not its history.
 *
 * Presentational — every action is supplied by the caller, so the planner can
 * offer transfer/substitute/captain while the pre-season builder offers
 * remove/swap, without this component knowing which mode it is in.
 */

import React from 'react';
import { Modal } from '@/components/ui';
import { ShirtImage } from '@/components/pitch/PitchView';
import { formatPrice, POSITION_NAMES } from '@/lib/squad-rules';
import {
  availability,
  priceChangeOutlook,
  upcomingFixtures,
  type PlannerData,
  type PlannerPlayerRow,
} from '@/lib/planner-data';

const FIXTURE_COUNT = 5;

/** Glyphs for the action row. Keyed by intent, not by caller. */
export type ActionIconName =
  | 'start'
  | 'bench'
  | 'captain'
  | 'vice'
  | 'transfer'
  | 'swap'
  | 'remove';

export interface PlayerAction {
  /** Full description — the tooltip, and what screen readers announce. */
  label: string;
  /** One or two words for the button itself, e.g. 'Bench'. */
  short: string;
  icon: ActionIconName;
  onClick: () => void;
  /** Present = the action is unavailable, and this says why. */
  disabled?: string;
  tone?: 'primary' | 'danger' | 'default';
  /** The state this action sets is already on (current captain, say). */
  active?: boolean;
}

export function PlayerDetailModal({
  player,
  data,
  fromGw,
  actions,
  onClose,
}: {
  player: PlannerPlayerRow;
  data: PlannerData;
  /** Gameweek the fixture strip starts from. */
  fromGw: number;
  actions: PlayerAction[];
  onClose: () => void;
}) {
  const team = data.teams.find((t) => t.id === player.team);
  const avail = availability(player);
  const outlook = priceChangeOutlook(player);
  const fixtures = upcomingFixtures(data, player.team, fromGw, FIXTURE_COUNT);

  const fullName = [player.first_name, player.second_name].filter(Boolean).join(' ');

  const rise = outlook.direction === 'rise';
  const moveTone = rise ? 'text-positive' : outlook.direction === 'fall' ? 'text-negative' : 'text-faint';

  const nowRows: LedgerRow[] = [
    {
      label: 'Price',
      value: (
        <>
          {formatPrice(player.now_cost)}
          {outlook.direction !== 'none' && (
            <span className={`ml-1 ${moveTone}`} aria-hidden>
              {rise ? '▲' : '▼'}
            </span>
          )}
        </>
      ),
    },
    {
      label: outlook.direction === 'none' ? 'Movement' : rise ? 'To a rise' : 'To a fall',
      value: outlook.direction === 'none' ? 'None yet' : `${outlook.progress.toFixed(0)}%`,
      tone: outlook.direction === 'none' ? 'text-faint' : moveTone,
    },
    { label: 'Net transfers', value: formatCompact(outlook.netTransfers) },
    { label: 'Form', value: player.form || '0.0' },
    { label: 'Pts / game', value: player.points_per_game || '0.0' },
    { label: 'Owned', value: `${player.selected_by_percent || '0'}%` },
  ];

  const seasonRows: LedgerRow[] = [
    { label: 'Points', value: String(player.total_points) },
    { label: 'Minutes', value: String(player.minutes) },
    { label: 'Starts', value: String(player.starts) },
    // Goals and assists say nothing about a keeper, so they give way to the
    // things that actually score him points.
    ...(player.element_type === 1
      ? [
          { label: 'Clean sheets', value: String(player.clean_sheets) },
          { label: 'Saves', value: String(player.saves) },
          { label: 'Bonus', value: String(player.bonus) },
        ]
      : [
          { label: 'Goals', value: String(player.goals_scored) },
          { label: 'Assists', value: String(player.assists) },
          player.element_type === 2
            ? { label: 'Clean sheets', value: String(player.clean_sheets) }
            : { label: 'xGI', value: player.expected_goal_involvements || '0.0' },
        ]),
  ];

  return (
    <Modal
      title={
        <span className="flex min-w-0 items-center gap-3">
          <ShirtImage
            teamCode={team?.code}
            positionId={player.element_type}
            className="h-9 w-9 shrink-0 object-contain"
          />
          <span className="min-w-0">
            <span className="block truncate">{fullName || player.web_name}</span>
            <span className="block truncate text-xs font-normal text-muted">
              {POSITION_NAMES[player.element_type]} · {team?.name ?? '—'}
            </span>
          </span>
        </span>
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {avail.text && (
          <p
            className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
              avail.tone === 'negative' ? 'bg-negative-soft text-negative' : 'bg-warning/10 text-warning'
            }`}
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            {avail.text}
          </p>
        )}

        <div className="grid grid-cols-2 gap-x-4">
          <LedgerColumn heading="Right now" rows={nowRows} />
          <LedgerColumn heading="This season" rows={seasonRows} />
        </div>

        <section>
          <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">Next fixtures</h3>
          <div className="flex gap-1.5">
            {fixtures.map(({ gw, fixtures: fx }) => (
              <div key={gw} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <span className="text-[0.6rem] font-semibold text-muted">GW{gw}</span>
                {fx.length === 0 ? (
                  <span className="w-full rounded border border-dashed border-edge px-1 py-1 text-center text-[0.6rem] font-bold text-faint">
                    —
                  </span>
                ) : (
                  fx.map((f, i) => (
                    <span
                      key={i}
                      className={`fdr-${f.fdr} w-full rounded px-1 py-1 text-center text-[0.6rem] font-bold leading-tight`}
                    >
                      {f.short}
                      <span className="block font-semibold opacity-80">{f.home ? '(H)' : '(A)'}</span>
                    </span>
                  ))
                )}
              </div>
            ))}
          </div>
        </section>

        {actions.length > 0 && (
          <div className="flex items-stretch gap-1.5">
            {actions.map((a) => (
              <ActionButton key={a.label} action={a} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// =============================================================================
// Ledger
// =============================================================================

interface LedgerRow {
  label: string;
  value: React.ReactNode;
  /** Text colour utility for the value, when it carries a signal. */
  tone?: string;
}

function LedgerColumn({ heading, rows }: { heading: string; rows: LedgerRow[] }) {
  return (
    <div>
      <h3 className="border-b border-edge-strong pb-1 text-[0.6rem] font-extrabold uppercase tracking-[0.1em] text-accent">
        {heading}
      </h3>
      <dl>
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-1.5 border-b border-edge py-1.5 last:border-0"
          >
            <dt className="truncate text-xs text-muted">{r.label}</dt>
            <dd className={`shrink-0 text-sm font-bold tabular-nums ${r.tone ?? ''}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// =============================================================================
// Action row
// =============================================================================

/**
 * One action as an equal-width button, matching the planner's chip picker: the
 * icon carries the meaning at a glance, the short label confirms it, and an
 * unavailable action keeps its reason on a second line rather than vanishing.
 *
 * Outline amber means "the move we'd suggest"; filled amber means "this state
 * is already on" — they have to stay distinguishable, since both are accent.
 */
function ActionButton({ action }: { action: PlayerAction }) {
  const disabled = !!action.disabled;
  const tone = disabled
    ? 'cursor-not-allowed border-edge text-faint'
    : action.active
      ? 'border-accent bg-accent text-accent-fg'
      : action.tone === 'danger'
        ? 'border-negative/40 text-negative hover:border-negative'
        : action.tone === 'primary'
          ? 'border-accent/50 text-accent hover:border-accent'
          : 'border-edge text-muted hover:border-accent hover:text-body';

  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={disabled}
      title={disabled ? `${action.label} — ${action.disabled}` : action.label}
      aria-label={action.label}
      aria-pressed={action.active ? true : undefined}
      className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[0.65rem] font-bold leading-tight ${tone}`}
    >
      <ActionIcon name={action.icon} />
      <span className="block w-full truncate">{action.short}</span>
      {disabled && <span className="block w-full truncate text-[0.5rem] font-semibold">{action.disabled}</span>}
    </button>
  );
}

/** Circled C and V mirror FPL's own armband marks; the rest are plain arrows. */
const ACTION_PATHS: Record<ActionIconName, React.ReactNode> = {
  start: (
    <>
      <path d="M12 20V9" />
      <path d="m7 13 5-5 5 5" />
      <path d="M4 4h16" />
    </>
  ),
  bench: (
    <>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  captain: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.2 9.2a4.2 4.2 0 1 0 0 5.6" />
    </>
  ),
  vice: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.6 8.6 3.4 7 3.4-7" />
    </>
  ),
  transfer: (
    <>
      <path d="M4 8h13" />
      <path d="m13 4 4 4-4 4" />
      <path d="M20 16H7" />
      <path d="m11 12-4 4 4 4" />
    </>
  ),
  swap: (
    <>
      <path d="M4 7h11" />
      <path d="m11 3 4 4-4 4" />
      <path d="M20 17H9" />
      <path d="m13 13-4 4 4 4" />
    </>
  ),
  remove: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 8.5l7 7" />
      <path d="M15.5 8.5l-7 7" />
    </>
  ),
};

function ActionIcon({ name }: { name: ActionIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-[1.05rem] w-[1.05rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ACTION_PATHS[name]}
    </svg>
  );
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * A transfer count short enough for a ledger row: 142318 → '+142k'. Zero reads
 * as a dash, since "+0" looks like a measurement when it means "nothing yet".
 */
function formatCompact(n: number): string {
  if (!n) return '—';
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return `${sign}${abs}`;
}
