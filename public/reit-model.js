#!/usr/bin/env node
/* =====================================================================
 * reit-model.js — full three-statement A-REIT model, in-platform  (v2)
 *
 * v1 produced correct-but-opaque numbers. This version is built so that EVERY
 * computed line carries the formula and the exact inputs that produced it, in
 * `workings`. A model you cannot audit is worth nothing regardless of whether
 * the arithmetic is right — that is the whole reason the Excel exists, and it is
 * the reason this rewrite happened.
 *
 * WHAT v2 ADDS OVER v1
 *   1. WORKINGS      — every line: value + formula string + named inputs.
 *   2. DEBT SCHEDULE — tranche-level, with a maturity ladder. Tranches roll off
 *                      and refinance at the market rate, so a maturity wall
 *                      shows up as a step in the interest cost rather than
 *                      being averaged away.
 *   3. EXPIRY PROFILE— reversion applies ONLY to the leases actually expiring in
 *                      the year. v1 applied it to the whole book every year,
 *                      which materially overstated growth.
 *   4. FFO BRIDGE    — statutory profit reconciled to FFO line by line:
 *                      revaluations, derivative MTM, straight-lining,
 *                      incentive amortisation.
 *   5. OPENING TIE   — the opening balance sheet can be taken from the last
 *                      REPORTED actuals, so the forecast starts from something
 *                      that was audited rather than from an assumption.
 *   6. WORKING CAPITAL, JV EQUITY INCOME, STRAIGHT-LINING.
 *
 * ARTICULATION (unchanged, still enforced, still the safety net):
 *   assets = liabilities + equity · cash flow ties · equity rolls.
 *   Failures are REPORTED, never suppressed.
 *
 * LANDLORD REITs ONLY — capitalising NPI and gearing against it describes a
 * rent collector. A fund manager is a fee annuity on FUM; a developer is
 * inventory turning into profit. `buildModel` refuses both.
 *
 * UNITS (SPEC.md §1.1–1.3)
 *   statement lines .......... MILLIONS of dollars
 *   per-security figures ..... DOLLARS  (not the workbooks' cents)
 *   rates / ratios ........... DECIMAL fractions (0.0625 = 6.25%)
 *   securities ............... MILLIONS of units
 *
 * PURE. No I/O, no Date.now(). Same assumptions in, same model out.
 * ===================================================================== */

const MODEL_VERSION = 'reit-model-2.0.0';

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const n0  = (v, d = 0) => { const x = num(v); return x === null ? d : x; };
const r2  = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 1e6) / 1e6;
const pc  = v => (v == null ? 'n/a' : (v * 100).toFixed(2) + '%');
const m$  = v => (v == null ? 'n/a' : '$' + Number(v).toFixed(1) + 'm');

const DEFAULTS = {
  // — Portfolio —
  base_noi_m:            null,   // $m annual passing net property income
  cap_rate:              null,   // decimal, portfolio weighted average
  escalation:            0.030,  // decimal, contracted review on non-expiring leases
  reversion:             0.000,  // decimal, uplift/(downlift) on leases that EXPIRE
  occupancy:             0.980,
  base_occupancy:        0.980,  // occupancy already inside base_noi_m
  expiry_profile:        null,   // [0.12,0.15,...] share of income expiring per year
  default_expiry_rate:   0.150,  // used when no profile supplied
  like_for_like_growth:  null,   // decimal; overrides the build-up in year 1
  /* A single year's LFL growth is an OUTCOME, not a run rate. CIP printed 5.2%
   * in FY26 on 30% re-leasing spreads and near-record leasing volume — a very
   * good year. Extrapolating it for five years at a held cap rate compounds the
   * book up ~29% and manufactures a discount that does not exist.
   * So LFL applies in year 1 and fades linearly to the contracted escalation
   * rate over `lfl_fade_years`. Set the fade to 1 to hold LFL flat if you
   * genuinely believe it persists. */
  lfl_fade_years:        3,
  /* REVALUATION FLOW-THROUGH. Capitalising NPI at a held cap rate implies the
   * book revalues by the full income growth. Valuers do not work that way.
   * CIP FY26: NOI grew 5.2% but the portfolio was revalued up only $116m on a
   * ~$3.8bn book — 3.0%, a flow-through of about 0.58. The balance shows up as
   * the implied cap rate drifting wider, which is exactly what happened.
   * Assuming 1.0 compounds the book faster than any valuer will mark it and
   * manufactures NAV. */
  revaluation_flowthrough: 0.60,
  /* CAPITAL RECYCLING. REITs sell and buy constantly, and ignoring it breaks the
   * forecast. CIP divested $200m in FY26 at a 17% premium — at a 5.8% cap that
   * removes ~$11.6m of NPI, almost exactly offsetting $11.8m of like-for-like
   * growth. Which is precisely why CIP guides FFO up 3-5% while a model that
   * only ever grows the book produces 9.3%.
   * Arrays are per forecast year; a scalar applies to year 1 only. $m. */
  divestments_m:         null,   // assets SOLD — removes book and its NPI
  acquisitions_m:        null,   // assets BOUGHT — adds book and NPI at acq_cap_rate
  acquisition_cap_rate:  null,   // defaults to the portfolio cap rate
  straight_line_m:       0.0,    // $m non-cash straight-lining in reported NPI
  jv_equity_income_m:    0.0,    // $m equity-accounted JV income

  // — Debt —
  gearing_target:        0.330,
  debt_tranches:         null,   // [{name,amount_m,rate,matures_year,hedged}]
  cost_of_debt:          0.055,  // blended fallback when no tranches supplied
  market_refi_rate:      null,   // rate maturing tranches refinance at; defaults to cost_of_debt
  hedging_enabled:       true,
  hedge_ratio:           0.700,
  unhedged_rate_shift:   0.000,
  undrawn_margin:        0.0035, // line fee on undrawn capacity
  derivative_mtm_m:      0.0,    // $m non-cash MTM through statutory profit

  // — Costs —
  mgmt_fee_pct_gav:      0.0055,
  admin_cost_m:          3.0,
  /* Costs inflate. Holding the corporate cost base flat while NPI grows makes
   * FFO grow FASTER than income — CIP's model grew FFO 9.3% on 5.2% NPI growth
   * against guidance of 3.3–5.5%, and a frozen cost base was the whole reason.
   * Operating leverage is real but it is not infinite. */
  cost_inflation:        0.030,
  maintenance_capex_pct_noi: 0.05,
  leasing_incentive_pct_noi: 0.03,
  incentive_amortisation_m:  0.0,  // $m non-cash amortisation of incentives

  // — Working capital —
  working_capital_pct_noi: 0.00,   // movement as a share of NPI; + = cash absorbed

  // — Distribution —
  payout_ratio:          0.950,
  payout_basis:          'affo',

  // — Valuation —
  required_return:       0.085,
  exit_cap_rate:         null,
  terminal_growth:       0.025,
  ffo_multiple:          15.0,

  // — Structure / opening —
  securities_m:          null,
  opening_investment_properties_m: null, // from reported actuals if known
  opening_net_debt_m:    null,
  opening_cash_m:        5.0,
  forecast_years:        5,
};

