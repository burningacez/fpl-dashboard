# FPL Mini League Dashboard

A real-time Fantasy Premier League dashboard for tracking a private mini-league. Built with vanilla JavaScript and Node.js, hosted on Render.

**Live site:** Hosted on Render (configure your own deployment)

## Features

### Pages
- **Live Scoring** (`/week`) - Real-time gameweek scores with pitch view, auto-subs, provisional bonus points
- **Standings** (`/standings`) - League table with manager profiles and season charts
- **Weekly Losers** (`/losers`) - Tracks who scored lowest each gameweek (wall of shame)
- **Manager of the Month** (`/motm`) - Period-based rankings with tiebreaker logic
- **Chips** (`/chips`) - Track chip usage across all managers
- **Earnings** (`/earnings`) - Prize money calculations based on league rules
- **Hall of Fame** (`/hall-of-fame`) - Season records and highlights
- **Set & Forget** (`/set-and-forget`) - What if you never changed your GW1 team?
- **Rules** (`/rules`) - League rules and prize structure
- **Admin** (`/admin`) - Password-protected season archive (mobile menu only)

### Key Features
- **Live provisional bonus points** - Calculates BPS-based bonus during matches, included in all scores
- **Auto-sub detection** - Shows when bench players come in for non-players
- **Yellow border for live matches** - Visual indicator for players currently playing
- **Fixture finish detection** - Stops live indicators after full-time whistle
- **Season archiving** - Archive completed seasons to Redis for historical viewing
- **Dark theme UI** - Purple/green FPL-style color scheme throughout

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

### Loser Overrides
Some gameweeks have manual overrides for who is the "loser" (configured in `LOSER_OVERRIDES` in server.js). This handles edge cases where the API data doesn't reflect the actual lowest scorer due to timing or data issues.

## Environment Variables

Set these in Render dashboard:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001, Render sets automatically) |
| `ADMIN_PASSWORD` | Yes | Password for admin panel (default: 'changeme') |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL for data persistence |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |
| `EMAIL_USER` | No | Gmail address for error alerts |
| `EMAIL_PASS` | No | Gmail app password for error alerts |

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
├── week.html          # Live scoring with pitch view
├── standings.html     # League table with modals
├── losers.html        # Weekly losers tracker
├── motm.html          # Manager of the month
├── chips.html         # Chip usage tracker
├── earnings.html      # Prize money breakdown
├── hall-of-fame.html  # Season records
├── set-and-forget.html# GW1 team comparison
├── rules.html         # League rules
├── admin.html         # Admin panel (archive season)
├── favicon.svg        # Site icon
├── render.yaml        # Render deployment config
└── package.json       # Node dependencies
```

## Key Server Functions

### Data Fetching
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
