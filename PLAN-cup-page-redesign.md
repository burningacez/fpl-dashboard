# Cup Page Redesign

## Context

`cup.html` (the `/cup` route) currently renders the bracket as a single 800px-wide column of dense rows: each match is a 0.85rem flex line `team | score | team`, with rounds stacked vertically newest-first. It works but feels cramped, doesn't celebrate the tournament, and clicking a team name navigates away to `/week` (losing the bracket context).

Several patterns elsewhere in the dashboard already solve the pieces we need:
- **`h2h.html`** has a beautiful side-by-side scoreboard (`.scoreboard`, lines 69–111) and stat-compare bars (lines 138–195) — exactly the "side-by-side teams" feel the user wants.
- **`losers.html`** has a tile grid (`.gw-tiles`, lines 17–95) with hover lift, status borders, and a live-pulse animation — great template for match tiles.
- **`standings.html`** has a polished modal pattern (`.modal-overlay`, `.quick-stats` stat boxes) we can reuse instead of navigating away.
- **`styles.css`** already exposes the design tokens (`--accent` green `#00ff87`, magenta `#e879f9` used as the "second manager" color in h2h, spacing, shadows, badges).

The goal: make the cup page feel like a tournament — scannable at a glance, satisfying to drill into, and consistent with the rest of the app.

## Recommended approach

A four-part redesign, each piece independently shippable. All files live in the same `cup.html` (vanilla HTML/JS/CSS — no framework). The `/api/cup` endpoint already returns everything we need; **no backend changes required** for parts 1–3.

### 1. Tournament summary header (replace `cup-header`)

Replace the single-line `${totalManagers} managers | Started GW${cupStartGW} | ${byeCount} byes` text with a `.quick-stats` grid of stat boxes (pattern from `standings.html:131-157`):

- **Round** — current live round name, or "Champion" once the final is decided
- **Managers remaining** — derived from `rounds[lastCompletedIdx].matches` winners count
- **Gameweek** — `currentGW`
- **Live matches** — count of `rounds[liveIdx].matches.filter(!isComplete && !isBye)`

When the final completes, swap the header for a "Champion" hero card (reuse `.winner-card.complete` from `styles.css:588-631`) with the winning manager + team name.

### 2. Round navigation strip (replaces "all rounds dumped vertically")

Add a horizontal "journey" strip below the header showing the bracket arc — `R32 → R16 → QF → SF → Final` — as pill tabs (pattern: `h2h.html` selector bar, lines 13–67). Each pill shows:
- Round name + GW number
- Status dot: complete (accent green), live (warning yellow + pulse), upcoming (gray)
- Click → scrolls to / filters to that round

Default to the live round, or the most recent completed round. On mobile, the strip scrolls horizontally.

### 3. Match tiles (the core change — replaces `.cup-match` rows)

Replace each `.cup-match` row with a **match tile**, laid out in a responsive grid (`grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))`, gap from `--space-4`). Each tile uses the H2H scoreboard pattern (`h2h.html:69-111`) at tile scale:

```
┌─────────────────────────────────┐
│  R16 · GW36                LIVE │  ← round/GW + live badge
├──────────┬─────────┬────────────┤
│ Manager1 │  72-58  │  Manager2  │  ← grid: 1fr auto 1fr
│ TeamName │   ✓     │  TeamName  │  ← winner check on winning side
├──────────┴─────────┴────────────┤
│ tiebreak: most goals (5 vs 4)   │  ← only if tiebreak
└─────────────────────────────────┘
```

Details:
- **Winner side**: accent-green name + bold + small check icon (reuse `.cup-team.winner` styling already there)
- **Loser side**: muted gray (existing `.cup-team.loser`)
- **Live tiles**: 1px accent border + soft glow (reuse `.round-section.live-round` styling); show provisional `liveScore1/liveScore2` with a small "LIVE" pill
- **Bye tiles**: half-width treatment, "BYE" badge centered, only one team shown
- **Final tile**: full-width spanning the grid, gold-tinted gradient (reuse `.round-section.final-round` linear-gradient at `cup.html:142-145`), trophy icon
- **Hover**: `transform: translateY(-2px)` + brighter background (copy from `.gw-tile:hover` at `losers.html:40-43`)
- **Click anywhere on tile**: opens match detail modal (part 4) instead of navigating away

