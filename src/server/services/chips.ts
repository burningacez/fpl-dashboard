/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchManagerHistory, fetchLeagueData } from '../fpl/client';

export async function fetchChipsData() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;
    const managers = leagueData.standings.results;

    const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'];

    const chipsData = await Promise.all(
        managers.map(async (m: any) => {
            const history = await fetchManagerHistory(m.entry);
            const usedChips = history.chips || [];

            const chipStatus: any = {
                firstHalf: {},
                secondHalf: {}
            };

            CHIP_TYPES.forEach(chipType => {
                const usedFirstHalf = usedChips.find((c: any) => c.name === chipType && c.event <= 19);
                if (usedFirstHalf) {
                    chipStatus.firstHalf[chipType] = { status: 'used', gw: usedFirstHalf.event };
                } else if (currentGW >= 20) {
                    chipStatus.firstHalf[chipType] = { status: 'expired' };
                } else {
                    chipStatus.firstHalf[chipType] = { status: 'available' };
                }

                const usedSecondHalf = usedChips.find((c: any) => c.name === chipType && c.event >= 20);
                if (usedSecondHalf) {
                    chipStatus.secondHalf[chipType] = { status: 'used', gw: usedSecondHalf.event };
                } else if (currentGW >= 20) {
                    chipStatus.secondHalf[chipType] = { status: 'available' };
                } else {
                    chipStatus.secondHalf[chipType] = { status: 'locked' };
                }
            });

            return {
                name: m.player_name,
                team: m.entry_name,
                chips: chipStatus,
                // entryId added for my-team highlighting (rewrite deviation)
                entryId: m.entry
            };
        })
    );

    return { leagueName: leagueData.league.name, managers: chipsData, currentGW };
}
