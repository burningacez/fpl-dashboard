// Note: Config module validates on load, so we test the exported values
// For validation testing, we would need to mock environment variables

const config = require('../config');

describe('config module', () => {
    describe('exports required configuration groups', () => {
        it('exports server config', () => {
            expect(config.server).toBeDefined();
            expect(typeof config.server.PORT).toBe('number');
            expect(typeof config.server.NODE_ENV).toBe('string');
        });

        it('exports league config', () => {
            expect(config.league).toBeDefined();
            expect(typeof config.league.LEAGUE_ID).toBe('number');
            expect(typeof config.league.CURRENT_SEASON).toBe('string');
        });

        it('exports api config', () => {
            expect(config.api).toBeDefined();
            expect(typeof config.api.FPL_API_BASE_URL).toBe('string');
            expect(typeof config.api.API_TIMEOUT_MS).toBe('number');
        });

        it('exports fpl config', () => {
            expect(config.fpl).toBeDefined();
            expect(config.fpl.MOTM_PERIODS).toBeDefined();
            expect(config.fpl.ALL_CHIPS).toBeDefined();
            expect(config.fpl.LOSER_OVERRIDES).toBeDefined();
            expect(config.fpl.POSITIONS).toBeDefined();
        });

        it('exports limits config', () => {
            expect(config.limits).toBeDefined();
            expect(typeof config.limits.MAX_CHANGE_EVENTS).toBe('number');
            expect(typeof config.limits.MAX_CHRONO_EVENTS).toBe('number');
            expect(typeof config.limits.MAX_BODY_SIZE).toBe('number');
        });

        it('exports events config', () => {
            expect(config.events).toBeDefined();
            expect(config.events.EVENT_PRIORITY).toBeDefined();
        });
    });

    describe('top-level convenience exports', () => {
        it('exports LEAGUE_ID at top level', () => {
            expect(config.LEAGUE_ID).toBe(config.league.LEAGUE_ID);
        });

        it('exports CURRENT_SEASON at top level', () => {
            expect(config.CURRENT_SEASON).toBe(config.league.CURRENT_SEASON);
        });

        it('exports PORT at top level', () => {
            expect(config.PORT).toBe(config.server.PORT);
        });

        it('exports API_TIMEOUT_MS at top level', () => {
            expect(config.API_TIMEOUT_MS).toBe(config.api.API_TIMEOUT_MS);
        });

        it('exports FPL_API_BASE_URL at top level', () => {
            expect(config.FPL_API_BASE_URL).toBe(config.api.FPL_API_BASE_URL);
        });
    });

    describe('MOTM_PERIODS', () => {
        it('has exactly 9 periods', () => {
            expect(Object.keys(config.fpl.MOTM_PERIODS).length).toBe(9);
        });

        it('each period has valid GW range', () => {
            Object.entries(config.fpl.MOTM_PERIODS).forEach(([num, [start, end]]) => {
                expect(start).toBeGreaterThanOrEqual(1);
                expect(end).toBeLessThanOrEqual(38);
                expect(start).toBeLessThanOrEqual(end);
            });
        });

        it('covers all 38 gameweeks', () => {
            const allGWs = new Set();
            Object.values(config.fpl.MOTM_PERIODS).forEach(([start, end]) => {
                for (let gw = start; gw <= end; gw++) {
                    allGWs.add(gw);
                }
            });
            expect(allGWs.size).toBe(38);
        });
    });

    describe('POSITIONS', () => {
        it('has all 4 positions', () => {
            expect(config.fpl.POSITIONS[1]).toBe('GKP');
            expect(config.fpl.POSITIONS[2]).toBe('DEF');
            expect(config.fpl.POSITIONS[3]).toBe('MID');
            expect(config.fpl.POSITIONS[4]).toBe('FWD');
        });
    });

    describe('ALL_CHIPS', () => {
        it('has all 4 chips', () => {
            expect(config.fpl.ALL_CHIPS).toContain('wildcard');
            expect(config.fpl.ALL_CHIPS).toContain('freehit');
            expect(config.fpl.ALL_CHIPS).toContain('bboost');
            expect(config.fpl.ALL_CHIPS).toContain('3xc');
            expect(config.fpl.ALL_CHIPS.length).toBe(4);
        });
    });

    describe('EVENT_PRIORITY', () => {
        it('has priority for all event types', () => {
            const expectedEvents = [
                'goal', 'assist', 'pen_save', 'pen_miss', 'own_goal',
                'red', 'yellow', 'clean_sheet', 'goals_conceded',
                'saves', 'bonus_change', 'defcon'
            ];
            expectedEvents.forEach(event => {
                expect(typeof config.events.EVENT_PRIORITY[event]).toBe('number');
            });
        });

        it('goal has highest priority (lowest number)', () => {
            expect(config.events.EVENT_PRIORITY.goal).toBe(1);
        });
    });

    describe('CUP configuration', () => {
        it('CUP_START_GW is valid', () => {
            expect(config.fpl.CUP_START_GW).toBeGreaterThanOrEqual(1);
            expect(config.fpl.CUP_START_GW).toBeLessThanOrEqual(38);
        });

        it('SEEDING_GW is before CUP_START_GW', () => {
            expect(config.fpl.SEEDING_GW).toBeLessThan(config.fpl.CUP_START_GW);
        });
    });

    describe('API configuration', () => {
        it('FPL_API_BASE_URL is valid URL', () => {
            expect(config.api.FPL_API_BASE_URL).toMatch(/^https:\/\//);
        });

        it('API_TIMEOUT_MS is reasonable', () => {
            expect(config.api.API_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
            expect(config.api.API_TIMEOUT_MS).toBeLessThanOrEqual(60000);
        });
    });

    describe('limits configuration', () => {
        it('MAX_CHANGE_EVENTS is positive', () => {
            expect(config.limits.MAX_CHANGE_EVENTS).toBeGreaterThan(0);
        });

        it('MAX_CHRONO_EVENTS is positive', () => {
            expect(config.limits.MAX_CHRONO_EVENTS).toBeGreaterThan(0);
        });

        it('MAX_BODY_SIZE is positive', () => {
            expect(config.limits.MAX_BODY_SIZE).toBeGreaterThan(0);
        });
    });
});
