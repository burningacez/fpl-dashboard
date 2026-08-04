'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Modal, PageHeader } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useIsMe, useMyTeam } from '@/components/providers';
import { TourButton, useTourHost } from '@/components/tour/TourProvider';
import { buildHofTour } from './hallOfFameTour';
// Type-only, so the demo payloads stay behind the dynamic import in enterDemo.
import type { DemoHofData } from './demoHallOfFame';

// =============================================================================
// Award metadata — ported verbatim from legacy hall-of-fame.html AWARD_INFO.
// =============================================================================

const AWARD_INFO: Record<string, { title: string; description: string; icon: string }> = {
  highestGW: {
    title: 'The Masterstroke',
    description:
      'The highest single gameweek score achieved by any manager this season. This is the gross score before any transfer penalties.',
    icon: '\u{1F3C6}',
  },
  biggestClimb: {
    title: 'The Phoenix',
    description:
      'The largest single-week improvement in league position. Calculated by comparing league rank before and after each gameweek.',
    icon: '\u{1F4C8}',
  },
  mostMotM: {
    title: 'The Dominator',
    description:
      'Manager of the Month is awarded to the highest scoring manager in each MotM period. This tracks who has won the most MotM awards.',
    icon: '\u{2B50}',
  },
  mostConsistent: {
    title: 'The Machine',
    description:
      'Awarded to the manager with the lowest standard deviation in their weekly scores. Lower variance means more predictable, steady performance week-to-week.',
    icon: '\u{1F3AF}',
  },
  highestTeamValue: {
    title: 'The Tycoon',
    description:
      'The highest team value achieved at any point during the season. Team value increases when you hold players whose price rises.',
    icon: '\u{1F4B0}',
  },
  perfectBB: {
    title: 'Bench Boss',
    description:
      'Awarded to managers who used their Bench Boost chip on the gameweek where their bench scored the most points compared to all other weeks. This means they timed it optimally.',
    icon: '\u{2728}',
  },
  perfectTC: {
    title: 'Captain Fantastic',
    description:
      "Awarded to managers who used their Triple Captain chip on a week where their captain scored highly. Compares the TC captain's points against their other captain performances.",
    icon: '\u{1F680}',
  },
  worstBB: {
    title: 'The Benchwarmer',
    description:
      'Awarded to the manager who got the least out of their Bench Boost chip. Their bench players delivered the fewest points on the one week they were actually needed. Sometimes the bench stays cold no matter what.',
    icon: '\u{1F4A4}',
  },
  worstTC: {
    title: 'Captain Hindsight',
    description:
      'Awarded to the manager whose Triple Captain pick delivered the fewest points. The armband was heavy that week. In hindsight, any other gameweek might have been a better shout.',
    icon: '\u{1F62C}',
  },
  lowestGW: {
    title: 'The Nightmare',
    description:
      'The lowest single gameweek score recorded this season. Sometimes bad luck, sometimes bad decisions!',
    icon: '\u{1F480}',
  },
  mostLosses: {
    title: 'The Wooden Spoon',
    description:
      'The manager who has finished bottom of the league standings most often in a single gameweek. Each week, the lowest scorer pays into the pot.',
    icon: '\u{1F921}',
  },
  biggestHit: {
    title: 'Panic Buyer',
    description:
      'The largest points penalty taken for transfers in a single gameweek. Each transfer beyond the free ones costs 4 points.',
    icon: '\u{1F4B8}',
  },
  biggestDrop: {
    title: 'The Freefall',
    description:
      'The largest single-week fall in league position. A bad week can see you tumble down the table!',
    icon: '\u{2B07}\u{FE0F}',
  },
  mostTransfers: {
    title: 'The Fidgeter',
    description:
      'Total number of transfers made across the entire season. More transfers often means more points hits taken.',
    icon: '\u{1F504}',
  },
  lowestTeamValue: {
    title: 'Bargain Hunter',
    description:
      'The lowest team value recorded at any point during the season. Can happen when selling players whose prices have dropped.',
    icon: '\u{1F4C9}',
  },
  biggestBenchHaul: {
    title: 'Wrong Call',
    description:
      "The most points left on the bench in a single gameweek (excluding Bench Boost weeks). These are points that didn't count because the players weren't in the starting XI.",
    icon: '\u{1FA91}',
  },
  bestTinkering: {
    title: 'The Genius',
    description:
      "The single gameweek where a manager's moves paid off the most versus keeping the previous week's team. Net impact = actual score minus what last week's team would have scored, minus transfer hits.",
    icon: '\u{1F3AF}',
  },
  worstTinkering: {
    title: 'The Blunder',
    description:
      "The single gameweek where moves backfired the most versus keeping the previous week's team. Sometimes the best move is no move at all!",
    icon: '\u{1F926}',
  },
  seasonBestTinkerer: {
    title: 'The Alchemist',
    description:
      'The manager who gained the most points over the whole season through active management compared to simply keeping their GW1 team (from Set & Forget).',
    icon: '\u{1F9EA}',
  },
  mostWeeklyWins: {
    title: 'The Sharpshooter',
    description:
      'The manager who topped the weekly scores the most times this season. Each gameweek, the highest scorer claims a weekly win. Shared top scores count for all winners.',
    icon: '\u{1F3AF}',
  },
  longestFormStreak: {
    title: 'The Unstoppable',
    description:
      'The longest form chart dominance. At a given gameweek, check who scored most over the last 1 week, last 2 weeks, last 3 weeks, and so on. This tracks the longest consecutive run of form windows where the same manager led them all: pure sustained brilliance.',
    icon: '\u{1F525}',
  },
};