/* ── BOTTOM-UP ROLL-UP ────────────────────────────────────────────────────────
 * Build the portfolio assumptions FROM the asset register instead of taking one
 * blended NPI and one blended cap rate on faith.
 *
 * Why it matters: a blended cap rate is a weighted average that conceals the
 * spread. A book carrying one asset at 4.9% and another at 7.8% is not the same
 * risk as two at 6.3%, and only the bottom-up view shows which end of the book
 * is holding up the valuation. It also means an edit to ONE asset — a cap rate
 * you disagree with, a tenant you think is going — flows all the way through the
 * three statements to DPU and fair value.
 *
 * The blended cap rate is DERIVED, not assumed:
 *     portfolio value = Σ (income_i ÷ cap_i)
 *     blended cap     = Σ income_i ÷ portfolio value
 * which is the value-weighted rate, not the naive average of the rates. Those
 * two differ materially whenever the spread is wide, and the naive one is wrong.
 *
 * Returns the assumption fragment to merge into buildModel(), plus the working.
 */
function rollUpAssets(assets, opts = {}) {
  const rows = (assets || []).filter(a => !a.is_excluded);
  const priced = [], unpriced = [];

  for (const a of rows) {
    const income = num(a.income_override_m) ?? num(a.passing_income_m);
    const cap    = num(a.cap_rate_override) ?? num(a.cap_rate);
    const own    = num(a.ownership_pct) ?? 1;
    if (income == null || cap == null || cap <= 0 || income <= 0) { unpriced.push(a.asset_name || 'unnamed'); continue; }
    priced.push({
      asset_name: a.asset_name, sector: a.sector, state: a.state, tenant: a.major_tenant,
      income_m: income * own, cap_rate: cap, ownership_pct: own,
      value_m: (income / cap) * own,
      overridden: num(a.cap_rate_override) != null || num(a.income_override_m) != null,
    });
  }

  if (!priced.length) {
    return { ok: false, reason: 'no asset row carries both a positive income and a cap rate',
             unpriced, assumptions: null };
  }

  const incomeM = priced.reduce((s, a) => s + a.income_m, 0);
  const valueM  = priced.reduce((s, a) => s + a.value_m, 0);
  const blendedCap = valueM > 0 ? incomeM / valueM : null;
  const caps = priced.map(a => a.cap_rate);

  // Concentration, bottom-up. Both are risk facts the top-down model cannot see.
  const group = (key) => {
    const m = {};
    priced.forEach(a => { const k = (a[key] || 'unattributed').trim(); m[k] = (m[k] || 0) + a.income_m; });
    return Object.entries(m).map(([k, v]) => ({ key: k, income_m: r2(v), share: r2(v / incomeM) }))
      .sort((x, y) => y.share - x.share);
  };
  const byTenant = group('tenant'), bySector = group('sector'), byState = group('state');

  return {
    ok: true,
    assumptions: {
      base_noi_m: r2(incomeM),
      cap_rate: r2(blendedCap),
      opening_investment_properties_m: r2(valueM),
    },
    working: {
      formula: 'portfolio value = Σ(asset income ÷ asset cap rate); blended cap = Σ income ÷ portfolio value',
      inputs: {
        assets_priced: priced.length, assets_unpriced: unpriced.length,
        unpriced_names: unpriced,
        portfolio_income_m: r2(incomeM),
        portfolio_value_m: r2(valueM),
        blended_cap_rate: r2(blendedCap),
        cap_rate_range: [Math.min(...caps), Math.max(...caps)],
        cap_spread_bps: Math.round((Math.max(...caps) - Math.min(...caps)) * 10000),
        note: 'blended cap is VALUE-WEIGHTED, not the average of the rates — those differ whenever the spread is wide, and the naive average is wrong',
      },
      breakdown: priced.sort((a, b) => b.value_m - a.value_m),
      concentration: { by_tenant: byTenant, by_sector: bySector, by_state: byState,
        top_tenant_share: byTenant[0]?.share ?? null,
        top_asset_share: r2(Math.max(...priced.map(a => a.value_m)) / valueM) },
    },
  };
}

/* ── CALIBRATION ──────────────────────────────────────────────────────────────
 * Seed the model from what the REIT actually REPORTED, not from generic defaults.
 *
 * A model running on escalation 3% / payout 95% / required return 8.5% is not a
 * model of anything — it is a template. When the results pack states LFL NOI of
 * +5.2%, a WACR of 5.8%, gearing of 34.9% and hedging of 54%, using 3% and
 * 33% instead is simply choosing to be wrong.
 *
 * And guidance gives a HARD TEST that a template can never pass: the company
 * publishes its own next-year FFO. If the model cannot reproduce that, the model
 * is miscalibrated and should say so rather than quietly emitting a fair value.
 * `validateAgainstGuidance` below is that test.
 */
