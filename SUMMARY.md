# SESSION SUMMARY — dashboard candle/chart upgrade + brief audit

Date: 2026-06-06

## What you actually asked for (and what I did)
> "Upgrade the dashboard — the candles don't appear visual in the 1-year chart, so maybe make a 3-month view as well."

**Done.** Root cause: in the 1-year view ~250 trading days are squeezed into the
chart width, so the candle width hits its 3px floor (`candleW = Math.max(3, …)` in
`buildFullChart`) and the bodies render as near-invisible hairlines. Fix:

- Added a **`3M`** range to the shared range bar (`RANGES` + `RANGE_DAYS`, `3M`=92
  days ≈ 63 trading days → candles ~9px wide, clearly readable). The `3M` button now
  appears on **all three** charts (stock detail, dashboard index charts, performance).
- Changed the **stock-detail chart default from `1Y` to `3M`** so a stock opens on
  the readable candle view instead of the cramped one. (1Y/All are still one click away.)

### Files changed (push BOTH — they are mirrors)
- `public/index.html`  ← the deployed file (`netlify.toml` publishes `public/`)
- `index.html`         ← root mirror copy

Exact edits in each (lines ~804, 807–808):
- `sdChartRange = '1Y'` → `'3M'`
- `RANGES = ['1D','1W','1M','1Y','All']` → `['1D','1W','1M','3M','1Y','All']`
- `RANGE_DAYS = {…,'1M':31,'1Y':365}` → `{…,'1M':31,'3M':92,'1Y':365}`

No SQL, no functions, no deps. Pure front-end. Low risk.

### Verify after deploy
Open any stock detail page → it should land on **3M** with fat, readable candles;
click `1Y`/`All` to confirm they still work. Spot-check a dividend-heavy name
(a bank or REIT) — the self-correcting candle geometry should still enclose every body.

---

## Audit of your larger 10-point brief — IMPORTANT
I read `CLAUDE.md`, `BUILD-PLAN.md` and `TODO.md` first as instructed. **A prior
session already implemented essentially the entire brief in code** (TODO.md documents
tasks 1–8 as built). I did **not** re-implement working real-money code — that would
risk breaking a live app for no gain. Status of each of your 10 points against the
actual code:

| # | Item | Status in code |
|---|------|----------------|
| 1 | Document uploads (3 types, Storage + metadata, parsers) | **Built.** `uploadDocument`, `parseContractNote`, `parseDistStatement`, `document_uploads` table. Storage bucket + policies are in migration `…_04_documents.sql` — **needs running in Supabase.** PDF auto-parse deliberately NOT built (parsers run on text/CSV and prefill a form for you to confirm — no silent real-money writes). |
| 2 | Income tracking (per-stock cumulative distributions) | **Built.** `distributions` table + `fetch-dividends-background.js` + Income page. Needs migration `…_03_distributions.sql` run, then click **Pull dividends (EODHD)**. |
| 3 | TSR per holding (capital + income, holding-period + annualised) | **Built.** `tsr()`; shown on holdings tables and the single-stock page. |
| 4 | Single-stock page + working candle chart + REIT fields | **Built**, and improved this session (3M default fixes the candle visibility). REIT panel shows ALL fields as labelled placeholders when blank. |
| 5 | Value screen: fold P/B in, sector-relativised, ignore for asset-light, sortable headers | **Built.** `loadValueStrat` + `valueAssetHeavy` gating + `relPB` + `sortValue` clickable headers. ⚠️ **Pulling GQG's raw EODHD payload to eyeball wrong figures was NOT done** — needs an EODHD API key + network, which this environment doesn't have. See TODO. |
| 6 | Performance: cumulative real-vs-model line chart + daily snapshot + reconstruct | **Built.** `perfLineChart`; daily snapshot writes from the 4pm `fetch-prices` job; **Reconstruct from trade history** button exists. |
| 7 | Two-bucket nav (Portfolio / Strategies), model under Strategies | **Built** per TODO. Still open: **Credit Holdings** + **Bond Holdings** pages under Portfolio. |
| 8 | Morning-scan 502 — fix so 7am email fires | **NOT fixed — see diagnosis below.** Your hypothesis (an EODHD macro symbol 404ing) is **already handled** and is NOT the cause. |
| 9 | REIT 7-layer fundamental scoring | **Built.** `scoreREITMacro` + REIT fundamental layers; dual 7-layer breakdown on the detail view. |
| 10 | Index charts: XKO → ASX 200 fallback | **Built.** `fetch-index-prices-background.js` already tries `XKO.INDX` → `AXKO.INDX` → `AS52.INDX`, with ASX 200 (`XJO`/`AXJO`) as a separate fallback index. |

