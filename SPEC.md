# SPEC.md — the build contract

**Every agent reads this file in full before touching anything.** It exists because
three agents building in parallel will otherwise each invent their own data model,
their own units convention and their own idea of what "yield" means, and the
reconciliation costs more than the build saved.

`CLAUDE.md` describes the repo as it *is*. This file describes what we are
building and the rules that bind every agent working on it. Where the two
disagree, **this file wins** and the agent must say so in its report.

---

## 0. The objective

Build a portfolio that generates **significant passive income**, judged against
two explicit hurdles, **after tax**:

| Hurdle | Target |
|---|---|
| **IRR** (total return: income + capital) | **≥ 12%** |
| **Cash yield** (forward 12m distribution) | **≥ 7%** |

And a **fundamental value engine** that computes the valuation methodology
in-platform, so the models are the product rather than a scrape of a spreadsheet.

Three things follow from this, and they drive every decision below:

1. **Post-tax is the primary lens, not a footnote.** A 7% unfranked interest
   distribution from a credit fund and a 7% distribution that is 30% tax-deferred
   are not the same asset. At a 47% marginal rate the gap is worth roughly 150–200bp
   of after-tax yield. **A platform that ranks on headline yield will systematically
   recommend the worse holding.** Franking, tax-deferred and CGT-concession
   components are therefore first-class model inputs, not reporting garnish.
2. **IRR and yield are a joint test.** 12% IRR on a 3% yield is a growth stock, not
   passive income. 7% yield on a 4% IRR is capital erosion dressed as income. An
   asset must be judged on both, and the UI must show both.
3. **Valuation drives the IRR.** The expected IRR is only as honest as the terminal
   value behind it, which is why the value engine and the income target are one
   build, not two.

---

## 1. Non-negotiable invariants

Break any of these and the platform silently reports wrong money. They are not
style preferences.

### 1.1 CENTS vs DOLLARS — the 100× landmine
Two unit conventions live side by side **on purpose**:

| Field | Unit |
|---|---|
| `reit_model_forecasts.dpu`, `.epu`, `reit_model_actuals.ffo_per_unit` | **CENTS** (workbooks label them "(cps)") |
| `reit_model_*.nta` and every valuation output | **DOLLARS** |
| `stocks.dps_fy26`, `stocks.dps_fy27` | **DOLLARS** |
| `distributions.amount_per_unit` | **DOLLARS** |
| Everything new you create | **DOLLARS** — see 1.2 |

`public/value-layer.html` already divides by 100 at the point of use
(`m.epu[2]/100/m.price`). `scripts/export-model.js` enforces the split with
separate `cents` / `dollars` range guards.

**Rule: do NOT "fix" either convention in isolation.** Both are internally
consistent. Normalising one alone shifts every yield on the platform by 100×,
and it will look plausible. If you touch a per-unit figure, state in your report
which convention it is in.

### 1.2 New money columns are DOLLARS, and say so
Every new numeric money column must be dollars, and its name or a comment must
make the unit explicit. No new cents columns. Ever.

### 1.3 Rates are decimals
`0.07`, not `7`. Every rate, yield, cap rate, tax rate and IRR in the database and
in engine code is a decimal fraction. Formatting to `%` happens in the UI only.
Mixing these is the second 100× landmine and there is no legacy excuse for it.

### 1.4 Point-in-time discipline
Any fundamental (NTA, WACR, NPI, gearing, ICR, WALE, occupancy, hedging) is
dated to the **results-pack release date**, never the period end. `reit_fundamentals`
already models this correctly: `period_end` is *what the number describes*,
`release_date` is *when we were allowed to know it*. **Every query that
backtests or scores must filter on `release_date`.** Using `period_end` is
look-ahead bias and makes every backtest a lie.

### 1.5 Never auto-write real-money records from a parse
Contract-note and document parsing **prefills a form for confirmation**. It does
not insert into `holdings`, `distributions` or `contract_notes` directly.

### 1.6 Tax figures are estimates, and must be labelled as such
The tax overlay is a **modelling tool, not tax advice**, and its output must carry
that label in the UI. Component splits are estimates until the actual annual tax
statement arrives. See §4.5.