function calibrateFromActuals(f, opts = {}) {
  if (!f) return { ok: false, reason: 'no reported fundamentals', assumptions: {} };
  const a = {}, sourced = {}, missing = [];

  const take = (key, val, label) => {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) { missing.push(label || key); return; }
    a[key] = Number(val); sourced[key] = label || key;
  };

  // Portfolio. NPI is a period flow in dollars; the model wants annual $m.
  if (f.npi != null && f.period_months) {
    take('base_noi_m', (Number(f.npi) * (12 / f.period_months)) / 1e6, 'reported NPI, annualised');
  } else if (f.portfolio_value != null && f.wacr != null) {
    // NPI is often not disclosed, but value x WACR recovers it as an identity.
    take('base_noi_m', (Number(f.portfolio_value) * Number(f.wacr)) / 1e6, 'portfolio value x WACR');
  } else missing.push('base_noi_m');

  // Start the balance sheet from the REPORTED book, not from NPI ÷ cap. They
  // should agree, and where they don't the reported figure is the one that was
  // audited.
  if (f.portfolio_value != null) take('opening_investment_properties_m', Number(f.portfolio_value) / 1e6, 'reported portfolio value');

  take('cap_rate', f.wacr, 'reported WACR');
  take('occupancy', f.occupancy, 'reported occupancy');
  take('base_occupancy', f.occupancy, 'reported occupancy');
  take('gearing_target', f.gearing, 'reported gearing');
  take('hedge_ratio', f.hedge_pct, 'reported hedging');
  /* COST OF DEBT. Rarely stated outright, but recoverable as an identity from
   * figures that always are:
   *      ICR  = EBIT / interest        FFO = EBIT − interest
   *   => interest = FFO / (ICR − 1)
   *   => cost of debt = interest / net debt
   * CIP FY26: 114.1 / (2.4 − 1) = $81.5m on ~$1,384m of debt = 5.89%, against a
   * 5.5% default. On that debt stack the difference is ~$5m of FFO, and it was a
   * meaningful part of why the model missed guidance. Derived beats defaulted. */
  if (f.cost_of_debt != null) {
    take('cost_of_debt', f.cost_of_debt, 'reported cost of debt');
  } else if (f.ffo != null && f.icr != null && Number(f.icr) > 1 &&
             f.gearing != null && f.portfolio_value != null) {
    const interest = Number(f.ffo) / (Number(f.icr) - 1);
    const netDebt = Number(f.portfolio_value) * Number(f.gearing);
    if (netDebt > 0) {
      const cod = interest / netDebt;
      if (cod > 0.01 && cod < 0.15) {
        take('cost_of_debt', cod, `derived: FFO ÷ (ICR−1) ÷ net debt = ${(cod*100).toFixed(2)}%`);
        a._derived_interest_m = Math.round(interest / 1e4) / 100;
      } else missing.push(`cost_of_debt (derived ${(cod*100).toFixed(1)}% is implausible)`);
    }
  } else missing.push('cost_of_debt');

  /* CORPORATE COSTS. The residual that makes the reported FFO tie:
   *      NPI − mgmt fee − admin − interest = FFO
   *   => mgmt + admin = NPI − interest − FFO
   * Solving for it beats assuming a fee rate, because it absorbs whatever the
   * REIT actually charges — base fee, performance fee, corporate overhead — and
   * forces year 0 of the model to reproduce the reported year. */
  if (a.base_noi_m != null && f.ffo != null && a._derived_interest_m != null) {
    const corporate = a.base_noi_m - a._derived_interest_m - (Number(f.ffo) / 1e6);
    if (corporate > 0 && corporate < a.base_noi_m * 0.4) {
      a.mgmt_fee_pct_gav = 0;          // folded into admin so nothing is double counted
      take('admin_cost_m', corporate, 'solved so NPI − costs − interest ties to reported FFO');
    }
  }

  // LFL growth is an OBSERVATION of what the portfolio actually did. It beats a
  // build-up from assumed escalation and reversion, so it overrides them.
  take('like_for_like_growth', f.lfl_noi_growth, 'reported like-for-like NOI growth');

  /* PAYOUT RATIO. Two sources, and the forward one wins.
   *
   * Guidance is a statement ABOUT THE FORECAST YEAR — the company publishing
   * both its expected FFO and the distribution it intends to pay out of it. The
   * trailing ratio is a statement about a year that has already happened, and a
   * REIT that is deliberately retaining more will not repeat it.
   *
   * CIP FY26 paid 16.8c on 17.97c of FFO = 93.5%. For FY27 it guides 17.3c on
   * 18.8–19.2c = 91.1%. Using the trailing 93.5% against a correct FFO forecast
   * overpays the distribution by 1.1c and misses guidance by 6.3% — a miss that
   * is entirely manufactured by using last year's payout for next year's.
   *
   * Both are applied to FFO, because both are derived against FFO. Deriving a
   * ratio off FFO and then paying it out of AFFO understates the distribution by
   * exactly the maintenance capex and incentive load. */
  const ffoPerUnit = (f.ffo != null && opts.securities_m)
    ? Number(f.ffo) / (opts.securities_m * 1e6) : null;

  const gLo = f.guidance_ffo_low != null ? Number(f.guidance_ffo_low) : null;
  const gHi = f.guidance_ffo_high != null ? Number(f.guidance_ffo_high) : gLo;
  const gMid = gLo != null ? (gLo + gHi) / 2 : null;

  if (f.guidance_dps != null && gMid) {
    take('payout_ratio', Number(f.guidance_dps) / gMid,
         `guided DPS ${(Number(f.guidance_dps)*100).toFixed(1)}c ÷ guided FFO ${(gMid*100).toFixed(1)}c — the forecast year's own intention`);
    a.payout_basis = 'ffo';
    sourced.payout_basis = 'set to FFO to match the basis the ratio was derived on';
  } else if (f.dps != null && ffoPerUnit > 0) {
    take('payout_ratio', Number(f.dps) / ffoPerUnit, 'reported DPS / FFO per security (trailing — no guidance published)');
    a.payout_basis = 'ffo';
    sourced.payout_basis = 'set to FFO to match the basis the ratio was derived on';
  } else missing.push('payout_ratio');

  if (f.wale != null) a._reported_wale = Number(f.wale);

  return {
    ok: Object.keys(a).length > 0,
    assumptions: a, sourced, missing,
    as_at: f.release_date || null, period_end: f.period_end || null,
    note: `Calibrated from the ${f.period_end} results pack released ${f.release_date}. ` +
          `${Object.keys(sourced).length} assumption(s) come from reported figures; ` +
          `${missing.length} fall back to defaults.`,
  };
}

/* Does the model reproduce the company's own guidance? This is the only
 * out-of-sample test available on a forward model, and a model that fails it
 * should not be trusted to value anything. */
function validateAgainstGuidance(model, f) {
  if (!model?.ok || !f) return null;
  const y1 = model.years[0];
  if (!y1) return null;

  const out = { checks: [], verdict: null };

  const lo = f.guidance_ffo_low != null ? Number(f.guidance_ffo_low) : null;
  const hi = f.guidance_ffo_high != null ? Number(f.guidance_ffo_high) : lo;
  if (lo != null) {
    const modelled = y1.ffo_per_unit;
    const mid = (lo + hi) / 2;
    const errPct = mid ? (modelled - mid) / mid : null;
    out.checks.push({
      metric: 'FFO per security', guidance: hi > lo ? `${(lo*100).toFixed(1)}–${(hi*100).toFixed(1)}c` : `${(lo*100).toFixed(1)}c`,
      modelled: modelled != null ? `${(modelled*100).toFixed(1)}c` : null,
      error_pct: r2(errPct),
      within_guidance: modelled != null && modelled >= lo * 0.98 && modelled <= hi * 1.02,
    });
  }

  const gd = f.guidance_dps != null ? Number(f.guidance_dps) : null;
  if (gd != null) {
    const modelled = y1.dpu;
    const errPct = gd ? (modelled - gd) / gd : null;
    out.checks.push({
      metric: 'Distribution per security', guidance: `${(gd*100).toFixed(1)}c`,
      modelled: modelled != null ? `${(modelled*100).toFixed(1)}c` : null,
      error_pct: r2(errPct),
      within_guidance: modelled != null && Math.abs(errPct) <= 0.05,
    });
  }

  if (!out.checks.length) { out.verdict = 'NO_GUIDANCE'; out.message = 'No published guidance to test against.'; return out; }

  const worst = Math.max(...out.checks.map(c => Math.abs(c.error_pct ?? 0)));
  out.max_error_pct = r2(worst);
  out.verdict = worst <= 0.05 ? 'CALIBRATED' : worst <= 0.15 ? 'LOOSE' : 'MISCALIBRATED';
  out.message =
    out.verdict === 'CALIBRATED'   ? `Model reproduces published guidance within ${(worst*100).toFixed(1)}%. The assumptions hold together.`
  : out.verdict === 'LOOSE'        ? `Model is ${(worst*100).toFixed(1)}% away from published guidance. Directionally right, but do not lean on the precise fair value.`
  : `Model misses published guidance by ${(worst*100).toFixed(1)}%. Something is wrong with the assumptions — the fair value below is NOT trustworthy until this is reconciled.`;
  return out;
}

