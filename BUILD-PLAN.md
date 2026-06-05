# BUILD PLAN — areit rebuild

Sequenced tasks for the Claude Code session. Work top-down; each builds on the last.
Read `CLAUDE.md` first for full context. Verify against the live schema before any DB change.

## 0. Setup (once per machine)
- [ ] Create `.env` with keys: `EODHD_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `FRED_API_KEY`. (Gitignored — never commit.)
- [ ] Confirm `email_log` table exists in Supabase (it should — created already).

## 1. Schema foundation
- [ ] Review `supabase/schema_v3_classes.sql` against live `schema_v2.sql` — confirm `stocks` column names.
- [ ] Run it in Supabase. Then run the commented backfill (assign `asset_class` / `reit_subclass` from existing `is_reit`/`is_manager`/`is_developer` flags).
- [ ] Manually tag `landlord_sector` for the landlord REITs (retail/office/industrial/diversified/other) — small one-off.

## 2. Two pending morning-scan fixes (already half-done)
- [ ] Deploy the hardened `morning-scan.js` (send-once guard now only skips on true duplicate `23505`).
- [ ] **macro → EODHD:** extend `eodhd-client.js` to route by symbol class (`.INDX`, `.FOREX`, `.US`, commodities) instead of hardcoding `.AU`. Replace all 13 `fetchYahoo` calls in `morning-scan.js`. Parallelise with `Promise.all`. (All covered on the $99 All-in-One tier.)
- [ ] **determinism:** make the scan read the committed `prices` + indicators snapshot rather than re-fetching live, so re-runs are byte-identical.

## 3. Fundamentals ingestion
- [ ] New function: pull EODHD fundamentals (EPS, DPS, book value, shares on issue, net debt, P/E) for the universe into a fundamentals table.
- [ ] Wire the **implied cap rate** calc (landlords only): `npi / (price*shares + net_debt)`, sourced from `reit_fundamentals.npi` + EODHD. Show implied-vs-WACR gap. Placeholder `—` until NPI populated.

## 4. The shell (port the approved previews into live index.html)
Reference design: the shell-preview HTML files from the chat session (brand palette, no 360 marks).
**Re-skin already shipped** (brand palette, Morning Update labelling, EODHD footer, brand-mono self-sorting chart). Remaining = structure:

### 4a. Master Dashboard (landing page — first thing seen on login)
- [ ] New top nav item "Dashboard", set as the default/landing view.
- [ ] Index charts: **All Ords (XAO)** + **ASX 300 (XKO)** — confirmed. Needs index price history — add ingestion (EODHD `XAO.INDX`, `XKO.INDX`) into the `index_prices` table (already created in db_classification.sql).
- [ ] Summary sections (cards + mini-tables, all linking through to the full page):
      Strategies snapshot · Current holdings + value · Model portfolio performance · macro/net-worth strip.

### 4b. Nav restructure
- [ ] **Model Portfolio moves UNDER the Strategy Engine** (it's the output of the strategies). Strategy Engine becomes the home for all strategies — beyond the current mean-reversion + breakout (value, momentum, ML, etc.).
- [ ] **Per-class portfolios under each income signal**: Credit Signals → credit holdings; Bond Signals → bond holdings. Each signal class gets a holdings view, not just signals.
- [ ] Five-class taxonomy + REIT sub-classes (landlord/dev/manager) + landlord sector filter (from the shell previews).

### 4c. Classification
- [ ] DXS reclassified to REIT/landlord/office (SQL run separately). Confirm which table the Real Portfolio vs REIT Holdings views read from, and that reclassified holdings flow to the right view.

### 4d. Detail view

- [ ] Nav: Portfolio group (Net Worth, Model, My Portfolio, Trading History) + Growth (Equities+LICs, REITs→landlord/dev/manager) + Income (LITs, Credit, Bonds) + Strategies (Value, Momentum, Reversion, Breakout, ML).
- [ ] Per-class signal tables with their own columns (the "different inputs" — landlords get the full field set incl. sector filter, implied cap, hedging).
- [ ] Detail view: dual 7-layer breakdown (equity technical / REIT fundamental) + the brand-mono `buildChart`.
- [ ] Swap the old `buildFullChart` for the fixed `buildChart` (correct ordering, candle geometry).

## 5. Portfolio + TSR
- [ ] Contract-note parser (CommSec layout → `contract_notes` → `holdings`).
- [ ] TSR per holding: capital (price vs cost) + income (distributions auto-pulled from EODHD against entry date). Show holding-period AND annualised.
- [ ] Net Worth dashboard (real holdings only) + allocation donut. Trading-history ledger.

## 6. The honest backtester (gates the Strategies numbers)
- [ ] Walk-forward, real brokerage + slippage, survivorship handling, time-series CV with purge/embargo.
- [ ] Until this exists, label all strategy performance figures as illustrative.

## 7. Income tracking, documents & performance (James's stated structure)

### CANONICAL nav structure — TWO buckets (James, repeated)
Everything you OWN in one place; everything strategy/research in one place.

- **Dashboard**
- **Portfolio** — all holdings in one place:
  - Real Portfolio · REIT Holdings · Credit Holdings · Bond Holdings · Income
  - (Credit/Bond *Holdings* pages are NEW — distinct from the Credit/Bond *Signals*
     which live under Strategies. Holdings = what you own; Signals = what to buy.)
  - At the very bottom of Portfolio: **Portfolio Performance** —
    cumulative-return LINE CHART over time (real + model), then real snapshot,
    then model snapshot below it.
- **Strategies** — all strategies + signals in one place:
  - Strategy Engine (mean reversion · breakout · value · + momentum/ML later)
  - Model Portfolio (the strategies' paper output)
  - Stock Screener
  - REIT Signals · Credit Signals · Bond Signals · Morning Scan · Bond Market
- **Admin** — Record Trade · Settings · Alerts

Nav already collapsed to Portfolio + Strategies + Admin in index.html. Still TODO:
add Credit Holdings + Bond Holdings pages under Portfolio, and the Performance block.

### Income tracking
- [ ] Under each REIT, list every distribution received, **cumulative per stock**
      (running total paid). Source: `distributions` table, populated from EODHD
      dividends AND from uploaded distribution statements.
- [ ] Per-class income views: Credit holdings under Credit, Bonds under Bonds.

### Document uploads — single source of truth (needs Supabase Storage)
- [ ] Storage bucket + upload UI in the portal for three doc types:
      **contract notes** (trades → holdings, parser exists),
      **distribution statements** (new parser → feeds cumulative income),
      **tax statements** (stored for reference).
- [ ] Each upload: store the file in Storage + a metadata row (type, ticker,
      date, amounts parsed) so everything's tracked in one place.

### Cumulative return chart (needs new table + daily job)
- [ ] `portfolio_snapshots` table (date, scope=real|model, total_value, cost_base).
- [ ] Daily job (after the 4pm price pull) captures real + model portfolio value.
- [ ] Line chart traces cumulative return over time. Starts accruing from switch-on;
      OPTION to reconstruct backwards from trade dates + price history (James to decide).

## Guardrails (from CLAUDE.md)
- No React/bundler. Client-side indicator calc from raw prices. Clean rewrites over patches.
- Run SQL migrations BEFORE deploying dependent code.
- Point-in-time discipline on all results-pack fundamentals (date to RELEASE, not period end).
- No 360 Capital branding anywhere.
