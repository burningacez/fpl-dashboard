import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisGet, redisSet } = vi.hoisted(() => ({
    redisGet: vi.fn(),
    redisSet: vi.fn(),
}));

vi.mock('../src/server/redis', () => ({
    redisGet,
    redisSet,
    redisConfigured: () => true,
}));

async function freshModule() {
    // The module keeps its state on globalThis so route bundles share it —
    // wipe both the global and the module registry for an isolated import.
    delete (globalThis as Record<string, unknown>).__fplSeasonState;
    vi.resetModules();
    return import('../src/server/season-state');
}

beforeEach(() => {
    redisGet.mockReset();
    redisSet.mockReset();
});

describe('season-state', () => {
    it('falls back to the config default before init runs', async () => {
        const mod = await freshModule();
        expect(mod.getCurrentSeason()).toBe('2025-26');
    });

    it('initSeasonState prefers the Redis pointer', async () => {
        redisGet.mockResolvedValue('2026-27');
        const mod = await freshModule();
        await mod.initSeasonState();
        expect(redisGet).toHaveBeenCalledWith('active-season');
        expect(mod.getCurrentSeason()).toBe('2026-27');
    });

    it('keeps the default when no pointer is stored', async () => {
        redisGet.mockResolvedValue(null);
        const mod = await freshModule();
        await mod.initSeasonState();
        expect(mod.getCurrentSeason()).toBe('2025-26');
    });

    it('ignores a malformed pointer', async () => {
        redisGet.mockResolvedValue('not-a-season');
        const mod = await freshModule();
        await mod.initSeasonState();
        expect(mod.getCurrentSeason()).toBe('2025-26');
    });

    it('setCurrentSeason persists first and only moves on success', async () => {
        redisGet.mockResolvedValue(null);
        const mod = await freshModule();
        await mod.initSeasonState();

        redisSet.mockResolvedValue(false);
        expect(await mod.setCurrentSeason('2026-27')).toBe(false);
        expect(mod.getCurrentSeason()).toBe('2025-26');

        redisSet.mockResolvedValue(true);
        expect(await mod.setCurrentSeason('2026-27')).toBe(true);
        expect(redisSet).toHaveBeenCalledWith('active-season', '2026-27');
        expect(mod.getCurrentSeason()).toBe('2026-27');
    });

    it('getActiveSeasonConfig falls back to the default season entry when the pointer has none', async () => {
        redisGet.mockResolvedValue('2099-00'); // valid format, no SEASONS entry
        const mod = await freshModule();
        await mod.initSeasonState();
        expect(mod.getCurrentSeason()).toBe('2099-00');
        expect(mod.getActiveSeasonConfig().id).toBe('2025-26');
        expect(mod.getLeagueId()).toBe(619028);
    });
});