/* ── WORKINGS RECORDER ────────────────────────────────────────────────────────
 * w(key, value, formula, inputs) stores the number AND how it was reached.
 * The UI renders these verbatim, so a reader can check any line without reading
 * this file. */
function makeWorkings() {
  const store = {};
  const w = (key, value, formula, inputs) => {
    store[key] = { value: r2(value), formula, inputs };
    return value;
  };
  return { w, store };
}

function buildModel(input = {}, opts = {}) {
  const a = { ...DEFAULTS, ...input };
  const errors = [];

  if (opts.subclass && String(opts.subclass).toLowerCase() !== 'landlord') {
    return { ok: false, errors: [
      `reit-model: subclass "${opts.subclass}" is not a landlord. This model capitalises NPI at a cap rate and gears against the result — that describes a rent-collecting landlord, not a fund manager (fee annuity on FUM) or a developer (inventory converting to profit).`
    ] };
  }

  if (num(a.base_noi_m) === null || a.base_noi_m <= 0) errors.push('base_noi_m (annual passing NPI, $m) is required and must be positive');
  if (num(a.cap_rate) === null || a.cap_rate <= 0)     errors.push('cap_rate is required (decimal, e.g. 0.0575)');
  if (num(a.securities_m) === null || a.securities_m <= 0) errors.push('securities_m (millions of units) is required');
  if (a.cap_rate > 0.25) errors.push(`cap_rate ${a.cap_rate} looks like a percentage — rates are decimals (SPEC §1.3)`);
  if (a.gearing_target >= 1) errors.push(`gearing_target ${a.gearing_target} >= 100% — decimal expected`);
  if (errors.length) return { ok: false, errors };

  const years   = Math.max(1, Math.min(10, n0(a.forecast_years, 5)));
  const exitCap = num(a.exit_cap_rate) ?? (a.cap_rate + 0.0025);
  const refiRate = num(a.market_refi_rate) ?? a.cost_of_debt;

  /* ── OPENING BALANCE SHEET ────────────────────────────────────────────────
   * Prefer REPORTED figures. Only fall back to deriving the book from NPI/cap
   * when no reported opening is supplied, and record which was used — a
   * forecast that silently starts from an assumption rather than from audited
   * actuals is a different object and the reader should be told. */
  const openingWorkings = makeWorkings();
  let noi = a.base_noi_m;

  const derivedGav = noi / a.cap_rate;
  let gav = num(a.opening_investment_properties_m) ?? derivedGav;
  openingWorkings.w('opening_investment_properties', gav,
    num(a.opening_investment_properties_m) != null
      ? 'reported opening balance sheet'
      : 'base_noi_m ÷ cap_rate',
    { base_noi_m: a.base_noi_m, cap_rate: a.cap_rate, derived: r2(derivedGav),
      source: num(a.opening_investment_properties_m) != null ? 'reported' : 'derived' });

  let cash = n0(a.opening_cash_m, 0);

  // Debt: tranche schedule if supplied, else a single implied balance.
  let tranches = Array.isArray(a.debt_tranches) && a.debt_tranches.length
    ? a.debt_tranches.map((t, i) => ({
        name: t.name || `Tranche ${i + 1}`,
        amount_m: n0(t.amount_m, 0),
        rate: num(t.rate) ?? a.cost_of_debt,
        matures_year: num(t.matures_year),
        hedged: t.hedged !== false,
      }))
    : null;

  let netDebt = tranches
    ? tranches.reduce((s, t) => s + t.amount_m, 0)
    : (num(a.opening_net_debt_m) ?? gav * a.gearing_target);

  openingWorkings.w('opening_net_debt', netDebt,
    tranches ? 'sum of debt tranches'
      : num(a.opening_net_debt_m) != null ? 'reported opening net debt'
      : 'opening investment properties × gearing_target',
    tranches ? { tranches: tranches.map(t => `${t.name} ${m$(t.amount_m)} @ ${pc(t.rate)}${t.matures_year ? ' to yr ' + t.matures_year : ''}`) }
             : { gav: r2(gav), gearing_target: a.gearing_target });

  /* Working capital and derivative MTM need balance-sheet homes, or the model
   * cannot tie. Cash absorbed by working capital becomes a receivable; a
   * derivative marked through profit creates a derivative asset (or liability
   * when negative). v2.0.0 moved both through cash and equity without recording
   * the other side, and the articulation check failed by exactly their sum. */
  let wcBalance = 0, derivBalance = 0;

  let equity = gav + cash - netDebt;
  openingWorkings.w('opening_equity', equity, 'properties + cash − net debt',
    { properties: r2(gav), cash: r2(cash), net_debt: r2(netDebt) });

  const rows = [];
  const checks = [];

  for (let y = 1; y <= years; y++) {
    const { w, store } = makeWorkings();
    const openGav = gav, openDebt = netDebt, openCash = cash, openEquity = equity;

    /* ── 1. NPI: escalation on the standing book, reversion on expiries ──────
     * v1 applied reversion to the entire book every year, which compounds an
     * uplift onto leases that never came up for review. Reversion belongs only
     * to the slice that actually expires. */
    const expShare = a.expiry_profile && a.expiry_profile[y - 1] != null
      ? n0(a.expiry_profile[y - 1], 0)
      : n0(a.default_expiry_rate, 0);

    let lfl;
    if (num(a.like_for_like_growth) !== null) {
      // Fade from the observed LFL toward contracted escalation. A strong year
      // is not a run rate, and assuming it is inflates every downstream number.
      const fade = Math.max(1, n0(a.lfl_fade_years, 3));
      const t = Math.min(1, (y - 1) / fade);
      lfl = a.like_for_like_growth * (1 - t) + n0(a.escalation, 0) * t;
      w('lfl_growth', lfl,
        'observed LFL faded linearly to contracted escalation over lfl_fade_years',
        { observed_lfl: a.like_for_like_growth, escalation: a.escalation,
          fade_years: fade, year: y, fade_progress: r2(t),
          note: 'a single year of LFL is an outcome, not a run rate — holding it flat compounds the book and manufactures a discount' });
    } else {
      lfl = a.escalation * (1 - expShare) + (a.escalation + a.reversion) * expShare;
      w('lfl_growth', lfl,
        'escalation × (1 − expiring) + (escalation + reversion) × expiring',
        { escalation: a.escalation, reversion: a.reversion, expiring_share: expShare,
          note: 'reversion applies only to leases expiring this year' });
    }

    const noiGrown = noi * (1 + lfl);
    w('noi_grown', noiGrown, 'prior NPI × (1 + like-for-like growth)',
      { prior_npi: r2(noi), lfl: r2(lfl) });

    const occRatio = n0(a.occupancy, DEFAULTS.occupancy) / n0(a.base_occupancy, DEFAULTS.base_occupancy);
    let npi = noiGrown * occRatio + n0(a.jv_equity_income_m, 0);   // `let`: capital recycling adjusts it below
    w('npi', npi, 'grown NPI × (occupancy ÷ base occupancy) + JV equity income',
      { grown_npi: r2(noiGrown), occupancy: a.occupancy, base_occupancy: a.base_occupancy,
        occupancy_ratio: r2(occRatio), jv_equity_income_m: n0(a.jv_equity_income_m, 0),
        note: 'base NPI is PASSING income, so occupancy flexes it only relative to the occupancy already inside it' });
    noi = noiGrown;

    // Cash NPI strips non-cash straight-lining — this is what actually funds distributions.
    const cashNpi = npi - n0(a.straight_line_m, 0);
    w('cash_npi', cashNpi, 'NPI − straight-lining (non-cash)',
      { npi: r2(npi), straight_line_m: n0(a.straight_line_m, 0) });

    /* ── 2. PROPERTY VALUE ───────────────────────────────────────────────── */
    /* The book moves by income growth × flow-through, NOT by the full income
     * growth. The residual widens the implied cap rate, which is reported so the
     * drift is visible rather than hidden. */
    /* Capital recycling BEFORE revaluation: an asset sold part-way through the
     * year takes its income with it. Sales are struck at book (the premium is a
     * realised gain, not recurring income); purchases come in at the acquisition
     * cap rate. */
    const perYear = (v) => Array.isArray(v) ? n0(v[y - 1], 0) : (y === 1 ? n0(v, 0) : 0);
    const sold = perYear(a.divestments_m);
    const bought = perYear(a.acquisitions_m);
    const acqCap = num(a.acquisition_cap_rate) ?? a.cap_rate;
    if (sold || bought) {
      const npiLost = sold * a.cap_rate;
      const npiGained = bought * acqCap;
      npi = npi - npiLost + npiGained;
      w('capital_recycling', npiGained - npiLost,
        'acquisitions × acquisition cap − divestments × portfolio cap',
        { divested_m: sold, npi_removed: r2(npiLost), acquired_m: bought,
          npi_added: r2(npiGained), acquisition_cap_rate: acqCap,
          note: 'an asset sold takes its income with it — a model that only grows the book overstates forward earnings' });
    }

    const ft = Math.max(0, Math.min(1, n0(a.revaluation_flowthrough, 1)));
    const closeGav = (openGav - sold + bought) * (1 + lfl * ft);
    const revaluation = closeGav - openGav;
    const impliedCap = closeGav > 0 ? npi / closeGav : null;
    w('investment_properties', closeGav,
      'opening book × (1 + like-for-like growth × revaluation flow-through)',
      { opening_book: r2(openGav), lfl: r2(lfl), flow_through: ft,
        book_growth: r2(lfl * ft), entry_cap_rate: a.cap_rate,
        implied_cap_rate_after: r2(impliedCap),
        cap_drift_bps: Math.round((impliedCap - a.cap_rate) * 10000),
        note: 'valuers do not pass through the whole of income growth; the residual shows up as the implied cap rate drifting wider' });
    w('implied_cap_rate', impliedCap, 'NPI ÷ closing book value',
      { npi: r2(npi), book: r2(closeGav), entry_cap_rate: a.cap_rate });
    w('revaluation', revaluation, 'closing properties − opening properties',
      { closing: r2(closeGav), opening: r2(openGav), note: 'NON-CASH: hits equity, never operating cash flow' });

    /* ── 3. DEBT SCHEDULE ────────────────────────────────────────────────── */
    const targetDebt = closeGav * a.gearing_target;
    w('target_debt', targetDebt, 'closing properties × gearing_target',
      { properties: r2(closeGav), gearing_target: a.gearing_target });

    let interest, trancheDetail = null, blendedRate;
    const hedgeRatio = a.hedging_enabled === false ? 0 : n0(a.hedge_ratio, 0);

    if (tranches) {
      // Tranche-level: anything maturing this year refinances at the market rate.
      const matured = [];
      tranches = tranches.map(t => {
        if (t.matures_year != null && t.matures_year === y) {
          matured.push(`${t.name} ${m$(t.amount_m)} refinanced ${pc(t.rate)} → ${pc(refiRate)}`);
          return { ...t, rate: refiRate, hedged: false, matures_year: null };
        }
        return t;
      });
      const drawn = tranches.reduce((s, t) => s + t.amount_m, 0);
      // Flex the unhedged tranches to hit target gearing; hedged debt is fixed.
      const gap = targetDebt - drawn;
      if (Math.abs(gap) > 0.001) {
        const flexIdx = tranches.findIndex(t => !t.hedged);
        if (flexIdx >= 0) tranches[flexIdx] = { ...tranches[flexIdx], amount_m: Math.max(0, tranches[flexIdx].amount_m + gap) };
        else tranches.push({ name: 'Revolver', amount_m: Math.max(0, gap), rate: refiRate, hedged: false, matures_year: null });
      }
      interest = tranches.reduce((s, t) => {
        const shock = t.hedged ? 0 : n0(a.unhedged_rate_shift, 0);
        return s + t.amount_m * (t.rate + shock);
      }, 0);
      const totalDrawn = tranches.reduce((s, t) => s + t.amount_m, 0);
      blendedRate = totalDrawn > 0 ? interest / totalDrawn : 0;
      trancheDetail = tranches.map(t => ({ ...t, interest_m: r2(t.amount_m * (t.rate + (t.hedged ? 0 : n0(a.unhedged_rate_shift, 0)))) }));
      w('interest', interest, 'Σ tranche amount × (tranche rate + shock if unhedged)',
        { tranches: trancheDetail.map(t => `${t.name} ${m$(t.amount_m)} @ ${pc(t.rate)}${t.hedged ? ' hedged' : ' floating'} → ${m$(t.interest_m)}`),
          refinanced_this_year: matured.length ? matured : 'none',
          blended_rate: r2(blendedRate) });
      netDebt = totalDrawn;
    } else {
      const avgDebt = (openDebt + targetDebt) / 2;
      blendedRate = a.cost_of_debt + (1 - hedgeRatio) * n0(a.unhedged_rate_shift, 0);
      interest = avgDebt * blendedRate;
      w('interest', interest, 'average debt × (cost_of_debt + (1 − hedge_ratio) × rate shock)',
        { opening_debt: r2(openDebt), closing_debt: r2(targetDebt), average_debt: r2(avgDebt),
          cost_of_debt: a.cost_of_debt, hedge_ratio: hedgeRatio,
          hedging_enabled: a.hedging_enabled !== false,
          rate_shock: n0(a.unhedged_rate_shift, 0), effective_rate: r2(blendedRate) });
      netDebt = targetDebt;
    }

    /* ── 4. P&L ──────────────────────────────────────────────────────────── */
    const mgmtFee = closeGav * n0(a.mgmt_fee_pct_gav, 0);
    w('mgmt_fee', mgmtFee, 'closing properties × mgmt_fee_pct_gav',
      { properties: r2(closeGav), fee_pct: n0(a.mgmt_fee_pct_gav, 0) });

    const admin = n0(a.admin_cost_m, 0) * Math.pow(1 + n0(a.cost_inflation, 0), y - 1);
    w('admin', admin, 'base admin × (1 + cost inflation)^(year − 1)',
      { base_admin: n0(a.admin_cost_m, 0), cost_inflation: n0(a.cost_inflation, 0), year: y,
        note: 'a frozen cost base makes FFO grow faster than income — operating leverage is real but not infinite' });
    const ebit = npi - mgmtFee - admin;
    w('ebit', ebit, 'NPI − management fee − admin',
      { npi: r2(npi), mgmt_fee: r2(mgmtFee), admin: r2(admin) });

    const ffo = ebit - interest;
    w('ffo', ffo, 'EBIT − net finance cost',
      { ebit: r2(ebit), interest: r2(interest),
        note: 'FFO excludes revaluations and derivative MTM by construction' });

    const maintCapex  = npi * n0(a.maintenance_capex_pct_noi, 0);
    const incentives  = npi * n0(a.leasing_incentive_pct_noi, 0);
    const affo = ffo - maintCapex - incentives - n0(a.straight_line_m, 0);
    w('affo', affo, 'FFO − maintenance capex − leasing incentives − straight-lining',
      { ffo: r2(ffo), maintenance_capex: r2(maintCapex), incentives: r2(incentives),
        straight_line_m: n0(a.straight_line_m, 0),
        note: 'AFFO is the cash actually available to distribute' });

    /* ── 5. FFO BRIDGE — statutory profit reconciled to FFO ──────────────── */
    const mtm = n0(a.derivative_mtm_m, 0);
    const incAmort = n0(a.incentive_amortisation_m, 0);
    const statutoryProfit = affo + revaluation + mtm + incAmort;
    w('statutory_profit', statutoryProfit,
      'AFFO + revaluation + derivative MTM + incentive amortisation',
      { affo: r2(affo), revaluation: r2(revaluation), derivative_mtm: mtm, incentive_amortisation: incAmort,
        note: 'built off AFFO, not FFO: maintenance capex and incentives are real costs that leave cash, and rolling equity off FFO would let that cash go without any charge against equity — the articulation check fails by exactly that amount' });

    const ffoBridge = [
      { line: 'Statutory profit',            value: r2(statutoryProfit) },
      { line: 'less: property revaluation',  value: r2(-revaluation) },
      { line: 'less: derivative MTM',        value: r2(-mtm) },
      { line: 'less: incentive amortisation',value: r2(-incAmort) },
      { line: 'add: maintenance capex',      value: r2(maintCapex) },
      { line: 'add: leasing incentives',     value: r2(incentives) },
      { line: 'add: straight-lining',        value: r2(n0(a.straight_line_m, 0)) },
      { line: '= FFO',                       value: r2(ffo), bold: true },
    ];

    /* ── 6. DISTRIBUTION ─────────────────────────────────────────────────── */
    const payoutBase = a.payout_basis === 'ffo' ? ffo : affo;
    const distributions = Math.max(0, payoutBase * n0(a.payout_ratio, 0));
    w('distributions', distributions, `${a.payout_basis.toUpperCase()} × payout_ratio`,
      { basis: a.payout_basis, base_value: r2(payoutBase), payout_ratio: n0(a.payout_ratio, 0) });

    /* ── 7. CASH FLOW ────────────────────────────────────────────────────── */
    const wcMovement = npi * n0(a.working_capital_pct_noi, 0);
    const cfo = ffo - n0(a.straight_line_m, 0) - wcMovement + incAmort;
    w('cfo', cfo, 'FFO − straight-lining + incentive amortisation − working capital movement',
      { ffo: r2(ffo), straight_line_m: n0(a.straight_line_m, 0),
        incentive_amortisation: incAmort, working_capital: r2(wcMovement),
        note: 'non-cash items removed; the revaluation never appears here' });

    const cfi = -(maintCapex + incentives);
    w('cfi', cfi, '−(maintenance capex + leasing incentives)',
      { maintenance_capex: r2(maintCapex), incentives: r2(incentives) });

    const debtDrawn = netDebt - openDebt;
    const cff = debtDrawn - distributions;
    w('cff', cff, 'debt drawn/(repaid) − distributions paid',
      { closing_debt: r2(netDebt), opening_debt: r2(openDebt),
        debt_drawn: r2(debtDrawn), distributions: r2(distributions) });

    const netCashMovement = cfo + cfi + cff;
    cash = openCash + netCashMovement;
    w('cash', cash, 'opening cash + operating + investing + financing',
      { opening_cash: r2(openCash), cfo: r2(cfo), cfi: r2(cfi), cff: r2(cff),
        movement: r2(netCashMovement) });

    /* ── 8. BALANCE SHEET ────────────────────────────────────────────────── */
    // The other side of the two non-property movements. Without these the
    // statements cannot balance — see the note at the opening balances.
    wcBalance   += wcMovement;   // cash absorbed by working capital → receivable
    derivBalance += mtm;         // MTM through profit → derivative asset/(liability)
    w('working_capital_balance', wcBalance, 'prior balance + this year\'s working-capital movement',
      { movement: r2(wcMovement), closing_balance: r2(wcBalance),
        note: 'cash absorbed by working capital becomes a receivable; it left cash, so it must appear as an asset or the balance sheet will not tie' });
    w('derivative_balance', derivBalance, 'prior balance + derivative MTM taken through profit',
      { mtm_this_year: mtm, closing_balance: r2(derivBalance),
        note: 'negative balance is a derivative liability' });

    const totalAssets = closeGav + cash + wcBalance + derivBalance;
    w('total_assets', totalAssets, 'investment properties + cash + working capital + derivative balance',
      { properties: r2(closeGav), cash: r2(cash),
        working_capital: r2(wcBalance), derivative: r2(derivBalance) });

    equity = openEquity + statutoryProfit - distributions;
    w('equity', equity, 'opening equity + statutory profit − distributions',
      { opening_equity: r2(openEquity), statutory_profit: r2(statutoryProfit), distributions: r2(distributions) });

    const gearing = totalAssets > 0 ? netDebt / totalAssets : null;
    w('gearing', gearing, 'net debt ÷ total assets',
      { net_debt: r2(netDebt), total_assets: r2(totalAssets) });

    const nta = (totalAssets - netDebt) / a.securities_m;
    w('nta', nta, '(total assets − net debt) ÷ securities on issue',
      { total_assets: r2(totalAssets), net_debt: r2(netDebt), securities_m: a.securities_m });

    /* ── 9. ARTICULATION ─────────────────────────────────────────────────── */
    const bsGap = totalAssets - (netDebt + equity);
    if (Math.abs(bsGap) > 0.01) checks.push({ year: y, check: 'balance_sheet', gap_m: r2(bsGap),
      detail: `assets ${r2(totalAssets)} ≠ debt ${r2(netDebt)} + equity ${r2(equity)}` });
    const cashGap = (openCash + netCashMovement) - cash;
    if (Math.abs(cashGap) > 0.01) checks.push({ year: y, check: 'cash_flow_ties', gap_m: r2(cashGap) });

    const ffoPerUnit  = ffo / a.securities_m;
    const affoPerUnit = affo / a.securities_m;
    const dpu = distributions / a.securities_m;
    w('dpu', dpu, 'distributions ÷ securities on issue',
      { distributions: r2(distributions), securities_m: a.securities_m });

    rows.push({
      year: y,
      npi: r2(npi), cash_npi: r2(cashNpi), mgmt_fee_m: r2(mgmtFee), admin_m: r2(admin),
      ebit_m: r2(ebit), net_finance_m: r2(interest), ffo_m: r2(ffo),
      maintenance_capex_m: r2(maintCapex), incentives_m: r2(incentives), affo_m: r2(affo),
      revaluation_m: r2(revaluation), derivative_mtm_m: mtm,
      statutory_profit_m: r2(statutoryProfit), distributions_m: r2(distributions),
      investment_properties_m: r2(closeGav), cash_m: r2(cash),
      total_assets_m: r2(totalAssets), net_debt_m: r2(netDebt), equity_m: r2(equity),
      gearing: r2(gearing),
      cfo_m: r2(cfo), cfi_m: r2(cfi), cff_m: r2(cff),
      working_capital_m: r2(-wcMovement),
      debt_drawn_m: r2(debtDrawn), net_cash_movement_m: r2(netCashMovement),
      ffo_per_unit: r2(ffoPerUnit), affo_per_unit: r2(affoPerUnit),
      dpu: r2(dpu), nta: r2(nta),
      affo_cover: distributions > 0 ? r2(affo / distributions) : null,
      icr: interest > 0 ? r2(ebit / interest) : null,
      lfl_growth: r2(lfl), expiring_share: r2(expShare),
      implied_cap_rate: r2(impliedCap),
      blended_debt_rate: r2(blendedRate),
      debt_tranches: trancheDetail,
      ffo_bridge: ffoBridge,
      workings: store,
    });

    gav = closeGav;
  }

  const valuation = valueModel(rows, a, exitCap);

  return {
    ok: true, model_version: MODEL_VERSION, assumptions: a,
    opening: openingWorkings.store,
    years: rows, valuation, checks,
    articulates: checks.length === 0,
    errors: [],
  };
}

