/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import config from '../config';
import { dataCache } from '../data-cache';
import {
  fetchBootstrap,
  fetchFixtures,
  fetchLeagueData,
  fetchCupStatus,
  fetchCupMatches,
  fetchManagerPicks,
  fetchLiveGWData,
  getCompletedGameweeks,
  cleanDisplayName,
} from '../fpl/client';
import { fetchManagerPicksDetailed } from './picks';
import { calculatePlayersLeft } from './scoring';
import { getActiveSeasonConfig, getLeagueId } from '../season-state';

/**
 * Cup bracket data — transliteration of the inline '/api/cup' handler from
 * legacy/server.js (:7106-7414) bracket/seeding logic. (The legacy mock-data
 * block was dropped: it carried real member names/ids and served no purpose
 * behind its always-false flag.)
 */
export async function buildCupData(): Promise<any> {
  // Mini-league cup configuration — season-specific (e.g. 25/26: starts GW34,
  // bracket drawn after GW33 ends based on GW33 net scores)
  const { startGw: CUP_START_GW, seedingGw: SEEDING_GW } = getActiveSeasonConfig().cup;

  const bootstrap = await fetchBootstrap();
  const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 1;


  // Production: FPL hosts the mini-league cup as an auto-generated H2H
  // sub-league. The H2H league id lives on the classic-league standings
  // response (league.cup_league); cup-status only exposes qualification
  // metadata. Fetch both in parallel, then pull the match list.
  const [cupStatus, leagueData] = await Promise.all([
    fetchCupStatus(getLeagueId()).catch(() => null),
    dataCache.league ? Promise.resolve(dataCache.league) : fetchLeagueData(),
  ]);
  const cupLeagueId = (leagueData as any)?.league?.cup_league || null;

  if (!cupLeagueId) {
    const qualGW = (cupStatus as any)?.qualification_event;
    return {
      cupStarted: false,
      cupStartGW: CUP_START_GW,
      message: qualGW
        ? `Cup will start in Gameweek ${qualGW + 1}`
        : `Cup will start in Gameweek ${CUP_START_GW}`,
    };
  }

  const fixtures = await fetchFixtures();
  const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
  const matches = await fetchCupMatches(cupLeagueId);

  const byEvent = new Map<any, any[]>();
  for (const m of matches as any[]) {
    if (!byEvent.has(m.event)) byEvent.set(m.event, []);
    byEvent.get(m.event)!.push(m);
  }
  const sortedEvents = [...byEvent.keys()].sort((a, b) => a - b);

  // Derive round names from the number of match objects in the round.
  // FPL cup gives each round a power-of-2 match count (byes in round 1
  // pad to the next power of 2), so matchCount * 2 = bracket size.
  const roundNameFor = (matchCount: number) => {
    if (matchCount === 1) return 'Final';
    if (matchCount === 2) return 'Semi-Finals';
    if (matchCount === 4) return 'Quarter-Finals';
    return `Round of ${matchCount * 2}`;
  };

  const rounds = sortedEvents.map((event) => {
    const isComplete = completedGWs.includes(event);
    const isLive = event === currentGW && !isComplete;
    const rawMatches = byEvent.get(event)!;

    return {
      name: roundNameFor(rawMatches.length),
      event,
      isLive,
      isComplete,
      matches: rawMatches.map((m: any) => {
        const isBye = !m.entry_2_entry;
        const entry1 = {
          entry: m.entry_1_entry,
          name: cleanDisplayName(m.entry_1_player_name),
          team: cleanDisplayName(m.entry_1_name),
        };
        const entry2 = isBye ? null : {
          entry: m.entry_2_entry,
          name: cleanDisplayName(m.entry_2_player_name),
          team: cleanDisplayName(m.entry_2_name),
        };
        const winner = isBye ? 1
          : m.winner === m.entry_1_entry ? 1
          : m.winner === m.entry_2_entry ? 2
          : null;
        return {
          entry1,
          entry2,
          score1: m.entry_1_points ?? null,
          score2: isBye ? null : (m.entry_2_points ?? null),
          winner,
          isBye,
          tiebreak: m.tiebreak ? 'tiebreaker' : undefined,
        } as any;
      }),
    };
  });

  // For the live round, compute net GW scores with provisional bonus
  // using the same auto-sub + BPS logic as the weekly/standings pages.
  const liveRound = rounds.find((r) => r.isLive);
  if (liveRound) {
    try {
      const liveData = await fetchLiveGWData(currentGW);
      const gwFixtures = fixtures.filter((f: any) => f.event === currentGW);

      const entryIds = new Set<any>();
      for (const m of liveRound.matches) {
        if (m.entry1?.entry) entryIds.add(m.entry1.entry);
        if (m.entry2?.entry) entryIds.add(m.entry2.entry);
      }

      const liveByEntry: Record<string, any> = {};
      await Promise.all([...entryIds].map(async (entryId) => {
        try {
          const picks = await fetchManagerPicks(entryId, currentGW);
          const detailedData = await fetchManagerPicksDetailed(
            entryId,
            currentGW,
            bootstrap,
            { picks, liveData, fixtures },
          );
          const score = detailedData.calculatedPoints
            + (detailedData.totalProvisionalBonus || 0)
            - (detailedData.transfersCost || 0);
          const left = calculatePlayersLeft(picks, gwFixtures, bootstrap, detailedData.players);
          liveByEntry[entryId] = {
            score,
            playersLeft: left.playersLeft,
            activePlayers: left.activePlayers,
          };
        } catch {
          // Skip if we can't compute live data for this entry
        }
      }));

      liveRound.matches.forEach((m: any) => {
        const live1 = liveByEntry[m.entry1?.entry];
        const live2 = m.entry2 ? liveByEntry[m.entry2.entry] : undefined;
        if (live1) {
          m.liveScore1 = live1.score;
          m.playersLeft1 = live1.playersLeft;
          m.activePlayers1 = live1.activePlayers;
        }
        if (!m.isBye && live2) {
          m.liveScore2 = live2.score;
          m.playersLeft2 = live2.playersLeft;
          m.activePlayers2 = live2.activePlayers;
        }
      });
    } catch (e: any) {
      console.error('[Cup] Failed to compute live scores:', e.message);
    }
  }

  const round1Matches = rounds[0]?.matches || [];
  const byeCount = round1Matches.filter((x: any) => x.isBye).length;
  const totalManagers = round1Matches.reduce((n: number, m: any) => n + (m.isBye ? 1 : 2), 0);

  return {
    cupStarted: true,
    cupName: 'Mini-League Cup',
    cupStartGW: sortedEvents[0] ?? CUP_START_GW,
    qualificationGW: (cupStatus as any)?.qualification_event ?? SEEDING_GW,
    currentGW,
    totalManagers,
    hasByes: byeCount > 0,
    byeCount,
    rounds,
  };
}
