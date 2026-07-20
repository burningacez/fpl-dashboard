/**
 * FPL formation validation and utility functions.
 * Near-verbatim TypeScript port of legacy/lib/formation.js — logic must stay
 * byte-identical; only types may be added.
 *
 * Used for validating team formations and auto-sub logic. positionId follows
 * FPL element_type: 1 GKP, 2 DEF, 3 MID, 4 FWD.
 */

export interface PositionedPlayer {
  positionId: number;
  subOut?: boolean;
  subIn?: boolean;
  isBench?: boolean;
  [key: string]: unknown;
}

export interface FormationCounts {
  GKP: number;
  DEF: number;
  MID: number;
  FWD: number;
}

/** Count players by position in a lineup */
export function getFormationCounts(lineup: PositionedPlayer[]): FormationCounts {
  return {
    GKP: lineup.filter((p) => p.positionId === 1 && !p.subOut).length,
    DEF: lineup.filter((p) => p.positionId === 2 && !p.subOut).length,
    MID: lineup.filter((p) => p.positionId === 3 && !p.subOut).length,
    FWD: lineup.filter((p) => p.positionId === 4 && !p.subOut).length,
  };
}

/**
 * Check if a formation is valid according to FPL rules.
 * Minimum requirements: 1 GKP, 3 DEF, 2 MID, 1 FWD.
 */
export function isValidFormation(counts: FormationCounts): boolean {
  return counts.GKP >= 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1;
}

/** Test a hypothetical substitution to see if it would result in a valid formation */
export function wouldBeValidSubstitution(
  starters: PositionedPlayer[],
  playerOut: PositionedPlayer,
  benchPlayer: PositionedPlayer,
): boolean {
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

/**
 * Count effective formation including auto-subs already processed.
 * Counts starters not subbed out + bench players already subbed in.
 * Use this during multi-sub processing to get correct formation after prior subs.
 */
export function getEffectiveFormationCounts(allPlayers: PositionedPlayer[]): FormationCounts {
  const effective = allPlayers.filter((p) => (!p.isBench && !p.subOut) || (p.isBench && p.subIn));
  return {
    GKP: effective.filter((p) => p.positionId === 1).length,
    DEF: effective.filter((p) => p.positionId === 2).length,
    MID: effective.filter((p) => p.positionId === 3).length,
    FWD: effective.filter((p) => p.positionId === 4).length,
  };
}
