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

## Guardrails (from CLAUDE.md)
- No React/bundler. Client-side indicator calc from raw prices. Clean rewrites over patches.
- Run SQL migrations BEFORE deploying dependent code.
- Point-in-time discipline on all results-pack fundamentals (date to RELEASE, not period end).
- No 360 Capital branding anywhere.
