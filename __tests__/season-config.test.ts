import { describe, it, expect } from 'vitest';
import {
    SEASONS,
    DEFAULT_SEASON,
    getSeasonConfig,
    seasonLabel,
    nextSeasonId,
    totalPot,
    motmPeriodCount,
    motmTotalPrize,
    leagueLinks,
    validateSeasonConfig,
    type SeasonConfig,
} from '../src/lib/season-config';

describe('season-config module', () => {
    it('every SEASONS entry is valid and keyed by its own id', () => {
        for (const [key, cfg] of Object.entries(SEASONS)) {
            expect(cfg.id).toBe(key);
            expect(validateSeasonConfig(cfg)).toEqual([]);
        }
    });

    it('DEFAULT_SEASON has an entry', () => {
        expect(getSeasonConfig(DEFAULT_SEASON)).not.toBeNull();
    });

    it('getSeasonConfig returns null for unknown or missing ids', () => {
        expect(getSeasonConfig('1999-00')).toBeNull();
        expect(getSeasonConfig(null)).toBeNull();
        expect(getSeasonConfig(undefined)).toBeNull();
    });

    it('seasonLabel expands the short year', () => {
        expect(seasonLabel('2025-26')).toBe('2025-2026');
    });

    it('nextSeasonId advances one season, including century wrap', () => {
        expect(nextSeasonId('2025-26')).toBe('2026-27');
        expect(nextSeasonId('2098-99')).toBe('2099-00');
    });

    it('derived money helpers match the 2025-26 rules', () => {
        const cfg = SEASONS['2025-26'];
        expect(totalPot(cfg)).toBe(29 * 30 + 5 * 38);
        expect(motmPeriodCount(cfg)).toBe(9);
        expect(motmTotalPrize(cfg)).toBe(270);
    });

    it('league links derive from the league id', () => {
        const { fplLeague, livefpl } = leagueLinks(SEASONS['2025-26']);
        expect(fplLeague).toContain('/619028/');
        expect(livefpl).toContain('/619028');
    });

    describe('validateSeasonConfig', () => {
        const base = (): SeasonConfig => JSON.parse(JSON.stringify(SEASONS['2025-26']));

        it('rejects a bad id format', () => {
            const cfg = base();
            cfg.id = '25-26';
            expect(validateSeasonConfig(cfg)).not.toEqual([]);
        });

        it('rejects non-contiguous MOTM periods', () => {
            const cfg = base();
            cfg.motmPeriods[2] = [7, 9]; // leaves GW6 uncovered
            expect(validateSeasonConfig(cfg).join(' ')).toContain('contiguous');
        });

        it('rejects periods that stop short of totalWeeks', () => {
            const cfg = base();
            cfg.motmPeriods[9] = [34, 37];
            expect(validateSeasonConfig(cfg).join(' ')).toContain('GW1-38');
        });

        it('rejects seeding GW at or after cup start', () => {
            const cfg = base();
            cfg.cup.seedingGw = cfg.cup.startGw;
            expect(validateSeasonConfig(cfg).join(' ')).toContain('seedingGw');
        });

        it('rejects loser overrides outside the season', () => {
            const cfg = base();
            cfg.loserOverrides[39] = 'Nobody';
            expect(validateSeasonConfig(cfg).join(' ')).toContain('out-of-range');
        });

        it('rejects a non-positive league id', () => {
            const cfg = base();
            cfg.leagueId = 0;
            expect(validateSeasonConfig(cfg).join(' ')).toContain('leagueId');
        });

        it('accepts a different period count as long as it tiles the season', () => {
            const cfg = base();
            cfg.motmPeriods = { 1: [1, 19], 2: [20, 38] } as Record<number, [number, number]>;
            expect(validateSeasonConfig(cfg)).toEqual([]);
        });
    });
});
