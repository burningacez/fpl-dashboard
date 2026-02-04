/**
 * FPL Formation validation and utility functions
 * Used for validating team formations and auto-sub logic
 */

/**
 * Count players by position in a lineup
 * @param {Array} lineup - Array of player objects with positionId and subOut properties
 * @returns {Object} Counts for each position {GKP, DEF, MID, FWD}
 */
function getFormationCounts(lineup) {
    return {
        GKP: lineup.filter(p => p.positionId === 1 && !p.subOut).length,
        DEF: lineup.filter(p => p.positionId === 2 && !p.subOut).length,
        MID: lineup.filter(p => p.positionId === 3 && !p.subOut).length,
        FWD: lineup.filter(p => p.positionId === 4 && !p.subOut).length
    };
}

/**
 * Check if a formation is valid according to FPL rules
 * Minimum requirements: 1 GKP, 3 DEF, 2 MID, 1 FWD
 * @param {Object} counts - Position counts {GKP, DEF, MID, FWD}
 * @returns {boolean} True if formation is valid
 */
function isValidFormation(counts) {
    return counts.GKP >= 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1;
}

/**
 * Test a hypothetical substitution to see if it would result in a valid formation
 * @param {Array} starters - Current starting lineup
 * @param {Object} playerOut - Player being substituted out
 * @param {Object} benchPlayer - Player being substituted in
 * @returns {boolean} True if the substitution would result in a valid formation
 */
function wouldBeValidSubstitution(starters, playerOut, benchPlayer) {
    // GK can only be subbed by GK
    if (playerOut.positionId === 1 && benchPlayer.positionId !== 1) return false;
    if (playerOut.positionId !== 1 && benchPlayer.positionId === 1) return false;

    const testFormation = getFormationCounts(starters);

    // Decrease count for player going out
    if (playerOut.positionId === 1) testFormation.GKP--;
    else if (playerOut.positionId === 2) testFormation.DEF--;
    else if (playerOut.positionId === 3) testFormation.MID--;
    else if (playerOut.positionId === 4) testFormation.FWD--;

    // Increase count for player coming in
    if (benchPlayer.positionId === 1) testFormation.GKP++;
    else if (benchPlayer.positionId === 2) testFormation.DEF++;
    else if (benchPlayer.positionId === 3) testFormation.MID++;
    else if (benchPlayer.positionId === 4) testFormation.FWD++;

    return isValidFormation(testFormation);
}

module.exports = {
    getFormationCounts,
    isValidFormation,
    wouldBeValidSubstitution
};