type SectionType = 'highlight' | 'lowlight';

// =============================================================================
// Tied-name display — replicates legacy formatTiedNames(), but wraps each
// rendered name so my-team matches get the my-team-name treatment.
// Records are keyed by manager NAME only (by design — works for archived
// seasons), so matching is name-based via useIsMe({ name }).
// =============================================================================

function NameSpan({ name }: { name: string }) {
  const isMe = useIsMe();
  return <span className={isMe({ name }) ? 'my-team-name' : ''}>{name}</span>;
}

function TiedNames({ names }: { names: string[] }) {
  if (!names || names.length === 0) return <>-</>;
  if (names.length === 1) return <NameSpan name={names[0]} />;
  if (names.length === 2)
    return (
      <>
        <NameSpan name={names[0]} /> & <NameSpan name={names[1]} />
      </>
    );
  return (
    <>
      <NameSpan name={names[0]} /> +{names.length - 1} others
    </>
  );
}

// =============================================================================
// Record card
// =============================================================================

function recordNames(rawData: any): string[] {
  if (rawData?.names?.length) return rawData.names.filter(Boolean);
  if (rawData?.name) return [rawData.name];
  return [];
}

function RecordCard({
  type,
  awardKey,
  names,
  value,
  detail,
  onOpen,
  anchor,
}: {
  type: SectionType;
  awardKey: string;
  names: string[];
  value: React.ReactNode;
  detail?: React.ReactNode;
  onOpen: () => void;
  /** `data-tour` name, so a walkthrough step can point at this card. */
  anchor?: string;
}) {
  const isMe = useIsMe();
  const info = AWARD_INFO[awardKey];
  const mine = names.some((n) => isMe({ name: n }));
  const hasTies = names.length > 1;
  const highlight = type === 'highlight';

  return (
    <div
      role="button"
      tabIndex={0}
      data-tour={anchor}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Card
        highlightMe={mine}
        className={`h-full border-t-2 ${highlight ? 'border-t-accent' : 'border-t-negative'}`}
      >
        <div className="mb-3 flex items-center gap-3">
          <span className="text-2xl" aria-hidden>
            {info.icon}
          </span>
          <span
            className={`text-xs font-bold uppercase tracking-wide ${highlight ? 'text-accent' : 'text-negative'}`}
          >
            {info.title}
          </span>
        </div>
        <div className="text-xl font-extrabold">
          {names.length > 0 ? <TiedNames names={names} /> : '-'}
        </div>
        <div className={`text-base font-bold ${highlight ? 'text-accent' : 'text-negative'}`}>{value}</div>
        {detail ? <div className="mt-0.5 text-xs text-muted">{detail}</div> : null}
        <div className="mt-2 text-right text-[0.65rem] text-faint">
          {hasTies ? 'Tap for all winners' : 'Tap for details'}
        </div>
      </Card>
    </div>
  );
}

// =============================================================================
// Modal value display — replicates the legacy renderAwardDetail switch.
// =============================================================================

