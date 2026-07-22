'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMyTeam, useIsMe, useSeason } from '@/components/providers';
import { PageHeader, DataTable, Modal, LoadingBlock, ErrorBlock, Tabs, WheelStepper, type Column } from '@/components/ui';
import { PitchView } from '@/components/pitch/PitchView';
import { FixtureStrip, MatchModal } from '@/components/match/MatchModal';
import { ProfileModal } from '@/components/views/StandingsView';
import { FormView } from '@/components/views/FormView';

const TOTAL_GWS = 38;

/**
 * Live gameweek page. Fetches /api/week for the initial paint, then subscribes
 * to /api/live/events (SSE) for live score/ticker updates:
 *  - `sync`       → full week payload (replaces state)
 *  - `new-events` → chronological ticker events to prepend
 *  - `status`     → live/idle flag
 * Tapping a manager opens their pitch via /api/manager/{id}/picks.
 */
export default function WeekPage() {
  const { me } = useMyTeam();
  const isMe = useIsMe();
  // Archived seasons render read-only from the snapshot: no SSE/ticker, no
  // form tab, no pitch/profile modals (those endpoints are live-only).
  const { season, withSeason } = useSeason();
  const archived = season !== null;
  const [week, setWeek] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticker, setTicker] = useState<any[]>([]);
  const [live, setLive] = useState(false);
  const [openEntry, setOpenEntry] = useState<{ id: number; name: string } | null>(null);
  const [openProfile, setOpenProfile] = useState<any | null>(null);
  const [openFixture, setOpenFixture] = useState<any>(null);
  const [sort, setSort] = useState<SortState>({ col: 'overallRank', asc: true });
  const [view, setView] = useState<'scores' | 'form'>('scores');
  const [highlight, setHighlight] = useState<HighlightState>(NO_HIGHLIGHT);
  const [hlOpen, setHlOpen] = useState(false);
  // Ticker event selected for the "who did this hit" table highlight. Keyed by a
  // stable event identity (not array index) so live prepends don't shift it.
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [gwPickerOpen, setGwPickerOpen] = useState(false);
  const [viewGW, setViewGW] = useState<number | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // For archives, currentGW is the snapshot's final gameweek.
  const currentGW: number | null = week?.currentGW ?? null;
  const viewingCurrent = viewGW == null || viewGW === currentGW;
  const viewingLive = viewingCurrent && !archived;

  const ingest = useCallback((data: any) => {
    if (!data) return;
    setWeek(data);
    setLive(Boolean(data.isLive));
    if (Array.isArray(data.chronologicalEvents)) {
      setTicker([...data.chronologicalEvents].reverse());
    } else if (Array.isArray(data.changeEvents)) {
      setTicker(data.changeEvents);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Season switch: drop everything from the previous season before refetching.
    setWeek(null);
    setError(null);
    setViewGW(null);
    setHistory(null);
    setTicker([]);
    fetch(withSeason('/api/week'))
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        ingest(d);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [ingest, withSeason]);

  // SSE subscription (mounted only on this page to respect the 50-client cap).
  // Archived seasons are static — no live events to subscribe to.
  useEffect(() => {
    if (archived) return;
    const es = new EventSource('/api/live/events');
    esRef.current = es;
    es.addEventListener('sync', (e: MessageEvent) => {
      try {
        ingest(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('new-events', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const events = payload.events ?? [];
        if (events.length) setTicker((prev) => [...[...events].reverse(), ...prev].slice(0, 100));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('status', (e: MessageEvent) => {
      try {
        setLive(Boolean(JSON.parse(e.data).isLive));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('data-update', () => {
      // A background refresh finished — pull the fresh week payload.
      fetch('/api/week')
        .then((r) => r.json())
        .then((d) => !d.error && ingest(d))
        .catch(() => {});
    });
    return () => es.close();
  }, [ingest, archived]);

  // View toggle (legacy switchView): ?view=form deep link.
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'form') setView(v);
  }, []);
  const switchView = (v: string) => {
    setView(v as 'scores' | 'form');
    const url = new URL(window.location.href);
    if (v === 'scores') url.searchParams.delete('view');
    else url.searchParams.set('view', v);
    window.history.replaceState(null, '', url.toString());
  };

  // Deep links from other pages (legacy checkInitialView): /week?entry=X&gw=Y
  // opens that manager's pitch, optionally for a past gameweek.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!week || deepLinked.current) return;
    deepLinked.current = true;
    const params = new URLSearchParams(window.location.search);
    const entry = Number(params.get('entry'));
    if (!entry) return;
    const gw = Number(params.get('gw'));
    if (gw && week.currentGW && gw !== week.currentGW) setViewGW(gw);
    const m = (week.managers ?? []).find((x: any) => x.entryId === entry);
    setOpenEntry({ id: entry, name: m?.name ?? '' });
  }, [week]);

  // Fetch historical GW data when navigating to a past gameweek.
  useEffect(() => {
    if (viewGW == null || viewGW === currentGW) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    fetch(withSeason(`/api/week/history?gw=${viewGW}`))
      .then((r) => r.json())
      .then((d) => !cancelled && setHistory(d))
      .catch(() => !cancelled && setHistory({ error: 'Could not load that gameweek' }))
      .finally(() => !cancelled && setHistoryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [viewGW, currentGW, withSeason]);

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Scores" />
        <ErrorBlock message={error} />
      </main>
    );
  }
  if (!week) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Scores" />
        <LoadingBlock label="Loading gameweek…" />
      </main>
    );
  }

  const shownGW = viewGW ?? currentGW ?? week.currentGW;
  // Live and past-GW payloads share the same shape (managers, squadPlayers,
  // plTeams, fixtures) so the whole view — table columns, match row and the
  // highlight feature — renders identically whichever gameweek is selected.
  // For an archived season the base payload is the snapshot's final GW.
  const source: any = viewingCurrent ? week : (history ?? {});
  const unsorted: any[] = source.managers ?? [];
  const squadPlayers = source.squadPlayers ?? {};

  // Player IDs owned by the logged-in user this GW — used to tint their
  // players teal in the match modal.
  const myManager = me
    ? (source.managers ?? []).find((m: any) => m.entryId === me.entryId)
    : null;
  const myPlayerIds: Set<number> | undefined = myManager
    ? new Set<number>([...(myManager.starting11 ?? []), ...(myManager.benchPlayerIds ?? [])])
    : undefined;
  // The ticker event whose manager-impact is currently pinned to the table.
  // Only meaningful on the live view (past gameweeks have no live ticker).
  const selEvent = viewingLive && selectedEventKey != null ? ticker.find((ev) => eventKey(ev) === selectedEventKey) ?? null : null;
  const key = SORT_KEYS[sort.col] ?? SORT_KEYS.overallRank;
  const managers = [...unsorted].sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    const cmp = typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
    return sort.asc ? cmp : -cmp;
  });
  const onSort = (col: string) => setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }));

  const columns: Column<any>[] = [
    { key: 'overallRank', header: <SortHeader label="#" col="overallRank" sort={sort} onSort={onSort} />, render: (m) => m.overallRank ?? m.rank },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (m) => {
        const cell = (
          <>
            <span className={`font-bold ${isMe({ entryId: m.entryId, name: m.name }) ? 'my-team-name' : ''}`}>
              {m.name}
            </span>
            <div className="text-xs text-muted">{m.team}</div>
            <ManagerPills
              manager={m}
              defCount={highlight.type === 'defense' ? highlightResult(m, highlight, squadPlayers).defCount : 0}
            />
          </>
        );
        // Profile modal fetches live endpoints — plain text on archived seasons.
        if (archived) return <div className="text-left">{cell}</div>;
        return (
          <button
            className="text-left"
            onClick={(e) => {
              e.stopPropagation();
              setOpenProfile(m);
            }}
          >
            {cell}
          </button>
        );
      },
    },
    {
      key: 'gwScore',
      header: <SortHeader label="GW" col="gwScore" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (m) => {
        const impact = selEvent ? eventImpact(m, selEvent) : null;
        return (
          <span>
            <strong>{m.gwScore}</strong>
            {m.transferCost > 0 && <span className="text-negative"> (-{m.transferCost})</span>}
            {impact != null && impact !== 0 && <ImpactBadge value={impact} />}
          </span>
        );
      },
    },
    {
      key: 'captain',
      header: <SortHeader label="Captain" col="captain" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (m) => (
        <span className="text-sm text-muted">
          {m.captainName ?? '–'}
          {m.viceCaptainName && <span className="block text-[0.65rem] text-faint">{m.viceCaptainName}</span>}
        </span>
      ),
    },
    { key: 'bench', header: <SortHeader label="Bench" col="bench" sort={sort} onSort={onSort} />, align: 'center', render: (m) => <span className="text-muted">{m.benchPoints ?? '–'}</span> },
    { key: 'overall', header: <SortHeader label="Total" col="overall" sort={sort} onSort={onSort} />, align: 'center', render: (m) => m.overallPoints ?? '–' },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <WheelStepper
              value={shownGW}
              min={archived ? (week.availableGWs?.[0] ?? 1) : 1}
              max={archived ? (currentGW ?? TOTAL_GWS) : TOTAL_GWS}
              isDisabled={(v) =>
                (currentGW != null && v > currentGW) ||
                (archived && Array.isArray(week.availableGWs) && !week.availableGWs.includes(v))
              }
              onChange={(gw) => setViewGW(currentGW != null && gw === currentGW ? null : gw)}
              formatLabel={(v) => `GW${v}`}
              formatItem={(v) => (
                <>
                  <span>GW{v}</span>
                  {v === currentGW && !archived && (
                    <span className="rounded-full bg-negative-soft px-1 py-px text-[0.55rem] text-negative">
                      NOW
                    </span>
                  )}
                  {v === TOTAL_GWS && (
                    <span className="text-[0.6rem] font-normal text-faint">(final)</span>
                  )}
                </>
              )}
              ariaLabel="Pick a gameweek"
              open={gwPickerOpen}
              onOpenChange={setGwPickerOpen}
            />
            {viewingLive && live && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-negative-soft px-2 py-0.5 text-sm text-negative">
                <span className="h-2 w-2 animate-pulse rounded-full bg-negative" /> LIVE
              </span>
            )}
            {shownGW === TOTAL_GWS && <span className="text-sm font-normal text-muted">(final)</span>}
          </span>
        }
        subtitle={week.leagueName}
      />

      {/* Form is computed live-only, so the tab disappears for archived seasons. */}
      {!archived && (
        <div className="mb-4 max-w-fit">
          <Tabs
            tabs={[
              { id: 'scores', label: 'Standings' },
              { id: 'form', label: 'Form' },
            ]}
            active={view}
            onChange={switchView}
          />
        </div>
      )}

      {!archived && view === 'form' && <FormView asof={viewingLive ? null : shownGW} />}

      {(archived || view === 'scores') && (
      <>
      {/* Highlight and match row work for any gameweek; the live ticker only
          appears on the live GW (past weeks have no live events). */}
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setHlOpen(true)}
          className={`rounded-full border px-3 py-1 text-xs font-bold ${
            highlight.type ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-muted hover:text-body'
          }`}
        >
          ★ {highlightLabel(highlight, source)}
        </button>
      </div>
      {viewingLive && (
        <LiveTicker
          events={ticker}
          live={live}
          myManager={myManager}
          selectedKey={selectedEventKey}
          onSelect={(k) => setSelectedEventKey((cur) => (cur === k ? null : k))}
        />
      )}
      <FixtureStrip fixtures={source.fixtures ?? []} onOpen={setOpenFixture} />

      {historyLoading && <LoadingBlock label={`Loading GW${shownGW}…`} />}
      {!viewingCurrent && history?.error && <ErrorBlock message={history.error} />}

      <DataTable
        columns={columns}
        rows={managers}
        rowKey={(m) => m.entryId}
        rowRef={(m) => ({ entryId: m.entryId, name: m.name })}
        onRowClick={archived ? undefined : (m) => setOpenEntry({ id: m.entryId, name: m.name })}
        rowClass={(m) => {
          // A pinned ticker event wins over the star-highlight mode: matching
          // managers stay lit, everyone else dims.
          if (selEvent) return eventImpact(m, selEvent) != null ? 'hl-match' : 'hl-dimmed';
          if (highlight.type) {
            return highlightResult(m, highlight, squadPlayers).match ? 'hl-match' : 'hl-dimmed';
          }
          return '';
        }}
      />
      </>
      )}

      {openEntry && <PitchModal entry={openEntry} gw={shownGW} onClose={() => setOpenEntry(null)} />}
      {openProfile && (
        <ProfileModal
          manager={openProfile}
          fallbackRank={openProfile.rank ?? openProfile.gwRank ?? '-'}
          onClose={() => setOpenProfile(null)}
        />
      )}
      {openFixture && <MatchModal fixture={openFixture} myPlayerIds={myPlayerIds} onClose={() => setOpenFixture(null)} />}
      {hlOpen && (
        <HighlightModal
          week={source}
          highlight={highlight}
          onChange={setHighlight}
          onClose={() => setHlOpen(false)}
        />
      )}
    </main>
  );
}

