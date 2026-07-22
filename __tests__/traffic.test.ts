import { describe, it, expect } from 'vitest';
import {
  MAX_SEEN_DEVICES,
  emptyStats,
  finalizePastDays,
  isBotUserAgent,
  londonDateKey,
  normalizeTrackedPath,
  recordView,
  summarizeTraffic,
  type TrafficStats,
} from '../src/lib/traffic';

const NOW = new Date('2026-07-22T10:00:00Z');

function stats(): TrafficStats {
  return emptyStats('2025-26', NOW);
}

function view(s: TrafficStats, over: { path?: string; deviceToken?: string; nameKey?: string | null; dateKey?: string } = {}) {
  recordView(s, {
    path: over.path ?? '/week',
    deviceToken: over.deviceToken ?? 'device-a',
    nameKey: over.nameKey ?? null,
    dateKey: over.dateKey ?? '2026-07-22',
  });
}

describe('londonDateKey', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(londonDateKey(new Date('2026-07-22T10:00:00Z'))).toBe('2026-07-22');
  });

  it('uses London time in summer (BST, UTC+1): 23:30 UTC is already tomorrow', () => {
    expect(londonDateKey(new Date('2026-07-21T23:30:00Z'))).toBe('2026-07-22');
  });

  it('uses London time in winter (GMT = UTC): 23:30 UTC is still today', () => {
    expect(londonDateKey(new Date('2026-01-21T23:30:00Z'))).toBe('2026-01-21');
  });
});

describe('normalizeTrackedPath', () => {
  it('accepts known pages', () => {
    expect(normalizeTrackedPath('/')).toBe('/');
    expect(normalizeTrackedPath('/week')).toBe('/week');
    expect(normalizeTrackedPath('/hall-of-fame')).toBe('/hall-of-fame');
  });

  it('strips query strings, hashes, and trailing slashes', () => {
    expect(normalizeTrackedPath('/week?gw=3')).toBe('/week');
    expect(normalizeTrackedPath('/week#top')).toBe('/week');
    expect(normalizeTrackedPath('/week/')).toBe('/week');
  });

  it('rejects unknown, admin, api, and junk paths', () => {
    expect(normalizeTrackedPath('/admin')).toBeNull();
    expect(normalizeTrackedPath('/api/members')).toBeNull();
    expect(normalizeTrackedPath('/nonsense')).toBeNull();
    expect(normalizeTrackedPath('week')).toBeNull();
    expect(normalizeTrackedPath('')).toBeNull();
    expect(normalizeTrackedPath(42)).toBeNull();
    expect(normalizeTrackedPath('/' + 'x'.repeat(300))).toBeNull();
  });
});

describe('isBotUserAgent', () => {
  it('flags missing UA and known bot patterns', () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('Googlebot/2.1')).toBe(true);
    expect(isBotUserAgent('HeadlessChrome/120')).toBe(true);
    expect(isBotUserAgent('curl/8.0')).toBe(true);
  });

  it('passes normal browsers', () => {
    expect(isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')).toBe(false);
  });
});

describe('recordView', () => {
  it('increments totals, page counts, and device counts', () => {
    const s = stats();
    view(s);
    view(s);
    view(s, { path: '/losers', deviceToken: 'device-b' });

    const day = s.days['2026-07-22'];
    expect(day.total).toBe(3);
    expect(day.pages).toEqual({ '/week': 2, '/losers': 1 });
    expect(day.devices).toEqual({ 'device-a': 2, 'device-b': 1 });
    expect(day.uniqueDevices).toBe(2);
  });

  it('attributes claimed devices to their nameKey', () => {
    const s = stats();
    view(s, { nameKey: 'barry smith' });
    view(s, { path: '/cup', nameKey: 'barry smith' });
    view(s, { deviceToken: 'device-b' }); // anonymous

    const day = s.days['2026-07-22'];
    expect(day.users).toEqual({ 'barry smith': { '/week': 1, '/cup': 1 } });
  });

  it('counts a device as new only on its first-ever day', () => {
    const s = stats();
    view(s, { dateKey: '2026-07-21' });
    view(s, { dateKey: '2026-07-22' }); // same device next day: returning
    view(s, { deviceToken: 'device-b', dateKey: '2026-07-22' }); // brand new

    expect(s.days['2026-07-21'].newDevices).toBe(1);
    expect(s.days['2026-07-22'].newDevices).toBe(1);
    expect(s.seenDevices).toEqual({ 'device-a': '2026-07-21', 'device-b': '2026-07-22' });
  });

  it('collapses past-day device maps when a new day starts', () => {
    const s = stats();
    view(s, { dateKey: '2026-07-21' });
    view(s, { deviceToken: 'device-b', dateKey: '2026-07-21' });
    view(s, { dateKey: '2026-07-22' });

    const past = s.days['2026-07-21'];
    expect(past.devices).toBeUndefined();
    expect(past.uniqueDevices).toBe(2);
    expect(s.days['2026-07-22'].devices).toEqual({ 'device-a': 1 });
  });

  it('caps seenDevices, evicting oldest first', () => {
    const s = stats();
    for (let i = 0; i < MAX_SEEN_DEVICES; i++) {
      view(s, { deviceToken: `old-${i}`, dateKey: '2026-07-01' });
    }
    view(s, { deviceToken: 'newest', dateKey: '2026-07-22' });

    expect(Object.keys(s.seenDevices).length).toBe(MAX_SEEN_DEVICES);
    expect(s.seenDevices['newest']).toBe('2026-07-22');
  });
});

