/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures } from '../fpl/client';
import { fetchManagerPicksCached, fetchLiveGWDataCached } from '../data-cache';
import { resolveEffectiveCaptaincy } from '../../lib/utils';
import { isValidFormation, getEffectiveFormationCounts } from '../../lib/formation';

export async function fetchManagerPicksDetailed(entryId: any, gw: any, bootstrapData: any = null, sharedData: any = null): Promise<any> {
    // Use provided bootstrap or fetch it (fetching in parallel with other data)
    // sharedData allows callers to pass pre-fetched picks/liveData/fixtures to avoid redundant API calls
    const [bootstrap, picks, liveData, fixtures] = await Promise.all([
        bootstrapData ? Promise.resolve(bootstrapData) : fetchBootstrap(),
        sharedData?.picks ? Promise.resolve(sharedData.picks) : fetchManagerPicksCached(entryId, gw, bootstrapData),
        sharedData?.liveData ? Promise.resolve(sharedData.liveData) : fetchLiveGWDataCached(gw, bootstrapData),
        sharedData?.fixtures ? Promise.resolve(sharedData.fixtures) : fetchFixtures()
    ]) as any[];

    const gwFixtures = fixtures.filter((f: any) => f.event === gw);

    // Team colors mapping with short names
    const TEAM_COLORS: Record<number, any> = {
        1: { primary: '#EF0107', secondary: '#FFFFFF', short: 'ARS' },
        2: { primary: '#670E36', secondary: '#95BFE5', short: 'AVL' },
        3: { primary: '#DA291C', secondary: '#000000', short: 'BOU' },
        4: { primary: '#FFC659', secondary: '#000000', short: 'BRE' },
        5: { primary: '#0057B8', secondary: '#FFFFFF', short: 'BHA' },
        6: { primary: '#034694', secondary: '#FFFFFF', short: 'CHE' },
        7: { primary: '#1B458F', secondary: '#C4122E', short: 'CRY' },
        8: { primary: '#003399', secondary: '#FFFFFF', short: 'EVE' },
        9: { primary: '#000000', secondary: '#FFFFFF', short: 'FUL' },
        10: { primary: '#0044A9', secondary: '#FFFFFF', short: 'IPS' },
        11: { primary: '#003090', secondary: '#FDBE11', short: 'LEI' },
        12: { primary: '#C8102E', secondary: '#FFFFFF', short: 'LIV' },
        13: { primary: '#6CABDD', secondary: '#FFFFFF', short: 'MCI' },
        14: { primary: '#DA291C', secondary: '#FBE122', short: 'MUN' },
        15: { primary: '#241F20', secondary: '#FFFFFF', short: 'NEW' },
        16: { primary: '#DD0000', secondary: '#FFFFFF', short: 'NFO' },
        17: { primary: '#D71920', secondary: '#FFFFFF', short: 'SOU' },
        18: { primary: '#132257', secondary: '#FFFFFF', short: 'TOT' },
        19: { primary: '#7A263A', secondary: '#1BB1E7', short: 'WHU' },
        20: { primary: '#FDB913', secondary: '#231F20', short: 'WOL' }
    };

    // Helper to get ALL fixture info for a team (supports DGW with multiple fixtures)
    function getAllFixtureInfo(playerTeamId: any): any[] {
        const teamFixtures = gwFixtures.filter((f: any) => f.team_h === playerTeamId || f.team_a === playerTeamId);
        if (teamFixtures.length === 0) return [];

        return teamFixtures.map((fixture: any) => {
            const isHome = fixture.team_h === playerTeamId;
            const oppTeamId = isHome ? fixture.team_a : fixture.team_h;
            const oppTeam = bootstrap.teams.find((t: any) => t.id === oppTeamId);

            return {
                oppTeamId,
                oppName: oppTeam?.short_name || 'UNK',
                isHome,
                fixtureStarted: fixture.started,
                fixtureFinished: fixture.finished_provisional || fixture.finished || false,
                kickoffTime: fixture.kickoff_time,
                fixture  // Include full fixture for BPS lookup
            };
        });
    }

    // Helper to calculate provisional bonus from BPS for a fixture
    // Returns { elementId: bonusPoints } map for players who would get bonus
    function calculateProvisionalBonus(fixture: any): any {
        if (!fixture?.stats) return {};

        const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
        if (!bpsStat) return {};

        // Combine home and away BPS, sort descending
        const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
            .sort((a: any, b: any) => b.value - a.value);

        if (allBps.length === 0) return {};

        const bonusMap: Record<number, number> = {};
        let bonusRemaining = 3;
        let currentRank = 1;
        let i = 0;

        while (i < allBps.length && bonusRemaining > 0) {
            const currentBps = allBps[i].value;

            // Find all players tied at this BPS value
            const tiedPlayers: any[] = [];
            while (i < allBps.length && allBps[i].value === currentBps) {
                tiedPlayers.push(allBps[i].element);
                i++;
            }

            // Determine bonus for this rank
            let bonusForRank;
            if (currentRank === 1) bonusForRank = 3;
            else if (currentRank === 2) bonusForRank = 2;
            else if (currentRank === 3) bonusForRank = 1;
            else break;

            // All tied players get the same bonus
            tiedPlayers.forEach(elementId => {
                bonusMap[elementId] = bonusForRank;
            });

            // Advance rank by number of tied players
            currentRank += tiedPlayers.length;
            bonusRemaining = Math.max(0, 4 - currentRank);
        }

        return bonusMap;
    }

    // Pre-calculate provisional bonus for all started fixtures where official bonus isn't confirmed yet
    // This includes live matches AND finished_provisional matches (FT but bonus not in total_points)
    const provisionalBonusMap: Record<number, number> = {};
    gwFixtures.forEach((fixture: any) => {
        if (fixture.started && !fixture.finished) {
            const bonusForFixture = calculateProvisionalBonus(fixture);
            Object.assign(provisionalBonusMap, bonusForFixture);
        }
    });

    // Build player details
    const players = picks.picks.map((pick: any, idx: number) => {
        const element = bootstrap.elements.find((e: any) => e.id === pick.element);
        const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
        const team = bootstrap.teams.find((t: any) => t.id === element?.team);
        const position = bootstrap.element_types.find((et: any) => et.id === element?.element_type);
        const teamInfo = TEAM_COLORS[element?.team] || { primary: '#333', secondary: '#fff', short: 'UNK' };
        const teamCode = team?.code || element?.team; // Team code for shirt images

        // Get fixture/opponent info (supports DGW with multiple fixtures)
        const allFixtures = getAllFixtureInfo(element?.team);
        const hasNoGame = allFixtures.length === 0;
        const hasDoubleGameweek = allFixtures.length > 1;
        const anyFixtureStarted = allFixtures.some((f: any) => f.fixtureStarted);
        const allFixturesFinished = allFixtures.length > 0 && allFixtures.every((f: any) => f.fixtureFinished);
        const allFixturesStarted = allFixtures.length > 0 && allFixtures.every((f: any) => f.fixtureStarted);
        const anyFixtureInProgress = allFixtures.some((f: any) => f.fixtureStarted && !f.fixtureFinished);
        const minutes = liveElement?.stats?.minutes || 0;

        // For backward compat and display: pick the most relevant opponent
        // Priority: next unstarted fixture > in-progress fixture > first fixture
        const nextUpFixture = allFixtures.find((f: any) => !f.fixtureStarted)
            || allFixtures.find((f: any) => !f.fixtureFinished)
            || allFixtures[0];

        // Use aggregate flags: fixtureStarted = any started, fixtureFinished = ALL finished
        const fixtureStarted = anyFixtureStarted;
        const fixtureFinished = allFixturesFinished;

        // Determine play status across ALL fixtures
        // Check if any fixture in the GW has started (for blank gameweek detection)
        const gwHasStarted = gwFixtures.some((f: any) => f.started);
        let playStatus = 'not_started';
        if (hasNoGame && gwHasStarted) {
            playStatus = 'no_game';           // blank gameweek - team has no fixture
        } else if (anyFixtureStarted && minutes > 0) {
            if (anyFixtureInProgress) {
                playStatus = 'playing';       // match currently in progress
            } else if (allFixturesFinished) {
                playStatus = 'played';        // all done
            } else {
                playStatus = 'played';        // between DGW fixtures (won't be faded - see allFixturesFinished)
            }
        } else if (anyFixtureStarted && minutes === 0) {
            playStatus = allFixturesFinished ? 'benched' : 'not_played_yet';
        }

        // Get points breakdown from FPL's explain array (includes all stats like defensive contribution)
        const stats = liveElement?.stats || {};
        const posId = element?.element_type; // 1=GK, 2=DEF, 3=MID, 4=FWD

        // FPL provides explain array with exact points breakdown
        const explainData = liveElement?.explain || [];
        const pointsBreakdown: any[] = [];

        // Stat identifier to friendly name and icon mapping
        const STAT_INFO: Record<string, any> = {
            'minutes': { name: 'Minutes played', icon: '⏱️' },
            'goals_scored': { name: 'Goals scored', icon: '⚽' },
            'assists': { name: 'Assists', icon: '👟' },
            'clean_sheets': { name: 'Clean sheet', icon: '🛡️' },
            'goals_conceded': { name: 'Goals conceded', icon: '😞' },
            'own_goals': { name: 'Own goals', icon: '🔴' },
            'penalties_saved': { name: 'Penalties saved', icon: '🧤' },
            'penalties_missed': { name: 'Penalties missed', icon: '❌' },
            'yellow_cards': { name: 'Yellow cards', icon: '🟨' },
            'red_cards': { name: 'Red cards', icon: '🟥' },
            'saves': { name: 'Saves', icon: '✋' },
            'bonus': { name: 'Bonus', icon: '⭐' },
            'bps': { name: 'BPS', icon: '📊' },
            'defensive_contribution': { name: 'Defensive contribution', icon: '🔒' }
        };

        // Process each fixture's explain data
        explainData.forEach((fixture: any) => {
            if (fixture.stats) {
                fixture.stats.forEach((stat: any) => {
                    // Only include stats that have points (positive or negative)
                    if (stat.points !== 0) {
                        const info = STAT_INFO[stat.identifier] || { name: stat.identifier.replace(/_/g, ' '), icon: '📋' };
                        // Format value - for clean sheets show Yes instead of 1
                        let displayValue = stat.value;
                        if (stat.identifier === 'clean_sheets' && stat.value === 1) {
                            displayValue = 'Yes';
                        }
                        pointsBreakdown.push({
                            stat: info.name,
                            icon: info.icon,
                            value: displayValue,
                            points: stat.points,
                            identifier: stat.identifier
                        });
                    }
                });
            }
        });

        // Position-based event hierarchy:
        // - Minutes always first
        // - Bonus always last
        // - Other events ordered by relevance to position
        const positionHierarchy: Record<number, string[]> = {
            // GKP: saves and penalties_saved are core, then clean sheet, then attacking
            1: ['minutes', 'penalties_saved', 'saves', 'clean_sheets', 'goals_scored', 'assists', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // DEF: clean sheets most important, then attacking contribution
            2: ['minutes', 'clean_sheets', 'goals_scored', 'assists', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // MID: goals and assists primary, clean sheet secondary
            3: ['minutes', 'goals_scored', 'assists', 'clean_sheets', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // FWD: goals and assists are everything (no clean sheet points)
            4: ['minutes', 'goals_scored', 'assists', 'defensive_contribution', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus']
        };

        const hierarchy = positionHierarchy[posId] || positionHierarchy[4];
        pointsBreakdown.sort((a, b) => {
            const aIndex = hierarchy.indexOf(a.identifier);
            const bIndex = hierarchy.indexOf(b.identifier);
            // Unknown stats go before bonus but after known stats
            const aPos = aIndex === -1 ? hierarchy.length - 1 : aIndex;
            const bPos = bIndex === -1 ? hierarchy.length - 1 : bIndex;
            return aPos - bPos;
        });

        // Build event icons from points breakdown (shows what actually scored points)
        const events: any[] = [];
        pointsBreakdown.forEach(item => {
            if (item.points > 0 && item.identifier !== 'minutes') {
                // Use the icon from the breakdown
                events.push({
                    icon: item.icon,
                    count: typeof item.value === 'number' ? item.value : 1,
                    label: item.stat
                });
            }
        });
        // Add negative events too (yellow/red cards, etc)
        pointsBreakdown.forEach(item => {
            if (item.points < 0) {
                events.push({
                    icon: item.icon,
                    count: typeof item.value === 'number' ? item.value : 1,
                    label: item.stat,
                    negative: true
                });
            }
        });

        // Get BPS and bonus info
        const bps = stats.bps || 0;
        const officialBonus = stats.bonus || 0;
        // Show provisional bonus when match has started AND official bonus hasn't been added yet
        // This covers both live matches and finished_provisional matches (FT but bonus not confirmed)
        // When officialBonus > 0, the bonus is already included in total_points
        const provisionalBonus = (fixtureStarted && officialBonus === 0)
            ? (provisionalBonusMap[pick.element] || 0)
            : 0;

        // Player availability status from FPL API
        // status: 'a' (available), 'i' (injured), 'd' (doubtful), 's' (suspended), 'u' (unavailable), 'n' (not in squad)
        const playerStatus = element?.status || 'a';
        const chanceOfPlaying = element?.chance_of_playing_this_round ?? element?.chance_of_playing_next_round ?? null;
        const playerNews = element?.news || '';

        return {
            id: pick.element,
            name: element?.web_name || 'Unknown',
            fullName: `${element?.first_name} ${element?.second_name}`,
            position: position?.singular_name_short || 'UNK',
            positionId: element?.element_type,
            teamId: element?.team,
            teamName: team?.short_name || 'UNK',
            teamCode: teamCode,
            teamColors: teamInfo,
            opponent: nextUpFixture?.oppName || null,
            isHome: nextUpFixture?.isHome,
            points: stats.total_points || 0,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            // Derive multiplier from is_captain + position instead of pick.multiplier.
            // For completed GWs the FPL API rewrites pick.multiplier to reflect post-
            // auto-sub state (e.g. a captain who didn't play gets multiplier=0). If we
            // trusted that here, resolveEffectiveCaptaincy would then transfer the 0
            // onto the vice-captain, zeroing the VC's doubled contribution.
            multiplier: pick.is_captain ? (picks.active_chip === '3xc' ? 3 : 2) : (idx >= 11 ? 0 : 1),
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            pickPosition: idx,
            events,
            pointsBreakdown,
            totalPoints: stats.total_points || 0,
            playStatus,
            minutes,
            fixtureStarted,
            fixtureFinished,
            // DGW-specific fields
            hasDoubleGameweek,
            hasNoGame,
            allFixturesFinished,
            allFixturesStarted,
            fixtureDetails: allFixtures.map((f: any) => ({
                oppName: f.oppName,
                isHome: f.isHome,
                started: f.fixtureStarted,
                finished: f.fixtureFinished
            })),
            bps,
            officialBonus,
            provisionalBonus,
            // Player availability status
            playerStatus,
            chanceOfPlaying,
            playerNews
        };
    });

    // Auto-subs logic: if a starter has 0 minutes and fixture is finished/in-progress, find valid sub
    const starters = players.filter((p: any) => !p.isBench);
    const bench = players.filter((p: any) => p.isBench).sort((a: any, b: any) => a.benchOrder - b.benchOrder);

    // Check if any fixture in the GW has started (needed for blank gameweek auto-subs)
    const gwHasStartedForSubs = gwFixtures.some((f: any) => f.started);

    // Track who gets subbed
    const autoSubs: any[] = [];
    let adjustedPlayers: any[] = [...players];

    // Only apply auto-subs if not using Bench Boost
    if (picks.active_chip !== 'bboost') {
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find((p: any) => p.positionId === 1);
        const benchGK = bench.find((p: any) => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started
            // For blank GW (no game), trigger once any GW fixture has started
            const gkNeedsSub = startingGK.minutes === 0 &&
                (startingGK.allFixturesStarted || (startingGK.hasNoGame && gwHasStartedForSubs));
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                (benchGK.allFixturesStarted || (benchGK.hasNoGame && gwHasStartedForSubs)));

            if (gkNeedsSub && benchGKAvailable) {
                autoSubs.push({
                    out: { id: startingGK.id, name: startingGK.name },
                    in: { id: benchGK.id, name: benchGK.name }
                });

                const pOut = adjustedPlayers.find((p: any) => p.id === startingGK.id);
                const pIn = adjustedPlayers.find((p: any) => p.id === benchGK.id);
                if (pOut) pOut.subOut = true;
                if (pIn) pIn.subIn = true;

                startingGK.subOut = true;
                benchGK.subIn = true;
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
        // For blank GW (no game), trigger once any GW fixture has started
        const outfieldNeedsSub = starters.filter((p: any) =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && (p.allFixturesStarted || (p.hasNoGame && gwHasStartedForSubs))
        );
        const outfieldBench = bench.filter((p: any) => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && (benchPlayer.allFixturesStarted || (benchPlayer.hasNoGame && gwHasStartedForSubs))) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                // Adjust for proposed sub
                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    autoSubs.push({
                        out: { id: playerOut.id, name: playerOut.name },
                        in: { id: benchPlayer.id, name: benchPlayer.name }
                    });

                    const pOut = adjustedPlayers.find((p: any) => p.id === playerOut.id);
                    const pIn = adjustedPlayers.find((p: any) => p.id === benchPlayer.id);
                    if (pOut) pOut.subOut = true;
                    if (pIn) pIn.subIn = true;

                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    adjustedPlayers.forEach((p: any) => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // Capture the originally-selected captain and VC before resolveEffectiveCaptaincy
    // potentially moves the armband. When the VC inherits captaincy, the function
    // clears isViceCaptain on the inheriting player, so consumers that want to
    // display "the manager originally captained X / vice-captained Y" can't read
    // it back off the players array after the call.
    const originalCaptain = adjustedPlayers.find((p: any) => p.isCaptain);
    const originalViceCaptain = adjustedPlayers.find((p: any) => p.isViceCaptain);
    const originalCaptainId = originalCaptain?.id || null;
    const originalCaptainName = originalCaptain?.name || null;
    const originalViceCaptainId = originalViceCaptain?.id || null;
    const originalViceCaptainName = originalViceCaptain?.name || null;

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(adjustedPlayers, gwHasStartedForSubs);

    // Calculate actual points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;
    let benchProvisionalBonus = 0;

    adjustedPlayers.forEach((p: any) => {
        // Use actual multiplier from picks (3 for TC, 2 for normal captain, 1 for others)
        // After resolveEffectiveCaptaincy, the VC who inherited captaincy has the correct multiplier
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points * p.multiplier;
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
            benchProvisionalBonus += (p.provisionalBonus || 0);
        }
    });

    // For Bench Boost, add bench points to total (they all count)
    if (picks.active_chip === 'bboost') {
        totalPoints += benchPoints;
    }

    // Detect formation from effective starting 11
    const effectiveStarters = adjustedPlayers.filter((p: any) => (!p.isBench && !p.subOut) || p.subIn);
    const formation = {
        GKP: effectiveStarters.filter((p: any) => p.positionId === 1).length,
        DEF: effectiveStarters.filter((p: any) => p.positionId === 2).length,
        MID: effectiveStarters.filter((p: any) => p.positionId === 3).length,
        FWD: effectiveStarters.filter((p: any) => p.positionId === 4).length
    };
    const formationString = `${formation.DEF}-${formation.MID}-${formation.FWD}`;

    // Calculate base points and bonus separately for display (X+Y format)
    // After resolveEffectiveCaptaincy, multiplier is already correct for all players
    let basePoints = 0;
    let totalProvisionalBonus = 0;
    effectiveStarters.forEach((p: any) => {
        basePoints += (p.points || 0) * p.multiplier;
        totalProvisionalBonus += (p.provisionalBonus || 0) * p.multiplier;
    });

    // When Bench Boost is active, bench provisional bonus also counts towards total
    if (picks.active_chip === 'bboost') {
        totalProvisionalBonus += benchProvisionalBonus;
    }

    return {
        entryId,
        gameweek: gw,
        points: picks.entry_history?.points || 0,
        calculatedPoints: totalPoints,
        basePoints,
        totalProvisionalBonus,
        pointsOnBench: benchPoints + benchProvisionalBonus,
        activeChip: picks.active_chip,
        formation: formationString,
        players: adjustedPlayers,
        autoSubs,
        transfersCost: picks.entry_history?.event_transfers_cost || 0,
        originalCaptainId,
        originalCaptainName,
        originalViceCaptainId,
        originalViceCaptainName
    };
}
