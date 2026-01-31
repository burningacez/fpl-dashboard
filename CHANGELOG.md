# Changelog

All notable changes to the FPL Mini League Dashboard.

## [2026-01-31] - Match Status & Polling Fixes

### Fixed
- **Match status showing "90'" instead of "FT"** - Polling now continues until FPL sets `finished_provisional=true`, rather than stopping at a calculated time (kickoff + 115 mins). This ensures matches display "FT" correctly even when FPL is delayed in updating the flag.
- **BPS bonus calculation in match modal** - Fixed tie handling to follow official FPL rules: ties cause subsequent ranks to be skipped (e.g., 2 players tied at highest BPS both get 3pts, next player is rank 3 and gets 1pt, nobody gets 2pts)

### Changed
- **Smarter polling stop logic** - Added `checkAndStopPolling()` function that checks fixture status before stopping. Includes 30-minute safety timeout to prevent infinite polling if FPL data is delayed.
- **Data polling starts from GW deadline** - Polling now begins at gameweek deadline (when FPL releases data) rather than 5 minutes before first kickoff, ensuring data is available as soon as FPL publishes it

### Technical
- New `checkAndStopPolling(originalEndTime, reason)` function in server.js that fetches fresh fixtures and verifies all started matches have `finished_provisional=true` before stopping
- Console logs now show when polling is extended: `"[Live] 2 match(es) not yet finished (extended 5+ mins), continuing polling"`

---

## [2026-01-24] - Tinkering & Pitch View Improvements

### Added
- **Pitch view fading** - Players whose match has finished now appear faded (60% opacity), making it easy to distinguish from players currently playing (yellow border) or not yet started
- **Pre-cached processed picks** - Pitch views now load instantly from cache for completed gameweeks (previously required on-demand processing)
- **Ticker event toggle** - Clicking a ticker event again now closes the popup/impact display (previously required a separate Clear button)

### Fixed
- **Tinkering impact calculation** - Section totals now correctly add up to the net benefit by calculating true impact considering bench positions and auto-subs
- **'+-' display bug** - Fixed negative scores in tinkering sections showing as "+-5" instead of "-5"
- **Manager impact display** - Fixed clicking ticker events not showing score impact on managers in the table (selector was targeting wrong element)

### Changed
- **Pre-caching timing** - Pre-calculation of picks and tinkering data now only runs during startup, daily refresh, and morning-after refresh (not during live polling every 60 seconds)
- **Removed Clear button** - Replaced with toggle behavior on ticker events for cleaner UI

### Performance
- Live polling refreshes are now much faster as they skip the heavy pre-caching step
- Pitch view loads are instant for completed gameweeks due to processed picks being pre-cached

---

## [2026-01-23] - Overall Points & Mobile Improvements

### Added
- **Overall points column** - Weekly scores table now shows overall points between Manager and Captain columns
- **Fullscreen mobile modals** - All modals (except Hall of Fame) now open fullscreen on mobile devices (768px and below)
- **Cup holding page** - Cup page now shows placeholder until GW34 with explanation of bye system for top 3 GW33 scorers

### Fixed
- **Standings calculation** - Fixed 8-point discrepancy between weekly scores and standings page by using consistent calculation method
- **Pitch view scroll bug** - Fixed vertical scrolling in pitch view triggering gameweek swipe navigation

---

## [2026-01-22] - Chronological Ticker

### Added
- **Chronological event ticker** - Events now display in the order they happened during matches
- **Event change tracking** - Live detection of bonus position changes, clean sheets lost, defensive contributions gained
- **Persistent event state** - Events persist across server restarts via Redis

### Fixed
- **Bonus calculation for auto-subs** - Fixed bonus points not being applied correctly when players came in as auto-subs
- **Polling performance** - Reduced Redis save frequency during live matches to prevent rate limiting

---

## [2026-01-21] - Live Event System

### Added
- **Live event ticker** - Real-time feed showing goals, assists, cards, saves, bonus changes
- **Clickable event impact** - Click any event to see which managers own that player with point impact badges
- **Provisional bonus popup** - Click bonus events to see BPS standings and projected bonus

### Fixed
- **Bonus points in popup** - Fixed bonus points display showing incorrect values in match popup

---

## Previous Releases

See git history for changes prior to 2026-01-21.
