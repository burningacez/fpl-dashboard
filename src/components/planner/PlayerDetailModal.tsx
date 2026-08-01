'use client';

/**
 * Player detail card for the planner, following the shape of FPL's own: a
 * header identifying the player, a row of headline stats with their rank among
 * players in the same position, then price outlook, season returns and the
 * upcoming fixtures.
 *
 * Presentational — every action is supplied by the caller, so the planner can
 * offer transfer/substitute/captain while the pre-season builder offers
 * remove/swap, without this component knowing which mode it is in.
 */

import { Modal } from '@/components/ui';
import { ShirtImage } from '@/components/pitch/PitchView';
import { formatPrice, POSITION_NAMES } from '@/lib/squad-rules';
import {
  availability,
  num,
  positionRank,
  priceChangeOutlook,
  upcomingFixtures,
  type PlannerData,
  type PlannerPlayerRow,
  type StatRank,
} from '@/lib/planner-data';

const FIXTURE_COUNT = 5;

export interface PlayerAction {
  label: string;
  onClick: () => void;
  /** Present = the action is unavailable, and this says why. */
  disabled?: string;
  tone?: 'primary' | 'danger' | 'default';
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

  const priceRank = positionRank(data.players, player, (p) => p.now_cost);
  const formRank = positionRank(data.players, player, (p) => num(p.form));
  const ppgRank = positionRank(data.players, player, (p) => num(p.points_per_game));
  const ownedRank = positionRank(data.players, player, (p) => num(p.selected_by_percent));

  const fullName = [player.first_name, player.second_name].filter(Boolean).join(' ');

  return (
    <Modal title={player.web_name} onClose={onClose}>
      {/* Identity */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-edge bg-raised p-3">
        <ShirtImage teamCode={team?.code} positionId={player.element_type} className="h-14 w-14 shrink-0 object-contain" />
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-wide text-muted">
            {POSITION_NAMES[player.element_type]}
          </div>
          <div className="truncate text-lg font-extrabold leading-tight">{fullName || player.web_name}</div>
          <div className="truncate text-sm text-muted">{team?.name ?? '—'}</div>
        </div>
      </div>

      {avail.text && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm font-semibold ${
            avail.tone === 'negative'
              ? 'border-negative/40 bg-negative-soft text-negative'
              : 'border-warning/40 bg-warning/10 text-warning'
          }`}
        >
          {avail.text}
        </div>
      )}

      {/* Headline stats, each with its rank among players in this position */}
      <div className="mb-4 grid grid-cols-4 divide-x divide-edge rounded-xl border border-edge bg-surface py-3">
        <RankedStat label="Price" value={formatPrice(player.now_cost)} rank={priceRank} />
        <RankedStat label="Form" value={player.form || '0.0'} rank={formRank} ranked={num(player.form) > 0} />
        <RankedStat
          label="Pts / match"
          value={player.points_per_game || '0.0'}
          rank={ppgRank}
          ranked={num(player.points_per_game) > 0}
        />
        <RankedStat
          label="Owned"
          value={`${player.selected_by_percent || '0'}%`}
          rank={ownedRank}
          ranked={num(player.selected_by_percent) > 0}
        />
      </div>

      {/* Price outlook */}
      <section className="mb-4 rounded-xl border border-edge bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Price change</h3>
          <span
            className={`text-sm font-bold ${
              outlook.direction === 'rise'
                ? 'text-positive'
                : outlook.direction === 'fall'
                  ? 'text-negative'
                  : 'text-muted'
            }`}
          >
            {outlook.direction === 'rise' ? '▲ ' : outlook.direction === 'fall' ? '▼ ' : ''}
            {outlook.label}
          </span>
        </div>

        {outlook.direction === 'none' ? (
          <p className="text-xs text-muted">
            Prices move once managers start transferring players in and out. Nothing to report yet.
          </p>
        ) : (
          <>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
              <div
                className={`h-full rounded-full ${outlook.direction === 'rise' ? 'bg-positive' : 'bg-negative'}`}
                style={{ width: `${Math.min(100, outlook.progress)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {outlook.progress.toFixed(0)}% of the way to a{' '}
              {outlook.direction === 'rise' ? 'rise' : 'fall'}
              {outlook.imminent ? ' — expected at 00:00 UK' : ''}.
            </p>
          </>
        )}

        <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          <MiniStat label="Net transfers" value={formatSigned(outlook.netTransfers)} />
          <MiniStat label="This GW" value={formatPriceDelta(player.cost_change_event)} />
          <MiniStat label="Since start" value={formatPriceDelta(player.cost_change_start)} />
        </dl>
      </section>

      {/* Season returns */}
      <section className="mb-4">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">This season</h3>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <MiniStat label="Points" value={String(player.total_points)} />
          <MiniStat label="Minutes" value={String(player.minutes)} />
          <MiniStat label="Starts" value={String(player.starts)} />
          <MiniStat label="Goals" value={String(player.goals_scored)} />
          <MiniStat label="Assists" value={String(player.assists)} />
          {player.element_type <= 2 ? (
            <MiniStat label="Clean sheets" value={String(player.clean_sheets)} />
          ) : (
            <MiniStat label="xGI" value={player.expected_goal_involvements || '0.0'} />
          )}
          <MiniStat label="Bonus" value={String(player.bonus)} />
          {player.element_type === 1 ? (
            <MiniStat label="Saves" value={String(player.saves)} />
          ) : (
            <MiniStat label="ICT" value={player.ict_index || '0.0'} />
          )}
        </div>
      </section>

      {/* Fixtures */}
      <section className="mb-4">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Next fixtures</h3>
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

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.onClick}
            disabled={!!a.disabled}
            title={a.disabled}
            className={`rounded-md px-3 py-2 text-left font-semibold ${
              a.disabled
                ? 'cursor-not-allowed border border-edge text-faint'
                : a.tone === 'danger'
                  ? 'bg-negative-soft text-negative'
                  : a.tone === 'primary'
                    ? 'bg-accent text-accent-fg'
                    : 'bg-raised text-body'
            }`}
          >
            {a.label}
            {a.disabled && <span className="ml-2 text-xs font-normal">({a.disabled})</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * A headline stat with its standing among players in the same position.
 *
 * `ranked` suppresses the standing when the stat is zero. Ties share the best
 * rank, so before a ball is kicked every player is "1 of 40" on form — a
 * ranking that reads as best-in-position when it means nothing at all.
 */
function RankedStat({
  label,
  value,
  rank,
  ranked = true,
}: {
  label: string;
  value: string;
  rank: StatRank;
  ranked?: boolean;
}) {
  return (
    <div className="px-1 text-center">
      <div className="text-[0.65rem] font-semibold text-muted">{label}</div>
      <div className="text-base font-extrabold leading-tight">{value}</div>
      <div className="text-[0.6rem] text-faint">{ranked ? `${rank.rank} of ${rank.total}` : '—'}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-center">
      <div className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm font-bold tabular-nums">{value}</div>
    </div>
  );
}

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toLocaleString('en-GB')}`;
}

/** A price delta in tenths of £m, e.g. -3 → '−£0.3m', 0 → '—'. */
function formatPriceDelta(tenths: number): string {
  if (!tenths) return '—';
  return `${tenths > 0 ? '+' : '−'}£${(Math.abs(tenths) / 10).toFixed(1)}m`;
}
