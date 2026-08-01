# FPL Mini League Dashboard

A real-time Fantasy Premier League dashboard for tracking a private mini-league. Built with **Next.js (App Router) + TypeScript + Tailwind CSS**, hosted on Render (`next start` as a single long-lived Node service).

> **26/27 rewrite.** The app was rebuilt from a single-file vanilla Node/HTML app
> into Next.js for the 26/27 season. The original app is preserved under
> [`legacy/`](legacy/) as the behavioural reference; the data-processing logic was
> ported near-verbatim and is guarded by the characterization harness in
> [`tests/characterization/`](tests/characterization/).

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm run start   # production
npm test           # vitest (lib + services unit tests)
npm run lint
```

Environment variables (all optional in dev; see `.env.example` and `src/server/config.ts`):
`LEAGUE_ID`, `CURRENT_SEASON`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`ADMIN_PASSWORD`, `EMAIL_USER`, `EMAIL_PASS`, `ALERT_EMAIL`, `LOG_LEVEL`.

> **Production note:** `ADMIN_PASSWORD` **must** be set in production — the app
> refuses to boot on the default value.

## Architecture

- `src/app/` — pages + `/api/*` route handlers (all `force-dynamic`).
- `src/server/` — FPL API client (30s stale-while-revalidate cache + in-flight
  dedupe), Redis persistence (Upstash REST), `services/` (ported
  scoring/aggregation), `live/` (match-window scheduler, SSE hub, event
  diffing). Boot runs from `instrumentation.ts`.
- `src/lib/` — isomorphic pure logic (`utils`, `formation`, `squad-rules`,
  `identity`, `season-config`, `fdr`, `chips`).
- `src/components/` — design system (`ui`, `layout`, `pitch`, `identity`,
  `match`, `views`, providers).

### Data flow

1. On boot the server hydrates caches from Redis, then (if needed) runs a full
   pre-calculation across all managers and completed gameweeks (~minutes on a
   cold start; cache-only routes serve placeholders until it finishes).
2. A match-window scheduler polls the FPL API every 60s during live matches,
   extends until every fixture is `finished_provisional`, then runs a
   bonus-confirmation loop until FPL marks the gameweek `finished`.
3. Live updates stream to clients over SSE (`/api/live/events`): full `sync`
   payloads, incremental `new-events` ticker items, and `status` flips.
4. Concluded gameweeks are served as static lookups; only the live gameweek is
   recomputed.

## Pages

- **Scores / Standings** (`/week`) — live gameweek scores merged with the season
  standings: overall rank with movement arrows, GW score, captain/vice, bench,
  team value, season goals/assists badges, total. Pitch view per manager, live event ticker with clickable
  impact, provisional bonus, auto-subs, fixture strip with match stats, form tab,
  manager profile modal. `/standings` redirects here.
- **Weekly Losers** (`/losers`) — who scored lowest each GW (calculated points,
  goals/assists then most-transfers tiebreak, persistent coin flip), with live
  "as it stands" tile.
- **Manager of the Month** (`/motm`) — config-driven periods with a multi-level
  tiebreaker chain.
- **Earnings** (`/earnings`) — fines and prize money (dashes until the season's
  cash values are confirmed in season config).
- **Cup** (`/cup`) — knockout cup bracket from FPL's H2H sub-league, with match
  detail modals.
- **Hall of Fame** (`/hall-of-fame`) — season records, highlights and lowlights.
- **Set & Forget** (`/set-and-forget`) — what if you never changed your GW1 team?
- **Head to Head** (`/h2h`) — any two managers compared: record, form, captains, chips.
- **Analytics** (`/analytics`) — tinkering ROI, captaincy, consistency, streaks.
- **Team Planner** (`/planner`) — multi-GW transfer planning with FPL squad
  rules (budget, selling prices, 3-per-club, FT banking, hits), chip planning
  (one per half-season), FDR matrix with DGW/BGW detection, price views.
  Plans autosave to localStorage per team + season.
- **Rules** (`/rules`) — league rules and prizes for the selected season.
- **Admin** (`/admin`) — password-gated console: refresh/rebuild, season
  rollover, identity switch codes, claim management, traffic stats, log viewer.

### Identity ("Who are you?")

Members claim their team once (identification, not authentication — no
passwords). The claim is enforced server-side per device; switching teams needs
a rotating one-time code from the admin. The claimed team is highlighted on
every page and unlocks the planner. Season rollover re-resolves claims
automatically.

### Seasons

Per-season configuration (league id, fees, prizes, MOTM periods, chip halves,
cup GWs) lives in `src/lib/season-config.ts`. Rule changes are gated there too:
`attackingTiebreakers` turns on the goals/assists tiebreakers (and their badges
and columns) from 2026-27, and stays false for 2025-26 so a season that has
already been played keeps the results it finished with. Completed seasons are archived to
Redis via the admin console and remain browsable read-only from the season
picker. Manual weekly-loser corrections live server-side in
`src/server/loser-overrides.ts`, keyed by entry id.

## Testing

- `npm test` — vitest over `__tests__/` (pure lib logic, scoring core,
  tinkering, losers/earnings-adjacent services, live-event dedup).
- `tests/characterization/` — capture/compare scripts that snapshot API
  responses from a running server and diff them against the legacy app.

## Deployment (Render)

Configured via `render.yaml`. Set `ADMIN_PASSWORD` and the Upstash credentials
in the Render dashboard. On the free tier the service spins down after 15
minutes idle — point a keep-alive pinger (e.g. cron-job.org or UptimeRobot) at
`GET /api/health` every ~14 minutes.

## License

Private project — not for redistribution.
