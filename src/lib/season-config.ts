/**
 * Per-season league configuration.
 *
 * Each season the mini-league runs with different parameters — a fresh FPL
 * classic-league id, prize amounts, MOTM period boundaries, manual loser
 * corrections, cup gameweeks. Every season gets an entry in SEASONS and keeps
 * it forever, so archived seasons render their own rules and prizes.
 *
 * To start a new season: add its entry here, deploy, then use the admin
 * "Start new season" action. Rollover refuses to flip to a season without an
 * entry.
 *
 * Manual weekly-loser corrections live in src/server/loser-overrides.ts
 * (server-only, keyed by entry id) so no member names ship in the bundle.
 *
 * Client-importable on purpose (no 'server-only'): pages render the selected
 * season's rules without a round-trip, so only public values belong here.
 */

export interface SeasonConfig {
  /** Season id in YYYY-YY format, e.g. '2025-26'. */
  id: string;
  /** FPL classic-league id — a new league is created each season. */
  leagueId: number;
  entrants: number;
  /** £ paid by each entrant at the start of the season. */
  entryFee: number;
  /** £ paid by each gameweek's lowest scorer. */
  weeklyLoserFine: number;
  totalWeeks: number;
  /**
   * Whether the entry fee and weekly loser fine are agreed. These are set by
   * the league before entries close, so they publish ahead of the prizes: the
   * Rules page shows their £ values as soon as this is true.
   */
  feesConfirmed: boolean;
  /**
   * Whether this season's pot and prize amounts are agreed. The pot is a
   * function of the final entrant count, so it stays unconfirmed until every
   * entry is in — the Rules, Earnings and Cup pages show dashes instead of £
   * values until then. Flip to true once the entrant list is final.
   *
   * Implies feesConfirmed: prizes can't be settled before the fees they come
   * from (enforced by validateSeasonConfig).
   */
  cashConfirmed: boolean;
  prizes: {
    /** £ for 1st, 2nd, 3rd, … in final-standings order. */
    league: number[];
    cup: number;
    motmPerPeriod: number;
  };
  /** Period number → [startGW, endGW], contiguous and covering 1..totalWeeks. */
  motmPeriods: Record<number, [number, number]>;
  /**
   * Whether goals and assists count as tiebreakers (and show as badges/columns).
   *
   * Introduced for 2026-27. Earlier seasons were played and settled without
   * them, so they stay false forever: a completed season must keep the loser,
   * MotM and final-standings results it actually finished with, and its
   * archive has no goal/assist data to display anyway.
   */
  attackingTiebreakers: boolean;
  /**
   * First GW of the second chip half. FPL issues a fresh set of chips here;
   * first-half chips expire after GW chipSecondHalfStartGw - 1.
   */
  chipSecondHalfStartGw: number;
  cup: {
    startGw: number;
    /** Bracket is drawn from net scores in this GW. */
    seedingGw: number;
    /** Top-N seeds skip round one when entrants aren't a power of two. */
    byes: number;
  };
  links: {
    monzo: string;
    paypal: string;
    whatsapp: string;
  };
}

export const DEFAULT_SEASON = '2025-26';

export const SEASONS: Record<string, SeasonConfig> = {
  '2025-26': {
    id: '2025-26',
    leagueId: 619028,
    entrants: 29,
    entryFee: 30,
    weeklyLoserFine: 5,
    totalWeeks: 38,
    feesConfirmed: true,
    cashConfirmed: true,
    prizes: {
      league: [320, 200, 120],
      cup: 150,
      motmPerPeriod: 30,
    },
    motmPeriods: {
      1: [1, 5],
      2: [6, 9],
      3: [10, 13],
      4: [14, 17],
      5: [18, 21],
      6: [22, 25],
      7: [26, 29],
      8: [30, 33],
      9: [34, 38],
    },
    // Settled without goal/assist tiebreakers — never flip this to true.
    attackingTiebreakers: false,
    chipSecondHalfStartGw: 20,
    cup: {
      startGw: 34,
      seedingGw: 33,
      byes: 3,
    },
    links: {
      monzo: 'https://monzo.me/barryevans75',
      paypal: 'https://www.paypal.com/paypalme/bevans194',
      whatsapp: 'https://chat.whatsapp.com/Dgk93EIvjj35J4BVMdG0M5',
    },
  },
  '2026-27': {
    id: '2026-27',
    leagueId: 117775,
    entrants: 29,
    entryFee: 30,
    weeklyLoserFine: 5,
    totalWeeks: 38,
    // £30 entry and £5 weekly fine are agreed for 2026-27, so they publish now.
    feesConfirmed: true,
    // Entrant count and prizes are still carried over from 2025-26 — the pot
    // can't be declared until every entry is in. Prizes and pot render as
    // dashes until this flips to true.
    cashConfirmed: false,
    prizes: {
      league: [320, 200, 120],
      cup: 150,
      motmPerPeriod: 30,
    },
    motmPeriods: {
      1: [1, 5],
      2: [6, 9],
      3: [10, 13],
      4: [14, 17],
      5: [18, 21],
      6: [22, 25],
      7: [26, 29],
      8: [30, 33],
      9: [34, 38],
    },
    // New for 2026-27: goals and assists break ties on all three money paths.
    attackingTiebreakers: true,
    chipSecondHalfStartGw: 20,
    cup: {
      startGw: 34,
      seedingGw: 33,
      byes: 3,
    },
    links: {
      monzo: 'https://monzo.me/barryevans75',
      paypal: 'https://www.paypal.com/paypalme/bevans194',
      whatsapp: 'https://chat.whatsapp.com/Dgk93EIvjj35J4BVMdG0M5',
    },
  },
};