### 1.7 Deploy order
SQL migration into Supabase **first**, then the code that reads it. A function
deployed ahead of its table fails silently against an empty result, which is the
single most common bug class in this repo's history.

---

## 2. Canonical data model

### 2.1 One holdings table
`holdings` is **the** register of what is owned. It exists and is empty. Fill it.

```
holdings(id, ticker, asset_class, units, cost_base, brokerage,
         entry_date, account, source, is_open)
```

Two legacy tables are being retired:

| Table | Rows | Disposition |
|---|---|---|
| `real_trades` | 5 | **Ledger, not a register.** Keep as the immutable trade log. `holdings` is derived from it. |
| `reit_income_holdings` | 1 (stale DXS) | **Retire.** Do not read or write it. Do not drop it yet. |

`holdings` is derived from `real_trades` by aggregation (units, weighted-average
cost base) and may also be edited directly for positions with no trade record.
`source` records which: `'trades'` or `'manual'`.

**Cost base is tax-adjusted.** Tax-deferred distributions reduce it (§4.2). Store
the original as `cost_base` and the adjusted figure as `adjusted_cost_base` —
never overwrite the original.

### 2.2 `asset_class` — the enum
Drives everything from data, never from a hardcoded ticker list in JS.

```
'equity' | 'reit' | 'lic' | 'lit' | 'credit' | 'bond_hybrid' | 'property'
```
`lic` (investment **companies** — pay franked dividends) and `lit` (investment
**trusts** — flow-through, typically unfranked) are separate values on purpose:
they have opposite franking behaviour, so collapsing them breaks §4.3. The live
data already uses `lic`.

`stocks.asset_class`, `stocks.reit_subclass`, `stocks.landlord_sector` already
exist as columns. Populate them; do not add parallel classification.

Asset class determines the **default tax profile** (§4.3) and which **valuation
method** applies (§5.2). This is why it must be data, not a ticker list.

### 2.3 Direct property
Property is **not** a row in `holdings` with a fake ticker. It is levered, valued
twice a year, and has its own cashflows.

```
property_holdings(id, name, address, property_type, ownership_pct,
                  purchase_price, purchase_date, acquisition_costs,
                  capex_to_date, is_open, notes)

property_valuations(id, property_id, valuation, valuation_date,
                    source, is_estimate)          -- point-in-time, 1.4 applies

property_loans(id, property_id, lender, balance, interest_rate,
               rate_type, io_expiry, balance_date)

property_cashflows(id, property_id, period_start, period_end,
                   gross_rent, agent_fees, rates, insurance, strata,
                   maintenance, other_costs, interest_paid,
                   depreciation, capital_works)   -- last two feed §4.4
```

The **Portfolio and Income pages must present one list**, not a listed tab and a
property tab the user has to add up mentally.

---

## 3. The income lens — canonical definitions

Every income figure on the platform uses these. No agent invents a variant.

### 3.1 The reconciling metric: cash-on-equity
A listed REIT is unlevered from the holder's point of view; a mortgaged property
is not. The only figure that means the same thing for both is **cash in pocket per
dollar of my own capital**.

**Forward annual income**
- Listed: `units × forward annual distribution per unit` (dollars — see 1.1)
- Property: `(gross rent − operating costs − interest) × ownership_pct`

**Equity invested (the cost denominator)**
- Listed: `cost_base + brokerage`
- Property: `purchase_price × ownership_pct + acquisition_costs + capex_to_date − loan drawn at purchase`

**Equity value (the market denominator)**
- Listed: `units × last price`
- Property: `(latest valuation × ownership_pct) − current loan balance`

**Then, identically for both:**
```
yield_on_cost   = forward_annual_income / equity_invested
yield_on_market = forward_annual_income / equity_value
```

**Total passive income = Σ forward_annual_income across every open holding.**
That is the headline number, and it is reported **pre-tax and post-tax, side by
side** (§4).

### 3.2 Mandatory caveat, displayed not buried
Property yield-on-equity is **leveraged**; a listed yield is not. Comparable as
cash return, **not** as risk. The Income page must carry this note in the UI.

