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
`ADMIN_PASSWORD`, `EMAIL_USER`, `EMAIL_PASS`, `ALERT_EMAIL`, `LOG_LEVEL`,
`PREVIEW_ENTRY_IDS` (see [Preview access](#preview-access-testing-a-feature-live-before-sharing-it)).

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
5. Pre-season (before the GW1 deadline) the roster is the only thing that moves,
   so a dedicated poller watches it — see [Pre-season roster sync](#pre-season-roster-sync).

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
  Plans autosave to localStorage per team + season. The pitch shows the starting
  XI in formation with the bench in substitution order, and warns when a planned
  transfer leaves an illegal XI.
- **Squad Builder** (`/planner`, pre-season only) — before the GW1 deadline FPL
  publishes no squads, so any logged-in member can build a practice GW1 team
  from £100.0m instead and plan against it. See
  [Pre-season squad builder](#pre-season-squad-builder).
- **Rules** (`/rules`) — league rules and prizes for the selected season.
- **Admin** (`/admin`) — password-gated console: refresh/rebuild, season
  rollover, identity switch codes, claim management, traffic stats (site-wide
  and per claimed member — first/last active, days and pages over the selected
  range), log viewer.

### Identity ("Who are you?")

Members claim their team once (identification, not authentication — no
passwords). The claim is enforced server-side per device; switching teams needs
a rotating one-time code from the admin. The claimed team is highlighted on
every page and unlocks the planner. Season rollover re-resolves claims
automatically.

### Guided walkthroughs

A first visit to Scores offers a step-by-step walkthrough that spotlights each
area of the page and opens each of its modals in turn. It is replayable from the
`?` button beside the gameweek, and skipping or finishing it records the fact
per device (`fpl-tour-seen` in localStorage, versioned per tour).

- `src/lib/tour.ts` — pure logic: step shape, seen-state, tooltip geometry.
- `src/components/tour/` — the engine (`TourProvider`) and the spotlight
  overlay. One provider in the app shell, one overlay at a time.
- `src/app/week/weekTour.ts` — the Scores script, kept beside the page it
  describes. Currently the only tour; other pages simply host none.

Two things to know before adding or editing steps:

1. **Steps drive page state, they don't click controls.** A step names its
   anchor with a `data-tour` attribute and mutates state through
   `before`/`after` callbacks. The modals here mount before their fetch
   resolves and close on a backdrop click, so synthesising clicks would be both
   racy and dismissable.
2. **Every data-dependent step needs a `when` gate.** Pre-season and
   cold-cache visits have no fixtures, no ticker and an empty table. Gated
   steps drop out and the walkthrough shrinks to what it can honestly show
   (16 steps down to 8 with an empty payload) rather than pointing at nothing.

Bump `WEEK_TOUR_VERSION` when the page changes enough that the old script would
mislead — that re-shows it once to everyone.

### Pre-season squad builder

FPL publishes nothing manager-specific until the GW1 deadline: `entry/{id}/picks`
404s, so the planner has no base squad and normally degrades to a fixtures-and-
prices view. That leaves the planner untestable for the weeks when people most
want to use it.

Every logged-in member instead gets a **Squad Builder**: pick 15 from £100.0m
under the real constraints (2/5/5/3, max 3 per club, and a cap per pick that
keeps the squad completable), then set the starting XI and bench order. The
finished draft becomes the planner's base and GW1..GW5 plan as normal.

It shipped through the 26/27 pre-season restricted to a preview allowlist and
was released to everyone in August 2026 — the gate it went through is still
there for the next feature, described under
[Preview access](#preview-access-testing-a-feature-live-before-sharing-it).

Design notes worth knowing before changing it:

- **The draft is based at gameweek 0**, meaning "the squad as it stands before
  GW1". That makes GW1 the first *plannable* week, which is the week you're
  actually picking — basing at GW1 would have started planning at GW2.
- **GW1 is an unlimited week** (`FoldBase.unlimitedGw`). Changing your squad
  before the first deadline isn't a transfer: it costs no points and banks
  nothing. Free transfers therefore start at 0, so accrual yields the correct
  1 FT entering GW2.
- **Pre-season is decided from the calendar** (no event `finished` or
  `is_current`), never inferred from a failed picks fetch — otherwise a
  transient FPL outage in November would drop someone into a squad builder.
- **The draft is local and disposable.** It lives only in the browser's
  localStorage, is never sent to the server, and is deleted the first time a
  real squad loads. Any plan still based on it then shows a season-start rebase
  prompt.
- **It is a sandbox, not an entry.** A permanent banner says so; the real team
  is entered on fantasy.premierleague.com and nothing here touches it.

Pre-season every player's `total_points`, `form` and `points_per_game` are 0, so
the player list sorts by price rather than points and says as much.

### Pre-season roster sync

Entrants join the mini-league right up to the GW1 deadline, and pre-season is
the one window where nothing on the normal schedule would notice them: the
match-window jobs need fixtures for a *current* gameweek (there are none), and
the freeze guard (`src/lib/refresh-freeze.ts`) turns the boot and 6am refreshes
into no-ops while no gameweek is live or settling. A new entrant used to appear
only when the process restarted, because boot unconditionally re-runs
`refreshWeekData()`.

So while `isPreSeason()` holds (`src/lib/season-phase.ts` — no event `finished`
or `is_current`, decided from the calendar, never from a failed fetch):

- `src/server/services/roster.ts` re-reads the league endpoint every 2 minutes
  and runs a full refresh **only when the member list actually changes** — one
  cheap request per poll, the expensive pass once per joiner.
- `/api/members` and the identity picker read the roster live (throttled to one
  FPL call per 30s, shared with the poller) instead of the standings snapshot,
  so a joiner shows on the next page load rather than the next poll.
- The poller stops itself at the first deadline and reschedules, which is also
  what picks up GW1's match windows if the 6am check ran before FPL marked the
  gameweek current.

In-season none of this runs: the roster is fixed, and the normal live/bonus
refreshes keep the member list current anyway.

### Seasons

Per-season configuration (league id, fees, prizes, MOTM periods, chip halves,
cup GWs) lives in `src/lib/season-config.ts`. Rule changes are gated there too:
`attackingTiebreakers` turns on the goals/assists tiebreakers (and their badges
and columns) from 2026-27, and stays false for 2025-26 so a season that has
already been played keeps the results it finished with. Completed seasons are archived to
Redis via the admin console and remain browsable read-only from the season
picker. Manual weekly-loser corrections live server-side in
`src/server/loser-overrides.ts`, keyed by entry id.

## Preview access (testing a feature live before sharing it)

Some things can only really be tested in production: they need the live FPL
feed, the real league, a phone on the sofa. `src/server/preview-access.ts` lets
a finished feature be deployed and used there while staying invisible to
everyone else, then released to the league by changing one line.

It has two moving parts, deliberately separate:

| Part | Where | What it decides |
| --- | --- | --- |
| `PREVIEW_GATED` | `src/server/preview-access.ts` | Whether a feature is **still** in preview. Ships as a commit, so the release is reviewable and revertable. |
| `PREVIEW_ENTRY_IDS` | Environment (Render dashboard) | **Who** gets in while a feature is gated. Comma-separated FPL entry ids, e.g. `1234567,7654321`. |

Keeping them apart is the point: releasing a feature never depends on
remembering to clear an environment variable, and the allowlist survives the
release, ready to gate the next thing.

**To gate a new feature**

1. Add a key to `PREVIEW_GATED` set to `true` (and to the `PreviewFeature` union).
2. Call `previewAllowed('your-feature', entryId)` on the server wherever the
   feature is served — a route handler, or a page's data fetch. Decide it
   server-side and send the client a boolean; a client-side check ships the
   feature (and the ids) to anyone who reads the bundle.
3. Set `PREVIEW_ENTRY_IDS` in the Render dashboard to the entry ids that should
   see it. No redeploy is needed to change the list later.
4. Give everyone else a sensible fallback — the planner degraded to its
   fixtures-and-prices view, it didn't 404.

**To release it:** set the key to `false` and deploy. Leave `PREVIEW_ENTRY_IDS`
alone; it only ever applies to features still marked `true`.

An **unset** `PREVIEW_ENTRY_IDS` means gated features are open in development
(so local work needs no setup) and closed in production (so a forgotten
variable fails shut, not open).

`PLANNER_PREVIEW_ENTRY_IDS` was the original, planner-specific name for this
variable and is still read as a fallback, so a value already set in a
deployment keeps working. Prefer `PREVIEW_ENTRY_IDS` for anything new.

## Testing

- `npm test` — vitest over `__tests__/` (pure lib logic, scoring core,
  tinkering, losers/earnings-adjacent services, live-event dedup).
- `tests/characterization/` — capture/compare scripts that snapshot API
  responses from a running server and diff them against the legacy app.
- `npm run test:tour` — walks the Scores walkthrough end to end against stubbed
  API payloads in a headless browser, screenshotting each step. Run it after
  touching the Scores page or its modals: tour steps are a second source of
  truth about the UI, and nothing else notices when a restructure orphans a
  `data-tour` anchor. Add `--empty` for the pre-season payload, or pass a
  viewport (`node tests/tour/week-tour.mjs /tmp/shots 390 844`) to check the
  phone layout, where the tooltip has to dodge the bottom-sheet modals.

## Deployment (Render)

Configured via `render.yaml`. Set `ADMIN_PASSWORD` and the Upstash credentials
in the Render dashboard. On the free tier the service spins down after 15
minutes idle — point a keep-alive pinger (e.g. cron-job.org or UptimeRobot) at
`GET /api/health` every ~14 minutes.

## License

Private project — not for redistribution.
