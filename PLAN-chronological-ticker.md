# Chronological Ticker Events Implementation Plan

**Overall Progress:** `90%`

## TLDR
Replace the current type-grouped ticker (goals, goals, goals, assists, assists...) with a true chronological event feed. Events are detected incrementally by comparing state between polls, timestamped, persisted to Redis for the current GW, and displayed with most recent on the right.

## Critical Decisions
- **Detection method**: Compare previous vs current player `explain` data from FPL API to detect point changes
- **Persistence**: Redis (already in use), cleared on GW transition
- **Clean sheets**: One ticker event per team, but FPL API handles individual player eligibility automatically via `explain` points
- **Saves/Goals conceded**: Incremental events (+1 each time threshold crossed, not cumulative)
- **Bonus points**: Only show when actual 3/2/1 positions change hands, not every BPS fluctuation
- **Same-poll ordering**: Priority by event type (goals first, then assists, etc.), then alphabetical
- **Transfer hits**: Remain at beginning of ticker (pre-kickoff events)

## Tasks

- [x] 🟩 **Step 1: Add Redis persistence for chronological events**
  - [x] 🟩 Add `getChronologicalEvents(gw)` and `setChronologicalEvents(gw, events)` Redis functions
  - [x] 🟩 Add `clearChronologicalEvents(gw)` for GW transitions
  - [x] 🟩 Load events from Redis on server startup

- [x] 🟩 **Step 2: Create previous state tracking structure**
  - [x] 🟩 Define `previousPlayerState` object to store last-seen `explain` points per player/fixture
  - [x] 🟩 Track: goals, assists, pen_saves, pen_misses, own_goals, red_cards, yellow_cards, clean_sheets, goals_conceded, saves, bonus, defcons
  - [x] 🟩 Store previous bonus positions (who had 3/2/1) per fixture

- [x] 🟩 **Step 3: Implement event detection logic**
  - [x] 🟩 On each poll, compare current `explain` data vs `previousPlayerState`
  - [x] 🟩 Detect new goals: player's goals_scored points increased
  - [x] 🟩 Detect new assists: player's assists points increased
  - [x] 🟩 Detect cards, pen saves/misses, own goals: points changed
  - [x] 🟩 Detect clean sheets: player gained clean_sheet points (API handles 60-min eligibility)
  - [x] 🟩 Detect saves: save points increased (+1 per 3 saves)
  - [x] 🟩 Detect goals conceded: goals_conceded points decreased (-1 per 2 goals)
  - [x] 🟩 Detect bonus changes: compare who holds 3/2/1 positions vs previous
  - [x] 🟩 Detect defcons: defensive_contribution points appeared

- [x] 🟩 **Step 4: Build chronological event objects**
  - [x] 🟩 Create event structure: `{ type, player, team, match, points, timestamp, fixtureId, elementId }`
  - [x] 🟩 Sort same-poll events by priority order, then alphabetically
  - [x] 🟩 Append new events to chronological list
  - [x] 🟩 Persist updated list to Redis

- [x] 🟩 **Step 5: Handle deduplication on restart**
  - [x] 🟩 On startup, load chronological events from Redis
  - [x] 🟩 Persist `previousPlayerState` and `previousBonusPositions` to Redis
  - [x] 🟩 Load previous state from Redis on startup (preserves detection continuity across restarts)
  - [x] 🟩 Clear previous state on GW transition

- [x] 🟩 **Step 6: Handle GW transitions**
  - [x] 🟩 Detect when `currentGW` changes from `liveEventState.lastGW`
  - [x] 🟩 Clear chronological events for old GW
  - [x] 🟩 Reset `previousPlayerState`

- [x] 🟩 **Step 7: Update API response**
  - [x] 🟩 Return `chronologicalEvents` array in `/api/week` response
  - [x] 🟩 Keep `liveEvents` for current state (impact calculations, match stats modal)

- [x] 🟩 **Step 8: Update frontend ticker display**
  - [x] 🟩 Replace ticker data source from `liveEvents` to `chronologicalEvents`
  - [x] 🟩 Keep transfer hits at the beginning
  - [x] 🟩 Display events left-to-right (oldest to newest)
  - [x] 🟩 Ensure each event shows match context clearly

- [ ] 🟥 **Step 9: Test and validate**
  - [ ] 🟥 Test with live match data
  - [ ] 🟥 Verify events appear in correct order
  - [ ] 🟥 Verify persistence survives server restart
  - [ ] 🟥 Verify GW transition clears old events
