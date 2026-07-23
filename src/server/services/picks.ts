/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures } from '../fpl/client';
import { fetchManagerPicksCached, fetchLiveGWDataCached } from '../data-cache';
import { scoreSquad } from './scoring-core';

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

    // All scoring decisions (auto-subs, effective captaincy, provisional bonus,
    // chip handling) come from the shared core; this service only decorates the
    // scored players with display data (colors, fixtures, breakdowns, status).
    const scored = scoreSquad(picks, liveData, bootstrap, gwFixtures);

    // Build player details
    const players = picks.picks.map((pick: any, idx: number) => {
        const scoredPlayer = scored.players[idx];
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

        // Get BPS and bonus info (provisional bonus comes from the scoring core)
        const bps = stats.bps || 0;
        const officialBonus = stats.bonus || 0;
        const provisionalBonus = scoredPlayer?.provisionalBonus || 0;

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
            // Captaincy and multiplier come from the scoring core, already
            // resolved for auto-subs and vice-captain inheritance.
            isCaptain: scoredPlayer?.isCaptain ?? pick.is_captain,
            isViceCaptain: scoredPlayer?.isViceCaptain ?? pick.is_vice_captain,
            multiplier: scoredPlayer?.multiplier ?? (idx >= 11 ? 0 : 1),
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

    // Mirror the core's auto-sub flags onto the enriched players (keys are only
    // present on affected players, matching the historical payload shape).
    scored.players.forEach((sp: any, idx: number) => {
        if (sp.subOut) players[idx].subOut = true;
        if (sp.subIn) players[idx].subIn = true;
    });

    const autoSubs = scored.autoSubs;

    // Original (pre-inheritance) captain/VC for display
    const nameOf = (id: number | null) =>
        id ? (players.find((p: any) => p.id === id)?.name || null) : null;
    const originalCaptainId = scored.originalCaptainId;
    const originalViceCaptainId = scored.originalViceCaptainId;
    const originalCaptainName = nameOf(originalCaptainId);
    const originalViceCaptainName = nameOf(originalViceCaptainId);

    // Detect formation from effective starting 11
    const effectiveStarters = players.filter((p: any) => (!p.isBench && !p.subOut) || p.subIn);
    const formation = {
        GKP: effectiveStarters.filter((p: any) => p.positionId === 1).length,
        DEF: effectiveStarters.filter((p: any) => p.positionId === 2).length,
        MID: effectiveStarters.filter((p: any) => p.positionId === 3).length,
        FWD: effectiveStarters.filter((p: any) => p.positionId === 4).length
    };
    const formationString = `${formation.DEF}-${formation.MID}-${formation.FWD}`;

    // Base points for display (X+Y format): effective starters only, so under
    // Bench Boost the bench contribution shows in calculatedPoints, not here.
    let basePoints = 0;
    effectiveStarters.forEach((p: any) => {
        basePoints += (p.points || 0) * p.multiplier;
    });

    return {
        entryId,
        gameweek: gw,
        points: picks.entry_history?.points || 0,
        // Gross GW score excluding provisional bonus — callers (week, losers,
        // cup) add totalProvisionalBonus and subtract transfersCost themselves.
        calculatedPoints: scored.basePoints,
        basePoints,
        totalProvisionalBonus: scored.provisionalBonusPoints,
        pointsOnBench: scored.benchPoints,
        activeChip: picks.active_chip,
        formation: formationString,
        players,
        autoSubs,
        transfersCost: picks.entry_history?.event_transfers_cost || 0,
        transfers: picks.entry_history?.event_transfers || 0,
        teamValue: picks.entry_history?.value != null ? (picks.entry_history.value / 10).toFixed(1) : null,
        originalCaptainId,
        originalCaptainName,
        originalViceCaptainId,
        originalViceCaptainName
    };
}