### Net: the only genuinely-outstanding work
- **#8 morning-scan 502** — needs your Netlify logs to confirm (diagnosis in TODO.md).
- **#5 GQG payload check** — needs an EODHD key in the environment.
- **#7 Credit/Bond Holdings pages** — net-new UI, not yet built (was already open in TODO).
- Plus the pre-existing open items in `TODO.md` (run the 4 SQL migrations, pull dividends,
  reconstruct performance, validate parsers against real documents).

I did not guess at any of these on a real-money system — they're flagged for you.

---

## What to deploy from the chart change
Push the two chart files via GitHub Desktop:
- `public/index.html`
- `index.html`

No SQL, no function deploys, no env changes required for the 3M chart change.

---

# PART 2 — A-REIT VALUE LAYER (Phase 1: Tasks A, B, C)

Built the bottom-up value layer per your brief, grounded against your real
workbooks + existing `export-model.js` (found in `areit models/`), so it matches
the actual schema (column names, conflict keys) rather than guesses.

## New / changed files
**Serverless functions** (`netlify/functions/`, auto-deploy with the repo):
- `upload-model.js` — POST `{ticker, model_version, file_name, file_base64}` →
  uploads the `.xlsx` to the private `reit-models` bucket at `{ticker}/v{version}.xlsx`
  (overwrite) + upserts `reit_model_files` (bytes + sha256 checksum). Service-role only.
- `get-model-url.js` — GET `?path=` (or `?ticker=&version=`) → 60-min signed download URL.
- `price-snapshot.js` — **scheduled 17:30 AEST (`30 7 * * 1-5`)**. Prices every
  `reit_models.is_current` ticker via the existing EODHD client (`getBulkPrices`) →
  upserts `reit_prices (ticker, last_price, price_date)`.

**Local CLI** (`scripts/`, NOT bundled by Netlify — runs on your machine):
- `export-model.js` — canonical copy of your working script (identical cell map +
  `META`), with one change: credentials accept `SUPABASE_SERVICE_ROLE` **or**
  `SUPABASE_SERVICE_KEY`, plus an opt-in `--dry-run` to parse+print before writing.
- `package.json` — pins `xlsx` + `@supabase/supabase-js` for local install.

**Frontend** (`public/`, standalone pages like `admin.html`):
- `models.html` — upload + list stored models + signed-URL download (mobile-friendly,
  the "download anywhere" surface).
- `reit-value.html` — value dashboard: `v_discount_to_fair_value` sorted cheapest-first,
  BUY/WAIT chips, + a composite (−discount × REIT macro from latest `morning_signals`).
- `index.html` + `public/index.html` — added a **"Value Layer"** nav section linking
  both pages.

