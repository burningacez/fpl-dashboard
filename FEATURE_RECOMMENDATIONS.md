# Feature Recommendations

Based on a full project review of the FPL Dashboard codebase (62 merged PRs, 11 pages, ~10,000+ lines of frontend code, 5,600-line server).

## 1. Head-to-Head Manager Comparison Page

**Route:** `/h2h`

**What:** Select any two managers and see a side-by-side comparison across every meaningful metric.

**Why:** The dashboard shows individual or league-wide stats, but mini-league banter thrives on direct rivalry. There's no way to answer "how am I doing against my mate?" in a single view. The data already exists across API endpoints — it needs to be composed into a comparison view.

**Metrics to compare:**
- GW-by-GW points (dual-line Chart.js chart)
- Head-to-head GW wins/losses/draws
- Captain pick comparison (overlap, points gained)
- Transfer activity (total transfers, hits, net ROI)
- Chip timing and effectiveness
- Rank trajectory overlay
- Current form (last 5 GW average)

**Implementation:** All data is already fetched and cached — `managerHistories`, `managerPicks`, `chipData`, `standingsData`. A new `/api/h2h?m1=ID&m2=ID` endpoint would compose these. Frontend: new HTML page with two-column layout and Chart.js overlays. Estimated: ~300 lines server, ~400 lines HTML/JS/CSS.

---

## 2. Season Analytics Dashboard

**Route:** `/analytics`

**What:** Aggregated, season-long statistical insights for each manager beyond points-and-rank.

**Why:** The project already computes detailed per-GW data (tinkering analysis, captain points, bench players) but only surfaces it one gameweek at a time. No aggregated view answers: "Who's left the most points on the bench?" or "Whose captain picks have been best?"

**Metrics:**
- **Transfer ROI:** Net point impact of all transfers across the season. Best/worst transfer per manager.
- **Captain Success Rate:** Captain points, accuracy (% of GWs where captain was team's top scorer).
- **Bench Points Wasted:** Total points from bench players that didn't auto-sub in.
- **Consistency Score:** Standard deviation of weekly scores (already computed for Hall of Fame, not surfaced per-manager).
- **Form Streaks:** Longest winning streak (consecutive GWs above league avg), longest cold streak.
- **Differential Impact:** Points from players owned by fewer than N managers in the league.

**Implementation:** The tinkering analysis (`/api/tinkering/:entryId`) already computes transfer/bench impact per GW. The analytics endpoint aggregates across all GWs. Sortable table with expandable per-GW breakdowns. Leverages existing caching.

---

## 3. Gameweek Predictions Mini-Game

**Route:** `/predictions`

**What:** League members submit predictions before each GW deadline. Results and a cumulative leaderboard shown after deadline.

**Why:** The biggest engagement gap is the mid-week lull between gameweeks. The dashboard only comes alive during live matches. Predictions give members a reason to visit before deadline and create a second layer of competition.

**How it works:**
- **Pre-deadline:** Each manager predicts: (a) highest scorer in the league, (b) weekly loser, (c) over/under on league total points. Optionally: predict top 3 order.
- **Scoring:** Exact match = 3 pts, close (within 1 rank) = 1 pt.
- **Leaderboard:** Cumulative prediction score across the season.
- **Auth:** Simple unique tokens per manager (stored in Redis + localStorage). No full auth system needed.

**Implementation:** New Redis keys (`predictions:{season}:{gw}:{managerId}`), submission endpoint (`POST /api/predictions`), deadline check against `bootstrapData.events`, scoring function after GW finalizes. Frontend: form pre-deadline, results post-deadline. Most ambitious feature — introduces write operations from users.

---

## Priority

| # | Feature | Impact | Effort | Recommendation |
|---|---------|--------|--------|----------------|
| 1 | Head-to-Head Comparison | High | Low | Start here |
| 2 | Season Analytics | High | Medium | Build next |
| 3 | Predictions Mini-Game | Very High | High | Most ambitious |
