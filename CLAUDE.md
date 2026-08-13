# CLAUDE.md — AREIT Trading Platform

Context for Claude Code working in this repo. Read this first.

## What this is
A personal ASX trading & research platform. Generates daily equity/REIT signals, tracks a model (paper) portfolio and a real portfolio, and emails a morning briefing. **This is a personal paper-trading tool — it is NOT a 360 Capital product. Do not put 360 Capital branding, logos, or the five-dot mark anywhere in it.** (The brand *colours* are reused, but unbranded.)

## Stack
- **Hosting:** Netlify Pro — live at `areit.netlify.app`. Auto-deploys from `main`.
- **Repo:** `originateai/areit-portfolio` (GitHub).
- **DB:** Supabase, project `opziisvjfkjwwdbclniw`.
- **Market data:** EODHD (**All-in-One, $99 tier** — full fundamentals, commodities, treasury, splits/dividends, calendar, tick all enabled). FRED for some macro.
- **ML:** XGBoost model (AUC 0.71, ~73.7% win rate) deployed on Railway as v2.0. Equities only.
- **Email:** Resend.

## Architecture conventions — IMPORTANT
- **Flat SPA. NO React, NO bundler.** The app is standalone HTML. Main file is `public/index.html` — **the single source of truth**. Do not introduce a build step or framework.
- **No mirror files.** The old root-level duplicates (`index.html`, `morning-scan.js`, `fetch-indicators.js`, `eodhd-client.js`) were deleted 2026-08-13 — they had silently drifted from the deployed copies. Only `public/` and `netlify/functions/` deploy (see `netlify.toml`). Never re-create a second copy of a deployed file.
- **Serverless functions** live in `netlify/functions/`.
- **All technical indicators are self-calculated client-side from raw price data** (`adjusted_close`): Wilder RSI, SMA20/50/200, Bollinger, MACD, ATR, ROC, volume ratio. Do not switch to a pre-computed indicator feed without being asked.
- **Prefer clean rewrites over patches.** Don't stack band-aids on a broken function — rewrite it cleanly. Avoid over-engineered solutions.
- **Workflow:** commit and push to `main`; Netlify auto-deploys. Git CLI works via GitHub Desktop's bundled binary (`%LOCALAPPDATA%\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`) — git is not on PATH. Node IS installed, so `node --check` every changed function before pushing.

## Pipeline (scheduled functions, AEST)
1. `fetch-prices.js` — ~4pm. Pulls EOD prices from EODHD into `prices` (open/high/low/close/volume + adjusted_close).
2. `fetch-indicators.js` — ~6:50am. Computes indicators from adjusted_close.
3. `morning-scan.js` — 7am AEST (`schedule('0 21 * * 0-4', run)` = 21:00 UTC Mon–Fri). Scores the universe, builds & sends the morning email.
- `_shared.js` — shared helpers incl. `sendEmail` (Resend).
- `eodhd-client.js` — EODHD wrapper. Currently ASX-only (`asxTicker()` hardcodes `.AU`).
- `bootstrap-history-background.js` — backfills price history.

## Known data gotchas
- **Adjusted vs raw OHLC:** the history bootstrap stored `adjusted_close` as close but RAW open/high/low — this detaches candle bodies from wicks for stocks with dividends/splits. Fix is to store both raw and adjusted consistently and pick one per chart.
- **Point-in-time discipline (critical for any fundamental/backtest work):** half-yearly REIT figures (NTA, WACR, NPI, WALE, occupancy, hedge position) must be dated to the **results-pack RELEASE date**, never the period end — or you get look-ahead bias.
- **Deploy order:** run SQL migrations in Supabase **before** deploying code that depends on them.
- **⚠ CENTS vs DOLLARS — two conventions live side by side.** In `reit_model_forecasts`/`reit_model_actuals`, `dpu`, `epu` and `ffo_per_unit` are **cents** (the workbooks label them "(cps)") while `nta` and every valuation output are **dollars**. `public/value-layer.html` divides by 100 before using them against price (`m.epu[2]/100/m.price`). But `stocks.dps_fy26` uses the **dollars** convention. Both are internally consistent — do NOT "fix" one in isolation, you will shift every yield by 100×. `scripts/export-model.js` now enforces the split with separate `cents`/`dollars` range guards.

## Model export hardening (2026-08-13)
`scripts/export-model.js` reads ~60 fixed cell addresses. It used to fail **silently** — insert one row in a workbook and every reference below it shifts, writing wrong-but-plausible numbers into real-money BUY signals. Three guards now run before anything is written, and any failure aborts the export:
1. **Label check** — each cell declares the label its row must carry in column B. The workbooks label every row (e.g. `B7` = "Industrial cap rate (WACR)"), so a shifted row stops matching. No named ranges needed — the workbooks have none.
2. **Range check** — each value declares a plausible range (cap rate 0.5–25%, gearing 0–150%, …).
3. **Null check** — required fields must be non-null, which catches a workbook saved without recalculating.

Verified: all 5 workbooks pass, and a simulated row-insert is rejected with 10 errors (it would otherwise have written `cap_rate = 77.5`). Re-validate any edited workbook with `--dry-run` before committing it.

