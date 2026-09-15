'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { EmptyBlock, ErrorBlock, GameUpdatingBlock, LoadingBlock, Modal } from '@/components/ui';
import { PitchView } from './PitchView';
import { TinkeringImpact } from './TinkeringImpact';
import type { SeasonStatsMap } from './seasonStats';

/** Season points of all fifteen, at face value — no captain, no bench split. */
function squadSeasonPoints(players: any[] = [], seasonStats: SeasonStatsMap): number {
  return players.reduce((sum: number, p: any) => sum + (seasonStats[p.id]?.totalPoints ?? 0), 0);
}

/**
 * A manager's squad for one gameweek, as a pitch. Shared by /week (the
 * clicked manager's current squad) and /set-and-forget (the GW1 squad the
 * whole page is about), so both open the same screen from a table row.
 *
 * Reads /api/manager/{id}/picks, which only serves the live season — callers
 * gate the click on an archived season being selected.
 */
export function PitchModal({
  entry,
  gw,
  onClose,
  subtitle,
  showMoves = true,
  seasonStats,
}: {
  entry: { id: number; name: string };
  gw: number;
  onClose: () => void;
  /** Extra line under the manager name (e.g. which gameweek is on show). */
  subtitle?: string;
  /** The tinkering ledger is meaningless for a fixed GW1 squad. */
  showMoves?: boolean;
  /**
   * Season totals per player id. Set & Forget passes these so its frozen GW1
   * squad reports what those fifteen did all season, not what they did in the
   * one gameweek the picks were taken from.
   */
  seasonStats?: SeasonStatsMap;
}) {
  const [picks, setPicks] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [empty, setEmpty] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/manager/${entry.id}/picks?gw=${gw}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d.available === false) return setEmpty(d.reason ?? 'Not available yet.');
          // FPL's "game is being updated" window: hold the friendly state and
          // re-check until squads come back.
          if (d.updating) {
            setUpdating(true);
            retry = setTimeout(load, 60_000);
            return;
          }
          if (d.error) return setErr(d.error);
          setUpdating(false);
          setPicks(d);
        })
        .catch((e) => !cancelled && setErr(e.message));
    };
    load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [entry.id, gw]);

  return (
    <Modal
      title={
        subtitle ? (
          <span>
            {entry.name}
            <span className="block text-sm font-normal text-muted">{subtitle}</span>
          </span>
        ) : (
          entry.name
        )
      }
      onClose={onClose}
      wide
      anchor="modal-pitch"
    >
      {err && <ErrorBlock message={err} />}
      {updating && !picks && <GameUpdatingBlock />}
      {empty && <EmptyBlock message={empty} />}
      {!picks && !err && !empty && !updating && <LoadingBlock label="Loading squad…" />}
      {picks && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted">
            {seasonStats ? (
              /*
                The squad's raw season haul: every player's season points added
                up, captaincy and benching left out of it deliberately. Those
                are gameweek decisions and this squad never made another one —
                what the S&F table scores is on the /set-and-forget page beside
                the manager's name.
              */
              <span>
                Squad season points{' '}
                <strong className="text-body">{squadSeasonPoints(picks.players, seasonStats)}</strong>
              </span>
            ) : (
              /* Same formula as the week table's gwScore so the two never disagree */
              <span>
                GW points{' '}
                <strong className="text-body">
                  {(picks.calculatedPoints ?? picks.points) + (picks.totalProvisionalBonus || 0) - (picks.transfersCost || 0)}
                </strong>
                {(picks.transfersCost || 0) > 0 && <span className="text-negative"> (−{picks.transfersCost} hit)</span>}
              </span>
            )}
          </div>
          {!seasonStats && (picks.autoSubs ?? []).length > 0 && (
            <p className="mb-2 rounded-lg bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent">
              ⟳ Auto-sub: {picks.autoSubs.map((s: any) => `${s.in.name} for ${s.out.name}`).join(', ')}
            </p>
          )}
          <PitchView
            players={picks.players ?? []}
            pointsOnBench={picks.pointsOnBench}
            seasonStats={seasonStats}
          />
          {showMoves && <TinkeringImpact entryId={entry.id} gw={gw} />}
        </>
      )}
    </Modal>
  );
}
