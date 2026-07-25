'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Personalised strip on the home page: the logged-in member's league rank,
 * season total, latest GW score and the next deadline. Renders nothing for
 * visitors, archived-season browsing, or before any scores exist — the home
 * page was previously the only page with zero identity awareness.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMyTeam, useSeason } from '@/components/providers';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 text-center">
      <div className="text-lg font-extrabold text-accent">{value}</div>
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

export function MyStrip() {
  const { me } = useMyTeam();
  const { season } = useSeason();
  const [week, setWeek] = useState<any>(null);

  const archived = season !== null;

  useEffect(() => {
    if (!me || archived) return;
    let cancelled = false;
    fetch('/api/week')
      .then((r) => r.json())
      .then((d) => !cancelled && !d.error && setWeek(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [me, archived]);

  if (!me || archived || !week) return null;

  const mine = (week.managers ?? []).find((m: any) => m.entryId === me.entryId);
  const deadline = week.nextGWInfo?.deadline ? new Date(week.nextGWInfo.deadline) : null;
  const deadlineLabel = deadline
    ? deadline.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  if (!mine && !deadlineLabel) return null;

  return (
    <Link
      href="/week"
      className="relative mx-auto mb-8 flex max-w-xl flex-wrap items-center justify-center gap-y-2 divide-x divide-edge rounded-xl border border-edge bg-surface px-2 py-3 transition-colors hover:border-accent"
    >
      <div className="px-3 text-center">
        <div className="text-sm font-bold my-team-name">{me.name}</div>
        <div className="text-[0.65rem] text-muted">{me.team}</div>
      </div>
      {mine && <Stat label="Rank" value={`#${mine.overallRank ?? mine.rank ?? '–'}`} />}
      {mine && <Stat label="Total" value={String(mine.overallPoints ?? '–')} />}
      {mine && week.currentGW != null && <Stat label={`GW${week.currentGW}`} value={String(mine.gwScore ?? '–')} />}
      {deadlineLabel && week.nextGWInfo?.gameweek && (
        <Stat label={`GW${week.nextGWInfo.gameweek} deadline`} value={deadlineLabel} />
      )}
    </Link>
  );
}