function chipLabel(chip: string): string {
  return { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' }[chip] ?? chip;
}

// =============================================================================
// Live ticker (legacy horizontal event ticker). Events scroll across the screen
// like a stock ticker; tapping one highlights the managers it impacted and pins
// a ▲/▼ points badge to their GW score. Each event also carries a subtle teal
// marker when it touched the logged-in manager's team — no click needed.
// =============================================================================

// Stable identity for a ticker event so a live prepend doesn't shift the
// selection (array indices are not stable; event contents are).
function eventKey(ev: any): string {
  return `${ev.timestamp ?? ''}|${ev.type}|${ev.elementId ?? ev.team ?? ''}|${ev.match ?? ''}|${ev.points ?? ''}`;
}

// Is a player in the manager's active scoring squad — starting 11, or the bench
// too when Bench Boost is active (legacy isInActiveSquad).
function isInActiveSquad(m: any, playerId: number): boolean {
  if ((m.starting11 ?? []).includes(playerId)) return true;
  if (m.activeChip === 'bboost' && (m.benchPlayerIds ?? []).includes(playerId)) return true;
  return false;
}

// Points a ticker event added/removed for a manager, or null when the event
// doesn't touch anyone in their active squad (legacy getChronoEventImpactForManager).
function eventImpact(m: any, ev: any): number | null {
  if (!m || !ev) return null;
  const mult = (id: number) => (m.captainId === id ? (m.activeChip === '3xc' ? 3 : 2) : 1);

  if (ev.type === 'bonus_change' && Array.isArray(ev.changes)) {
    let owned = false;
    let total = 0;
    for (const c of ev.changes) {
      if (isInActiveSquad(m, c.elementId)) {
        owned = true;
        total += (c.impact || 0) * mult(c.elementId);
      }
    }
    return owned ? total : null;
  }
  if ((ev.type === 'team_clean_sheet' || ev.type === 'team_goals_conceded') && Array.isArray(ev.affectedPlayers)) {
    let owned = false;
    let total = 0;
    for (const p of ev.affectedPlayers) {
      if (isInActiveSquad(m, p.elementId)) {
        owned = true;
        total += (p.points || 0) * mult(p.elementId);
      }
    }
    return owned ? total : null;
  }
  if (ev.elementId != null && isInActiveSquad(m, ev.elementId)) {
    return (ev.points || 0) * mult(ev.elementId);
  }
  return null;
}

function ImpactBadge({ value }: { value: number }) {
  const pos = value >= 0;
  return (
    <span
      className={`ml-1 inline-flex items-center rounded px-1 text-[0.65rem] font-bold ${
        pos ? 'bg-positive-soft text-positive' : 'bg-negative-soft text-negative'
      }`}
    >
      {pos ? '▲' : '▼'}
      {Math.abs(value)}
    </span>
  );
}

const TICKER_POSITIVE = new Set([
  'goal', 'assist', 'clean_sheet', 'team_clean_sheet', 'pen_save', 'saves', 'defcon', 'bonus_change', 'defcon_gained',
]);
const TICKER_NEGATIVE = new Set([
  'own_goal', 'pen_miss', 'red', 'goals_conceded', 'team_goals_conceded', 'cs_lost', 'transfer_hit',
]);

function tickerTone(type: string): 'positive' | 'negative' | 'warning' | 'neutral' {
  if (TICKER_POSITIVE.has(type)) return 'positive';
  if (TICKER_NEGATIVE.has(type)) return 'negative';
  if (type === 'yellow') return 'warning';
  return 'neutral';
}

const EVENT_LABELS: Record<string, string> = {
  goal: 'Goal', assist: 'Assist', yellow: 'Yellow', red: 'Red', own_goal: 'OG', pen_save: 'Pen Save',
  pen_miss: 'Pen Miss', saves: 'Save', clean_sheet: 'CS', team_clean_sheet: 'CS', goals_conceded: 'GC',
  team_goals_conceded: 'GC', bonus_change: 'Bonus', defcon: 'Defcon', transfer_hit: 'Hit',
};

/** The lead label for an event chip (legacy buildTickerHtml). */
function tickerPrimary(ev: any): string {
  if (ev.type === 'bonus_change') {
    const changes = ev.changes ?? [];
    const preview = changes
      .slice(0, 2)
      .map((c: any) => `${c.impact > 0 ? '▲' : c.impact < 0 ? '▼' : ''}${c.player}`)
      .join(', ');
    return preview || 'Bonus';
  }
  if (ev.type === 'team_clean_sheet' || ev.type === 'team_goals_conceded') {
    return `${ev.team} (${(ev.affectedPlayers ?? []).length})`;
  }
  return ev.player ?? ev.team ?? '';
}

function TickerChip({
  ev,
  selected,
  affectsMe,
  onClick,
}: {
  ev: any;
  selected: boolean;
  affectsMe: boolean;
  onClick: () => void;
}) {
  const label = EVENT_LABELS[ev.type] ?? '';
  const showPoints = ev.points != null && ev.type !== 'bonus_change';
  return (
    <button
      type="button"
      onClick={onClick}
      data-tone={tickerTone(ev.type)}
      className={`lt-event ${selected ? 'is-selected' : ''} ${affectsMe ? 'affects-me' : ''}`}
      title={affectsMe ? 'This event affected your team' : undefined}
    >
      <span aria-hidden>{ev.icon ?? '•'}</span>
      <span className="lt-player">{tickerPrimary(ev)}</span>
      {label && <span className="lt-label">{label}</span>}
      {showPoints && (
        <span className={ev.points >= 0 ? 'font-bold text-positive' : 'font-bold text-negative'}>
          {ev.points >= 0 ? '+' : ''}
          {ev.points}
        </span>
      )}
      {ev.match && <span className="lt-match">{ev.match}</span>}
      {affectsMe && <span className="lt-me-dot" aria-hidden />}
    </button>
  );
}

function LiveTicker({
  events,
  live,
  myManager,
  selectedKey,
  onSelect,
}: {
  events: any[];
  live: boolean;
  myManager: any;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  // Newest events sit on the left so the latest are visible without scrolling;
  // older events scroll off to the right (legacy behaviour — a scrollable strip,
  // not an auto-advancing marquee).
  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">
          {live && <span className="h-2 w-2 animate-pulse rounded-full bg-live" />}
          {live ? 'Live events' : 'Match events'}
        </h2>
        {selectedKey != null ? (
          <button type="button" onClick={() => onSelect(selectedKey)} className="text-xs font-bold text-accent hover:underline">
            ✕ Clear
          </button>
        ) : (
          events.length > 0 && <span className="hidden text-xs text-faint sm:block">Tap an event to see who it hit</span>
        )}
      </div>
      {events.length === 0 ? (
        <div className="rounded-xl border border-edge bg-surface px-4 py-3 text-sm text-muted">
          Events from live matches will appear here.
        </div>
      ) : (
        <div className="lt-viewport overflow-x-auto rounded-xl border border-edge bg-surface px-3 py-2">
          <div className="flex gap-2.5">
            {events.map((ev, i) => {
              const k = eventKey(ev);
              return (
                <TickerChip
                  key={i}
                  ev={ev}
                  selected={k === selectedKey}
                  affectsMe={eventImpact(myManager, ev) != null}
                  onClick={() => onSelect(k)}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// Sortable headers on the live table (legacy sortTable).
type SortState = { col: string; asc: boolean };

const SORT_KEYS: Record<string, (m: any) => string | number> = {
  gwRank: (m) => m.gwRank ?? m.rank ?? 0,
  overallRank: (m) => m.overallRank ?? m.rank ?? 0,
  manager: (m) => String(m.name).toLowerCase(),
  gwScore: (m) => m.gwScore ?? 0,
  captain: (m) => String(m.captainName ?? '').toLowerCase(),
  overall: (m) => m.overallPoints ?? 0,
  bench: (m) => m.benchPoints ?? 0,
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

/** Chip and players-left pills under the team name (legacy manager-pills). */
function ManagerPills({ manager: m, defCount = 0 }: { manager: any; defCount?: number }) {
  const pills: ReactNode[] = [];
  if (defCount > 0) {
    pills.push(
      <span key="def" className="rounded-full bg-accent px-1.5 py-px text-[0.6rem] font-bold text-accent-fg">
        {defCount} DEF
      </span>,
    );
  }
  if (m.activeChip) {
    pills.push(
      <span key="chip" className="rounded-full bg-accent-soft px-1.5 py-px text-[0.6rem] font-bold text-accent">
        {chipLabel(m.activeChip)}
      </span>,
    );
  }
  if (m.playersLeft > 0) {
    pills.push(
      <span key="left" className="rounded-full bg-raised px-1.5 py-px text-[0.6rem] font-bold text-muted">
        {m.playersLeft}
        {m.activePlayers > 0 ? ` (+${m.activePlayers})` : ''} left
      </span>,
    );
  }
  // Always reserve a pill-row worth of height so every manager row has the
  // same total height whether badges are showing or not.
  return <div className="mt-1 flex min-h-[1.125rem] flex-wrap gap-1">{pills}</div>;
}

function PitchModal({ entry, gw, onClose }: { entry: { id: number; name: string }; gw: number; onClose: () => void }) {
  const [picks, setPicks] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/manager/${entry.id}/picks?gw=${gw}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setPicks(d)))
      .catch((e) => setErr(e.message));
  }, [entry.id, gw]);

  return (
    <Modal title={entry.name} onClose={onClose} wide>
      {err && <ErrorBlock message={err} />}
      {!picks && !err && <LoadingBlock label="Loading squad…" />}
      {picks && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted">
            <span>GW points <strong className="text-body">{picks.calculatedPoints ?? picks.points}</strong></span>
          </div>
          {(picks.autoSubs ?? []).length > 0 && (
            <p className="mb-2 rounded-lg bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent">
              ⟳ Auto-sub: {picks.autoSubs.map((s: any) => `${s.in.name} for ${s.out.name}`).join(', ')}
            </p>
          )}
          <PitchView players={picks.players ?? []} pointsOnBench={picks.pointsOnBench} />
          <TinkeringBar entryId={entry.id} gw={gw} />
        </>
      )}
    </Modal>
  );
}

// Tinkering bar (legacy renderTinkeringBar): actual vs "kept last week's team"
// score with per-change impact sections. Collapsed by default.
function TinkeringBar({ entryId, gw }: { entryId: number; gw: number }) {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/manager/${entryId}/tinkering?gw=${gw}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entryId, gw]);

  if (!data) return null;
  if (!data.available) {
    return data.reason === 'gw1' ? (
      <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
        No tinkering data for GW1 (no previous team to compare)
      </p>
    ) : null;
  }

  const { actualScore, hypotheticalScore, transferCost, netImpact, reason } = data;
  const impactCls = netImpact > 0 ? 'text-positive' : netImpact < 0 ? 'text-negative' : 'text-muted';
  const chipBadge = { freehit: 'FH', wildcard: 'WC', '3xc': 'TC', bboost: 'BB' }[reason as string];

  const item = (label: ReactNode, impact: number, key: string | number) => (
    <div key={key} className="flex justify-between py-0.5">
      <span>{label}</span>
      <span className={`font-bold ${impact > 0 ? 'text-positive' : impact < 0 ? 'text-negative' : 'text-muted'}`}>
        {impact > 0 ? '+' : ''}
        {impact} pts
      </span>
    </div>
  );

  const section = (title: string, rows: ReactNode[], total?: number) =>
    rows.length > 0 && (
      <div key={title} className="mt-2 rounded-lg bg-raised px-3 py-2 text-xs">
        <div className="mb-1 font-bold uppercase tracking-wide text-muted">{title}</div>
        {rows}
        {total !== undefined &&
          item(<span className="font-bold">Impact</span>, total, 'total')}
      </div>
    );

  const sumImpact = (arr: any[] | undefined, sign = 1) =>
    (arr ?? []).reduce((s, t) => s + sign * (t.impact || 0), 0);

  const cap = data.captainChange;
  const lineupRows = [
    ...(data.lineupChanges?.movedToStarting ?? []).map((p: any, i: number) => item(`Started ${p.name}`, p.impact || 0, `s${i}`)),
    ...(data.lineupChanges?.movedToBench ?? []).map((p: any, i: number) => item(`Benched ${p.name}`, p.impact || 0, `b${i}`)),
  ];
  const lineupTotal = sumImpact(data.lineupChanges?.movedToStarting) + sumImpact(data.lineupChanges?.movedToBench);

  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface p-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-sm font-bold">
        <span>
          🔧 Tinkering Impact
          {chipBadge && <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[0.6rem] text-accent">{chipBadge}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={impactCls}>
            {netImpact > 0 ? '+' : ''}
            {netImpact} pts
          </span>
          <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <div className="rounded-lg bg-raised px-3 py-2 text-xs">
            <div className="flex justify-between py-0.5">
              <span>If you kept last week&apos;s team:</span>
              <span>{hypotheticalScore} pts</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span>Your actual score:</span>
              <span>{actualScore} pts</span>
            </div>
            {transferCost > 0 && (
              <div className="flex justify-between py-0.5">
                <span>Transfer hits:</span>
                <span className="text-negative">-{transferCost} pts</span>
              </div>
            )}
            <div className="flex justify-between border-t border-edge pt-1 font-bold">
              <span>NET BENEFIT</span>
              <span className={impactCls}>
                {netImpact > 0 ? '+' : ''}
                {netImpact} pts
              </span>
            </div>
          </div>
          {section(
            'Transfers In',
            (data.transfersIn ?? []).map((t: any, i: number) =>
              item(`${t.player.name}${t.captained ? (reason === '3xc' ? ' (TC)' : ' (C)') : ''}`, t.impact || 0, i),
            ),
            sumImpact(data.transfersIn),
          )}
          {section(
            'Transfers Out',
            (data.transfersOut ?? []).map((t: any, i: number) =>
              item(`${t.player.name}${t.wasCaptain ? ' (was C)' : ''}`, -(t.impact || 0), i),
            ),
            sumImpact(data.transfersOut, -1),
          )}
          {cap?.changed &&
            section(
              'Captain Change',
              [item(`${cap.oldCaptain?.name} (${cap.oldCaptain?.points} pts) → ${cap.newCaptain?.name} (${cap.newCaptain?.points} pts)`, cap.impact, 'cap')],
            )}
          {section('Lineup Changes', lineupRows, lineupRows.length ? lineupTotal : undefined)}
          {section(
            'Auto-Sub Effects',
            (data.autoSubEffects ?? []).map((p: any, i: number) => item(p.name, p.impact || 0, i)),
            sumImpact(data.autoSubEffects),
          )}
          {data.chipImpact?.tripleCaptain &&
            section('Triple Captain Bonus', [
              item(
                `${data.chipImpact.tripleCaptain.playerName} (${data.chipImpact.tripleCaptain.basePoints} pts × 3)`,
                data.chipImpact.tripleCaptain.bonus,
                'tc',
              ),
            ])}
          {data.chipImpact?.benchBoost &&
            section(
              'Bench Boost',
              (data.chipImpact.benchBoost.players ?? []).map((p: any, i: number) => item(p.name, p.points, i)),
              data.chipImpact.benchBoost.totalBonus,
            )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Highlight modes (legacy toggleHighlightPopup/getHighlightResult): pick a
// player (owned/started/benched) or a club's defense and dim non-matching rows.
// =============================================================================

type HighlightState = {
  type: 'player' | 'defense' | null;
  playerId: number | null;
  playerMode: 'own' | 'started' | 'benched';
  teamId: number | null;
};

const NO_HIGHLIGHT: HighlightState = { type: null, playerId: null, playerMode: 'own', teamId: null };

function highlightResult(
  manager: any,
  hl: HighlightState,
  squadPlayers: Record<string, any> | undefined,
): { match: boolean; defCount: number } {
  if (hl.type === 'player' && hl.playerId != null) {
    const pid = hl.playerId;
    const inStarting = (manager.starting11 ?? []).includes(pid);
    const onBench = (manager.benchPlayerIds ?? []).includes(pid);
    const autoSubbedIn = (manager.autoSubsIn ?? []).includes(pid);
    const autoSubbedOut = (manager.autoSubsOut ?? []).includes(pid);
    const isBenchBoost = manager.activeChip === 'bboost';
    if (hl.playerMode === 'own') return { match: inStarting || onBench, defCount: 0 };
    if (hl.playerMode === 'started') {
      return { match: (inStarting && !autoSubbedOut) || autoSubbedIn || (onBench && isBenchBoost), defCount: 0 };
    }
    return { match: (onBench && !autoSubbedIn && !isBenchBoost) || (inStarting && autoSubbedOut), defCount: 0 };
  }
  if (hl.type === 'defense' && hl.teamId != null) {
    const allIds = [...(manager.starting11 ?? []), ...(manager.benchPlayerIds ?? [])];
    const count = allIds.filter((id) => {
      const p = squadPlayers?.[id];
      return p && p.teamId === hl.teamId && (p.positionId === 1 || p.positionId === 2);
    }).length;
    return { match: count > 0, defCount: count };
  }
  return { match: false, defCount: 0 };
}

function highlightLabel(hl: HighlightState, week: any): string {
  if (hl.type === 'player' && hl.playerId != null) {
    const p = week?.squadPlayers?.[hl.playerId];
    const mode = { own: 'Owned', started: 'Started', benched: 'Benched' }[hl.playerMode];
    if (p) return `${p.name} (${mode})`;
  }
  if (hl.type === 'defense' && hl.teamId != null) {
    const t = (week?.plTeams ?? []).find((t: any) => t.id === hl.teamId);
    if (t) return `${t.shortName} Defense`;
  }
  return 'Highlight';
}

function HighlightModal({
  week,
  highlight,
  onChange,
  onClose,
}: {
  week: any;
  highlight: HighlightState;
  onChange: (hl: HighlightState) => void;
  onClose: () => void;
}) {
  const squadPlayers: Record<string, any> = week?.squadPlayers ?? {};
  const players = Object.entries(squadPlayers)
    .map(([id, p]: [string, any]) => ({ id: Number(id), name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams: any[] = week?.plTeams ?? [];
  const selectCls = 'w-full rounded-md border border-edge bg-raised px-3 py-2 text-sm';

  return (
    <Modal title="Highlight Managers" onClose={onClose}>
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Player</div>
      <select
        value={highlight.type === 'player' ? String(highlight.playerId ?? '') : ''}
        onChange={(e) =>
          onChange(
            e.target.value
              ? { type: 'player', playerId: Number(e.target.value), playerMode: highlight.playerMode, teamId: null }
              : NO_HIGHLIGHT,
          )
        }
        className={selectCls}
      >
        <option value="">Select player…</option>
        {players.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {highlight.type === 'player' && (
        <div className="mt-2 flex gap-1.5">
          {(['own', 'started', 'benched'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ ...highlight, playerMode: mode })}
              className={`rounded-full border px-3 py-1 text-xs font-bold ${
                highlight.playerMode === mode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-edge text-muted hover:text-body'
              }`}
            >
              {{ own: 'Owned', started: 'Started', benched: 'Benched' }[mode]}
            </button>
          ))}
        </div>
      )}

      <div className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Club Defense (GK + DEF)</div>
      <select
        value={highlight.type === 'defense' ? String(highlight.teamId ?? '') : ''}
        onChange={(e) =>
          onChange(
            e.target.value
              ? { type: 'defense', playerId: null, playerMode: 'own', teamId: Number(e.target.value) }
              : NO_HIGHLIGHT,
          )
        }
        className={selectCls}
      >
        <option value="">Select club…</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => {
          onChange(NO_HIGHLIGHT);
          onClose();
        }}
        className="mt-5 w-full rounded-md border border-edge py-2 text-sm font-bold text-muted hover:bg-raised"
      >
        Clear Highlights
      </button>
    </Modal>
  );
}