### 3.3 Forward distribution — source precedence
Use the first available, and **record which was used** so the UI can show it:
1. `reit_model_forecasts.dpu` current FY, `/100` (cents → dollars), where a current model exists
2. `stocks.dps_fy26` (already dollars)
3. Trailing 12 months actual from `distributions`
4. Otherwise `null` — **render `—`, never zero.** A missing forecast is not an
   income of nought, and zeros silently poison the headline total.

---

## 4. The tax overlay

The differentiator. Get this right and the platform tells you something no broker
screen will.

### 4.1 Settings, not constants
```
tax_settings(id, marginal_rate, medicare_levy, cgt_discount,
             entity_type, effective_from)
```
Defaults: `marginal_rate 0.45`, `medicare_levy 0.02` (→ 47% combined),
`cgt_discount 0.5`, `entity_type 'individual'`. **Never hardcode a tax rate in
engine code or SQL.** Read from settings. Support `'individual' | 'smsf' | 'company'`
as an enum now even if only `individual` is calculated — an SMSF at 15% (0% in
pension phase) inverts several rankings, and the schema should not need a
migration when that day comes.

### 4.2 Distribution components
AREIT distributions are not one thing. Model the split:
```
distribution_components(id, ticker, financial_year, ex_date,
                        franked_amount, franking_credit, unfranked_amount,
                        interest_income, tax_deferred, cgt_concession,
                        foreign_income, foreign_credit, amit_cost_base_net,
                        source, is_estimate)
```

Treatment, at marginal rate `m`:

| Component | Taxed | Effect |
|---|---|---|
| **Franked dividend** | grossed up at `credit/(1−0.30)`, `m` applied, credit refunded | net `= D/0.7 × (1−m)` at 100% franking |
| **Unfranked / interest** | fully at `m` | net `= D × (1−m)` — **worst case** |
| **Tax-deferred** | **not taxed on receipt**; reduces cost base | deferred to CGT on sale, then `cgt_discount` applies |
| **CGT concession** | not taxed, no cost-base effect | fully tax-free |
| **Foreign income** | at `m`, less foreign credit | |

**Tax-deferred is the AREIT edge and the reason this section exists.** It is not
tax-free — it is tax *deferred* into a discounted capital gain. Model it as
deferred, never as exempt, or the platform will overstate after-tax returns.

### 4.3 Default tax profiles by asset class
Used when actual component data is absent, and **flagged as an assumption**:

| Asset class | Default assumption |
|---|---|
| `credit`, `bond_hybrid` | 100% unfranked interest — worst-case, and correct for MXT/GCI/QRI |
| `reit` (landlord) | typical split with a tax-deferred portion; **estimate only, must be marked** |
| `equity`, `lit` | franked per actual franking history |

Where a real annual tax statement exists, it **always** supersedes the default.

### 4.4 Property tax
Property has its own treatment and must not reuse the listed path: rental income
is taxed at `m`, but **depreciation and capital works are deductions that reduce
taxable income without reducing cash**. This makes post-tax property yield
*higher* than its pre-tax cash yield in a way no listed holding replicates.
`property_cashflows.depreciation` and `.capital_works` carry it. Negative gearing
(interest exceeding income) produces a tax *benefit* — model the sign correctly.

### 4.5 Required outputs — the three yield lenses

**Every yield on this platform is reported three ways, always together.** They are
different numbers answering different questions, and showing one alone is how
income investors talk themselves into the wrong asset.

| Lens | Definition | Answers |
|---|---|---|
| **Cash yield** | distribution actually received / denominator | "what hits my bank account" |
| **Gross yield** (grossed-up) | `(cash + franking credits) / denominator` | "what it's worth before *my* tax rate" |
| **Post-tax yield** | `(cash + credits − tax payable) / denominator` | "what I actually keep" |

Applied against both denominators from §3.1 — cost and market — giving six figures
per holding. The UI need not show all six at once, but the engine computes all six
and the user can switch lens.

Worked illustration of why all three are needed, at `m = 0.47`, all on a 7.0%
cash yield:

| Asset | Cash | Gross | Post-tax |
|---|---|---|---|
| Credit fund, 100% unfranked interest | 7.0% | 7.0% | **3.71%** |
| REIT, 70% unfranked / 30% tax-deferred | 7.0% | 7.0% | **4.20%** |
| Equity, 100% franked | 7.0% | 10.0% | **5.30%** |