## Recently done (this session)
- **Chart rewrite** (`buildChart`): brand-mono candles (sky up `#00B0F0` / ink down `#00273E`), fixed reversed ordering (query was `ascending:false` but chart drew oldest-first), fixed candle geometry, added price axis + crosshair + OHLC tooltip.
- **Email rewrite** (`buildEmail` in morning-scan.js): brand palette, Arial, Outlook-safe (MSO ghost-table wrapper, nested tables — no `display:table`). Header "Morning Update", no 360 marks.
- **Send-once guard:** `email_log` table, unique `(email_type, send_date)`. Guard only skips on Postgres `23505` (true duplicate); sends anyway on any other claim error; rolls back the claim if send fails. (Earlier bug: treated *any* claim error as "already sent" → silent failure when table missing.)
- **BCC fix** (`sendEmail`): recipients moved to BCC so they're never cross-exposed.

## Pending / next build (priority order)
1. **macro → EODHD migration:** `morning-scan.js` still calls Yahoo 13× for the macro layer (indices, VIX, FX, 10yr, commodities, VNQ). Move all to EODHD (now fully covered on $99 tier). Extend `eodhd-client.js` to route by symbol class: `.INDX` (indices/VIX), `.FOREX`, `.US`, commodities. Parallelise. This also reduces the timeout/retry that drives duplicate runs.
2. **Determinism:** morning scan re-fetches live data each invocation → different signals on retries. Should read the committed snapshot (`prices` + indicators) instead, so any re-run is byte-identical.
3. **Schema for the new structure** (below).
4. **Honest backtester:** walk-forward, real brokerage + slippage, survivorship handling, time-series CV with purge/embargo. Strategy performance numbers are meaningless without it.

## Target information architecture (designed, not yet built)
Two-level structure. Each asset class scored on **its own inputs** — no single model across everything.

**Asset classes (5):**
- **Equities** — ASX-500 ex A-REITs (+ **LICs** as a sub-group). Technical/ML scoring.
- **REITs** — sub-classes: **Landlords / Developers / Fund managers**. Landlords further tagged by **sector: retail / office / industrial / diversified / other** (cap rates only comparable within sector).
- **LITs** — listed investment trusts (income/credit vehicles).
- **Private credit** — MXT, GCI, QRI, KKC, MOT, TCF.
- **Bonds & hybrids.**

**Two parallel 7-layer scoring stacks (each → 0–7 conviction):**
- *Equity (technical):* Macro · Trend · Momentum · Reversion · Volume · Candle · ML.
- *REIT (fundamental):* Macro/rates · NTA value · Yield · Cap rates (WACR + implied) · Balance sheet (gearing, ICR, **interest-rate hedging**) · Earnings (FFO/AFFO) · Income trigger (DPS/price ≥ 8%).

**Portfolio section (ownership lens, sits above asset classes):**
- **Net Worth** — total + allocation by class; **real holdings only** (model kept separate).
- **My Portfolio** — all real holdings, TSR per position (capital + income; distributions auto-pulled from EODHD against entry date; user only uploads the contract note).
- **Model Portfolio** — system paper trades, performance shown separately.
- **Trading History** — closed-trade ledger (model + real); open positions show TSR-to-date.

**Strategies section (rule lens):** Value, Momentum, Mean reversion. Each shows rule + current signals + (honest) backtest stats.
- **Breakout was removed (2026-08-13)** along with the ORB confirmation scan (`orb-scan.js`) — the platform is income-focused, not momentum-trading. Recoverable from git history if ever needed.
- **Value is cross-cohort:** equities & earnings-driven REITs (developers/managers) screen on low P/E + earnings yield; landlord REITs screen on NTA discount + implied-vs-book cap gap + yield (with NTA discount + coverage as the value-trap filter).

## Implied cap rate (landlords only)
`implied cap rate = NPI / (price × shares on issue + net debt)`.
- Price → `prices`; shares & net debt → EODHD fundamentals; **NPI → results pack (manual/doc-reader, point-in-time)**.
- Landlords ONLY — meaningless for developers/managers (EV captures non-property earnings).
- Signal is the **implied-vs-book (WACR) gap**. Renders as placeholder `—` until NPI captured.

## Schema notes (for the rebuild)
- Add `asset_class` and `landlord_sector` columns to `stocks` (drive separation from data, not hardcoded ticker lists). Current schema only has `universe` (ASX500/REIT) + `is_manager`/`is_developer`.
- New tables needed: holdings, contract-note parses (built to the CommSec trade-confirmation layout), results-pack fundamentals (NTA/WACR/NPI/WALE/occupancy/hedging, point-in-time dated), `email_log` (exists).

## Design tokens
Palette: sky `#00B0F0`, navy `#063D58`, ink `#00273E`, teal `#4B97B2`. Up `#1f8a4c`, down `#c0392b`. Font: Arial. Candles: brand-mono (sky up / ink down). No 360 Capital marks.

## Outstanding bugs to watch
- Watchlist 400 errors.
- Bollinger Position extreme values.
- (Netlify scheduled-function double/triple trigger — now neutralised by the send-once guard.)

## Secrets
Live in environment vars / a gitignored `.env` (EODHD key, Supabase service key, Resend key, FRED key). Never commit them. Re-add per machine.
