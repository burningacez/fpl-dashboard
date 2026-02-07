const {
    getFormationCounts,
    isValidFormation,
    wouldBeValidSubstitution,
    getEffectiveFormationCounts
} = require('../lib/formation');

describe('getFormationCounts', () => {
    it('counts players by position correctly for a 4-4-2 formation', () => {
        const lineup = [
            { positionId: 1 }, // GKP
            { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, // 4 DEF
            { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, // 4 MID
            { positionId: 4 }, { positionId: 4 } // 2 FWD
        ];
        expect(getFormationCounts(lineup)).toEqual({ GKP: 1, DEF: 4, MID: 4, FWD: 2 });
    });

    it('counts players by position correctly for a 3-5-2 formation', () => {
        const lineup = [
            { positionId: 1 }, // GKP
            { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, // 3 DEF
            { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, // 5 MID
            { positionId: 4 }, { positionId: 4 } // 2 FWD
        ];
        expect(getFormationCounts(lineup)).toEqual({ GKP: 1, DEF: 3, MID: 5, FWD: 2 });
    });

    it('excludes players marked as subOut', () => {
        const lineup = [
            { positionId: 1 },
            { positionId: 2, subOut: true }, // Should not count
            { positionId: 2 }, { positionId: 2 }, { positionId: 2 }
        ];
        expect(getFormationCounts(lineup).DEF).toBe(3);
    });

    it('counts players with subOut: false', () => {
        const lineup = [
            { positionId: 1 },
            { positionId: 2, subOut: false },
            { positionId: 2, subOut: false },
            { positionId: 2 }
        ];
        expect(getFormationCounts(lineup).DEF).toBe(3);
    });

    it('returns zero counts for empty lineup', () => {
        expect(getFormationCounts([])).toEqual({ GKP: 0, DEF: 0, MID: 0, FWD: 0 });
    });
});

describe('isValidFormation', () => {
    it('returns true for standard 4-4-2 formation', () => {
        expect(isValidFormation({ GKP: 1, DEF: 4, MID: 4, FWD: 2 })).toBe(true);
    });

    it('returns true for 3-5-2 formation', () => {
        expect(isValidFormation({ GKP: 1, DEF: 3, MID: 5, FWD: 2 })).toBe(true);
    });

    it('returns true for 5-4-1 formation', () => {
        expect(isValidFormation({ GKP: 1, DEF: 5, MID: 4, FWD: 1 })).toBe(true);
    });

    it('returns true for minimum valid 3-2-1 formation (with 4 extra outfield)', () => {
        // This tests the minimum requirements only
        expect(isValidFormation({ GKP: 1, DEF: 3, MID: 2, FWD: 1 })).toBe(true);
    });

    it('returns false when less than 3 defenders', () => {
        expect(isValidFormation({ GKP: 1, DEF: 2, MID: 4, FWD: 4 })).toBe(false);
    });

    it('returns false when no goalkeeper', () => {
        expect(isValidFormation({ GKP: 0, DEF: 5, MID: 4, FWD: 2 })).toBe(false);
    });

    it('returns false when less than 2 midfielders', () => {
        expect(isValidFormation({ GKP: 1, DEF: 5, MID: 1, FWD: 4 })).toBe(false);
    });

    it('returns false when no forwards', () => {
        expect(isValidFormation({ GKP: 1, DEF: 5, MID: 5, FWD: 0 })).toBe(false);
    });

    it('returns false for all zeros', () => {
        expect(isValidFormation({ GKP: 0, DEF: 0, MID: 0, FWD: 0 })).toBe(false);
    });
});

describe('wouldBeValidSubstitution', () => {
    // Standard 4-4-2 starting lineup
    const standardStarters = [
        { positionId: 1 }, // GKP
        { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, // 4 DEF
        { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, // 4 MID
        { positionId: 4 }, { positionId: 4 } // 2 FWD
    ];

    it('returns true when subbing a defender with a defender', () => {
        const playerOut = { positionId: 2 }; // DEF
        const benchPlayer = { positionId: 2 }; // DEF
        expect(wouldBeValidSubstitution(standardStarters, playerOut, benchPlayer)).toBe(true);
    });

    it('returns true when subbing a midfielder with a forward (if valid)', () => {
        const playerOut = { positionId: 3 }; // MID
        const benchPlayer = { positionId: 4 }; // FWD
        // 4-4-2 -> 4-3-3 is valid
        expect(wouldBeValidSubstitution(standardStarters, playerOut, benchPlayer)).toBe(true);
    });

    it('returns false when subbing GK with outfield player', () => {
        const playerOut = { positionId: 1 }; // GKP
        const benchPlayer = { positionId: 2 }; // DEF
        expect(wouldBeValidSubstitution(standardStarters, playerOut, benchPlayer)).toBe(false);
    });

    it('returns false when subbing outfield player with GK', () => {
        const playerOut = { positionId: 2 }; // DEF
        const benchPlayer = { positionId: 1 }; // GKP
        expect(wouldBeValidSubstitution(standardStarters, playerOut, benchPlayer)).toBe(false);
    });

    it('returns true when subbing GK with GK', () => {
        const playerOut = { positionId: 1 }; // GKP
        const benchPlayer = { positionId: 1 }; // GKP
        expect(wouldBeValidSubstitution(standardStarters, playerOut, benchPlayer)).toBe(true);
    });

    it('returns false when subbing would leave less than 3 defenders', () => {
        // 3-5-2 formation - can't lose a defender for a midfielder
        const threeDefenders = [
            { positionId: 1 },
            { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, // 3 DEF
            { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, // 5 MID
            { positionId: 4 }, { positionId: 4 }
        ];
        const playerOut = { positionId: 2 }; // DEF
        const benchPlayer = { positionId: 3 }; // MID
        expect(wouldBeValidSubstitution(threeDefenders, playerOut, benchPlayer)).toBe(false);
    });

    it('returns false when subbing would leave less than 1 forward', () => {
        // 5-4-1 formation - can't lose the only forward
        const oneForward = [
            { positionId: 1 },
            { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, { positionId: 2 }, // 5 DEF
            { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, { positionId: 3 }, // 4 MID
            { positionId: 4 } // 1 FWD
        ];
        const playerOut = { positionId: 4 }; // FWD
        const benchPlayer = { positionId: 3 }; // MID
        expect(wouldBeValidSubstitution(oneForward, playerOut, benchPlayer)).toBe(false);
    });
});

describe('getEffectiveFormationCounts', () => {
    it('counts only active starters when no subs have happened', () => {
        const players = [
            // Starters
            { positionId: 1, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            // Bench
            { positionId: 1, isBench: true, subIn: false },
            { positionId: 2, isBench: true, subIn: false },
            { positionId: 3, isBench: true, subIn: false },
            { positionId: 4, isBench: true, subIn: false }
        ];
        expect(getEffectiveFormationCounts(players)).toEqual({ GKP: 1, DEF: 4, MID: 4, FWD: 2 });
    });

    it('includes subbed-in bench players and excludes subbed-out starters', () => {
        const players = [
            // Starters - DEF subbed out
            { positionId: 1, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: true },  // Subbed out
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            // Bench - DEF subbed in
            { positionId: 1, isBench: true, subIn: false },
            { positionId: 2, isBench: true, subIn: true },   // Subbed in
            { positionId: 3, isBench: true, subIn: false },
            { positionId: 4, isBench: true, subIn: false }
        ];
        // DEF out + DEF in = still 4 DEF
        expect(getEffectiveFormationCounts(players)).toEqual({ GKP: 1, DEF: 4, MID: 4, FWD: 2 });
    });

    it('correctly counts after GK sub (critical: GKP stays at 1)', () => {
        const players = [
            // Starters - GK subbed out
            { positionId: 1, isBench: false, subOut: true },  // GK subbed out
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            // Bench - GK subbed in
            { positionId: 1, isBench: true, subIn: true },   // Bench GK subbed in
            { positionId: 2, isBench: true, subIn: false },
            { positionId: 3, isBench: true, subIn: false },
            { positionId: 4, isBench: true, subIn: false }
        ];
        // GKP should still be 1 (bench GK came on)
        expect(getEffectiveFormationCounts(players)).toEqual({ GKP: 1, DEF: 4, MID: 4, FWD: 2 });
    });

    it('correctly counts after multiple subs', () => {
        const players = [
            // Starters - GK and DEF both subbed out
            { positionId: 1, isBench: false, subOut: true },  // GK subbed out
            { positionId: 2, isBench: false, subOut: true },  // DEF subbed out
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 3, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            { positionId: 4, isBench: false, subOut: false },
            // Bench - GK and DEF subbed in
            { positionId: 1, isBench: true, subIn: true },   // Bench GK in
            { positionId: 2, isBench: true, subIn: true },   // Bench DEF in
            { positionId: 3, isBench: true, subIn: false },
            { positionId: 4, isBench: true, subIn: false }
        ];
        // Should still be valid 4-4-2 with 11 effective players
        expect(getEffectiveFormationCounts(players)).toEqual({ GKP: 1, DEF: 4, MID: 4, FWD: 2 });
    });

    it('does not count bench players who have not been subbed in', () => {
        const players = [
            { positionId: 1, isBench: false, subOut: false },
            { positionId: 2, isBench: false, subOut: false },
            // Bench player NOT subbed in
            { positionId: 4, isBench: true, subIn: false }
        ];
        expect(getEffectiveFormationCounts(players)).toEqual({ GKP: 1, DEF: 1, MID: 0, FWD: 0 });
    });
});
