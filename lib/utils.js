/**
 * Utility functions for FPL Dashboard
 */

/**
 * Format tied names for display
 * @param {Array} names - Array of names
 * @returns {string} Formatted string
 */
function formatTiedNames(names) {
    if (!names || names.length === 0) return '-';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names[0]} +${names.length - 1} others`;
}

/**
 * Update a record with tie support (higher is better)
 * @param {Object} current - Current record {names: [], value: number, ...}
 * @param {string} newName - Name of potential new record holder
 * @param {number} newValue - Value to compare
 * @param {Object} additionalData - Additional data to store with the record
 * @returns {Object} Updated record
 */
function updateRecordWithTies(current, newName, newValue, additionalData = {}) {
    if (newValue > current.value) {
        return { names: [newName], value: newValue, ...additionalData };
    } else if (newValue === current.value && !current.names.includes(newName)) {
        return { ...current, names: [...current.names, newName] };
    }
    return current;
}

/**
 * Update a record with tie support (lower is better)
 * @param {Object} current - Current record {names: [], value: number, ...}
 * @param {string} newName - Name of potential new record holder
 * @param {number} newValue - Value to compare
 * @param {Object} additionalData - Additional data to store with the record
 * @returns {Object} Updated record
 */
function updateRecordWithTiesLow(current, newName, newValue, additionalData = {}) {
    if (newValue < current.value) {
        return { names: [newName], value: newValue, ...additionalData };
    } else if (newValue === current.value && !current.names.includes(newName)) {
        return { ...current, names: [...current.names, newName] };
    }
    return current;
}

/**
 * Calculate match end time from kickoff time
 * Match duration approximately 115 minutes (90 + stoppage + halftime + buffer)
 * @param {string} kickoffTime - ISO date string of kickoff time
 * @returns {Date} Estimated match end time
 */
function getMatchEndTime(kickoffTime) {
    const kickoff = new Date(kickoffTime);
    return new Date(kickoff.getTime() + 115 * 60 * 1000);
}

/**
 * Group fixtures into kickoff windows (matches starting within 30 mins of each other)
 * @param {Array} fixtures - Array of fixture objects with kickoff_time
 * @returns {Array} Array of window objects {start, end, fixtures}
 */
function groupFixturesIntoWindows(fixtures) {
    if (!fixtures || fixtures.length === 0) return [];

    const sortedFixtures = fixtures
        .filter(f => f.kickoff_time)
        .map(f => ({ ...f, kickoffDate: new Date(f.kickoff_time) }))
        .sort((a, b) => a.kickoffDate - b.kickoffDate);

    const windows = [];
    let currentWindow = null;

    sortedFixtures.forEach(fixture => {
        if (!currentWindow) {
            currentWindow = {
                start: fixture.kickoffDate,
                end: getMatchEndTime(fixture.kickoffDate),
                fixtures: [fixture]
            };
        } else {
            // If this kickoff is within 30 mins of the window start, add to current window
            const timeDiff = fixture.kickoffDate - currentWindow.start;
            if (timeDiff <= 30 * 60 * 1000) {
                currentWindow.fixtures.push(fixture);
                // Extend window end time if this match ends later
                const matchEnd = getMatchEndTime(fixture.kickoffDate);
                if (matchEnd > currentWindow.end) {
                    currentWindow.end = matchEnd;
                }
            } else {
                // Start a new window
                windows.push(currentWindow);
                currentWindow = {
                    start: fixture.kickoffDate,
                    end: getMatchEndTime(fixture.kickoffDate),
                    fixtures: [fixture]
                };
            }
        }
    });

    if (currentWindow) {
        windows.push(currentWindow);
    }

    return windows;
}

/**
 * Generate a simple hash for data change detection
 * @param {*} data - Data to hash
 * @returns {string} Hash string
 */
function generateDataHash(data) {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}

module.exports = {
    formatTiedNames,
    updateRecordWithTies,
    updateRecordWithTiesLow,
    getMatchEndTime,
    groupFixturesIntoWindows,
    generateDataHash
};