### 4. Match detail modal (replaces full-page nav to `/week`)

Currently `openPitchModal()` at `cup.html:410-412` does `window.location.href = '/week?entry=...'`, which loses the bracket. Replace with an in-page modal (pattern: `.modal-overlay` from `standings.html:69-265`). The modal shows:

- **Top**: full-size H2H scoreboard (the actual `.scoreboard` from `h2h.html:69-111`) — big scores in accent/magenta, manager names + team names
- **Middle**: side-by-side "starting XI" panels — fetch existing pitch data from `/api/manager/{entryId}/picks?gw={gw}` for both entries in parallel; show captain (C), vice (V), bench, chips played, points per player
- **Bottom**: a compact stat-compare strip (pattern: `.stat-compare-row` + `.h2h-bar` from `h2h.html:138-195`) for "Bench points / Captain points / Transfer cost / Goals scored" — useful on tiebreaks

Close on overlay click, Escape, or X button (copy modal close handlers from `standings.html`).

## Critical files

- `cup.html` — entire redesign lives here (lines 11–244 styles, 283–414 script). No new files needed.
- `styles.css` — read-only reference for existing tokens (`--accent`, `--space-*`, `--radius-*`, `.badge`, `.winner-card`).
- `h2h.html:69-195` — copy `.scoreboard`, `.stat-compare-row`, `.h2h-bar` styles.
- `losers.html:17-95` — copy `.gw-tiles`/`.gw-tile` patterns for the match grid.
- `standings.html:69-265` — copy `.modal-overlay`, `.modal-content`, `.quick-stats`, `.stat-box` for the modal and summary header.
- `server.js:6839-7127` — `/api/cup` endpoint, **read-only reference** (data shape already includes everything: `cupName`, `currentGW`, `rounds[].matches[]` with `entry1/entry2`, scores, `liveScore1/2`, `winner`, `tiebreak`, `isBye`).
- `server.js:7309-7362` — `/api/manager/:entryId/picks?gw=N` endpoint used by the modal; returns `players[]` with `name`, `position`, `points`, `multiplier`, `isCaptain`, `isViceCaptain`, `isBench`, `subIn/subOut`, plus `formation`, `activeChip`, `transfersCost`, `pointsOnBench`.

## Verification

1. `node server.js` (or whatever the existing run command is) and load `http://localhost:<port>/cup`.
2. **Pre-cup state** — confirm placeholder + rules still render (use `?season=` for an old season where cup hadn't started, or temporarily mock `cupStarted: false`).
3. **Active cup** — current season:
   - Summary stat boxes populate with sensible numbers
   - Round strip highlights the live round
   - Match tiles render in a responsive grid; verify breakpoints at 480/768px
   - Live round shows accent border + pulse + provisional scores
   - Bye tiles render compact with "BYE" pill
   - Tiebreak text shows under the score
4. **Modal** — click any tile, confirm modal opens with both squads, captain marked, scores match the tile, Esc/overlay-click closes, bracket position preserved.
5. **Past seasons** — load `?season=2023` etc., confirm completed bracket still renders correctly with a champion hero card.
6. **Mobile** — Chrome devtools at 375px: round strip scrolls horizontally, tiles stack one-per-row, modal fills viewport.
7. Hover, focus-visible, and click states all reachable by keyboard.

## Out of scope for this pass

- Visual horizontal bracket (rounds as columns with connecting lines) — nice but expensive; revisit if part 1–4 lands well.
- "Your match highlight" (requires user identity / saved entry) — separate feature.
- Backend changes to `/api/cup` — current shape is sufficient.