## Key decisions / things I verified
- **Env var:** deployed functions use `SUPABASE_SERVICE_KEY` (per `_shared.js`); your
  local `export-model.js` uses `SUPABASE_SERVICE_ROLE`. My functions accept **either**,
  so you do **not** need to add `SUPABASE_SERVICE_ROLE` in Netlify — the existing
  `SUPABASE_SERVICE_KEY` already works. (Set `SUPABASE_SERVICE_ROLE` locally for the script,
  or it will fall back to `SUPABASE_SERVICE_KEY` if that's what you have.)
- **Workbook layout confirmed:** unzipped `DXI_…xlsx` — sheet names (`Control`,
  `Assumptions`, `Debt`, `P&L`, `Balance Sheet`, `Cash Flow`, `Valuation`,
  `Earnings Quality`, `Asset Register`) **all match** the script's references. Node isn't
  installed in my environment, so I could not run the export or verify cached cell
  values — run `--dry-run` first (below) to confirm the parse before writing.
- **Frontend reads via anon + RLS** → the new tables/view MUST be granted to anon or the
  pages show nothing. See TODO (this is the same class as your past "silent empty" bug).

## Task D — market-evidence layer (BUILT)
- `netlify/functions/ingest-evidence.js` — service-role writer for the three `cre_*`
  tables; whitelists table + columns, coerces numerics/dates, takes a single row or a
  CSV batch.
- `public/evidence.html` — tabbed admin page (Transactions / Leasing / Developments):
  dynamic add-form + CSV import (posts to ingest-evidence) + recent rows, plus the three
  benchmark views (`v_market_cap_rates`, `v_leasing_benchmarks`, `v_reit_vs_market_cap`)
  rendered as reference tables. Linked under the "Value Layer" nav.
- **Still deferred:** showing a benchmark *inline beside each assumption input* (needs an
  assumptions-editor UI that doesn't exist yet — the benchmarks live on `evidence.html`
  for now), and the AI doc-reader pipeline (parse result PDFs/IMs → propose evidence rows).

## Corrections made after reading the v2 schema
- `export-model.js`: removed `price_at_build` from the **`reit_models`** upsert — that
  column only exists on `reit_model_outputs` (where it's still written). The original
  would have errored against v2. *(This fix is in `scripts/export-model.js`; your copy in
  `areit models/` still has the bug — use the `scripts/` one, or delete that line.)*
- `models.html`: file date now reads `uploaded_at` (the real column name).
- `reit-value.html`: `buy_signal_value_layer` is a Postgres **boolean**, not a string —
  fixed the BUY/WAIT logic (it would otherwise always show WAIT).

## Follow-ups built (dashboard card + assumptions editor)
- **Dashboard "REIT Value Layer" card** — `loadDashboard` now renders a top-5 biggest-
  discounts table (BUY/WAIT chips) above Current holdings, linking to `reit-value.html`
  (`renderDashValue()` in both `index.html` files). Degrades quietly if the value-layer
  schema/grants aren't in yet.
- **Assumptions editor** — `public/assumptions.html` + `netlify/functions/save-assumptions.js`.
  Pick a current-model REIT → edit the headline assumptions (cap rate, escalation, gearing,
  valuation inputs…) with the cap-rate + leasing benchmark views shown alongside, filtered to
  that REIT's sectors/states. Saves via service role. **Banner makes clear the workbook is the
  source of truth — a re-export overwrites manual edits**, and the valuation outputs only move
  when you recompute in Excel (this editor writes assumptions, not recomputed outputs).
  Linked under "Value Layer" nav.
  - This completes the deferred "benchmarks beside the assumption inputs" piece of Task D.

## AI doc-reader (BUILT — completes Task D)
- `netlify/functions/read-evidence-doc.js` — takes document text and calls the Claude
  Messages API (raw `fetch`, matching the app's no-SDK convention) with **forced tool
  use** to extract CRE transactions / leasing / developments as structured rows. Returns
  proposals only; defaults to `claude-opus-4-8`, override via `ANTHROPIC_MODEL`.
- `evidence.html` — "AI document reader" card: extracts PDF text client-side via pdf.js
  (same lib the app already uses), sends it to the function, previews the proposed rows,
  and a "Review in <tab>" button drops them into that tab's CSV box for you to check and
  Import. **Never auto-inserts** — same parse-and-approve discipline as the rest of the app.
  Scanned image-only PDFs won't extract (no OCR); the card says so.
- Needs `ANTHROPIC_API_KEY` in Netlify (see deploy list). The whole value layer functions
  without it — only this card needs it.
- **Cost note:** at `claude-opus-4-8` a large results pack is a few cents per parse; switch
  `ANTHROPIC_MODEL` to `claude-haiku-4-5` if you parse many docs and want it cheaper.

## Could not run from here
No Node/EODHD/Supabase in my environment — nothing was written to Supabase. Validate the
export with `--dry-run` before trusting it. The new functions (`ingest-evidence`,
`save-assumptions`) are untested against the live DB — confirm a single insert/save works
before bulk use.

## DEPLOY RUNBOOK (value layer)
**A. In Supabase first (before deploying code):**
1. SQL editor → run **`areit_value_layer_schema_v2.sql` ONLY**. It self-declares as
   superseding `areit_value_layer_schema.sql` + `areit_value_layer_patch_01.sql`
   (creates `reit_prices` before the view that joins it; idempotent; one transaction).
   I verified my functions/script columns against this v2 file.
2. Storage → New bucket → `reit-models`, **Private**.
3. RLS/grants — for every new table the frontend reads (`reit_model_files`,
   `reit_prices`, `reit_models`, the `cre_*` tables, and the views, esp.
   `v_discount_to_fair_value`, `v_market_cap_rates`, `v_leasing_benchmarks`,
   `v_reit_vs_market_cap`): `for select using (true)` policy **and**
   `grant select to anon, authenticated`. ⚠️ The v2 file's RLS example grants to
   `authenticated` only — but your SPA uses the **anon** key, so you MUST include
   `anon` or the pages render empty (the silent-empty bug class). Writes go through the
   service role (bypasses RLS), so no insert policy is needed for the `cre_*` tables.
4. Confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` exist in Netlify
   env (all already used by the app). No new Netlify env var required.

**B. Deploy code (GitHub Desktop):** push these —
`netlify/functions/upload-model.js`, `get-model-url.js`, `price-snapshot.js`,
`ingest-evidence.js`, `save-assumptions.js`, `read-evidence-doc.js`,
`public/models.html`, `public/reit-value.html`, `public/evidence.html`,
`public/assumptions.html`, `public/index.html`, `index.html`,
`scripts/export-model.js`, `scripts/package.json`.

**New env var for the AI doc-reader only:** add `ANTHROPIC_API_KEY` in Netlify
(Site settings → Environment variables). Optional `ANTHROPIC_MODEL` to override the
model (defaults to `claude-opus-4-8`; set `claude-haiku-4-5` for cheaper high-volume
PDF parsing). Everything else in the value layer works without it.

**C. Load the models:**
1. `cd scripts && npm install`
2. Set env locally: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` (or `_KEY`).
3. Dry run to validate the parse:
   `node export-model.js DXI "../areit models/DXI_Dexus_Industria_Model.xlsx" 1 --dry-run`
   — eyeball the printed values (blended_value, buy_threshold, etc. should be non-null).
4. Commit: drop `--dry-run`. Repeat for `DXC` and `CIP`.
5. Upload the workbooks on `models.html` (or they're already in `areit models/`).
6. Trigger `price-snapshot` once (Netlify → Functions → Run) to fill `reit_prices`.
7. Open `reit-value.html` — DXI should show, BUY if last price ≤ buy_threshold.

## Acceptance criteria status
- Upload → list → signed download: **code complete**, pending bucket + grants.
- `export-model.js` populates the six tables idempotently: **uses your verified script**;
  validate with `--dry-run` against a recalculated workbook.
- `price-snapshot` fills `reit_prices`; `v_discount_to_fair_value` one row per current
  model: **code complete**, pending SQL + a snapshot run.
- Dashboard sorted by discount + composite ranking: **built**.