describe('finalizePastDays', () => {
  it('leaves today untouched and is idempotent', () => {
    const s = stats();
    view(s, { dateKey: '2026-07-22' });
    finalizePastDays(s, '2026-07-22');
    expect(s.days['2026-07-22'].devices).toBeDefined();
    finalizePastDays(s, '2026-07-23');
    finalizePastDays(s, '2026-07-23');
    expect(s.days['2026-07-22'].devices).toBeUndefined();
    expect(s.days['2026-07-22'].uniqueDevices).toBe(1);
  });
});

describe('summarizeTraffic', () => {
  function seeded(): TrafficStats {
    const s = stats();
    // Day 1: barry on two pages from device-a, anonymous device-b.
    view(s, { dateKey: '2026-07-20', nameKey: 'barry smith' });
    view(s, { dateKey: '2026-07-20', path: '/cup', nameKey: 'barry smith' });
    view(s, { dateKey: '2026-07-20', deviceToken: 'device-b' });
    // Day 2: barry returns; dave appears (new device).
    view(s, { dateKey: '2026-07-22', nameKey: 'barry smith' });
    view(s, { dateKey: '2026-07-22', deviceToken: 'device-c', nameKey: 'dave jones', path: '/losers' });
    return s;
  }

  it('aggregates days newest-first with new/returning split', () => {
    const sum = summarizeTraffic(seeded(), 0, '2026-07-22');
    expect(sum.days.map((d) => d.date)).toEqual(['2026-07-22', '2026-07-20']);
    expect(sum.days[0]).toEqual({ date: '2026-07-22', views: 2, uniques: 2, newDevices: 1, returning: 1 });
    expect(sum.days[1]).toEqual({ date: '2026-07-20', views: 3, uniques: 2, newDevices: 2, returning: 0 });
    expect(sum.totals).toEqual({ views: 5, uniqueDevices: 3 });
  });

  it('sums pages and users over the range, most active first', () => {
    const sum = summarizeTraffic(seeded(), 0, '2026-07-22');
    expect(sum.pages[0]).toEqual({ path: '/week', views: 3 });
    expect(sum.users.map((u) => u.nameKey)).toEqual(['barry smith', 'dave jones']);
    expect(sum.users[0].views).toBe(3);
    expect(sum.users[0].lastSeen).toBe('2026-07-22');
    expect(sum.users[0].pages).toEqual([
      { path: '/week', views: 2 },
      { path: '/cup', views: 1 },
    ]);
  });

  it('clips to the requested range', () => {
    const sum = summarizeTraffic(seeded(), 2, '2026-07-22');
    expect(sum.days.map((d) => d.date)).toEqual(['2026-07-22']);
    expect(sum.totals.views).toBe(2);
    expect(sum.users.map((u) => u.nameKey)).toEqual(['barry smith', 'dave jones']);
    // Season-wide uniques stay season-wide even for a clipped range.
    expect(sum.totals.uniqueDevices).toBe(3);
  });

  it('uses finalized uniqueDevices for collapsed past days', () => {
    const s = seeded();
    finalizePastDays(s, '2026-07-23');
    const sum = summarizeTraffic(s, 0, '2026-07-23');
    expect(sum.days.find((d) => d.date === '2026-07-20')?.uniques).toBe(2);
  });
});