/* ── VALUATION ────────────────────────────────────────────────────────────── */
function valueModel(rows, a, exitCap) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const r = a.required_return, g = Math.min(n0(a.terminal_growth, 0), r - 0.005);
  const workings = {};

  /* CURRENT NAV, not terminal. Using the year-5 NTA as a valuation presents a
   * future value as though it were a present one — it embeds five years of
   * compounding revaluation with no discounting, and on a geared vehicle that
   * inflates the answer badly. The current book is what you can buy today. */
  const first = rows[0];
  const capNav = first.nta;
  workings.cap_rate_nav = { value: capNav,
    formula: 'CURRENT NAV per security: (properties + cash − net debt) ÷ securities, year 1',
    inputs: { total_assets: first.total_assets_m, net_debt: first.net_debt_m,
              securities_m: a.securities_m, terminal_nta_for_reference: last.nta,
              note: 'year 1, NOT year 5 — the terminal NTA is a future value and discounting it is what the DCF is for' } };

  let ddm = null;
  if (r > g) {
    let pv = 0; const terms = [];
    rows.forEach((row, i) => { const t = row.dpu / Math.pow(1 + r, i + 1); pv += t; terms.push(`yr${i+1} ${row.dpu?.toFixed(4)} ÷ (1+${r})^${i+1} = ${t.toFixed(4)}`); });
    const terminal = (last.dpu * (1 + g)) / (r - g);
    const pvTerm = terminal / Math.pow(1 + r, rows.length);
    ddm = pv + pvTerm;
    workings.ddm = { value: r2(ddm),
      formula: 'Σ DPU ÷ (1+r)^t  +  [DPU_N × (1+g) ÷ (r − g)] ÷ (1+r)^N',
      inputs: { discount_rate: r, terminal_growth: g, explicit_pv: r2(pv),
                terminal_value: r2(terminal), pv_of_terminal: r2(pvTerm), terms } };
  } else {
    workings.ddm = { value: null, formula: 'refused', inputs: { reason: `terminal growth ${g} ≥ discount rate ${r} — Gordon model undefined` } };
  }

  /* Terminal book revalued at the exit cap, then DISCOUNTED BACK. Without the
   * discount this is a year-5 number masquerading as a year-0 one. */
  const exitGav = last.npi / exitCap;
  const exitNavFuture = (exitGav + last.cash_m - last.net_debt_m) / a.securities_m;
  const exitNav = exitNavFuture / Math.pow(1 + r, rows.length);
  workings.exit_cap_nav = { value: r2(exitNav),
    formula: '[(terminal NPI ÷ exit cap + cash − net debt) ÷ securities] ÷ (1+r)^N',
    inputs: { terminal_npi: last.npi, exit_cap_rate: exitCap, entry_cap_rate: a.cap_rate,
              revalued_book: r2(exitGav), undiscounted_value: r2(exitNavFuture),
              discount_rate: r, periods: rows.length,
              note: 'discounted back to today — the gap to current NAV is the cap-rate risk in the position' } };

  const ffoMult = last.ffo_per_unit != null ? last.ffo_per_unit * n0(a.ffo_multiple, 0) : null;
  workings.ffo_multiple = { value: r2(ffoMult), formula: 'terminal FFO per security × multiple',
    inputs: { ffo_per_unit: last.ffo_per_unit, multiple: n0(a.ffo_multiple, 0) } };

  /* ── LEVERED DCF (free cash flow to equity) ─────────────────────────────────
   * Distinct from the DDM, and the distinction matters. The DDM discounts only
   * what is PAID OUT; this discounts all cash available to equity, including
   * what is retained and the debt drawn as the book revalues. For a REIT that
   * retains earnings or gears into a rising valuation, the two diverge — and the
   * gap between them is exactly the value of what management keeps back.
   *
   *   FCFE_t = AFFO_t + net debt drawn_t
   *   V = Σ FCFE_t/(1+r)^t  +  terminal equity value/(1+r)^N
   *
   * Terminal is the exit-cap equity value, so the DCF is anchored to a property
   * valuation at exit rather than to a perpetuity of its own cash flows. */
  let dcf = null;
  if (rows.length && a.securities_m) {
    let pv = 0; const terms = [];
    rows.forEach((row, i) => {
      const fcfe = (row.affo_m ?? 0) + (row.debt_drawn_m ?? 0);
      const disc = fcfe / Math.pow(1 + r, i + 1);
      pv += disc;
      terms.push(`yr${i+1} AFFO ${(row.affo_m??0).toFixed(1)} + debt drawn ${(row.debt_drawn_m??0).toFixed(1)} = ${fcfe.toFixed(1)} → PV ${disc.toFixed(1)}`);
    });
    const terminalEquity = exitGav + last.cash_m - last.net_debt_m;
    const pvTerminal = terminalEquity / Math.pow(1 + r, rows.length);
    dcf = (pv + pvTerminal) / a.securities_m;
    workings.dcf = { value: r2(dcf),
      formula: 'Σ (AFFO + net debt drawn) ÷ (1+r)^t  +  terminal equity ÷ (1+r)^N,  all ÷ securities',
      inputs: { discount_rate: r, pv_explicit_m: r2(pv), terminal_equity_m: r2(terminalEquity),
                pv_of_terminal_m: r2(pvTerminal), securities_m: a.securities_m, cashflows: terms,
                note: 'FCFE, not distributions — the gap to the DDM is the value of retained earnings and of gearing into a revaluing book' } };
  }

  const parts = [
    { method: 'cap_rate_nav', value: capNav,  weight: 0.30 },
    { method: 'dcf',          value: dcf,     weight: 0.25 },
    { method: 'ddm',          value: ddm,     weight: 0.20 },
    { method: 'exit_cap_nav', value: exitNav, weight: 0.15 },
    { method: 'ffo_multiple', value: ffoMult, weight: 0.10 },
  ].filter(p => p.value !== null && Number.isFinite(p.value));

  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  const blended = totalW > 0 ? parts.reduce((s, p) => s + p.value * (p.weight / totalW), 0) : null;
  workings.blended_value = { value: r2(blended), formula: 'weighted mean, weights renormalised over the methods that produced a value',
    inputs: Object.fromEntries(parts.map(p => [p.method, `${p.value.toFixed(3)} × ${(p.weight/totalW*100).toFixed(0)}%`])) };

  return {
    cap_rate_nav: r2(capNav), ddm: r2(ddm), dcf: r2(dcf), exit_cap_nav: r2(exitNav),
    ffo_multiple_value: r2(ffoMult), exit_cap_rate: exitCap,
    blended_value: r2(blended),
    weights: Object.fromEntries(parts.map(p => [p.method, r2(p.weight / totalW)])),
    terminal_dpu: last.dpu, terminal_nta: last.nta,
    workings,
  };
}

