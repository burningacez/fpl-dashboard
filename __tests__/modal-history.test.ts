import { describe, it, expect } from 'vitest';
import { acquireModalEntry, type HistoryWindow } from '../src/hooks/useModalHistory';

/**
 * A minimal history stack: enough to check that Back unwinds overlays one at a
 * time instead of leaving the page.
 */
function fakeWindow() {
    const stack: unknown[] = [{ __NA: 'next-router-key' }];
    const win: HistoryWindow & { stack: unknown[]; pop: () => void } = {
        history: {
            get state() {
                return stack[stack.length - 1];
            },
            pushState(state: unknown) {
                stack.push(state);
            },
            back() {
                if (stack.length > 1) stack.pop();
            },
        },
        stack,
        // The browser's Back: pop, then everyone hears popstate.
        pop() {
            if (stack.length > 1) stack.pop();
        },
    };
    return win;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('modal history entries', () => {
    it('keeps the router state already on the entry', () => {
        const win = fakeWindow();
        acquireModalEntry(win, 'a');
        expect(win.history.state).toMatchObject({ __NA: 'next-router-key', __modal: 'a' });
    });

    it('closes only the top overlay on Back, leaving the one under it open', () => {
        const win = fakeWindow();
        const pitch = acquireModalEntry(win, 'pitch');
        const player = acquireModalEntry(win, 'player');

        win.pop(); // browser Back
        expect(player.shouldClose()).toBe(true);
        expect(pitch.shouldClose()).toBe(false);
        // Still one entry above the page: the pitch modal is what you see.
        expect(win.stack).toHaveLength(2);

        // A second Back then closes the pitch and returns to the page.
        win.pop();
        expect(pitch.shouldClose()).toBe(true);
        expect(win.stack).toHaveLength(1);
    });

    it('unwinds its own entry when the overlay is closed by ✕ instead', async () => {
        const win = fakeWindow();
        const entry = acquireModalEntry(win, 'a');
        entry.release();
        await tick();
        expect(win.stack).toHaveLength(1);
    });

    it('does not unwind twice when the overlay was closed by Back', async () => {
        const win = fakeWindow();
        const entry = acquireModalEntry(win, 'a');
        win.pop();
        expect(entry.shouldClose()).toBe(true);
        entry.release(); // React unmount cleanup, after the pop
        await tick();
        expect(win.stack).toHaveLength(1);
    });

    it('leaves history alone when a route change replaced the entry', async () => {
        const win = fakeWindow();
        const entry = acquireModalEntry(win, 'a');
        // Next.js navigating: a new entry with its own state, no modal tag.
        win.history.pushState({ __NA: 'other-page' });
        entry.release();
        await tick();
        expect(win.stack).toHaveLength(3);
    });

    it('survives a Strict Mode remount without duplicating or losing the entry', async () => {
        const win = fakeWindow();
        // React mounts the effect, tears it down, and mounts it again with the
        // same tag, all before the unwind can run.
        acquireModalEntry(win, 'a').release();
        const entry = acquireModalEntry(win, 'a');
        await tick();
        expect(win.stack).toHaveLength(2); // exactly one entry, still ours
        win.pop();
        expect(entry.shouldClose()).toBe(true);
    });
});