Same headline. **159bp spread post-tax.** Gross yield alone would rank the
credit fund and the REIT as identical, and they are not.

These figures are **verified against `scripts/tax-engine.js`**, not asserted.
The REIT row works as: 4.9% unfranked taxed at 47% → 2.597%, plus 2.1%
tax-deferred taxed as a discounted capital gain at 47% × (1 − 0.5) = 23.5% →
1.607%. Total 4.204%.

**Deferral is charged immediately at the discounted CGT rate, with no credit for
the time value of deferring it.** That is deliberate and conservative: crediting
the deferral properly needs a holding-period assumption, and a wrong one
overstates after-tax return on exactly the assets this platform is meant to
favour. If a horizon-aware treatment is added later it must be opt-in and
labelled, never the default.

Per holding and for the portfolio total:
```
cash_income, franking_credits, gross_income, tax_payable, post_tax_income,
cash_yield_on_cost,     gross_yield_on_cost,     post_tax_yield_on_cost,
cash_yield_on_market,   gross_yield_on_market,   post_tax_yield_on_market,
tax_deferred_pct, franked_pct
```
Plus, against the §0 hurdles: **post-tax yield vs the 7% target** and
**post-tax IRR vs the 12% target**, each as a pass/fail with the gap shown.

**The 7% hurdle is measured post-tax.** A 7% cash yield that nets 3.7% has not met
it. State the lens next to the target everywhere it appears.

Everything here is an estimate. Label it in the UI: *modelling tool, not tax
advice.*

---

## 5. The fundamental value engine

Replaces the scrape-a-spreadsheet approach. The workbooks become a **seed for
assumptions**, not the calculation engine.

### 5.1 Principles
- **Pure, deterministic functions.** Inputs → outputs, no I/O, no `Date.now()`
  inside a calculation. The same inputs must always produce the same valuation.
- **Versioned.** Every stored output records `engine_version` and the assumption
  set it used. A valuation you cannot reproduce is worthless.
- **Every output carries its inputs.** No naked numbers.
- **Excel stays the seed.** `scripts/export-model.js` and its label/range/null
  guards remain the ingest path for assumptions. Do not delete that hardening —
  it is the only thing standing between a shifted workbook row and a wrong
  real-money BUY signal.

### 5.2 Methods, and where each applies
Cap rates are only comparable **within a sector** — never blend across.

| Method | Applies to | Core |
|---|---|---|
| **NTA / cap-rate** | landlord REITs | `NPI / cap_rate` → asset value → less net debt → per unit |
| **Implied cap rate** | landlords only | `NPI / (price × shares + net debt)`; signal is the **implied-vs-book (WACR) gap** |
| **DDM** | all income assets | forecast DPU discounted at required return |
| **FFO/AFFO multiple** | REITs | sector multiple × per-unit FFO |
| **Levered equity DCF** | all REITs | free cash to equity, terminal on exit cap |
| **Takeover / internalisation** | externally-managed | synergy + control premium |

Blend to a single `fair_value` with **explicit, stored weights**. A blend whose
weights are buried in code is not a methodology.

### 5.3 IRR — the 12% test
```
IRR solves: price_today = Σ [ DPU_t / (1+r)^t ] + terminal_value_N / (1+r)^N
```
- Use forecast DPU where a model exists, else the §3.3 precedence.
- Terminal value from the blended fair value, grown at the terminal assumption.
- Solve numerically (bisection is fine and is more robust than Newton here);
  **bracket it and return `null` if it does not converge — never return a
  fallback number.**
- Compute **pre-tax and post-tax** IRR. Post-tax applies §4 to each cashflow and
  the CGT discount to the terminal gain.

### 5.4 Scoring against the hurdles
The REIT fundamental stack (7 layers: macro/rates · NTA value · yield · cap rates ·
balance sheet · earnings · income trigger) keeps its 0–7 scale — the
`>=5 BUY` / `>=6 STRONG_BUY` thresholds depend on it. **Do not rescale it.**

