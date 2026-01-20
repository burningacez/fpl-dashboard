# FPL Mini League Dashboard

A real-time Fantasy Premier League dashboard for tracking a private mini-league. Built with vanilla JavaScript and Node.js, hosted on Render.

**Live site:** Hosted on Render (configure your own deployment)

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
- **Clickable event impact** - Click any event to see which managers are affected with point impact badges
- **Live provisional bonus points** - Calculates BPS-based bonus during matches with popup showing BPS standings
- **Auto-sub detection** - Shows when bench players come in for non-players
- **Yellow border for live matches** - Visual indicator for players currently playing
- **Standings movement** - Arrow indicators showing rank changes from previous week
- **Match stats modal** - Click any fixture to see player stats and points breakdown
- **Fixture finish detection** - Stops live indicators after full-time whistle
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
2. Cron jobs refresh data:
   - Every 2 minutes during live matches (7am-midnight UK)
   - Daily at 6am UK for full refresh
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

1. **Pre-calculating processed picks on startup** - Originally tried to pre-process all 600+ picks records (managers × gameweeks) with full player enrichment. This overwhelmed the server and caused timeouts. Solution: Only cache raw API data, process on-demand.

2. **Calculating tinkering during Hall of Fame requests** - Made Hall of Fame page timeout. Solution: Pre-calculate all tinkering data during daily refresh and store in cache.

3. **Checking cache after network calls** - Initial caching implementation checked cache AFTER calling bootstrap API, adding latency. Solution: Check cache BEFORE any network calls when GW parameter is provided.


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
├── favicon.svg        # Site icon
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

## License

Private project - not for redistribution.
