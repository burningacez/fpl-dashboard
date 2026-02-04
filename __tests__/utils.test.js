const {
    formatTiedNames,
    updateRecordWithTies,
    updateRecordWithTiesLow,
    getMatchEndTime,
    groupFixturesIntoWindows,
    generateDataHash
} = require('../lib/utils');

describe('formatTiedNames', () => {
    it('returns dash for null', () => {
        expect(formatTiedNames(null)).toBe('-');
    });

    it('returns dash for undefined', () => {
        expect(formatTiedNames(undefined)).toBe('-');
    });

    it('returns dash for empty array', () => {
        expect(formatTiedNames([])).toBe('-');
    });

    it('returns single name as-is', () => {
        expect(formatTiedNames(['John'])).toBe('John');
    });

    it('joins two names with &', () => {
        expect(formatTiedNames(['John', 'Jane'])).toBe('John & Jane');
    });

    it('formats three names with +N others', () => {
        expect(formatTiedNames(['A', 'B', 'C'])).toBe('A +2 others');
    });

    it('formats four names with +N others', () => {
        expect(formatTiedNames(['A', 'B', 'C', 'D'])).toBe('A +3 others');
    });
});

describe('updateRecordWithTies', () => {
    it('updates record when new value is higher', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTies(current, 'Bob', 60, { gw: 2 });
        expect(result).toEqual({ names: ['Bob'], value: 60, gw: 2 });
    });

    it('adds name to tie when values are equal', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTies(current, 'Bob', 50, { gw: 2 });
        expect(result.names).toEqual(['Alice', 'Bob']);
        expect(result.value).toBe(50);
    });

    it('returns current record when new value is lower', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTies(current, 'Bob', 40, { gw: 2 });
        expect(result).toBe(current);
    });

    it('does not add duplicate names on tie', () => {
        const current = { names: ['Alice'], value: 50 };
        const result = updateRecordWithTies(current, 'Alice', 50, {});
        expect(result.names).toEqual(['Alice']);
    });

    it('preserves additional data on tie', () => {
        const current = { names: ['Alice'], value: 50, gw: 1, extra: 'data' };
        const result = updateRecordWithTies(current, 'Bob', 50, { gw: 2 });
        expect(result.gw).toBe(1); // Original additional data preserved
        expect(result.extra).toBe('data');
    });
});

describe('updateRecordWithTiesLow', () => {
    it('updates record when new value is lower', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTiesLow(current, 'Bob', 40, { gw: 2 });
        expect(result).toEqual({ names: ['Bob'], value: 40, gw: 2 });
    });

    it('adds name to tie when values are equal', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTiesLow(current, 'Bob', 50, { gw: 2 });
        expect(result.names).toEqual(['Alice', 'Bob']);
        expect(result.value).toBe(50);
    });

    it('returns current record when new value is higher', () => {
        const current = { names: ['Alice'], value: 50, gw: 1 };
        const result = updateRecordWithTiesLow(current, 'Bob', 60, { gw: 2 });
        expect(result).toBe(current);
    });

    it('does not add duplicate names on tie', () => {
        const current = { names: ['Alice'], value: 50 };
        const result = updateRecordWithTiesLow(current, 'Alice', 50, {});
        expect(result.names).toEqual(['Alice']);
    });
});

describe('getMatchEndTime', () => {
    it('adds 115 minutes to kickoff time', () => {
        const kickoff = '2025-01-15T15:00:00Z';
        const result = getMatchEndTime(kickoff);
        expect(result.getTime()).toBe(new Date(kickoff).getTime() + 115 * 60 * 1000);
    });

    it('handles different time zones', () => {
        const kickoff = '2025-01-15T20:00:00+01:00';
        const result = getMatchEndTime(kickoff);
        const expected = new Date(kickoff).getTime() + 115 * 60 * 1000;
        expect(result.getTime()).toBe(expected);
    });

    it('returns a Date object', () => {
        const result = getMatchEndTime('2025-01-15T15:00:00Z');
        expect(result instanceof Date).toBe(true);
    });
});

describe('groupFixturesIntoWindows', () => {
    it('returns empty array for null input', () => {
        expect(groupFixturesIntoWindows(null)).toEqual([]);
    });

    it('returns empty array for empty array', () => {
        expect(groupFixturesIntoWindows([])).toEqual([]);
    });

    it('groups fixtures with same kickoff time', () => {
        const fixtures = [
            { id: 1, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 2, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 3, kickoff_time: '2025-01-15T15:00:00Z' }
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        expect(windows.length).toBe(1);
        expect(windows[0].fixtures.length).toBe(3);
    });

    it('groups fixtures within 30 minutes of each other', () => {
        const fixtures = [
            { id: 1, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 2, kickoff_time: '2025-01-15T15:15:00Z' },
            { id: 3, kickoff_time: '2025-01-15T15:30:00Z' } // Exactly 30 mins, should be in same window
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        expect(windows.length).toBe(1);
        expect(windows[0].fixtures.length).toBe(3);
    });

    it('creates separate windows for fixtures more than 30 minutes apart', () => {
        const fixtures = [
            { id: 1, kickoff_time: '2025-01-15T12:30:00Z' },
            { id: 2, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 3, kickoff_time: '2025-01-15T17:30:00Z' }
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        expect(windows.length).toBe(3);
    });

    it('filters out fixtures without kickoff_time', () => {
        const fixtures = [
            { id: 1, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 2 }, // No kickoff_time
            { id: 3, kickoff_time: null }
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        expect(windows.length).toBe(1);
        expect(windows[0].fixtures.length).toBe(1);
    });

    it('sorts fixtures by kickoff time', () => {
        const fixtures = [
            { id: 3, kickoff_time: '2025-01-15T17:30:00Z' },
            { id: 1, kickoff_time: '2025-01-15T12:30:00Z' },
            { id: 2, kickoff_time: '2025-01-15T15:00:00Z' }
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        expect(windows[0].fixtures[0].id).toBe(1);
        expect(windows[1].fixtures[0].id).toBe(2);
        expect(windows[2].fixtures[0].id).toBe(3);
    });

    it('sets window end time based on latest match end', () => {
        const fixtures = [
            { id: 1, kickoff_time: '2025-01-15T15:00:00Z' },
            { id: 2, kickoff_time: '2025-01-15T15:15:00Z' }
        ];
        const windows = groupFixturesIntoWindows(fixtures);
        // End time should be 115 minutes after the later kickoff (15:15)
        const expectedEnd = new Date('2025-01-15T15:15:00Z').getTime() + 115 * 60 * 1000;
        expect(windows[0].end.getTime()).toBe(expectedEnd);
    });
});

describe('generateDataHash', () => {
    it('returns a string', () => {
        expect(typeof generateDataHash({ a: 1 })).toBe('string');
    });

    it('returns same hash for same data', () => {
        const data = { a: 1, b: 2 };
        expect(generateDataHash(data)).toBe(generateDataHash(data));
    });

    it('returns different hash for different data', () => {
        expect(generateDataHash({ a: 1 })).not.toBe(generateDataHash({ a: 2 }));
    });

    it('handles arrays', () => {
        expect(typeof generateDataHash([1, 2, 3])).toBe('string');
    });

    it('handles nested objects', () => {
        const data = { a: { b: { c: 1 } } };
        expect(typeof generateDataHash(data)).toBe('string');
    });

    it('handles empty objects', () => {
        expect(typeof generateDataHash({})).toBe('string');
    });

    it('handles strings', () => {
        expect(typeof generateDataHash('test')).toBe('string');
    });

    it('handles numbers', () => {
        expect(typeof generateDataHash(123)).toBe('string');
    });
});
