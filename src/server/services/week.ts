/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import {
    fetchBootstrap,
    fetchFixtures,
    fetchLiveGWData,
    fetchManagerPicks,
    fetchManagerHistory,
    fetchLeagueData,
    fetchManagerData
} from '../fpl/client';
import { dataCache } from '../data-cache';
import {
    liveState,
    deduplicateNewEvents,
    MAX_CHANGE_EVENTS,
    MAX_CHRONO_EVENTS,
    EVENT_PRIORITY,
    loadChronologicalEvents,
    saveChronologicalEvents,
    clearChronologicalEvents,
    loadPreviousPlayerState,
    savePreviousPlayerState,
    clearPreviousPlayerState
} from '../live/state';
import { broadcastSSE } from '../live/sse-hub';
import { fetchManagerPicksDetailed } from '../services/picks';

export async function fetchWeekData(): Promise<any> {
    const [leagueData, bootstrap, fixtures]: [any, any, any] = await Promise.all([
        fetchLeagueData(),
        fetchBootstrap(),
        fetchFixtures()
    ]);

    const currentGWEvent = bootstrap.events.find((e: any) => e.is_current);
    let currentGW = currentGWEvent?.id || 1;
    let gwNotFinished = currentGWEvent && !currentGWEvent.finished;

    // Detect if the current GW is fully done and we should advance to the next GW.
    // The FPL API keeps is_current on a finished GW until the next GW's deadline passes,
    // but once the deadline passes, picks become available and we should show the new GW.
    const now = new Date();
    const apiCurrentGW = currentGW;
    let currentGWFixturesCheck = fixtures.filter((f: any) => f.event === currentGW);
    const isCurrentGWDone = currentGWEvent?.finished ||
        (currentGWFixturesCheck.length > 0 && currentGWFixturesCheck.every((f: any) => f.finished_provisional));

    if (isCurrentGWDone) {
        const nextEvent = bootstrap.events.find((e: any) => e.is_next) ||
                          bootstrap.events.find((e: any) => e.id === currentGW + 1);
        if (nextEvent && new Date(nextEvent.deadline_time) <= now) {
            console.log(`[Week] GW${currentGW} is done and GW${nextEvent.id} deadline passed - advancing to GW${nextEvent.id}`);
            currentGW = nextEvent.id;
            gwNotFinished = !nextEvent.finished;
        }
    }

    // Always clear cached live data for current GW to ensure fresh player points
    // (bonus points, corrections, etc. may have been added since last cache)
    delete dataCache.liveDataCache[currentGW];

    // Clear change events if gameweek has transitioned
    if (liveState.liveEventState.lastGW !== null && liveState.liveEventState.lastGW !== currentGW) {
        console.log(`[Week] Gameweek changed from ${liveState.liveEventState.lastGW} to ${currentGW}, clearing ticker events`);
        liveState.liveEventState.changeEvents = [];
        liveState.liveEventState.bonusPositions = {};
        liveState.liveEventState.cleanSheets = {};
        liveState.liveEventState.defcons = {};
        liveState.liveEventState.scores = {};
        // Clear chronological events and previous state for new GW
        liveState.chronologicalEvents = [];
        liveState.previousPlayerState = {};
        liveState.previousBonusPositions = {};
        await clearChronologicalEvents(liveState.liveEventState.lastGW);
        await clearPreviousPlayerState(liveState.liveEventState.lastGW);
    } else if (liveState.liveEventState.lastGW === null) {
        // First run - load existing chronological events and previous state from Redis
        await loadChronologicalEvents(currentGW);
        await loadPreviousPlayerState(currentGW);
    }
    liveState.liveEventState.lastGW = currentGW;

    const managers = leagueData.standings.results;
    const currentGWFixtures = fixtures.filter((f: any) => f.event === currentGW);

    // Smarter live detection:
    // Show LIVE only when matches have started or are within 1 hour of first kickoff
    const sortedFixtures = [...currentGWFixtures].sort((a, b) =>
        (new Date(a.kickoff_time) as any) - (new Date(b.kickoff_time) as any)
    );
    const firstKickoff = sortedFixtures.length > 0 ? new Date(sortedFixtures[0].kickoff_time) : null;
    const hasStartedMatches = currentGWFixtures.some((f: any) => f.started);
    const allMatchesFinished = currentGWFixtures.length > 0 && currentGWFixtures.every((f: any) => f.finished_provisional);
    const withinOneHour = firstKickoff && (now >= new Date(firstKickoff.getTime() - 60 * 60 * 1000));

    // Get live element data if GW not finished and matches starting soon or started
    let liveData: any = null;
    let liveDataSuccess = false;
    if (gwNotFinished && (withinOneHour || hasStartedMatches)) {
        try {
            liveData = await fetchLiveGWData(currentGW);
            liveDataSuccess = !!liveData;
        } catch (e: any) {
            console.error('[Week] Failed to fetch live data:', e.message);
        }
    }

    // isLive = matches have started AND we have live data (not just deadline passed)
    const isLive = hasStartedMatches && liveDataSuccess && !allMatchesFinished;

    const weekData: any[] = await Promise.all(
        managers.map(async (m: any) => {
            try {
                const [picks, history, managerInfo]: [any, any, any] = await Promise.all([
                    fetchManagerPicks(m.entry, currentGW),
                    fetchManagerHistory(m.entry),
                    fetchManagerData(m.entry)
                ]);

                const latestGW = history.current[history.current.length - 1];
                const teamValue = latestGW ? (latestGW.value / 10).toFixed(1) : '100.0';
                const bank = latestGW ? (latestGW.bank / 10).toFixed(1) : '0.0';

                // Get active chip
                const activeChip = picks.active_chip;

                // Calculate GW score - ALWAYS use fetchManagerPicksDetailed (same as pitch view)
                // This guarantees the weekly table score matches what's shown in the pitch view modal
                // IMPORTANT: Never trust processedPicksCache for the current GW - it may contain
                // stale data from before bonus was confirmed, or from previous code versions.
                // Always calculate fresh from live API data.
                let gwScore = picks.entry_history?.points || 0;
                let benchPoints = 0;
                const apiGWPoints = picks.entry_history?.points || 0;
                const apiTotalPoints = picks.entry_history?.total_points || 0;

                // Track effective captain and auto-sub info after resolution
                let effectiveCaptainId: any = null;
                let effectiveVCId: any = null;
                let detailedData: any = null;

                try {
                    const sharedData: any = { picks };
                    if (liveData) sharedData.liveData = liveData;
                    sharedData.fixtures = fixtures;

                    detailedData = await fetchManagerPicksDetailed(m.entry, currentGW, bootstrap, sharedData);
                    // Net GW score: calculatedPoints + provisional bonus (bonus is 0 for finished GWs),
                    // minus transfer cost. This matches what FPL shows as the manager's weekly score.
                    gwScore = detailedData.calculatedPoints + (detailedData.totalProvisionalBonus || 0) - (detailedData.transfersCost || 0);
                    benchPoints = detailedData.pointsOnBench || 0;
                    // Update cache so pitch view modal shows consistent data
                    dataCache.processedPicksCache[`${m.entry}-${currentGW}`] = detailedData;

                    // Get effective captain/VC after auto-sub captaincy resolution
                    const effCaptain = detailedData.players?.find((p: any) => p.isCaptain);
                    const effVC = detailedData.players?.find((p: any) => p.isViceCaptain);
                    effectiveCaptainId = effCaptain?.id || null;
                    effectiveVCId = effVC?.id || null;
                } catch (e: any) {
                    // Fallback to entry_history if calculation fails
                    gwScore = apiGWPoints;
                }

                // Calculate overall points: API total adjusted for calculated gwScore
                // This ensures live auto-sub/bonus calculations are reflected in overall.
                // Before a GW's entry_history exists (deadline passed, no points yet)
                // apiTotalPoints is 0, which would wrongly zero every manager's total —
                // fall back to the league standings total (season points to date).
                let priorTotal = apiTotalPoints - apiGWPoints;
                if (priorTotal <= 0 && (m.total || 0) > 0) priorTotal = m.total;
                const overallPoints = priorTotal + gwScore;

                // Calculate players who haven't played yet
                // In DGWs a team can have multiple fixtures, so count remaining
                // (unstarted) fixtures per team rather than a simple started flag
                const teamRemainingFixtures: Record<string, any> = {};
                const teamActiveFixtures: Record<string, any> = {};
                currentGWFixtures.forEach((f: any) => {
                    const increment = f.started ? 0 : 1;
                    teamRemainingFixtures[f.team_h] = (teamRemainingFixtures[f.team_h] || 0) + increment;
                    teamRemainingFixtures[f.team_a] = (teamRemainingFixtures[f.team_a] || 0) + increment;
                    // Count in-progress fixtures (started but not finished)
                    const active = (f.started && !f.finished_provisional && !f.finished) ? 1 : 0;
                    teamActiveFixtures[f.team_h] = (teamActiveFixtures[f.team_h] || 0) + active;
                    teamActiveFixtures[f.team_a] = (teamActiveFixtures[f.team_a] || 0) + active;
                });

                // Count players left
                // Each unstarted fixture counts as 1 per player (DGW = up to 2)
                // Captain multiplier: 2x (or 3x if Triple Captain chip is active)
                // Bench Boost means bench players (idx 11-14) also count
                // Use effective captain (may be VC if captain was auto-subbed out)
                // Account for auto-subs: exclude subbed-out starters, include subbed-in bench players
                const isBenchBoost = activeChip === 'bboost';
                const isTripleCaptain = activeChip === '3xc';
                let playersLeft = 0;
                let activePlayers = 0;

                // Build set of auto-subbed player IDs from detailedData
                const autoSubbedOutIds = new Set<any>();
                const autoSubbedInIds = new Set<any>();
                if (detailedData?.players) {
                    detailedData.players.forEach((p: any) => {
                        if (p.subOut) autoSubbedOutIds.add(p.id);
                        if (p.subIn) autoSubbedInIds.add(p.id);
                    });
                }

                picks.picks.forEach((pick: any, idx: number) => {
                    const element = bootstrap.elements.find((e: any) => e.id === pick.element);
                    if (element) {
                        const remaining = teamRemainingFixtures[element.team] || 0;
                        const activeCount = teamActiveFixtures[element.team] || 0;
                        // Effective squad: original starters minus subbed out, plus subbed in
                        const isOriginalStarter = idx < 11;
                        const wasSubbedOut = autoSubbedOutIds.has(pick.element);
                        const wasSubbedIn = autoSubbedInIds.has(pick.element);
                        const inSquad = isBenchBoost
                            || (isOriginalStarter && !wasSubbedOut)
                            || wasSubbedIn;
                        if (inSquad && remaining > 0) {
                            const isCaptain = effectiveCaptainId
                                ? (pick.element === effectiveCaptainId)
                                : pick.is_captain;
                            const multiplier = isCaptain ? (isTripleCaptain ? 3 : 2) : 1;
                            playersLeft += remaining * multiplier;
                        }
                        if (inSquad && activeCount > 0) {
                            activePlayers += activeCount;
                        }
                    }
                });

                // Free transfers (from previous GW)
                const freeTransfers = managerInfo.last_deadline_total_transfers !== undefined
                    ? Math.min(managerInfo.last_deadline_bank !== undefined ? 2 : 1, 2)
                    : 1;

                // Extract starting 11 player IDs and captain info for event impact
                // Use effective captain (VC inherits if captain auto-subbed out)
                const starting11 = picks.picks.slice(0, 11).map((p: any) => p.element);
                const benchPlayerIds = picks.picks.slice(11).map((p: any) => p.element);
                const captainId = effectiveCaptainId || picks.picks.find((p: any) => p.is_captain)?.element || null;
                const viceCaptainId = effectiveVCId || picks.picks.find((p: any) => p.is_vice_captain)?.element || null;
                const captainElement = captainId ? bootstrap.elements.find((e: any) => e.id === captainId) : null;
                const captainName = captainElement?.web_name || null;
                const viceCaptainElement = viceCaptainId ? bootstrap.elements.find((e: any) => e.id === viceCaptainId) : null;
                const viceCaptainName = viceCaptainElement?.web_name || null;

                // Build player->team map and defender IDs for team event impact
                // Include bench players when bench boost is active
                const playerTeamMap: Record<string, any> = {};
                const defenderIds: any[] = [];
                const squadSlice = activeChip === 'bboost' ? picks.picks : picks.picks.slice(0, 11);
                squadSlice.forEach((p: any) => {
                    const element = bootstrap.elements.find((e: any) => e.id === p.element);
                    if (element) {
                        playerTeamMap[p.element] = element.team;
                        // GK (1) and DEF (2) are affected by clean sheets
                        if (element.element_type === 1 || element.element_type === 2) {
                            defenderIds.push(p.element);
                        }
                    }
                });

                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore,
                    overallPoints,
                    playersLeft,
                    activePlayers,
                    teamValue,
                    bank,
                    benchPoints,
                    activeChip,
                    transfersMade: picks.entry_history?.event_transfers || 0,
                    transferCost: picks.entry_history?.event_transfers_cost || 0,
                    starting11,
                    benchPlayerIds,
                    captainId,
                    captainName,
                    viceCaptainId,
                    viceCaptainName,
                    playerTeamMap,
                    defenderIds,
                    autoSubsIn: (picks.automatic_subs || []).map((s: any) => s.element_in),
                    autoSubsOut: (picks.automatic_subs || []).map((s: any) => s.element_out)
                };
            } catch (e: any) {
                console.error(`[Week] Failed to fetch data for ${m.player_name}:`, e.message);
                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore: 0,
                    overallPoints: m.total || 0,
                    playersLeft: 12,
                    activePlayers: 0,
                    teamValue: '100.0',
                    bank: '0.0',
                    benchPoints: 0,
                    activeChip: null,
                    transfersMade: 0,
                    starting11: [],
                    benchPlayerIds: [],
                    captainId: null,
                    captainName: null,
                    viceCaptainId: null,
                    viceCaptainName: null,
                    playerTeamMap: {},
                    defenderIds: [],
                    autoSubsIn: [],
                    autoSubsOut: []
                };
            }
        })
    );

    // Sort by GW score
    weekData.sort((a, b) => b.gwScore - a.gwScore);
    weekData.forEach((m, i) => m.gwRank = i + 1);

    // Overall (total points) rank — the standings position the # column shows.
    // Derived from the same live-adjusted overallPoints as the Total column so
    // the two always agree; league rank breaks ties for equal totals.
    [...weekData]
        .sort((a, b) => (b.overallPoints - a.overallPoints) || (a.rank - b.rank))
        .forEach((m, i) => m.overallRank = i + 1);

    // Build squad player map for highlight feature (all players across all squads)
    const squadPlayers: Record<string, any> = {};
    weekData.forEach(m => {
        [...(m.starting11 || []), ...(m.benchPlayerIds || [])].forEach(elementId => {
            if (!squadPlayers[elementId]) {
                const element = bootstrap.elements.find((e: any) => e.id === elementId);
                if (element) {
                    squadPlayers[elementId] = {
                        name: element.web_name,
                        positionId: element.element_type,
                        teamId: element.team
                    };
                }
            }
        });
    });

    // Build teams list for highlight feature
    const plTeams = bootstrap.teams.map((t: any) => ({
        id: t.id,
        name: t.name,
        shortName: t.short_name
    })).sort((a: any, b: any) => a.name.localeCompare(b.name));

    // Extract live events from fixtures for ticker
    const liveEvents: any[] = [];

    // Add transfer hit events at the start (for managers with hits this GW)
    weekData.filter(m => m.transferCost > 0).forEach(m => {
        liveEvents.push({
            type: 'transfer_hit',
            elementId: null,
            player: m.name,
            team: '',
            match: '',
            icon: '📉',
            points: -m.transferCost,
            isTransferHit: true
        });
    });

    currentGWFixtures.forEach((fixture: any) => {
        if (!fixture.stats || !fixture.started) return;

        const homeTeam = bootstrap.teams.find((t: any) => t.id === fixture.team_h);
        const awayTeam = bootstrap.teams.find((t: any) => t.id === fixture.team_a);
        const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture.team_h_score ?? 0}-${fixture.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

        // Helper to get goal points by position
        const getGoalPoints = (posType: any) => posType <= 2 ? 6 : posType === 3 ? 5 : 4;

        // Extract goals
        const goalsStat = fixture.stats.find((s: any) => s.identifier === 'goals_scored');
        if (goalsStat) {
            [...(goalsStat.h || []), ...(goalsStat.a || [])].forEach(g => {
                const player = bootstrap.elements.find((e: any) => e.id === g.element);
                if (player) {
                    for (let i = 0; i < g.value; i++) {
                        liveEvents.push({
                            type: 'goal',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '⚽',
                            points: getGoalPoints(player.element_type)
                        });
                    }
                }
            });
        }

        // Extract assists
        const assistsStat = fixture.stats.find((s: any) => s.identifier === 'assists');
        if (assistsStat) {
            [...(assistsStat.h || []), ...(assistsStat.a || [])].forEach(a => {
                const player = bootstrap.elements.find((e: any) => e.id === a.element);
                if (player) {
                    for (let i = 0; i < a.value; i++) {
                        liveEvents.push({
                            type: 'assist',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '👟',
                            points: 3
                        });
                    }
                }
            });
        }

        // Extract yellow cards
        const yellowsStat = fixture.stats.find((s: any) => s.identifier === 'yellow_cards');
        if (yellowsStat) {
            [...(yellowsStat.h || []), ...(yellowsStat.a || [])].forEach(y => {
                const player = bootstrap.elements.find((e: any) => e.id === y.element);
                if (player) {
                    liveEvents.push({
                        type: 'yellow',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🟨',
                        points: -1
                    });
                }
            });
        }

        // Extract red cards
        const redsStat = fixture.stats.find((s: any) => s.identifier === 'red_cards');
        if (redsStat) {
            [...(redsStat.h || []), ...(redsStat.a || [])].forEach(r => {
                const player = bootstrap.elements.find((e: any) => e.id === r.element);
                if (player) {
                    liveEvents.push({
                        type: 'red',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🟥',
                        points: -3
                    });
                }
            });
        }

        // Extract own goals
        const ownGoalsStat = fixture.stats.find((s: any) => s.identifier === 'own_goals');
        if (ownGoalsStat) {
            [...(ownGoalsStat.h || []), ...(ownGoalsStat.a || [])].forEach(og => {
                const player = bootstrap.elements.find((e: any) => e.id === og.element);
                if (player) {
                    liveEvents.push({
                        type: 'own_goal',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '⚽',
                        points: -2
                    });
                }
            });
        }

        // Extract penalties saved
        const penSavedStat = fixture.stats.find((s: any) => s.identifier === 'penalties_saved');
        if (penSavedStat) {
            [...(penSavedStat.h || []), ...(penSavedStat.a || [])].forEach(ps => {
                const player = bootstrap.elements.find((e: any) => e.id === ps.element);
                if (player) {
                    liveEvents.push({
                        type: 'pen_save',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🧤',
                        points: 5
                    });
                }
            });
        }

        // Extract penalties missed
        const penMissedStat = fixture.stats.find((s: any) => s.identifier === 'penalties_missed');
        if (penMissedStat) {
            [...(penMissedStat.h || []), ...(penMissedStat.a || [])].forEach(pm => {
                const player = bootstrap.elements.find((e: any) => e.id === pm.element);
                if (player) {
                    liveEvents.push({
                        type: 'pen_miss',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '❌',
                        points: -2
                    });
                }
            });
        }

        // Extract saves (GK gets 1pt per 3 saves)
        const savesStat = fixture.stats.find((s: any) => s.identifier === 'saves');
        if (savesStat) {
            [...(savesStat.h || []), ...(savesStat.a || [])].forEach(s => {
                const player = bootstrap.elements.find((e: any) => e.id === s.element);
                if (player && s.value >= 3) {
                    const savePoints = Math.floor(s.value / 3);
                    liveEvents.push({
                        type: 'saves',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🧤',
                        points: savePoints,
                        detail: `${s.value} saves`
                    });
                }
            });
        }

        // Track clean sheets and goals conceded
        // team_h_score = goals scored BY home = goals conceded BY away
        // team_a_score = goals scored BY away = goals conceded BY home
        const homeTeamConceded = fixture.team_a_score || 0;
        const awayTeamConceded = fixture.team_h_score || 0;

        // Clean sheets - only show after 60 minutes (when CS points are actually awarded)
        // FPL awards CS points to players who play 60+ mins without conceding
        const fixtureMinutes = fixture.minutes || 0;

        if (fixture.started && fixtureMinutes >= 60 && homeTeamConceded === 0) {
            // Home team has clean sheet
            liveEvents.push({
                type: 'clean_sheet',
                elementId: null,
                player: homeTeam?.short_name || 'HOME',
                team: homeTeam?.short_name || '',
                match: matchLabel,
                icon: '🛡️',
                points: 4, // GK/DEF get 4 pts each
                teamId: fixture.team_h,
                isTeamEvent: true
            });
        }

        if (fixture.started && fixtureMinutes >= 60 && awayTeamConceded === 0) {
            // Away team has clean sheet
            liveEvents.push({
                type: 'clean_sheet',
                elementId: null,
                player: awayTeam?.short_name || 'AWAY',
                team: awayTeam?.short_name || '',
                match: matchLabel,
                icon: '🛡️',
                points: 4,
                teamId: fixture.team_a,
                isTeamEvent: true
            });
        }

        // Goals conceded - GK/DEF lose 1pt per 2 goals conceded
        if (homeTeamConceded >= 2) {
            const gcPoints = -Math.floor(homeTeamConceded / 2);
            liveEvents.push({
                type: 'goals_conceded',
                elementId: null,
                player: homeTeam?.short_name || 'HOME',
                team: homeTeam?.short_name || '',
                match: matchLabel,
                icon: '😞',
                points: gcPoints,
                teamId: fixture.team_h,
                isTeamEvent: true,
                detail: `${homeTeamConceded} conceded`
            });
        }

        if (awayTeamConceded >= 2) {
            const gcPoints = -Math.floor(awayTeamConceded / 2);
            liveEvents.push({
                type: 'goals_conceded',
                elementId: null,
                player: awayTeam?.short_name || 'AWAY',
                team: awayTeam?.short_name || '',
                match: matchLabel,
                icon: '😞',
                points: gcPoints,
                teamId: fixture.team_a,
                isTeamEvent: true,
                detail: `${awayTeamConceded} conceded`
            });
        }

        // Extract bonus points as single item per match with full BPS details
        const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
        if (bpsStat && fixture.started) {
            const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
                .sort((a, b) => b.value - a.value);

            if (allBps.length >= 1) {
                // Calculate who gets bonus
                const bonusPlayers: any[] = [];
                const nearMissPlayers: any[] = []; // Players just outside bonus
                let rank = 1;
                let i = 0;

                while (i < allBps.length && rank <= 3) {
                    const currentBps = allBps[i].value;
                    const tied: any[] = [];
                    while (i < allBps.length && allBps[i].value === currentBps) {
                        const player = bootstrap.elements.find((e: any) => e.id === allBps[i].element);
                        if (player) {
                            tied.push({
                                elementId: player.id,
                                name: player.web_name,
                                bps: currentBps,
                                bonus: rank === 1 ? 3 : rank === 2 ? 2 : 1
                            });
                        }
                        i++;
                    }
                    bonusPlayers.push(...tied);
                    rank += tied.length;
                }

                // Get next few players who are close to bonus (4th-6th)
                let nearMissCount = 0;
                while (i < allBps.length && nearMissCount < 3) {
                    const player = bootstrap.elements.find((e: any) => e.id === allBps[i].element);
                    if (player) {
                        nearMissPlayers.push({
                            elementId: player.id,
                            name: player.web_name,
                            bps: allBps[i].value,
                            bonus: 0
                        });
                    }
                    i++;
                    nearMissCount++;
                }

                liveEvents.push({
                    type: 'bonus',
                    elementId: null, // Multiple players
                    player: 'Bonus',
                    team: '',
                    match: matchLabel,
                    icon: '⭐',
                    points: null, // Varies per player
                    isBonus: true,
                    bonusPlayers,
                    nearMissPlayers,
                    fixtureId: fixture.id
                });
            }
        }
    });

    // Extract defensive contributions from live player data
    if (liveData && liveData.elements) {
        liveData.elements.forEach((liveElement: any) => {
            if (!liveElement.explain) return;

            liveElement.explain.forEach((fixture: any) => {
                if (!fixture.stats) return;

                const defconStat = fixture.stats.find((s: any) => s.identifier === 'defensive_contribution');
                if (defconStat && defconStat.points > 0) {
                    const player = bootstrap.elements.find((e: any) => e.id === liveElement.id);
                    if (player) {
                        // Find the fixture info for match label
                        const fixtureData = currentGWFixtures.find((f: any) => f.id === fixture.fixture);
                        let matchLabel = '';
                        if (fixtureData) {
                            const homeTeam = bootstrap.teams.find((t: any) => t.id === fixtureData.team_h);
                            const awayTeam = bootstrap.teams.find((t: any) => t.id === fixtureData.team_a);
                            matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixtureData.team_h_score ?? 0}-${fixtureData.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;
                        }

                        liveEvents.push({
                            type: 'defcon',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '🔒',
                            points: defconStat.points
                        });
                    }
                }
            });
        });
    }

    // Build fixtures summary for display
    const fixturesSummary = currentGWFixtures.map((f: any) => {
        const homeTeam = bootstrap.teams.find((t: any) => t.id === f.team_h);
        const awayTeam = bootstrap.teams.find((t: any) => t.id === f.team_a);

        return {
            id: f.id,
            home: homeTeam?.short_name || 'HOM',
            away: awayTeam?.short_name || 'AWY',
            homeScore: f.team_h_score,
            awayScore: f.team_a_score,
            started: f.started,
            finished: f.finished || f.finished_provisional,  // Show FT as soon as match ends
            kickoff: f.kickoff_time,
            minutes: f.minutes
        };
    }).sort((a: any, b: any) => (new Date(a.kickoff) as any) - (new Date(b.kickoff) as any));

    // Find next kickoff time
    const upcomingFixtures = currentGWFixtures
        .filter((f: any) => !f.started && f.kickoff_time)
        .sort((a: any, b: any) => (new Date(a.kickoff_time) as any) - (new Date(b.kickoff_time) as any));
    const nextKickoff = upcomingFixtures[0]?.kickoff_time || null;

    // ==========================================================================
    // CHANGE DETECTION - Compare current state with previous to detect changes
    // ==========================================================================
    const timestamp = now.toISOString();

    // Build current state
    const currentBonusPositions: Record<string, any> = {};
    const currentCleanSheets: Record<string, any> = {};
    const currentDefcons: Record<string, any> = {};
    const currentScores: Record<string, any> = {};

    // Extract current bonus positions from liveEvents
    liveEvents.filter(e => e.isBonus).forEach(e => {
        currentBonusPositions[e.fixtureId] = {};
        (e.bonusPlayers || []).forEach((bp: any) => {
            currentBonusPositions[e.fixtureId][bp.elementId] = bp.bonus;
        });
    });

    // Extract current clean sheet status
    currentGWFixtures.forEach((f: any) => {
        if (f.started) {
            const homeTeamConceded = f.team_a_score || 0;
            const awayTeamConceded = f.team_h_score || 0;
            currentCleanSheets[f.id] = {
                home: homeTeamConceded === 0,
                away: awayTeamConceded === 0,
                homeTeamId: f.team_h,
                awayTeamId: f.team_a
            };
            currentScores[f.id] = {
                home: f.team_h_score || 0,
                away: f.team_a_score || 0
            };
        }
    });

    // Extract current defcons from liveEvents
    liveEvents.filter(e => e.type === 'defcon').forEach(e => {
        currentDefcons[e.elementId] = true;
    });

    // Detect changes and create change events
    if (liveState.liveEventState.lastUpdate && isLive) {
        // Check for bonus changes
        Object.keys(currentBonusPositions).forEach(fixtureId => {
            const prevBonus = liveState.liveEventState.bonusPositions[fixtureId] || {};
            const currBonus = currentBonusPositions[fixtureId];

            const changes: any[] = [];
            const allPlayerIds = new Set([...Object.keys(prevBonus), ...Object.keys(currBonus)]);

            allPlayerIds.forEach(pid => {
                const prevPts = prevBonus[pid] || 0;
                const currPts = currBonus[pid] || 0;
                if (prevPts !== currPts) {
                    const player = bootstrap.elements.find((e: any) => e.id === parseInt(pid));
                    if (player) {
                        changes.push({
                            elementId: parseInt(pid),
                            player: player.web_name,
                            from: prevPts,
                            to: currPts,
                            impact: currPts - prevPts
                        });
                    }
                }
            });

            if (changes.length > 0) {
                const fixture = currentGWFixtures.find((f: any) => f.id === parseInt(fixtureId));
                const homeTeam = bootstrap.teams.find((t: any) => t.id === fixture?.team_h);
                const awayTeam = bootstrap.teams.find((t: any) => t.id === fixture?.team_a);
                const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture?.team_h_score ?? 0}-${fixture?.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

                liveState.liveEventState.changeEvents.unshift({
                    type: 'bonus_change',
                    match: matchLabel,
                    fixtureId: parseInt(fixtureId),
                    changes,
                    timestamp,
                    icon: '⭐',
                    minute: fixture?.minutes || null
                });
            }
        });

        // Check for clean sheet changes (lost)
        Object.keys(currentCleanSheets).forEach(fixtureId => {
            const prevCS = liveState.liveEventState.cleanSheets[fixtureId];
            const currCS = currentCleanSheets[fixtureId];

            if (prevCS) {
                const fixture = currentGWFixtures.find((f: any) => f.id === parseInt(fixtureId));
                const homeTeam = bootstrap.teams.find((t: any) => t.id === fixture?.team_h);
                const awayTeam = bootstrap.teams.find((t: any) => t.id === fixture?.team_a);
                const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture?.team_h_score ?? 0}-${fixture?.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

                // Home team lost clean sheet
                if (prevCS.home && !currCS.home) {
                    liveState.liveEventState.changeEvents.unshift({
                        type: 'cs_lost',
                        team: homeTeam?.short_name || 'HOME',
                        teamId: currCS.homeTeamId,
                        match: matchLabel,
                        fixtureId: parseInt(fixtureId),
                        timestamp,
                        icon: '💔',
                        points: -4, // GK/DEF lose 4 pts
                        minute: fixture?.minutes || null
                    });
                }

                // Away team lost clean sheet
                if (prevCS.away && !currCS.away) {
                    liveState.liveEventState.changeEvents.unshift({
                        type: 'cs_lost',
                        team: awayTeam?.short_name || 'AWAY',
                        teamId: currCS.awayTeamId,
                        match: matchLabel,
                        fixtureId: parseInt(fixtureId),
                        timestamp,
                        icon: '💔',
                        points: -4,
                        minute: fixture?.minutes || null
                    });
                }
            }
        });

        // Check for new defcons
        Object.keys(currentDefcons).forEach(pid => {
            if (!liveState.liveEventState.defcons[pid]) {
                const player = bootstrap.elements.find((e: any) => e.id === parseInt(pid));
                if (player) {
                    // Find the match this defcon is from
                    const defconEvent = liveEvents.find(e => e.type === 'defcon' && e.elementId === parseInt(pid));
                    liveState.liveEventState.changeEvents.unshift({
                        type: 'defcon_gained',
                        elementId: parseInt(pid),
                        player: player.web_name,
                        team: bootstrap.teams.find((t: any) => t.id === player.team)?.short_name || '',
                        match: defconEvent?.match || '',
                        timestamp,
                        icon: '🔒',
                        points: 1
                    });
                }
            }
        });

        // Trim change events to max
        if (liveState.liveEventState.changeEvents.length > MAX_CHANGE_EVENTS) {
            liveState.liveEventState.changeEvents = liveState.liveEventState.changeEvents.slice(0, MAX_CHANGE_EVENTS);
        }
    }

    // ==========================================================================
    // CHRONOLOGICAL EVENT DETECTION - Detect all events by comparing explain data
    // ==========================================================================
    const newChronoEvents: any[] = [];

    if (liveData && liveData.elements && isLive) {
        // Build lookup maps for O(1) access (instead of repeated .find() calls)
        const playerMap = new Map<any, any>(bootstrap.elements.map((e: any) => [e.id, e]));
        const teamMap = new Map<any, any>(bootstrap.teams.map((t: any) => [t.id, t]));
        const fixtureMap = new Map<any, any>(currentGWFixtures.map((f: any) => [f.id, f]));

        // Build current player state from explain data
        const currentPlayerState: Record<string, any> = {};

        liveData.elements.forEach((liveElement: any) => {
            if (!liveElement.explain) return;

            liveElement.explain.forEach((fixtureExplain: any) => {
                const fixtureId = fixtureExplain.fixture;
                const stateKey = `${fixtureId}_${liveElement.id}`;

                // Initialize state for this player/fixture
                // Note: Keys must match FPL API explain stat identifiers exactly
                currentPlayerState[stateKey] = {
                    goals_scored: 0,
                    assists: 0,
                    clean_sheets: 0,
                    goals_conceded: 0,
                    own_goals: 0,
                    penalties_saved: 0,
                    penalties_missed: 0,
                    yellow_cards: 0,
                    red_cards: 0,
                    saves: 0,
                    bonus: 0,
                    defensive_contribution: 0
                };

                // Extract points from each stat
                (fixtureExplain.stats || []).forEach((stat: any) => {
                    if (currentPlayerState[stateKey].hasOwnProperty(stat.identifier)) {
                        currentPlayerState[stateKey][stat.identifier] = stat.points;
                    }
                });
            });
        });

        // Helper functions using lookup maps (O(1) instead of O(n))
        const getMatchLabel = (fixtureId: any) => {
            const fixture = fixtureMap.get(fixtureId);
            if (!fixture) return '';
            const homeTeam = teamMap.get(fixture.team_h);
            const awayTeam = teamMap.get(fixture.team_a);
            return `${homeTeam?.short_name || 'HOM'} ${fixture.team_h_score ?? 0}-${fixture.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;
        };

        const getPlayerInfo = (elementId: any) => {
            const player = playerMap.get(elementId);
            if (!player) return null;
            const team = teamMap.get(player.team);
            return {
                id: player.id,
                name: player.web_name,
                team: team?.short_name || '',
                teamId: player.team,
                positionId: player.element_type // 1=GK, 2=DEF, 3=MID, 4=FWD
            };
        };

        // Event type mapping: explain identifier -> our event type
        // Keys must match FPL API explain stat identifiers exactly
        const statToEventType: Record<string, any> = {
            'goals_scored': 'goal',
            'assists': 'assist',
            'clean_sheets': 'clean_sheet',
            'goals_conceded': 'goals_conceded',
            'own_goals': 'own_goal',
            'penalties_saved': 'pen_save',
            'penalties_missed': 'pen_miss',
            'yellow_cards': 'yellow',
            'red_cards': 'red',
            'saves': 'saves',
            'defensive_contribution': 'defcon'
        };

        const statIcons: Record<string, any> = {
            'goal': '⚽',
            'assist': '👟',
            'clean_sheet': '🛡️',
            'goals_conceded': '😞',
            'own_goal': '🙈',
            'pen_save': '🧤',
            'pen_miss': '❌',
            'yellow': '🟨',
            'red': '🟥',
            'saves': '🧤',
            'defcon': '🔒'
        };

        // Only detect changes if we have previous state
        if (Object.keys(liveState.previousPlayerState).length > 0) {
            // Collect team events (clean sheets and goals conceded) by team+fixture
            // Structure: { 'fixtureId_teamId_statKey': { players: [], ... } }
            const teamEventBuckets: Record<string, any> = {};

            Object.keys(currentPlayerState).forEach(stateKey => {
                const [fixtureIdStr, elementIdStr] = stateKey.split('_');
                const fixtureId = parseInt(fixtureIdStr);
                const elementId = parseInt(elementIdStr);
                const prevState = liveState.previousPlayerState[stateKey] || {};
                const currState = currentPlayerState[stateKey];
                const playerInfo = getPlayerInfo(elementId);
                if (!playerInfo) return;

                const matchLabel = getMatchLabel(fixtureId);

                // Check each stat for changes
                Object.keys(currState).forEach(statKey => {
                    if (statKey === 'bonus') return; // Handle bonus separately

                    const prevPts = prevState[statKey] || 0;
                    const currPts = currState[statKey] || 0;
                    const diff = currPts - prevPts;

                    if (diff !== 0) {
                        const eventType = statToEventType[statKey];
                        if (!eventType) return;

                        // Clean sheets and goals conceded: group by team
                        if (statKey === 'clean_sheets' || statKey === 'goals_conceded') {
                            const bucketKey = `${fixtureId}_${playerInfo.teamId}_${statKey}`;
                            if (!teamEventBuckets[bucketKey]) {
                                teamEventBuckets[bucketKey] = {
                                    type: statKey === 'clean_sheets' ? 'team_clean_sheet' : 'team_goals_conceded',
                                    teamId: playerInfo.teamId,
                                    team: playerInfo.team,
                                    match: matchLabel,
                                    fixtureId,
                                    icon: statIcons[eventType],
                                    points: diff, // Points per player (for display)
                                    affectedPlayers: [],
                                    timestamp
                                };
                            }
                            teamEventBuckets[bucketKey].affectedPlayers.push({
                                elementId: playerInfo.id,
                                player: playerInfo.name,
                                points: diff
                            });
                        } else if (statKey === 'saves') {
                            // Saves: create individual +1 events (per point gained)
                            const eventsToAdd = Math.abs(diff);
                            for (let i = 0; i < eventsToAdd; i++) {
                                newChronoEvents.push({
                                    type: eventType,
                                    elementId: playerInfo.id,
                                    player: playerInfo.name,
                                    team: playerInfo.team,
                                    match: matchLabel,
                                    fixtureId,
                                    icon: statIcons[eventType],
                                    points: diff > 0 ? 1 : -1,
                                    timestamp
                                });
                            }
                        } else {
                            // For other events (goals, assists, cards, etc.), create one event per player
                            newChronoEvents.push({
                                type: eventType,
                                elementId: playerInfo.id,
                                player: playerInfo.name,
                                team: playerInfo.team,
                                match: matchLabel,
                                fixtureId,
                                icon: statIcons[eventType],
                                points: diff,
                                timestamp
                            });
                        }
                    }
                });
            });

            // Add team events to chronological events
            Object.values(teamEventBuckets).forEach(teamEvent => {
                // Sort affected players alphabetically
                teamEvent.affectedPlayers.sort((a: any, b: any) => a.player.localeCompare(b.player));
                newChronoEvents.push(teamEvent);
            });
        }

        // Handle bonus position changes (only when 3/2/1 positions change hands)
        const currentBonusHolders: Record<string, any> = {}; // { fixtureId: { 3: [ids], 2: [ids], 1: [ids] } }

        liveEvents.filter(e => e.isBonus).forEach(e => {
            currentBonusHolders[e.fixtureId] = { 3: [], 2: [], 1: [] };
            (e.bonusPlayers || []).forEach((bp: any) => {
                if (bp.bonus >= 1 && bp.bonus <= 3) {
                    currentBonusHolders[e.fixtureId][bp.bonus].push(bp.elementId);
                }
            });
        });

        // Compare bonus holders with previous
        if (Object.keys(liveState.previousBonusPositions).length > 0) {
            Object.keys(currentBonusHolders).forEach(fixtureIdStr => {
                const fixtureId = parseInt(fixtureIdStr);
                const prev = liveState.previousBonusPositions[fixtureId] || { 3: [], 2: [], 1: [] };
                const curr = currentBonusHolders[fixtureId];
                const matchLabel = getMatchLabel(fixtureId);

                // Check if the actual position holders changed (not just BPS values)
                const positionsChanged = [3, 2, 1].some(pos => {
                    const prevIds = (prev[pos] || []).sort().join(',');
                    const currIds = (curr[pos] || []).sort().join(',');
                    return prevIds !== currIds;
                });

                if (positionsChanged) {
                    // Build change details
                    const changes: any[] = [];
                    [3, 2, 1].forEach(pos => {
                        const prevIds = prev[pos] || [];
                        const currIds = curr[pos] || [];

                        // Players who gained this position
                        currIds.filter((id: any) => !prevIds.includes(id)).forEach((id: any) => {
                            const player = getPlayerInfo(id);
                            if (player) {
                                // Find what position they had before
                                let prevPos = 0;
                                [3, 2, 1].forEach(p => {
                                    if ((prev[p] || []).includes(id)) prevPos = p;
                                });
                                changes.push({
                                    elementId: id,
                                    player: player.name,
                                    from: prevPos,
                                    to: pos,
                                    impact: pos - prevPos
                                });
                            }
                        });

                        // Players who lost this position (and didn't gain another)
                        prevIds.filter((id: any) => !currIds.includes(id)).forEach((id: any) => {
                            // Check if they're in another position
                            const newPos = [3, 2, 1].find(p => (curr[p] || []).includes(id)) || 0;
                            if (newPos === 0) {
                                const player = getPlayerInfo(id);
                                if (player) {
                                    changes.push({
                                        elementId: id,
                                        player: player.name,
                                        from: pos,
                                        to: 0,
                                        impact: -pos
                                    });
                                }
                            }
                        });
                    });

                    if (changes.length > 0) {
                        newChronoEvents.push({
                            type: 'bonus_change',
                            match: matchLabel,
                            fixtureId,
                            icon: '⭐',
                            points: null,
                            changes,
                            timestamp
                        });
                    }
                }
            });
        }

        // Sort new events by priority, then alphabetically by player name
        newChronoEvents.sort((a, b) => {
            const priorityA = EVENT_PRIORITY[a.type] || 99;
            const priorityB = EVENT_PRIORITY[b.type] || 99;
            if (priorityA !== priorityB) return priorityA - priorityB;
            return (a.player || '').localeCompare(b.player || '');
        });

        // Deduplicate new events against existing chronological events.
        // This prevents duplicates when previousPlayerState loaded from Redis
        // is stale (e.g. after a server restart between polls).
        const dedupedEvents = deduplicateNewEvents(liveState.chronologicalEvents, newChronoEvents);

        // Append to chronological events and save
        if (dedupedEvents.length > 0) {
            liveState.chronologicalEvents.push(...dedupedEvents);
            // Limit array size to prevent unbounded growth
            if (liveState.chronologicalEvents.length > MAX_CHRONO_EVENTS) {
                liveState.chronologicalEvents = liveState.chronologicalEvents.slice(-MAX_CHRONO_EVENTS);
            }
            await saveChronologicalEvents(currentGW);
            broadcastSSE('new-events', { events: dedupedEvents });
            console.log(`[ChronoEvents] Added ${dedupedEvents.length} new events (total: ${liveState.chronologicalEvents.length})${dedupedEvents.length < newChronoEvents.length ? ` [${newChronoEvents.length - dedupedEvents.length} duplicates filtered]` : ''}`);
        } else if (newChronoEvents.length > 0) {
            console.log(`[ChronoEvents] All ${newChronoEvents.length} detected events were duplicates, skipped`);
        }

        // Update previous state AFTER successful save (prevents data loss if save fails)
        liveState.previousPlayerState = currentPlayerState;
        liveState.previousBonusPositions = currentBonusHolders;
        // Save previous state to Redis alongside chrono events to prevent
        // stale state after restarts from causing duplicate event detection
        await savePreviousPlayerState(currentGW);
    }

    // Update state for next comparison
    liveState.liveEventState.bonusPositions = currentBonusPositions;
    liveState.liveEventState.cleanSheets = currentCleanSheets;
    liveState.liveEventState.defcons = currentDefcons;
    liveState.liveEventState.scores = currentScores;
    liveState.liveEventState.lastUpdate = timestamp;

    // Build next GW info when the displayed GW is fully done (all matches finished)
    // and there's an upcoming GW. This allows the client to show an "incoming" banner.
    let nextGWInfo: any = null;
    if (allMatchesFinished) {
        const nextEvent = bootstrap.events.find((e: any) => e.is_next) ||
                          bootstrap.events.find((e: any) => e.id === currentGW + 1);
        if (nextEvent) {
            const nextGWFixturesList = fixtures.filter((f: any) => f.event === nextEvent.id);
            const nextGWSorted = nextGWFixturesList
                .filter((f: any) => f.kickoff_time)
                .sort((a: any, b: any) => (new Date(a.kickoff_time) as any) - (new Date(b.kickoff_time) as any));
            const nextFirstKickoff = nextGWSorted[0]?.kickoff_time || null;

            if (nextFirstKickoff) {
                nextGWInfo = {
                    gameweek: nextEvent.id,
                    deadline: nextEvent.deadline_time,
                    firstKickoff: nextFirstKickoff
                };
            }
        }
    }

    const refreshTime = new Date().toISOString();
    return {
        leagueName: leagueData.league.name,
        currentGW,
        isLive,
        managers: weekData,
        lastUpdated: refreshTime,
        liveEvents,
        chronologicalEvents: liveState.chronologicalEvents,
        changeEvents: liveState.liveEventState.changeEvents,
        fixtures: fixturesSummary,
        nextKickoff,
        nextGWInfo,
        squadPlayers,
        plTeams
    };
}

export async function refreshWeekData(): Promise<any> {
    console.log('[Week] Refreshing week data...');
    const startTime = Date.now();
    try {
        const weekData = await fetchWeekData();
        dataCache.week = weekData;
        dataCache.lastWeekRefresh = weekData.lastUpdated;
        broadcastSSE('sync', weekData);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Week] Refresh complete in ${duration}s`);
        return weekData;
    } catch (error: any) {
        console.error('[Week] Refresh failed:', error.message);
        throw error;
    }
}
