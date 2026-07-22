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
 * Cup bracket data — verbatim transliteration of the inline '/api/cup'
 * handler from legacy/server.js (:7106-7414), including the MOCK_CUP_DATA
 * block and all bracket/seeding logic.
 */
export async function buildCupData(): Promise<any> {
  // Mini-league cup configuration — season-specific (e.g. 25/26: starts GW34,
  // bracket drawn after GW33 ends based on GW33 net scores)
  const { startGw: CUP_START_GW, seedingGw: SEEDING_GW } = getActiveSeasonConfig().cup;
  const MOCK_CUP_DATA = config.fpl.MOCK_CUP_DATA;

  const bootstrap = await fetchBootstrap();
  const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 1;

  // Mock data for testing UI (remove for production)
  if (MOCK_CUP_DATA) {
    const managers = [
      { entry: 70252, name: 'Pieter Sayer', team: 'La Seleccion' },
      { entry: 656869, name: 'Rich Cooper', team: 'Coopers Troopers' },
      { entry: 3964451, name: 'Doug Stephenson', team: 'DS' },
      { entry: 2918350, name: 'Dean Thompson', team: 'CBS United' },
      { entry: 318792, name: 'Ewan Pirrie', team: 'A Cunha Mateta' },
      { entry: 1013421, name: 'Alex Hogan', team: "TINDALL'S UCL MAGS" },
      { entry: 2071480, name: 'Arran May', team: 'Isles of Scilly FC' },
      { entry: 1624536, name: 'Simon Bays', team: 'Aston Villalobos' },
      { entry: 3931649, name: 'Calum Smith', team: 'BootCutIsBack' },
      { entry: 753357, name: 'Janek Metelski', team: 'Jan Utd' },
      { entry: 2383752, name: 'Harrylujah', team: 'Derry Rhumba!!!' },
      { entry: 1282728, name: 'James Armstrong', team: 'Obi-Wan Cunha-bi' },
      { entry: 323126, name: 'Tom Powell', team: 'Good Ebening' },
      { entry: 5719661, name: 'Cammy Murrie', team: 'Beef Cherki' },
      { entry: 4616973, name: 'Kyal Mapara', team: 'Gyok It Like Its Hot' },
      { entry: 808774, name: 'craig macdonald', team: 'Half The World (A)' },
      { entry: 119985, name: 'Kenny Jones', team: 'BrokenStonesXI' },
      { entry: 1380538, name: 'Harry Strouts', team: 'Melbourne Blues' },
      { entry: 7673766, name: 'Jasper Gray', team: 'Casemiro Royale' },
      { entry: 810727, name: 'Mike Garty', team: 'FC Gartetaserey' },
      { entry: 1405359, name: 'Barry Evans', team: 'Bueno Naughty' },
      { entry: 4982573, name: 'Nadin Khoda', team: 'FC Nadz' },
      { entry: 2783391, name: 'Marcus Black', team: 'shiit briik' },
      { entry: 4448148, name: 'Fraser Doig', team: 'Hahahaland' },
      { entry: 4616587, name: 'Grant Clark', team: 'FrimPingPong' },
      { entry: 1412038, name: 'Simon Bell', team: 'BFC' },
      { entry: 3215944, name: 'VÍCTOR MACÍAS LARI', team: 'Unreal Madrid' },
      { entry: 1282268, name: 'Logan Garty', team: 'hay joonz terrors' },
      { entry: 7636212, name: 'Charlie Hall', team: 'Haaland & Barrett' },
    ];

    // Simulate completed cup - 29 managers, 3 byes needed
    // Round of 32: 13 matches + 3 byes = 16 winners
    const round1 = {
      name: 'Round of 32',
      event: 34,
      isLive: false,
      isComplete: true,
      matches: [
        // 3 byes for top 3 seeds
        { entry1: managers[0], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
        { entry1: managers[1], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
        { entry1: managers[2], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
        // 13 actual matches
        { entry1: managers[3], entry2: managers[28], score1: 67, score2: 54, winner: 1 },
        { entry1: managers[4], entry2: managers[27], score1: 72, score2: 71, winner: 1 },
        { entry1: managers[5], entry2: managers[26], score1: 58, score2: 63, winner: 2 },
        { entry1: managers[6], entry2: managers[25], score1: 81, score2: 45, winner: 1 },
        { entry1: managers[7], entry2: managers[24], score1: 55, score2: 55, winner: 2, tiebreak: 'goals scored' },
        { entry1: managers[8], entry2: managers[23], score1: 49, score2: 52, winner: 2 },
        { entry1: managers[9], entry2: managers[22], score1: 77, score2: 66, winner: 1 },
        { entry1: managers[10], entry2: managers[21], score1: 61, score2: 59, winner: 1 },
        { entry1: managers[11], entry2: managers[20], score1: 44, score2: 88, winner: 2 },
        { entry1: managers[12], entry2: managers[19], score1: 73, score2: 70, winner: 1 },
        { entry1: managers[13], entry2: managers[18], score1: 56, score2: 62, winner: 2 },
        { entry1: managers[14], entry2: managers[17], score1: 69, score2: 41, winner: 1 },
        { entry1: managers[15], entry2: managers[16], score1: 50, score2: 53, winner: 2 },
      ],
    };

    // Round of 16 winners from round 1
    const r16Players = [
      managers[0], managers[1], managers[2], managers[3], // byes + Dean
      managers[4], managers[26], managers[6], managers[24], // Ewan, Victor, Arran, Grant
      managers[23], managers[9], managers[10], managers[20], // Fraser, Janek, Harrylujah, Barry
      managers[12], managers[18], managers[14], managers[16], // Tom, Jasper, Kyal, Kenny
    ];

    const round2 = {
      name: 'Round of 16',
      event: 35,
      isLive: false,
      isComplete: true,
      matches: [
        { entry1: r16Players[0], entry2: r16Players[15], score1: 82, score2: 65, winner: 1 },
        { entry1: r16Players[1], entry2: r16Players[14], score1: 71, score2: 74, winner: 2 },
        { entry1: r16Players[2], entry2: r16Players[13], score1: 59, score2: 48, winner: 1 },
        { entry1: r16Players[3], entry2: r16Players[12], score1: 66, score2: 66, winner: 1, tiebreak: 'goals scored' },
        { entry1: r16Players[4], entry2: r16Players[11], score1: 77, score2: 81, winner: 2 },
        { entry1: r16Players[5], entry2: r16Players[10], score1: 53, score2: 49, winner: 1 },
        { entry1: r16Players[6], entry2: r16Players[9], score1: 68, score2: 72, winner: 2 },
        { entry1: r16Players[7], entry2: r16Players[8], score1: 61, score2: 55, winner: 1 },
      ],
    };

    // Quarter-final players
    const qfPlayers = [
      managers[0], managers[14], managers[2], managers[3],
      managers[20], managers[26], managers[9], managers[24],
    ];

    const round3 = {
      name: 'Quarter-Finals',
      event: 36,
      isLive: false,
      isComplete: true,
      matches: [
        { entry1: qfPlayers[0], entry2: qfPlayers[7], score1: 91, score2: 78, winner: 1 },
        { entry1: qfPlayers[1], entry2: qfPlayers[6], score1: 64, score2: 69, winner: 2 },
        { entry1: qfPlayers[2], entry2: qfPlayers[5], score1: 57, score2: 52, winner: 1 },
        { entry1: qfPlayers[3], entry2: qfPlayers[4], score1: 73, score2: 85, winner: 2 },
      ],
    };

    // Semi-final players
    const sfPlayers = [managers[0], managers[9], managers[2], managers[20]];

    const round4 = {
      name: 'Semi-Finals',
      event: 37,
      isLive: false,
      isComplete: true,
      matches: [
        { entry1: sfPlayers[0], entry2: sfPlayers[1], score1: 84, score2: 79, winner: 1 },
        { entry1: sfPlayers[2], entry2: sfPlayers[3], score1: 62, score2: 71, winner: 2 },
      ],
    };

    // Final
    const round5 = {
      name: 'Final',
      event: 38,
      isLive: true, // Simulating live final
      isComplete: false,
      matches: [
        { entry1: managers[0], entry2: managers[20], score1: 45, score2: 52, winner: null, liveScore1: 45, liveScore2: 52, bonusScore1: 3, bonusScore2: 0, playersLeft1: 4, playersLeft2: 2, activePlayers1: 1, activePlayers2: 0 },
      ],
    };

    return {
      cupStarted: true,
      cupName: 'Si and chums Cup',
      cupStartGW: CUP_START_GW,
      qualificationGW: 33,
      currentGW: 38, // Simulating GW38
      totalManagers: 29,
      hasByes: true,
      byeCount: 3,
      rounds: [round1, round2, round3, round4, round5],
    };
  }

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
