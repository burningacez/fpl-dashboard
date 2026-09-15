# Design canvas sources

Working files for the Set & Forget "banked points" mockups
(https://claude.ai/artifact/NRozQde7M1F7irYNM8Co5n) — three directions for what
the manager pitch shows when you open a frozen GW1 squad:

- `Main.dc.html` — A, banked points on the existing pitch
- `Ledger.dc.html` — B, a sortable ledger that reconciles to the S&F total
- `SeasonMap.dc.html` — C, a 38-gameweek map per player
- `canvas.json` — how the three sit on the canvas

They are mockups, not app code: sample numbers, no imports from `src/`. The
premise behind all three is that a player's raw season total appears nowhere in
the Set & Forget score — that total is, per gameweek, starters x multiplier plus
auto-subs on, so what a player is worth to a frozen squad is what it BANKED:
started / armband on top / came on as a sub, with bench points outside the
total entirely.

The published canvas is re-seeded from these files; the seeded `.html` carries a
2MB editor bundle and is gitignored.