The hurdle test sits **beside** the score, not inside it:
`post_tax_IRR ≥ 12%` **and** `post_tax_yield ≥ 7%` → `MEETS_HURDLE`.
Show which of the two failed when it fails. A high score that misses both hurdles
is exactly the thing this platform exists to catch.

### 5.5 Storage
```
valuation_runs(id, ticker, engine_version, as_of, method_values jsonb,
               weights jsonb, fair_value, irr_pre_tax, irr_post_tax,
               yield_pre_tax, yield_post_tax, meets_hurdle, inputs jsonb)
```
Append-only. Never update a past run — the history is the audit trail.

---

## 6. Front-end conventions

Extracted from the current code. Follow exactly — mismatched UI is the most
visible failure mode of a parallel build.

- **Flat SPA. No React, no bundler, no build step.** `public/index.html` is the
  single source of truth and is ~2,930 lines.
- **No mirror files.** Root-level duplicates were deleted 2026-08-13 after
  silently drifting. Only `public/` and `netlify/functions/` deploy.
- **A page is** `<div id="pg-NAME" class="page">` with a sidebar entry
  `<a data-page="NAME">`. Separate top-level HTML files (`value-layer.html`,
  `models.html`, `assumptions.html`, `evidence.html`, `reit-value.html`) are
  linked with a plain `href` and are the exception.
- **Reuse the existing classes.** Do not write new CSS for things that exist:

  | Need | Class |
  |---|---|
  | Page header | `.ph` (`<h1>` + `<p>`) |
  | KPI tiles | `.kb` wrapper, `.kc` card (`.dk` = dark), `.kl` label, `.kv` value, `.kn` note |
  | Section label | `.sl` |
  | Tabs | `.tab-row` + `.tab` (`.active`) |
  | Forms | `.form-grid` + `.form-group` |
  | Buttons | `.btn.btn-primary` / `.btn.btn-secondary` |
  | Empty state | `.empty` |
  | Right-align cell | `.r` |

- **Design tokens are CSS variables** — `--teal --ink --paper --cream --rule
  --muted`. Use the variables, never literal hex.
- **Fonts: `DM Sans` for UI, `DM Mono` for labels/numerics.** `CLAUDE.md` says
  Arial — that applies to the **email template only**, which must stay
  Outlook-safe. Do not put DM fonts in the email; do not put Arial in the app.
- **No 360 Capital branding.** Colours reused, unbranded. No five-dot mark.
- **Missing data renders `—`, never `0`, never `NaN`, never a blank cell.**
- **Pre-tax and post-tax appear together.** Never a post-tax figure without its
  pre-tax counterpart visible — the difference *is* the insight.

---

## 7. File ownership — the anti-collision map

Each agent owns its files **exclusively**. If an agent needs a change in a file
it does not own, it **reports** the required change; it does not make it.

| Agent | Owns | Must not touch |
|---|---|---|
| **A — income & holdings** | `supabase/migrations/*_holdings_property_*.sql`, `netlify/functions/income-rollup.js`, `netlify/functions/sync-holdings.js` | `public/index.html`, `scripts/` |
| **B — tax engine** | `supabase/migrations/*_tax_*.sql`, `scripts/tax-engine.js`, `netlify/functions/tax-rollup.js` | `public/index.html`, `scripts/model-engine.js` |
| **C — value engine** | `scripts/model-engine.js`, `scripts/irr.js`, `netlify/functions/run-valuation.js`, `supabase/migrations/*_valuation_*.sql` | `public/index.html`, `scripts/export-model.js` |
| **D — fundamentals capture** | `netlify/functions/ingest-fundamentals.js`, `supabase/migrations/*_fundamentals_*.sql` | `public/index.html`, `scripts/` |
| **Integrator (me)** | `public/index.html`, `CLAUDE.md`, `SPEC.md`, `scripts/export-model.js`, migration ordering | — |

**`public/index.html` has exactly one owner.** Agents specify their UI needs; the
integrator wires them.

Migrations are written with a **descriptive suffix and no number**; the integrator
numbers them at merge time to guarantee ordering.

