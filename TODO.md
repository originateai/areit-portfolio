# TODO — needs James (after this session)

This session implemented tasks 1–8 in code. The items below need **you** because
they touch the live database, real money, or things I can't run/test from here
(no Supabase/EODHD credentials or network access in this environment, and the app
is deployed via GitHub Desktop, not CLI).

## 1. Run the SQL migrations — IN ORDER, BEFORE the code goes live
Supabase → SQL Editor → run each, top to bottom:
1. `supabase/migrations/20260605_01_rls_grants_audit.sql` — read access for the
   anon front-end on every table (this is the fix for tables that silently return
   nothing / 400s). Re-run any time you add a table.
2. `supabase/migrations/20260605_02_stock_reit_fields.sql` — REIT columns on
   `stocks` (icr, hedged_pct, npi, shares_on_issue, net_debt, landlord_sector,
   reit_subclass, fundamentals_asof, etc.).
3. `supabase/migrations/20260605_03_distributions.sql` — `source`/`currency`
   columns + `unique(ticker, ex_date)`. **If it errors on the unique index you
   have duplicate distribution rows** — run the de-dupe snippet in the file first.
4. `supabase/migrations/20260605_04_documents.sql` — `document_uploads` table +
   the `documents` Storage bucket + storage policies.

After #1, run the verify query at the bottom of that file — it should return zero
rows. Deploy the code only after the migrations are in.

## 2. Candles (task 2)
- The chart now self-corrects so no candle renders inside-out, and the bootstrap
  stores fully-adjusted OHLC going forward.
- **Legacy rows are still mixed (adjusted close + raw OHLC).** To clean history,
  re-run the bootstrap once it's deployed:
  `POST /.netlify/functions/bootstrap-history-background` (optionally `?ticker=XXX`).
- Spot-check a dividend-heavy name (e.g. a bank or a REIT) on the detail chart.

## 3. Income / dividends (task 5)
- Click **Pull dividends (EODHD)** on the Income page (calls
  `fetch-dividends-background`) to backfill `distributions` for held tickers.
  Units-held per ex-date are reconstructed from `real_trades`; manual rows are
  never overwritten.
- Verify a couple of distributions against your statements before trusting totals.

## 4. Performance (task 7)
- A daily snapshot (real + model) now writes from the 4pm `fetch-prices` job.
- **Decision for you:** click **Reconstruct from trade history** to backfill
  history from your trade dates + stored prices (overwrites past snapshot rows).
  The MODEL reconstruction is approximate (realised P&L + open-position MTM) —
  fine for a trend line, not an audited figure.

## 5. Uploads / parsers (task 8) — REAL MONEY, read this
- File upload + Storage + metadata is fully wired.
- **Contract-note and distribution parsing only runs on TEXT/CSV**, and it does
  **not** silently write to holdings/income — it prefills the Record Trade /
  Income form for you to confirm. This is deliberate: I won't auto-insert
  real-money records from a best-effort parse.
- **PDF auto-parsing is NOT built.** CommSec confirmations are usually PDFs;
  they're stored for reference and you enter details manually. To enable PDF
  parsing properly, add a server-side function using a `pdf-parse` (or similar)
  dependency in `netlify/functions` and point the CommSec layout parser at the
  extracted text. I didn't add an untested dependency.
- The CommSec/registry regexes in `parseContractNote` / `parseDistStatement` are
  best-effort — validate against your real documents and tighten as needed.

## 6. Mirror files — RESOLVED 2026-08-13
- Deployed front-end is `public/index.html` (`netlify.toml` → `publish = public`).
- The root mirror copies were deleted (they had drifted). There is now **one** copy of each
  file. Do not re-create root duplicates.

## 8. A-REIT VALUE LAYER (Phase 1 built — needs your Supabase steps)
Full runbook in `SUMMARY.md` (Part 2). The must-dos, in order:
1. **SQL:** run **`areit_value_layer_schema_v2.sql` ONLY** (it supersedes the old
   schema.sql + patch_01; idempotent, single transaction). Verified against my code.
2. **Storage:** create a **Private** bucket named `reit-models`.
3. **RLS/grants (critical):** for every new table the frontend reads —
   `reit_model_files`, `reit_prices`, `reit_models`, and the views (esp.
   `v_discount_to_fair_value`) — add a `for select using (true)` policy AND
   `grant select to anon, authenticated`. Without this, `models.html` and
   `reit-value.html` show nothing (same class as the old "silent empty / 400" bug).
4. **Env:** no new Netlify var needed — functions accept the existing
   `SUPABASE_SERVICE_KEY`. Set `SUPABASE_SERVICE_ROLE` (or `_KEY`) locally for the script.
5. **Load models:** `cd scripts && npm install`, then
   `node export-model.js DXI "../areit models/DXI_…xlsx" 1 --dry-run` to validate the
   parse, then re-run without `--dry-run`. Repeat for DXC, CIP. The `.xlsx` must have
   cached values (open+save in Excel first) or it exports nulls.
6. **Snapshot:** trigger `price-snapshot` once (Netlify → Functions) to fill `reit_prices`.

**Task D (market evidence) — BUILT:** `evidence.html` (add-form + CSV import + recent
rows + the three benchmark views) and `ingest-evidence.js` (service-role writer).
Linked under "Value Layer". Also built: **assumptions editor** (`assumptions.html` +
`save-assumptions.js`) — edit headline assumptions per REIT with cap-rate/leasing
benchmarks shown alongside; workbook stays source of truth (re-export overwrites). And a
**REIT Value card** on the main dashboard (top discounts → `reit-value.html`).
**AI doc-reader — BUILT:** `read-evidence-doc.js` + the "AI document reader" card on
`evidence.html` (pdf.js extracts text → Claude forced-tool extraction → propose rows →
you review + Import). Needs `ANTHROPIC_API_KEY` in Netlify env (optional `ANTHROPIC_MODEL`,
defaults to `claude-opus-4-8`; use `claude-haiku-4-5` for cheaper bulk parsing). No OCR —
scanned image PDFs won't extract. The `cre_*` tables, `reit_model_assumptions`, and the
views still need anon SELECT grants (step 3 above) for the pages to display data.

That closes out the entire value-layer brief (Tasks A–D). Remaining open items are all
yours: run the SQL, grants, bucket, env vars, and the model export/snapshot.

**Could not verify from here:** no Node/EODHD/Supabase in my environment, so the export
was never run and nothing was written to the DB — validate with `--dry-run` before trusting.

## 7. Not in scope this session (from BUILD-PLAN, still open)
- macro → EODHD migration in `morning-scan.js` (still calls Yahoo).
- Morning-scan determinism (read committed snapshot vs re-fetch live).
- Honest backtester (walk-forward, brokerage/slippage, purge/embargo). Until it
  exists, treat all strategy performance numbers as illustrative.
- Credit Holdings / Bond Holdings pages under Portfolio.
- Manual tagging of `landlord_sector` for landlord REITs (one-off).