function awardValue(awardKey: string, data: any): { display: string; label: string } {
  switch (awardKey) {
    case 'highestGW':
    case 'lowestGW':
      return { display: `${data.score} pts`, label: `Gameweek ${data.gw}` };
    case 'biggestClimb':
      return { display: `+${data.ranksGained}`, label: `Ranks gained in GW${data.gw}` };
    case 'biggestDrop':
      return { display: `-${data.ranksLost}`, label: `Ranks lost in GW${data.gw}` };
    case 'mostMotM':
      return { display: `${data.count}`, label: 'MotM wins' };
    case 'mostConsistent':
      return { display: `${data.stdDev}`, label: 'Standard deviation' };
    case 'highestTeamValue':
    case 'lowestTeamValue':
      return { display: `£${data.value}m`, label: `Gameweek ${data.gw}` };
    case 'mostLosses':
      return { display: `${data.count}`, label: 'Weekly losses' };
    case 'biggestHit':
      return { display: `-${data.cost} pts`, label: `Gameweek ${data.gw}` };
    case 'mostTransfers':
      return { display: `${data.count}`, label: 'Total transfers' };
    case 'biggestBenchHaul':
      return { display: `${data.points} pts`, label: `Wasted in GW${data.gw}` };
    case 'bestTinkering':
      return { display: `+${data.impact} pts`, label: `Gained in GW${data.gw}` };
    case 'worstTinkering':
      return { display: `${data.impact} pts`, label: `Lost in GW${data.gw}` };
    case 'seasonBestTinkerer':
      return {
        display: `+${data.difference} pts`,
        label: `Gained vs set & forget (${data.completedGWs} GWs)`,
      };
    case 'mostWeeklyWins':
      return { display: `${data.count}`, label: 'Weekly wins' };
    case 'longestFormStreak':
      return { display: `${data.count}`, label: 'Consecutive form windows on top' };
    case 'worstBB':
      return { display: `${data.benchPoints} pts`, label: `Bench scored on Bench Boost (GW${data.gw})` };
    case 'worstTC':
      return { display: `${data.captainPoints} pts`, label: `${data.player} on Triple Captain (GW${data.gw})` };
    default:
      return { display: '', label: '' };
  }
}

// =============================================================================
// Page
// =============================================================================

type ModalState =
  | { kind: 'award'; type: SectionType; awardKey: string }
  | { kind: 'chip'; type: SectionType; awardKey: 'perfectBB' | 'perfectTC' }
  | null;

