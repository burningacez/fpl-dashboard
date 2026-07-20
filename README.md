# FPL Mini League Dashboard

A real-time Fantasy Premier League dashboard for tracking a private mini-league. Built with **Next.js (App Router) + TypeScript + Tailwind CSS**, hosted on Render.

**Live site:** Hosted on Render (`next start` as a single long-lived Node service).

> **26/27 rewrite.** The app was rebuilt from a single-file vanilla Node/HTML app
> into Next.js for the 26/27 season. The original app is preserved under
> [`legacy/`](legacy/) as the behavioural reference; the data-processing logic was
> ported near-verbatim and is guarded by the characterization harness in
> [`tests/characterization/`](tests/characterization/). New this season:
> "Who are you?" login (pick your team → highlighted everywhere), a multi-gameweek
> **Team Planner** (`/planner`), and a charcoal + amber theme.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm run start   # production
npm test           # vitest (ported unit tests + squad-rules)
```

Environment variables (all optional in dev; see `src/server/config.ts`):
`LEAGUE_ID`, `CURRENT_SEASON`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`ADMIN_PASSWORD`, `EMAIL_USER`, `EMAIL_PASS`, `ALERT_EMAIL`, `LOG_LEVEL`.

## Architecture

- `src/app/` — pages + `/api/*` route handlers (all `force-dynamic`).
- `src/server/` — FPL API client (30s stale-while-revalidate cache + in-flight
  dedupe), Redis persistence (Upstash REST, byte-compatible with the legacy blob,
  `CACHE_VERSION = 5`), `services/` (ported scoring/aggregation), `live/`
  (match-window scheduler, SSE hub, event diffing). Boot runs from
  `instrumentation.ts`.
- `src/lib/` — isomorphic pure logic (`utils`, `formation`, `squad-rules`, `identity`).
- `src/components/` — design system (`ui`, `layout`, `pitch`, `identity`, providers).

**[View Changelog](CHANGELOG.md)** for detailed update history.

## Features

### Pages
- **Weekly Scores** (`/week`) - Real-time gameweek scores with pitch view, live event ticker, auto-subs, provisional bonus
- **Standings** (`/standings`) - League table with movement indicators, manager profiles and season charts
- **Weekly Losers** (`/losers`) - Tracks who scored lowest each gameweek with live GW modal
- **Manager of the Month** (`/motm`) - Period-based rankings with tiebreaker logic
- **Chips** (`/chips`) - Track chip usage across all managers
- **Earnings** (`/earnings`) - Prize money calculations with dynamic season progress
- **Cup** (`/cup`) - Mini-league knockout cup competition (starts GW34)
- **Hall of Fame** (`/hall-of-fame`) - Season records and highlights
- **Set & Forget** (`/set-and-forget`) - What if you never changed your GW1 team?
- **Rules** (`/rules`) - League rules and prize structure
- **Admin** (`/admin`) - Password-protected season archive (mobile menu only)

### Key Features
- **Live event ticker** - Real-time feed of goals, assists, cards, saves, bonus changes, clean sheets, and defensive contributions
- **Event change tracking** - Shows events AS they happen (bonus position changes, clean sheets lost, defcons gained)
- **Clickable event impact** - Click any event to see which managers are affected with point impact badges (click again to toggle off)
- **Tinkering impact** - Shows true impact of transfers and lineup changes, accounting for bench positions and auto-subs
- **Live provisional bonus points** - Calculates BPS-based bonus during matches with popup showing BPS standings
- **Auto-sub detection** - Shows when bench players come in for non-players
- **Yellow border for live matches** - Visual indicator for players currently playing
- **Faded players for finished matches** - Players whose match has finished appear at 60% opacity
- **Standings movement** - Arrow indicators showing rank changes from previous week
- **Match stats modal** - Click any fixture to see player stats and points breakdown
- **Fixture finish detection** - Uses `finished_provisional` flag to detect full-time, polling extends until all matches confirm finished
- **Season archiving** - Archive completed seasons to Redis for historical viewing
- **Dark theme UI** - Purple/green FPL-style color scheme throughout

### Live Event Types
The ticker tracks and displays these events in real-time:
- ⚽ Goals (with position-based points: DEF 6, MID 5, FWD 4)
- 👟 Assists (+3 pts)
- 🟨 Yellow cards (-1 pt)
- 🟥 Red cards (-3 pts)
- 🧤 Goalkeeper saves (+1 pt per 3 saves)
- 🔒 Defensive contributions (+1 pt)
- 🛡️ Clean sheets (+4 pts for GK/DEF)
- 💔 Clean sheet lost (-4 pts when team concedes)
- ⭐ Bonus points with BPS breakdown and position changes
- 😞 Goals conceded (-1 pt per 2 goals for GK/DEF)

## Architecture

### Tech Stack
- **Backend:** Node.js with native `http` module (no Express)
- **Frontend:** Vanilla JavaScript, HTML, CSS (no frameworks)
- **Data:** FPL API (fantasy.premierleague.com)
- **Storage:** Upstash Redis for visitor stats and archived seasons
- **Hosting:** Render.com

### Data Flow
1. Server fetches data from FPL API on startup and caches it
2. Smart polling system:
   - **Pre-match polling** starts at GW deadline (when FPL releases data), not kickoff
   - **Live polling** every 60 seconds during matches
   - **Smart stop** - polling continues until all matches have `finished_provisional=true` (with 30-min safety timeout)
   - Daily refresh at 6am UK
3. All API endpoints serve from cache for instant response
4. Pre-calculated data includes: manager profiles, hall of fame, tinkering impact, set-and-forget scores

### Error Handling
- All FPL API calls have 10-second timeouts to prevent hanging
- Failed API responses (non-2xx) throw descriptive errors with HTTP status
- Frontend displays user-friendly error messages without exposing internals
- Admin endpoints validate request bodies and return appropriate HTTP status codes (400, 401, 413)

## Important Caveats

### Startup Time (~6 minutes)
On server startup or daily refresh, the server pre-calculates data for all managers across all gameweeks:
- Fetches picks for every manager for every completed GW
- Calculates tinkering impact (what if you kept last week's team?)
- Calculates set-and-forget scores (what if you kept GW1 team?)
- Pre-caches processed picks for instant pitch view loading

**This only happens once per day (or on restart)**. During live matches, only lightweight data refreshes occur.

### What We Tried That Didn't Work

1. **Calculating tinkering during Hall of Fame requests** - Made Hall of Fame page timeout. Solution: Pre-calculate all tinkering data during daily refresh and store in cache.

2. **Checking cache after network calls** - Initial caching implementation checked cache AFTER calling bootstrap API, adding latency. Solution: Check cache BEFORE any network calls when GW parameter is provided.

3. **Pre-caching during live polling** - Initially ran pre-calculation during every 60-second refresh. This was unnecessary (completed GW data doesn't change) and impacted live performance. Solution: Only pre-cache during startup/daily/morning refresh.


## Environment Variables

Set these in Render dashboard:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001, Render sets automatically) |
| `ADMIN_PASSWORD` | **Yes** | Password for admin panel - **must be set in production** (insecure default: 'changeme') |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL for data persistence |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |
| `EMAIL_USER` | No | Gmail address for error alerts |
| `EMAIL_PASS` | No | Gmail app password for error alerts |

> **Security Note:** Always set `ADMIN_PASSWORD` to a strong, unique value in production. The default value is intentionally weak to encourage configuration.

## Local Development

```bash
# Install dependencies
npm install

# Run server
npm start

# Server runs on http://localhost:3001
```

For local development, create a `.env` file (not committed):
```
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token
ADMIN_PASSWORD=localpassword
```

## Project Structure

```
├── server.js          # Main server - all API endpoints and data fetching
├── CHANGELOG.md       # Detailed changelog of all updates
├── styles.css         # Global styles (dark theme)
├── season-selector.js # Client-side season switching logic
├── index.html         # Home page with navigation cards
├── week.html          # Weekly scores with pitch view and live ticker
├── standings.html     # League table with movement indicators
├── losers.html        # Weekly losers tracker with live GW modal
├── motm.html          # Manager of the month
├── chips.html         # Chip usage tracker
├── earnings.html      # Prize money breakdown
├── cup.html           # Mini-league cup competition
├── hall-of-fame.html  # Season records
├── set-and-forget.html# GW1 team comparison
├── rules.html         # League rules
├── admin.html         # Admin panel (archive season)
├── favicon.png        # Site icon
├── render.yaml        # Render deployment config
└── package.json       # Node dependencies
```

## Security

### Server-Side Protections
- **API Timeouts** - All FPL API calls use `AbortSignal.timeout(10000)` to prevent hanging requests
- **Response Validation** - All fetch calls check `response.ok` before parsing JSON to handle HTTP errors gracefully
- **DoS Prevention** - Admin endpoints (`/api/admin/verify`, `/api/archive-season`) enforce 1KB request body limits
- **Input Validation** - `entryId` and `gw` parameters are validated with `isNaN()` checks; gameweek must be 1-38
- **Request Error Handling** - Admin POST endpoints include `req.on('error')` handlers for connection issues

### Frontend Protections
- **XSS Prevention** - Error messages use `textContent` instead of `innerHTML` to prevent script injection
- **Safe HTML Rendering** - `escapeHtml()` helper function sanitizes user data before HTML insertion
- **Event Delegation** - Clickable rows use data attributes instead of inline onclick with string escaping

## Key Server Functions

### Data Fetching
- `fetchWithTimeout(url, timeoutMs)` - Wrapper that adds timeout and response.ok validation to all API calls
- `fetchBootstrap()` - Core FPL data (players, teams, events)
- `fetchManagerPicks(entryId, gw)` - Manager's team for a gameweek
- `fetchLiveGWData(gw)` - Live points data for a gameweek
- `fetchManagerHistory(entryId)` - Manager's full season history

### Pre-calculation (runs on startup/daily)
- `preCalculateManagerProfiles()` - Season stats for each manager
- `preCalculatePicksData()` - Cache raw picks and live data
- `preCalculateTinkeringData()` - "What if you kept last week's team?"
- `calculateSetAndForgetData()` - "What if you kept GW1 team?"
- `preCalculateHallOfFame()` - Season records and highlights

### Points Calculation
- `calculatePointsWithAutoSubs()` - Total points with auto-subs and provisional bonus
- `calculateProvisionalBonus()` - BPS-based bonus during live matches
- `calculateHypotheticalScore()` - Points for a hypothetical team in a given GW

### Live Event Tracking
- `liveEventState` - Stores previous state for change detection (bonus positions, clean sheets, defcons)
- `fetchWeekData()` - Extracts live events from fixtures and detects changes between polls
- Change events generated: `bonus_change`, `cs_lost`, `defcon_gained`

### Polling Control
- `scheduleRefreshes()` - Calculates match windows and schedules polling start/stop
- `startLivePolling(reason)` - Begins 60-second refresh interval
- `checkAndStopPolling(originalEndTime, reason)` - Verifies all matches have `finished_provisional=true` before stopping; extends polling up to 30 mins if needed
- `stopLivePolling(reason)` - Stops polling and performs final data refresh

## Customization

### League ID
Change `LEAGUE_ID` constant in server.js (line 7) to your mini-league ID.

### Season
Update `CURRENT_SEASON` constant in server.js (line 10) each year.

### Loser Overrides
Edit `LOSER_OVERRIDES` object in server.js to manually set weekly losers.

### Prize Structure
Edit the rules in `rules.html` and earnings calculation in `fetchProfitLossData()`.

## Deployment

The project is configured for Render.com via `render.yaml`:
1. Push to GitHub
2. Connect repo to Render
3. Set environment variables
4. Deploy

First deployment takes ~6 minutes to pre-calculate all data.

### Preventing Cold Starts (Render Free Tier)

Render's free tier spins down after 15 minutes of inactivity. To keep your app running:

1. **Set up a free keep-alive service** (recommended: [cron-job.org](https://cron-job.org))
2. Create a job that pings your health endpoint every 14 minutes:
   - URL: `https://your-app.onrender.com/api/health`
   - Interval: Every 14 minutes
   - Method: GET

The `/api/health` endpoint returns minimal data for fast response:
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "uptime": 3600
}
```

**Alternative free services:**
- [UptimeRobot](https://uptimerobot.com) - 5-minute intervals on free tier
- [Freshping](https://freshping.io) - Free monitoring

## License

Private project - not for redistribution.
