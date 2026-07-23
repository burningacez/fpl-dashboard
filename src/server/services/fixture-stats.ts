/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures } from '../fpl/client';
import { fetchLiveGWDataCached } from '../data-cache';

// Get player stats for a specific fixture
export async function getFixtureStats(fixtureId: any): Promise<any> {
    const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrap(),
        fetchFixtures()
    ]);

    const fixture = fixtures.find((f: any) => f.id === fixtureId);
    if (!fixture) {
        return { error: 'Fixture not found' };
    }

    if (!fixture.started) {
        return { error: 'Match not started yet' };
    }

    const gw: any = fixture.event;
    const liveData = await fetchLiveGWDataCached(gw, bootstrap);

    const POSITIONS: any = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

    // Elapsed match minutes used to infer substitutions from per-player minutes
    // (the FPL API caps player minutes at 90, so use 90 once finished).
    const matchOver = fixture.finished || fixture.finished_provisional;
    const matchMinutes = matchOver ? 90 : Math.min(fixture.minutes ?? 0, 90);

    // Pre-calculate provisional bonus for the fixture (handles ties correctly)
    const provisionalBonusMap: any = {};
    if (fixture.stats) {
        const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
        if (bpsStat) {
            const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
                .sort((a: any, b: any) => b.value - a.value);
            let currentRank = 1;
            let i = 0;
            while (i < allBps.length && currentRank <= 3) {
                const currentBps = (allBps[i] as any).value;
                const tiedPlayers: any[] = [];
                while (i < allBps.length && (allBps[i] as any).value === currentBps) {
                    tiedPlayers.push((allBps[i] as any).element);
                    i++;
                }
                const bonusForRank = currentRank === 1 ? 3 : currentRank === 2 ? 2 : currentRank === 3 ? 1 : 0;
                if (bonusForRank > 0) {
                    tiedPlayers.forEach(elementId => { provisionalBonusMap[elementId] = bonusForRank; });
                }
                currentRank += tiedPlayers.length;
            }
        }
    }

    // Helper to get player stats from live data
    const getPlayerStats = (element: any) => {
        const liveEl = liveData.elements.find((e: any) => e.id === element.id);
        if (!liveEl || !liveEl.stats) return null;

        const stats = liveEl.stats;
        // Only include players who played (minutes > 0)
        if (stats.minutes === 0) return null;

        // Get bonus: confirmed (already in total_points) or provisional (not yet)
        const officialBonus = stats.bonus || 0;
        const bonus = provisionalBonusMap[element.id] || 0;

        // Get player's BPS from fixture stats
        let bps = 0;
        if (fixture.stats) {
            const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
            if (bpsStat) {
                const playerBps = [...(bpsStat.h || []), ...(bpsStat.a || [])].find((b: any) => b.element === element.id);
                if (playerBps) bps = (playerBps as any).value;
            }
        }

        // Get saves from fixture stats
        let saves = 0;
        if (fixture.stats) {
            const savesStat = fixture.stats.find((s: any) => s.identifier === 'saves');
            if (savesStat) {
                const playerSaves = [...(savesStat.h || []), ...(savesStat.a || [])].find((s: any) => s.element === element.id);
                if (playerSaves) saves = (playerSaves as any).value;
            }
        }

        // Get defensive contribution count from fixture stats
        let defcon = 0;
        if (fixture.stats) {
            const defconStat = fixture.stats.find((s: any) => s.identifier === 'defensive_contribution');
            if (defconStat) {
                const playerDefcon = [...(defconStat.h || []), ...(defconStat.a || [])].find((d: any) => d.element === element.id);
                if (playerDefcon) defcon = (playerDefcon as any).value || 0;
            }
        }

        // Build points breakdown from explain data
        const explainData = liveEl?.explain || [];
        const pointsBreakdown: any[] = [];

        const STAT_INFO: any = {
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
            'defensive_contribution': { name: 'Defensive contribution', icon: '🔒' }
        };

        explainData.forEach((fixtureExplain: any) => {
            if (fixtureExplain.stats) {
                fixtureExplain.stats.forEach((stat: any) => {
                    if (stat.points !== 0) {
                        const info = STAT_INFO[stat.identifier] || { name: stat.identifier.replace(/_/g, ' '), icon: '📋' };
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
        const positionHierarchy: any = {
            // GKP: saves and penalties_saved are core, then clean sheet, then attacking
            1: ['minutes', 'penalties_saved', 'saves', 'clean_sheets', 'goals_scored', 'assists', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // DEF: clean sheets most important, then attacking contribution
            2: ['minutes', 'clean_sheets', 'goals_scored', 'assists', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // MID: goals and assists primary, clean sheet secondary
            3: ['minutes', 'goals_scored', 'assists', 'clean_sheets', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // FWD: goals and assists are everything (no clean sheet points)
            4: ['minutes', 'goals_scored', 'assists', 'defensive_contribution', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus']
        };

        const hierarchy = positionHierarchy[element.element_type] || positionHierarchy[4];
        pointsBreakdown.sort((a: any, b: any) => {
            const aIndex = hierarchy.indexOf(a.identifier);
            const bIndex = hierarchy.indexOf(b.identifier);
            // Unknown stats go before bonus but after known stats
            const aPos = aIndex === -1 ? hierarchy.length - 1 : aIndex;
            const bPos = bIndex === -1 ? hierarchy.length - 1 : bIndex;
            return aPos - bPos;
        });

        // Infer substitutions from minutes: a starter short of the elapsed match
        // minutes was withdrawn (unless sent off); a non-starter with minutes came
        // on. Live feeds can lag the fixture clock by a minute or two, so require
        // a 3-minute gap before flagging an in-play starter as subbed off.
        const started = stats.starts === 1;
        const subbedOff = started && !(stats.red_cards > 0) &&
            (matchOver ? stats.minutes < 90 : matchMinutes - stats.minutes > 3);
        const subbedOn = !started && stats.minutes > 0;

        // Get team info
        const team = bootstrap.teams.find((t: any) => t.id === element.team);

        return {
            id: element.id,
            name: element.web_name,
            fullName: `${element.first_name} ${element.second_name}`,
            position: POSITIONS[element.element_type] || 'UNK',
            positionId: element.element_type,
            teamName: team?.short_name || 'UNK',
            teamCode: team?.code || 1,
            points: stats.total_points,
            // Provisional bonus: show when match has started and bonus not yet confirmed in total_points
            provisionalBonus: (fixture.started && officialBonus === 0) ? bonus : 0,
            goals: stats.goals_scored || 0,
            assists: stats.assists || 0,
            cleanSheet: stats.clean_sheets > 0,
            saves: saves,
            defcon: defcon,
            yellowCard: stats.yellow_cards > 0,
            redCard: stats.red_cards > 0,
            bonus: bonus,
            bps: bps,
            minutes: stats.minutes,
            started,
            subbedOff,
            offMinute: subbedOff ? stats.minutes : 0,
            subbedOn,
            onMinute: subbedOn ? Math.max(matchMinutes - stats.minutes, 1) : 0,
            pointsBreakdown
        };
    };

    // Sort by position (GKP=1, DEF=2, MID=3, FWD=4) then by points within position
    const sortByPosition = (a: any, b: any) => {
        if (a.positionId !== b.positionId) return a.positionId - b.positionId;
        return (b.points + b.provisionalBonus) - (a.points + a.provisionalBonus);
    };

    // Separate starters from subs based on whether they started the match
    const separateStartersAndSubs = (players: any[]) => {
        const starters = players.filter((p: any) => p.started).sort(sortByPosition);
        const subs = players.filter((p: any) => !p.started).sort(sortByPosition);
        return { starters, subs };
    };

    // Get all players from both teams
    const homeAll = bootstrap.elements
        .filter((e: any) => e.team === fixture.team_h)
        .map(getPlayerStats)
        .filter((p: any) => p !== null);
    const homeSplit = separateStartersAndSubs(homeAll);

    const awayAll = bootstrap.elements
        .filter((e: any) => e.team === fixture.team_a)
        .map(getPlayerStats)
        .filter((p: any) => p !== null);
    const awaySplit = separateStartersAndSubs(awayAll);

    return {
        home: { starters: homeSplit.starters, subs: homeSplit.subs },
        away: { starters: awaySplit.starters, subs: awaySplit.subs },
        fixtureId,
        homeScore: fixture.team_h_score,
        awayScore: fixture.team_a_score,
        finished: fixture.finished,
        finishedProvisional: fixture.finished_provisional
    };
}