export default function HallOfFamePage() {
  const { data: dataApi, loading, error, empty } = useApi<any>('/api/hall-of-fame');
  // Legacy merges /api/set-and-forget's bestTinkerer in as "The Alchemist".
  const { data: safApi } = useApi<any>('/api/set-and-forget');
  const { me, features } = useMyTeam();
  const [modal, setModal] = useState<ModalState>(null);

  // ---- walkthrough demo mode (see demoHallOfFame.ts) ----
  // Nothing on this page fetches on open, so demo mode is purely a render-time
  // override of both payloads: the real ones come straight back when the tour
  // ends. It also stands in for the empty state, which is where a first visit
  // lands: /api/hall-of-fame publishes nothing until gameweeks are played.
  const [demo, setDemo] = useState<DemoHofData | null>(null);
  const data = demo ? demo.hof : dataApi;
  const safData = demo ? demo.saf : safApi;

  const enterDemo = useCallback(async () => {
    const mod = await import('./demoHallOfFame');
    setModal(null);
    setDemo(mod.buildDemoHof(me ? { entryId: me.entryId, name: me.name, team: me.team } : null));
  }, [me]);

  const exitDemo = useCallback(() => {
    setDemo(null);
    setModal(null);
  }, []);

  useTourHost(
    buildHofTour({
      // Preview-gated server-side, same flag as the other walkthroughs. Unlike
      // them this does not require a payload: pre-season there isn't one, which
      // is exactly when the walkthrough is worth having.
      ready: !loading && !error && !dataApi?.error && features.walkthroughs,
      hasHighlights: Boolean(demo) || Boolean(dataApi?.highlights),
      hasLowlights: Boolean(demo) || Boolean(dataApi?.lowlights),
      onStart: enterDemo,
      onEnd: exitDemo,
      actions: { closeAward: () => setModal(null) },
    }),
  );

  // Escape closes the detail modal, matching legacy behaviour.
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  const seasonBestTinkerer =
    safData?.bestTinkerer && safData.bestTinkerer.difference > 0
      ? {
          name: safData.bestTinkerer.name,
          difference: safData.bestTinkerer.difference,
          completedGWs: safData.completedGWs,
        }
      : null;

  // Shared by every return path below, so the See demo button is there in the
  // empty state too: pre-season that is the only state this page has.
  const header = (
    <div className="flex items-start justify-between gap-3">
      <PageHeader title="Hall of Fame" subtitle="League records, highlights and lowlights" />
      <TourButton label="See demo" title="See a guided demo of this page" className="mt-1" />
    </div>
  );

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        {header}
        <LoadingBlock label="Loading hall of fame data…" />
      </main>
    );
  }

  // A run in progress renders the example records instead of the empty or failed
  // state the real payload is in.
  if (empty && !demo) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        {header}
        <EmptyBlock message={empty} />
      </main>
    );
  }

  if ((error || !data || data.error) && !demo) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        {header}
        <ErrorBlock message={data?.error || error || 'Unknown error'} />
      </main>
    );
  }

  const highlights = data.highlights || {};
  const lowlights = data.lowlights || {};
  const chipAwards = data.chipAwards || {};

  const openAward = (type: SectionType, awardKey: string) => setModal({ kind: 'award', type, awardKey });
  const openChip = (type: SectionType, awardKey: 'perfectBB' | 'perfectTC') =>
    setModal({ kind: 'chip', type, awardKey });

  // ---- modal data resolution (mirrors legacy renderAwardDetail) ----
  let modalContent: React.ReactNode = null;
  if (modal?.kind === 'award') {
    const { awardKey, type } = modal;
    let award: any;
    if (awardKey === 'seasonBestTinkerer') {
      award = seasonBestTinkerer;
    } else if (awardKey === 'worstBB' || awardKey === 'worstTC') {
      award = chipAwards?.[awardKey];
    } else {
      award = type === 'highlight' ? highlights[awardKey] : lowlights[awardKey];
    }
    if (award) {
      const info = AWARD_INFO[awardKey];
      const { display, label } = awardValue(awardKey, award);
      const names: string[] = recordNames(award);
      modalContent = (
        <Modal
          title={
            <span className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                {info.icon}
              </span>
              {info.title}
            </span>
          }
          onClose={() => setModal(null)}
          anchor="modal-hof-award"
        >
          <div className="mb-4 rounded-lg bg-raised p-3 text-sm leading-relaxed text-muted">
            {info.description}
          </div>
          <div className="mb-4 rounded-lg border border-edge bg-canvas p-4 text-center">
            <div
              className={`text-3xl font-extrabold ${type === 'lowlight' ? 'text-negative' : 'text-accent'}`}
            >
              {display}
            </div>
            <div className="mt-1 text-xs text-muted">{label}</div>
          </div>
          {names.length === 1 && (
            <div className="text-center text-lg font-bold">
              <NameSpan name={names[0]} />
            </div>
          )}
          {names.length > 1 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                All Winners ({names.length}-way tie)
              </h4>
              {names.map((n) => (
                <div key={n} className="border-b border-edge py-2 font-bold last:border-b-0">
                  <NameSpan name={n} />
                </div>
              ))}
            </div>
          )}
        </Modal>
      );
    }
  } else if (modal?.kind === 'chip') {
    const { awardKey } = modal;
    const winners: any[] = chipAwards?.[awardKey] || [];
    if (winners.length > 0) {
      const info = AWARD_INFO[awardKey];
      modalContent = (
        <Modal
          title={
            <span className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                {info.icon}
              </span>
              {info.title}
            </span>
          }
          onClose={() => setModal(null)}
          anchor="modal-hof-award"
        >
          <div className="mb-4 rounded-lg bg-raised p-3 text-sm leading-relaxed text-muted">
            {info.description}
          </div>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
            {winners.length === 1 ? 'Winner' : `Winners (${winners.length})`}
          </h4>
          {winners.map((w, i) => (
            <div
              key={`${w.name}-${i}`}
              className="flex items-center justify-between gap-4 border-b border-edge py-2 last:border-b-0"
            >
              <span className="font-bold">
                <NameSpan name={w.name} />
              </span>
              <span className="text-sm text-muted">
                {awardKey === 'perfectBB'
                  ? `GW${w.gw} - ${w.benchPoints} pts`
                  : `${w.player} (${w.captainPoints} pts) GW${w.gw}`}
              </span>
            </div>
          ))}
        </Modal>
      );
    }
  }

  // ---- chip card (perfectBB / perfectTC) ----
  const ChipCard = ({ awardKey, winners }: { awardKey: 'perfectBB' | 'perfectTC'; winners: any[] }) => {
    const names = winners.map((w) => w.name);
    const detail =
      winners.length === 1
        ? awardKey === 'perfectBB'
          ? `GW${winners[0].gw} - ${winners[0].benchPoints} bench pts`
          : `${winners[0].player} - ${winners[0].captainPoints} pts (GW${winners[0].gw})`
        : `${winners.length} managers`;
    return (
      <RecordCard
        type="highlight"
        awardKey={awardKey}
        names={names}
        value="Optimal timing!"
        detail={detail}
        onOpen={() => openChip('highlight', awardKey)}
      />
    );
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      {header}

      {demo && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
          Example data. A made-up season, because this page has nothing to show until
          gameweeks have been played. Your real league comes back when the tour ends.
        </p>
      )}

      <h2 className="mb-6 mt-8 flex items-center justify-center gap-3 border-b-2 border-accent/30 pb-3 text-center text-lg font-extrabold uppercase tracking-wide text-accent">
        Highlights
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-tour="hof-highlights">
        <RecordCard
          type="highlight"
          awardKey="highestGW"
          names={recordNames(highlights.highestGW)}
          value={`${highlights.highestGW?.score || 0} pts`}
          detail={`Gameweek ${highlights.highestGW?.gw || '-'}`}
          onOpen={() => openAward('highlight', 'highestGW')}
          // The card the walkthrough describes and opens.
          anchor="hof-card"
        />
        <RecordCard
          type="highlight"
          awardKey="biggestClimb"
          names={recordNames(highlights.biggestClimb)}
          value={`+${highlights.biggestClimb?.ranksGained || 0} ranks`}
          detail={`Gameweek ${highlights.biggestClimb?.gw || '-'}`}
          onOpen={() => openAward('highlight', 'biggestClimb')}
        />
        <RecordCard
          type="highlight"
          awardKey="mostMotM"
          names={recordNames(highlights.mostMotM)}
          value={`${highlights.mostMotM?.count || 0} wins`}
          onOpen={() => openAward('highlight', 'mostMotM')}
          // MotM is the record most often shared, so it is where the walkthrough
          // explains a tie. The demo season ties it three ways.
          anchor="hof-tied"
        />
        {highlights.mostWeeklyWins?.count > 0 && (
          <RecordCard
            type="highlight"
            awardKey="mostWeeklyWins"
            names={recordNames(highlights.mostWeeklyWins)}
            value={`${highlights.mostWeeklyWins?.count || 0} wins`}
            detail="Weekly highest scorer"
            onOpen={() => openAward('highlight', 'mostWeeklyWins')}
          />
        )}
        {highlights.longestFormStreak?.count > 0 && (
          <RecordCard
            type="highlight"
            awardKey="longestFormStreak"
            names={recordNames(highlights.longestFormStreak)}
            value={`${highlights.longestFormStreak?.count || 0} weeks`}
            detail="Top of the form chart"
            onOpen={() => openAward('highlight', 'longestFormStreak')}
          />
        )}
        <RecordCard
          type="highlight"
          awardKey="mostConsistent"
          names={recordNames(highlights.mostConsistent)}
          value={`${highlights.mostConsistent?.stdDev || 0} std dev`}
          detail="Lowest variance"
          onOpen={() => openAward('highlight', 'mostConsistent')}
        />
        <RecordCard
          type="highlight"
          awardKey="highestTeamValue"
          names={recordNames(highlights.highestTeamValue)}
          value={`£${highlights.highestTeamValue?.value || '100.0'}m`}
          detail={`Gameweek ${highlights.highestTeamValue?.gw || '-'}`}
          onOpen={() => openAward('highlight', 'highestTeamValue')}
        />
        {chipAwards?.perfectBB?.length > 0 && <ChipCard awardKey="perfectBB" winners={chipAwards.perfectBB} />}
        {chipAwards?.perfectTC?.length > 0 && <ChipCard awardKey="perfectTC" winners={chipAwards.perfectTC} />}
        {highlights.bestTinkering?.impact > 0 && (
          <RecordCard
            type="highlight"
            awardKey="bestTinkering"
            names={recordNames(highlights.bestTinkering)}
            value={`+${highlights.bestTinkering?.impact || 0} pts`}
            detail={`Gameweek ${highlights.bestTinkering?.gw || '-'}`}
            onOpen={() => openAward('highlight', 'bestTinkering')}
          />
        )}
        {seasonBestTinkerer && (
          <RecordCard
            type="highlight"
            awardKey="seasonBestTinkerer"
            names={recordNames(seasonBestTinkerer)}
            value={`+${seasonBestTinkerer.difference} pts`}
            detail={`Over ${seasonBestTinkerer.completedGWs} gameweeks`}
            onOpen={() => openAward('highlight', 'seasonBestTinkerer')}
          />
        )}
      </div>

      <h2 className="mb-6 mt-10 flex items-center justify-center gap-3 border-b-2 border-negative/30 pb-3 text-center text-lg font-extrabold uppercase tracking-wide text-negative">
        Lowlights
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-tour="hof-lowlights">
        <RecordCard
          type="lowlight"
          awardKey="lowestGW"
          names={recordNames(lowlights.lowestGW)}
          value={`${lowlights.lowestGW?.score || 0} pts`}
          detail={`Gameweek ${lowlights.lowestGW?.gw || '-'}`}
          onOpen={() => openAward('lowlight', 'lowestGW')}
        />
        <RecordCard
          type="lowlight"
          awardKey="mostLosses"
          names={recordNames(lowlights.mostLosses)}
          value={`${lowlights.mostLosses?.count || 0} times`}
          onOpen={() => openAward('lowlight', 'mostLosses')}
        />
        <RecordCard
          type="lowlight"
          awardKey="biggestHit"
          names={recordNames(lowlights.biggestHit)}
          value={`-${lowlights.biggestHit?.cost || 0} pts`}
          detail={`Gameweek ${lowlights.biggestHit?.gw || '-'}`}
          onOpen={() => openAward('lowlight', 'biggestHit')}
        />
        <RecordCard
          type="lowlight"
          awardKey="biggestDrop"
          names={recordNames(lowlights.biggestDrop)}
          value={`-${lowlights.biggestDrop?.ranksLost || 0} ranks`}
          detail={`Gameweek ${lowlights.biggestDrop?.gw || '-'}`}
          onOpen={() => openAward('lowlight', 'biggestDrop')}
        />
        <RecordCard
          type="lowlight"
          awardKey="mostTransfers"
          names={recordNames(lowlights.mostTransfers)}
          value={`${lowlights.mostTransfers?.count || 0} transfers`}
          detail="Total season"
          onOpen={() => openAward('lowlight', 'mostTransfers')}
        />
        <RecordCard
          type="lowlight"
          awardKey="lowestTeamValue"
          names={recordNames(lowlights.lowestTeamValue)}
          value={`£${lowlights.lowestTeamValue?.value || '100.0'}m`}
          detail={`Gameweek ${lowlights.lowestTeamValue?.gw || '-'}`}
          onOpen={() => openAward('lowlight', 'lowestTeamValue')}
        />
        {lowlights.biggestBenchHaul?.points > 0 && (
          <RecordCard
            type="lowlight"
            awardKey="biggestBenchHaul"
            names={recordNames(lowlights.biggestBenchHaul)}
            value={`${lowlights.biggestBenchHaul?.points || 0} pts`}
            detail={`Gameweek ${lowlights.biggestBenchHaul?.gw || '-'}`}
            onOpen={() => openAward('lowlight', 'biggestBenchHaul')}
          />
        )}
        {lowlights.worstTinkering?.impact < 0 && (
          <RecordCard
            type="lowlight"
            awardKey="worstTinkering"
            names={recordNames(lowlights.worstTinkering)}
            value={`${lowlights.worstTinkering?.impact || 0} pts`}
            detail={`Gameweek ${lowlights.worstTinkering?.gw || '-'}`}
            onOpen={() => openAward('lowlight', 'worstTinkering')}
          />
        )}
        {chipAwards?.worstBB && (
          <RecordCard
            type="lowlight"
            awardKey="worstBB"
            names={recordNames(chipAwards.worstBB)}
            value={`${chipAwards.worstBB.benchPoints} pts`}
            detail={`Bench Boost GW${chipAwards.worstBB.gw}`}
            onOpen={() => openAward('lowlight', 'worstBB')}
          />
        )}
        {chipAwards?.worstTC && (
          <RecordCard
            type="lowlight"
            awardKey="worstTC"
            names={recordNames(chipAwards.worstTC)}
            value={`${chipAwards.worstTC.captainPoints} pts`}
            detail={`${chipAwards.worstTC.player} (GW${chipAwards.worstTC.gw})`}
            onOpen={() => openAward('lowlight', 'worstTC')}
          />
        )}
      </div>

      {modalContent}
    </main>
  );
}
