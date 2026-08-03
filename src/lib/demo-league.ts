/**
 * The example league the guided walkthroughs narrate.
 *
 * Shared so every page's demo tells the same story: the same six managers, the
 * same names, the same person sitting second. A walkthrough that showed one
 * cast on Scores and another on Losers would quietly teach people that the
 * numbers are made up, which is the one thing the banner is already saying and
 * the data should not have to.
 *
 * Entry ids sit in a 900_000 block so they cannot collide with a real FPL entry
 * if a payload ever leaks past a demo boundary.
 */

export interface DemoManager {
  entryId: number;
  name: string;
  team: string;
}

/** Slot handed to the real user when we know who they are. */
export const DEMO_YOU_SLOT = 1;

export const DEMO_ROSTER: DemoManager[] = [
  { entryId: 900_001, name: 'Danny Kelly', team: 'Kelly Kong' },
  { entryId: 900_002, name: 'Example Manager', team: 'Your Team' },
  { entryId: 900_003, name: 'Ste Hughes', team: 'Hughes Are Ya' },
  { entryId: 900_004, name: 'Michael Owen', team: 'Owen Me a Favour' },
  { entryId: 900_005, name: 'Jonny Doyle', team: 'Doyle Rules' },
  { entryId: 900_006, name: 'Tom Rowley', team: 'Rowley Poly' },
];

/** The example gameweek every walkthrough is set in. */
export const DEMO_GW = 21;

export interface DemoIdentity {
  entryId: number;
  name: string;
  team: string;
}

/**
 * Seat the real user in the example league, so "your row is tinted teal" is
 * literally true and runs through the same useIsMe() path as the live page. Even
 * pre-season, when they have no real row anywhere.
 */
export function seatUser(roster: DemoManager[], me: DemoIdentity | null): DemoManager[] {
  if (!me) return roster;
  return roster.map((m, i) =>
    i === DEMO_YOU_SLOT ? { entryId: me.entryId, name: me.name, team: me.team || m.team } : m,
  );
}
