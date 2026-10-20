import { describe, it, expect } from 'vitest';

import { preCalculateHallOfFame, calculatePerfectChipUsage } from '../src/server/services/hall-of-fame';
import { preCalculateManagerProfiles } from '../src/server/services/profiles';
import { seasonFromWeekHistory, weekRowFromPicks, gwScoreFromPicks } from '../src/server/services/season-scores';

// The Hall of Fame, profiles and the week page all read one stored row per
// manager per completed gameweek. These tests pin that the season records
// agree with what the scores table shows for each week.

const league = [
  { entry: 1, player_name: 'Cam', entry_name: 'Cam FC' },
  { entry: 2, player_name: 'Dee', entry_name: 'Dee FC' },
  { entry: 3, player_name: 'Eli', entry_name: 'Eli FC' },
];

/** Processed picks as preCalculatePicksData caches them. */
function picks(over: Record<string, any> = {}) {
  return {
    calculatedPoints: 60,
    totalProvisionalBonus: 0,
    transfersCost: 0,
    transfers: 0,
    pointsOnBench: 0,
    activeChip: null,
    teamValue: '100.0',
    players: [],
    autoSubs: [],
    ...over,
  };
}

/** Build the stored week history from processed picks, as buildWeekHistoryCache does. */
function weekHistory(byGW: Record<number, Record<number, Record<string, any>>>) {
  const out: Record<number, any> = {};
  for (const [gw, byEntry] of Object.entries(byGW)) {
    out[Number(gw)] = {
      managers: league
        .filter((m) => byEntry[m.entry])
        .map((m) => weekRowFromPicks(m, picks(byEntry[m.entry]))),
    };
  }
  return out;
}

describe('stored gameweek scores', () => {
  it('scores a week as gross plus provisional bonus minus the hit', () => {
    expect(gwScoreFromPicks(picks({ calculatedPoints: 70, totalProvisionalBonus: 3, transfersCost: 8 }))).toBe(65);
    expect(weekRowFromPicks(league[0], picks({ calculatedPoints: 70, totalProvisionalBonus: 3, transfersCost: 8 })).gwScore).toBe(65);
  });

  it('does not hand a weekly win to a manager whose hit cost them top spot', () => {
    // GW1: Cam scores the most gross (70) but took a -8, so 62 on the table;
    // Dee's 65 is the week's top score. GW2 and GW3 Cam wins outright.
    const history = weekHistory({
      1: { 1: { calculatedPoints: 70, transfersCost: 8 }, 2: { calculatedPoints: 65 }, 3: { calculatedPoints: 50 } },
      2: { 1: { calculatedPoints: 80 }, 2: { calculatedPoints: 40 }, 3: { calculatedPoints: 45 } },
      3: { 1: { calculatedPoints: 75 }, 2: { calculatedPoints: 55 }, 3: { calculatedPoints: 52 } },
    });
    const seasons = seasonFromWeekHistory(history, league, [1, 2, 3]);
    const hof = preCalculateHallOfFame(seasons, { losers: [] }, { winners: [] }, [1, 2, 3]);

    expect(hof.highlights.mostWeeklyWins).toMatchObject({ names: ['Cam'], count: 2 });

    // Each week's winner is exactly who tops that stored week's table.
    for (const gw of [1, 2, 3]) {
      const top = [...history[gw].managers].sort((a: any, b: any) => b.gwScore - a.gwScore)[0];
      expect(top.name).toBe(gw === 1 ? 'Dee' : 'Cam');
    }
  });

  it('reads highest and lowest GW, and profile records, as the table shows them', () => {
    const history = weekHistory({
      1: { 1: { calculatedPoints: 90, transfersCost: 12 }, 2: { calculatedPoints: 80 }, 3: { calculatedPoints: 30, transfersCost: 4 } },
    });
    const seasons = seasonFromWeekHistory(history, league, [1]);
    const hof = preCalculateHallOfFame(seasons, null, null, [1]);

    expect(hof.highlights.highestGW).toMatchObject({ names: ['Dee'], score: 80, gw: 1 });
    expect(hof.lowlights.lowestGW).toMatchObject({ names: ['Eli'], score: 26, gw: 1 });

    const profiles = preCalculateManagerProfiles({ standings: { results: league } }, seasons, null, null);
    expect(profiles[1].records.highestGW).toEqual({ points: 78, gw: 1 });
    expect(profiles[1].records.transferHits).toBe(12);
  });

  it('only reads completed gameweeks', () => {
    const history = weekHistory({
      1: { 1: { calculatedPoints: 50 }, 2: { calculatedPoints: 40 }, 3: { calculatedPoints: 45 } },
      2: { 1: { calculatedPoints: 10 }, 2: { calculatedPoints: 120 }, 3: { calculatedPoints: 12 } },
    });
    const hof = preCalculateHallOfFame(seasonFromWeekHistory(history, league, [1]), null, null, [1]);
    expect(hof.highlights.highestGW).toMatchObject({ names: ['Cam'], score: 50 });
  });

  it('judges every Bench Boost and Triple Captain use, with the effective captain', () => {
    const captain = (name: string, points: number, multiplier: number) => ({ id: 1, name, points, multiplier, isCaptain: true, isBench: false });
    const history = weekHistory({
      1: { 1: { pointsOnBench: 6, players: [captain('Salah', 8, 2)] } },
      2: { 1: { activeChip: 'bboost', pointsOnBench: 4, players: [captain('Salah', 5, 2)] } },
      // Second Bench Boost of the season: the bench earned 20.
      3: { 1: { activeChip: 'bboost', pointsOnBench: 20, players: [captain('Salah', 6, 2)] } },
      // Captain blanked and the vice inherited the armband at 3x.
      4: { 1: { activeChip: '3xc', originalCaptainName: 'Haaland', players: [captain('Palmer', 15, 3)] } },
    });
    const awards = calculatePerfectChipUsage(seasonFromWeekHistory(history, league, [1, 2, 3, 4]));

    expect(awards.perfectBB).toEqual([{ name: 'Cam', gw: 3, benchPoints: 20, maxOtherBench: 6 }]);
    expect(awards.worstBB).toEqual({ names: ['Cam'], benchPoints: 4, gw: 2 });
    expect(awards.perfectTC).toEqual([{ name: 'Cam', gw: 4, captainPoints: 15, player: 'Palmer' }]);
  });
});
