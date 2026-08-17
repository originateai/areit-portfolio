# TODO — AREIT income platform

Rewritten 2026-08-17. Everything in the previous version (SQL migrations, RLS
grants, storage bucket, model export) is **done and verified against the live
database** — that list is gone rather than left to rot.

Read `SPEC.md` first. It is the build contract: the 12% IRR / 7% yield hurdles
measured post-tax, the units invariants, and the canonical data model.

---

## 1. SECURITY — do this first

**The site is public and unauthenticated, and the browser's anon key can write.**
`areit.netlify.app` has no login. The anon key ships in the page, and RLS policies
grant `insert, update, delete` on `holdings`, `real_trades`, `distributions`,
`property_holdings`, `property_valuations`, `property_loans`,
`property_cashflows`, `tax_settings` and `distribution_components`.

That means anyone who finds the URL can read your entire net worth, and can
modify or delete it. This pattern predates this build, but the surface is now
materially worse: **property records carry a street address and a loan balance.**

Two fixes, either is enough:
- **Netlify password protection** (you are on Pro — Site settings → Access
  control → Password protection). One toggle, no code.
- Move writes behind service-role functions and revoke anon write, as
  `reit_fundamentals` and `valuation_runs` already do.

Until one is in place, do not enter a real property address.

---

## 2. Fill the gaps that make numbers real

**NPI and WACR for the five modelled REITs** — the highest-value data you can
enter. NPI exists only in results packs; no vendor feed has it, because statutory
A-REIT revenue includes fair-value revaluations. Until it is captured the implied
cap rate renders `—` and the cap-rate layer cannot score.
Use **Value Layer → Fundamentals**, and validate before saving.

**Assumptions for ARF, ASK, CQR, HDN.** They have models and forecasts but no
`reit_model_assumptions` row, so three of the four valuation methods skip and
their "fair value" is book NTA alone. They are flagged `NTA only` and greyed on
the Value Engine page. Either build workbooks or enter cap rate, required return
and base multiple directly.

**Your actual distribution components.** The tax overlay currently assumes 30%
tax-deferred / 70% unfranked for every REIT (a class-level default, flagged EST,
never a figure for a named security). Your annual tax statements have the real
split. Load them into `distribution_components` and every post-tax figure stops
being an estimate.

**Your other positions.** Only 5 holdings are registered, all from
`real_trades`. Listed credit, bonds and hybrids are missing entirely.

---

## 3. Known issues, in priority order

**`stocks.dps_fy26` is a completed financial year.** Today is FY27. The income
rollup resolves model forecasts to FY27E but falls back to a hardcoded `dps_fy26`
column, so DXS is currently valued on a finished year while the modelled REITs
use the current one. This drifts further every July and needs a real fix —
either a `dps_current_fy` view or a year-keyed table.

**`adjusted_cost_base` never updates.** It is seeded to `cost_base` on first
write. Tax-deferred distributions are supposed to reduce it (SPEC §4.2), and a
new BUY will not refresh it. Until this is wired, CGT on sale will be
understated.

**`property_loans.original_drawn` is unpopulated.** The column exists; the engine
falls back to the oldest recorded balance and flags the proxy. Fill it when you
add a property or equity invested will be wrong.

**TCF is not in `stocks`.** Its `asset_class` is set on the holding directly, so
income and tax work, but it has no price row — it is excluded from every
yield-on-market denominator, and the Income page says so.

**Excel and the engine disagree by 5–17%.** By design, not by error: Excel's
`blended_value` is exactly its equity DCF in every stored row, while the engine
blends four methods with NTA at 15%. The workbook is the more conservative. Pick
one as authoritative before acting on either.

---

## 4. Still not built

- **Honest backtester** — walk-forward, real brokerage and slippage, survivorship
  handling, purge/embargo. Until it exists, every strategy performance number on
  the platform is illustrative and is labelled so.
- **macro → EODHD migration.** `morning-scan.js` still calls Yahoo 13× per run.
- **Morning-scan determinism.** It re-fetches live data each invocation, so
  retries produce different signals. It should read the committed snapshot.
- **Contract-note PDF parsing.** Text/CSV only today; PDFs are stored for
  reference and entered by hand. Parsing prefills a form and never writes a
  real-money record directly — keep it that way.
- **Credit and bond holdings pages** exist in the nav but are thin.
- **`landlord_sector` tagging** — one-off manual pass; cap rates are only
  comparable within a sector.

---

## 5. Housekeeping

- `C:\Users\james\Downloads\CLAUDE.md` is a **drifted copy** of the repo's
  `CLAUDE.md` sitting outside the repo. It still claims root `index.html` mirrors
  `public/` and still lists Breakout as a strategy — both untrue since
  2026-08-13. It gets auto-loaded as context and actively misleads. Delete it.
- `reit_income_holdings` is retired but not dropped. Drop it once nothing
  references it.
- There is no test suite. `node --check` is the floor, and the pure engines carry
  hand-checkable worked examples in comments. Real tests would be worth having
  for `tax-engine.js` and `model-engine.js` specifically.