/* ── SENSITIVITY ──────────────────────────────────────────────────────────── */
function sensitivity(baseAssumptions, spec = {}, opts = {}) {
  const {
    x_field = 'cap_rate', x_values = [-0.005, -0.0025, 0, 0.0025, 0.005],
    y_field = 'required_return', y_values = [-0.010, -0.005, 0, 0.005, 0.010],
    output = 'blended_value', mode = 'delta',
  } = spec;

  const baseX = n0(baseAssumptions[x_field], 0);
  const baseY = n0(baseAssumptions[y_field], 0);

  const pick = (m) => {
    if (!m.ok) return null;
    const last = m.years[m.years.length - 1];
    switch (output) {
      case 'blended_value':    return m.valuation?.blended_value ?? null;
      case 'cap_rate_nav':     return m.valuation?.cap_rate_nav ?? null;
      case 'ddm':              return m.valuation?.ddm ?? null;
      case 'terminal_dpu':     return last?.dpu ?? null;
      case 'terminal_gearing': return last?.gearing ?? null;
      case 'affo_cover':       return last?.affo_cover ?? null;
      case 'icr':              return last?.icr ?? null;
      default: return null;
    }
  };

  const base = buildModel(baseAssumptions, opts);
  const baseValue = pick(base);

  const grid = y_values.map(dy => x_values.map(dx => {
    const mutated = { ...baseAssumptions,
      [x_field]: mode === 'delta' ? baseX + dx : dx,
      [y_field]: mode === 'delta' ? baseY + dy : dy };
    const m = buildModel(mutated, opts);
    const v = pick(m);
    return { x: mode === 'delta' ? baseX + dx : dx, y: mode === 'delta' ? baseY + dy : dy,
             value: v,
             vs_base: (v !== null && baseValue !== null && baseValue !== 0) ? r2((v - baseValue) / baseValue) : null,
             articulates: m.ok ? m.articulates : null };
  }));

  return { x_field, y_field, output, mode,
    x_axis: x_values.map(dx => mode === 'delta' ? r2(baseX + dx) : dx),
    y_axis: y_values.map(dy => mode === 'delta' ? r2(baseY + dy) : dy),
    base_value: baseValue, grid };
}

/* Build the whole model from the asset register up. Asset-derived figures are
 * the base; `overrides` win, so a deliberate house view still beats the roll-up
 * and the page can show you which is which. */
function buildFromAssets(assets, overrides = {}, opts = {}) {
  const roll = rollUpAssets(assets, opts);
  if (!roll.ok) return { ok: false, errors: [`bottom-up roll-up failed: ${roll.reason}`], rollup: roll };
  const merged = { ...roll.assumptions, ...overrides };
  const m = buildModel(merged, opts);
  return { ...m, rollup: roll, built_from: 'asset_register',
           overridden_fields: Object.keys(overrides).filter(k => k in roll.assumptions) };
}

const API = { MODEL_VERSION, DEFAULTS, buildModel, valueModel, sensitivity,
              rollUpAssets, buildFromAssets, calibrateFromActuals, validateAgainstGuidance };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.ReitModel = API;