export function getSeasonConfig(id: string | null | undefined): SeasonConfig | null {
  if (!id) return null;
  return SEASONS[id] ?? null;
}

/** '2025-26' → '2025-2026' (display form used by the home page heading). */
export function seasonLabel(id: string): string {
  return id.replace('-', '-20');
}

/** '2025-26' → '2026-27' (admin rollover prefill). */
export function nextSeasonId(id: string): string {
  const startYear = parseInt(id.slice(0, 4), 10);
  const next = startYear + 1;
  return `${next}-${String((next + 1) % 100).padStart(2, '0')}`;
}

export function totalPot(cfg: SeasonConfig): number {
  return cfg.entrants * cfg.entryFee + cfg.weeklyLoserFine * cfg.totalWeeks;
}

export function motmPeriodCount(cfg: SeasonConfig): number {
  return Object.keys(cfg.motmPeriods).length;
}

export function motmTotalPrize(cfg: SeasonConfig): number {
  return motmPeriodCount(cfg) * cfg.prizes.motmPerPeriod;
}

/** Returns a list of problems; empty means the entry is valid. */
export function validateSeasonConfig(cfg: SeasonConfig): string[] {
  const errors: string[] = [];

  if (!/^\d{4}-\d{2}$/.test(cfg.id)) {
    errors.push(`id '${cfg.id}' must be in format YYYY-YY (e.g. 2025-26)`);
  }
  if (!Number.isInteger(cfg.leagueId) || cfg.leagueId <= 0) {
    errors.push('leagueId must be a positive integer');
  }
  if (!Number.isInteger(cfg.entrants) || cfg.entrants <= 1) {
    errors.push('entrants must be an integer greater than 1');
  }
  if (cfg.entryFee < 0 || cfg.weeklyLoserFine < 0) {
    errors.push('entryFee and weeklyLoserFine must not be negative');
  }
  if (cfg.cashConfirmed && !cfg.feesConfirmed) {
    errors.push('cashConfirmed requires feesConfirmed: prizes come out of the fees, so they cannot be agreed first');
  }
  if (!Number.isInteger(cfg.totalWeeks) || cfg.totalWeeks < 1 || cfg.totalWeeks > 38) {
    errors.push('totalWeeks must be between 1 and 38');
  }
  if (cfg.prizes.league.length === 0 || cfg.prizes.league.some((p) => p <= 0)) {
    errors.push('prizes.league must be a non-empty list of positive amounts');
  }
  if (cfg.prizes.cup <= 0 || cfg.prizes.motmPerPeriod <= 0) {
    errors.push('prizes.cup and prizes.motmPerPeriod must be positive');
  }

  // MOTM periods must tile the season exactly: contiguous, in order, covering
  // GW 1..totalWeeks. Period count is deliberately not fixed at 9.
  const periods = Object.entries(cfg.motmPeriods)
    .map(([num, range]) => ({ num: Number(num), range }))
    .sort((a, b) => a.num - b.num);
  if (periods.length === 0) {
    errors.push('motmPeriods must not be empty');
  } else {
    let expectedStart = 1;
    periods.forEach(({ num, range: [start, end] }, i) => {
      if (num !== i + 1) errors.push(`motmPeriods must be numbered 1..N without gaps (found ${num})`);
      if (start !== expectedStart) {
        errors.push(`motmPeriods[${num}] starts at GW${start}, expected GW${expectedStart} (periods must be contiguous)`);
      }
      if (end < start) errors.push(`motmPeriods[${num}] has invalid GW range [${start}, ${end}]`);
      expectedStart = end + 1;
    });
    const lastEnd = periods[periods.length - 1].range[1];
    if (lastEnd !== cfg.totalWeeks) {
      errors.push(`motmPeriods must cover GW1-${cfg.totalWeeks} (last period ends at GW${lastEnd})`);
    }
  }

  if (
    !Number.isInteger(cfg.chipSecondHalfStartGw) ||
    cfg.chipSecondHalfStartGw < 2 ||
    cfg.chipSecondHalfStartGw > cfg.totalWeeks
  ) {
    errors.push(`chipSecondHalfStartGw must be between 2 and ${cfg.totalWeeks}`);
  }


  if (cfg.cup.startGw < 1 || cfg.cup.startGw > cfg.totalWeeks) {
    errors.push(`cup.startGw must be between 1 and ${cfg.totalWeeks}`);
  }
  if (cfg.cup.seedingGw < 1 || cfg.cup.seedingGw >= cfg.cup.startGw) {
    errors.push('cup.seedingGw must be between 1 and cup.startGw - 1');
  }
  if (!Number.isInteger(cfg.cup.byes) || cfg.cup.byes < 0) {
    errors.push('cup.byes must be a non-negative integer');
  }

  return errors;
}