**Interface contract between agents:** B (tax) consumes the component schema in
§4.2 and exposes `taxAdjust(cashflow, profile, settings) → {tax, credits, net}`.
C (value) calls that signature for post-tax IRR. Neither imports the other's
internals. If the signature needs to change, report it — do not change it
unilaterally.

---

## 8. Definition of done, per agent

"I wrote the code" is not done. All of these must hold:

1. `node --check` passes on every changed `.js`. There is no test suite, so this
   is the floor, not the ceiling.
2. **Pure calculation functions ship with worked examples** in a comment showing
   inputs → expected output, hand-checkable. For anything tax or IRR related this
   is mandatory — those are the numbers that will be trusted blindly.
3. Every SQL migration is **idempotent** and re-runnable.
4. Every new table has RLS enabled, a `for select using (true)` policy, and
   `grant select to anon, authenticated`. **Omitting this is the single most
   repeated bug in this repo** — the page shows nothing, with no error.
5. No secrets in committed files. Service-role key is server-side only.
6. The report states: what was built, what was **not** verified and why, and any
   assumption made that the spec did not settle.
7. **Do not commit or push.** The integrator reviews and lands everything.

---

## 9. Honesty rules

This tool moves real money. These override any instinct to look finished.

- **A number you did not verify is labelled unverified** — in the report and,
  where it matters, in the UI.
- **Placeholder ≠ value.** Unbuilt signals render `—`. Never seed a plausible fake
  so a page looks populated.
- **No fabricated market data.** If a figure needs a results pack that has not been
  captured, it stays empty. Do not estimate it into the database.
- **No fabricated tax components.** Use the §4.3 defaults, flagged as assumptions.
  Never invent a franking or tax-deferred percentage for a specific security.
- **Strategy performance stays labelled illustrative** until the honest backtester
  (walk-forward, brokerage, slippage, purge/embargo) exists. It does not.
- If a spec instruction turns out to be wrong once you see the code, **say so and
  stop** — do not quietly build a different thing.

---

## 10. Current state, verified 2026-08-17

Checked directly against the database. Do not re-derive.

- Repo clean at `df95f2f`, in sync with `origin/main`.
- **All grants/RLS already in place** on every existing table and view.
- Models loaded: 5 REITs (CIP, DXC, DXI, RGN, WPR), 9 versions, 45 forecasts,
  28 actuals. `META` in `export-model.js` also lists REP, which has no workbook.
- `distributions`: 28 rows, ~$4,351 across CIP/DXC/DXI/DXS/TCF.
- `real_trades`: 5 rows — DXS 1869@5.35, DXI 4032@2.48, DXC 3759@2.66,
  CIP 2000@2.84, TCF 3100@5.91.
- **Empty and blocking:** `holdings` (0), `reit_fundamentals` (0),
  `contract_notes` (0), `watchlist` (0), `bond_data` (0), `cre_developments` (0),
  `cre_leasing_deals` (0). No property, tax or valuation-run tables exist yet.
- `prices` 281k, `stocks` 514, `fundamentals` 509 — market data is healthy.
- Private credit universe named in `CLAUDE.md`: MXT, GCI, QRI, KKC, MOT, TCF.

### Known-stale artefact
`C:\Users\james\Downloads\CLAUDE.md` (outside the repo) is a **drifted copy** of
the repo's `CLAUDE.md`. It still claims root `index.html` mirrors `public/` and
still lists Breakout as a strategy — both untrue since 2026-08-13. Not in the
repo, must not be used as a source. Delete it.

---

## 11. Environment notes

- **Git is not on PATH.** Use GitHub Desktop's bundled binary:
  `%LOCALAPPDATA%\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`
- **Node is installed** at `C:\Program Files\nodejs\node.exe`. No `gh` CLI.
- **PowerShell 5.1 encoding trap:** `Get-Content` / `Set-Content` default to ANSI
  and corrupt the UTF-8 box-drawing characters in this repo's comment banners. Use
  `[System.IO.File]::ReadAllLines($f,[System.Text.Encoding]::UTF8)` and
  `WriteAllLines` with `UTF8Encoding($false)` (no BOM), or use the editing tools
  rather than the shell.
- Supabase project `opziisvjfkjwwdbclniw`, live at `areit.netlify.app`,
  auto-deploys from `main`.
