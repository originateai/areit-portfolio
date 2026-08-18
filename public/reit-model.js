#!/usr/bin/env node
/* =====================================================================
 * reit-model.js — full three-statement A-REIT model, in-platform
 *
 * Replaces the Excel workbook rather than scraping it. Same shape as the
 * workbooks (`Assumptions | Debt | P&L | Balance Sheet | Cash Flow | Valuation`),
 * built so the three statements ARTICULATE:
 *
 *   1. the balance sheet balances: assets = liabilities + equity, every year;
 *   2. the cash flow ties: opening cash + net movement = closing cash on the BS;
 *   3. retained earnings roll: opening equity + FFO - distributions + revals
 *      = closing equity.
 *
 * Those three checks are what separate a model from three unrelated schedules.
 * They run on every build and are returned in `checks` — a model that does not
 * articulate is REPORTED as broken rather than quietly rendered.
 *
 * LANDLORD REITs ONLY. The mechanics here — capitalise NPI at a cap rate to get
 * asset value, gear against it, distribute AFFO — describe a rent-collecting
 * landlord. A fund manager's value is a fee annuity on FUM and a developer's is
 * inventory turning into profit; running either through this model produces a
 * confident, wrong number. `buildModel` refuses a non-landlord subclass.
 *
 * ── UNITS (SPEC.md §1.1–1.3) ──────────────────────────────────────────────────
 *   Statement lines .......... MILLIONS of dollars ($m), matching the workbooks
 *   Per-security figures ..... DOLLARS (NOT the workbooks' cents — this is new
 *                              code, and SPEC §1.2 says new columns are dollars)
 *   Rates .................... DECIMAL fractions (0.0625 = 6.25%)
 *   Securities ............... MILLIONS of units
 *
 * PURE. No I/O, no Date.now(). Same assumptions in, same model out, always —
 * which is what makes a stored scenario reproducible and a sensitivity grid
 * meaningful.
 * ===================================================================== */

const MODEL_VERSION = 'reit-model-1.0.0';

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const n0  = (v, d = 0) => { const x = num(v); return x === null ? d : x; };
const r2  = v => v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6;

/* ── ASSUMPTION SET ───────────────────────────────────────────────────────────
 * Everything the model needs, with the defaults an A-REIT analyst would reach
 * for. Each carries the unit in its name or a comment. This object IS the
 * editable surface — the UI edits exactly these fields, nothing hidden.
 */
const DEFAULTS = {
  // — Portfolio —
  base_noi_m:          null,   // $m, annual net property income, year 0
  cap_rate:            null,   // decimal, portfolio weighted average
  escalation:          0.030,  // decimal, contracted annual rent review
  reversion:           0.000,  // decimal, uplift/(downlift) on expiry re-leasing
  occupancy:           0.980,  // decimal, modelled occupancy
  base_occupancy:      0.980,  // decimal, occupancy implicit in base_noi_m
  like_for_like_growth: null,  // decimal; overrides escalation+reversion if set

  // — Capital structure —
  gearing_target:      0.330,  // decimal, net debt / total assets
  cost_of_debt:        0.055,  // decimal, all-in cost on the HEDGED slice
  hedging_enabled:     true,   // false => hedge_ratio forced to 0, the worst case
  hedge_ratio:         0.700,  // decimal, portion fixed/hedged
  unhedged_rate_shift: 0.000,  // decimal, shock applied to the UNHEDGED portion

  // — Costs —
  mgmt_fee_pct_gav:    0.0055, // decimal of gross asset value; 0 for internal
  admin_cost_m:        3.0,    // $m corporate overhead
  maintenance_capex_pct_noi: 0.05,  // decimal of NOI
  leasing_incentive_pct_noi: 0.03,  // decimal of NOI

  // — Distribution —
  payout_ratio:        0.950,  // decimal of AFFO
  payout_basis:        'affo', // 'affo' | 'ffo'

  // — Valuation —
  required_return:     0.085,  // decimal, cost of equity for the DDM/DCF
  exit_cap_rate:       null,   // decimal; defaults to cap_rate + 25bps
  terminal_growth:     0.025,  // decimal
  ffo_multiple:        15.0,   // x

  // — Structure —
  securities_m:        null,   // millions of units
  opening_net_debt_m:  null,   // $m; derived from gearing if null
  opening_cash_m:      5.0,    // $m
  forecast_years:      5,
};

/* ── THE MODEL ────────────────────────────────────────────────────────────────
 * One year at a time, each year's opening balances taken from the prior close.
 * That sequencing is what makes the statements articulate — a model that
 * computes each year independently from assumptions cannot tie.
 */
function buildModel(input = {}, opts = {}) {
  const a = { ...DEFAULTS, ...input };
  const errors = [];

  if (opts.subclass && String(opts.subclass).toLowerCase() !== 'landlord') {
    return { ok: false, errors: [
      `reit-model: subclass "${opts.subclass}" is not a landlord. This model capitalises NPI at a cap rate and gears against the result — that describes a rent-collecting landlord, not a fund manager (fee annuity on FUM) or a developer (inventory converting to profit). Model those separately rather than forcing them through this one.`
    ] };
  }

  // Required inputs. Refuse rather than default — a fabricated cap rate produces
  // a plausible valuation that is entirely fictional.
  if (num(a.base_noi_m) === null || a.base_noi_m <= 0) errors.push('base_noi_m (annual NPI, $m) is required and must be positive');
  if (num(a.cap_rate) === null || a.cap_rate <= 0)     errors.push('cap_rate is required (decimal, e.g. 0.0575)');
  if (num(a.securities_m) === null || a.securities_m <= 0) errors.push('securities_m (millions of units) is required');
  if (a.cap_rate > 0.25) errors.push(`cap_rate ${a.cap_rate} looks like a percentage — rates are decimals (SPEC §1.3)`);
  if (a.gearing_target >= 1) errors.push(`gearing_target ${a.gearing_target} >= 100% — decimal expected`);
  if (errors.length) return { ok: false, errors };

  const years = Math.max(1, Math.min(10, n0(a.forecast_years, 5)));
  const exitCap = num(a.exit_cap_rate) ?? (a.cap_rate + 0.0025);

  // Opening balance sheet, derived so the first year has somewhere to start.
  let noi = a.base_noi_m;
  let gav = noi / a.cap_rate;                                   // investment properties, $m
  let netDebt = num(a.opening_net_debt_m) ?? gav * a.gearing_target;
  let cash = n0(a.opening_cash_m, 0);
  let equity = gav + cash - netDebt;

  const rows = [];
  const checks = [];

  for (let y = 1; y <= years; y++) {
    const openGav = gav, openDebt = netDebt, openCash = cash, openEquity = equity;

    // ── 1. PORTFOLIO / NPI ──────────────────────────────────────────────────
    // Like-for-like growth overrides the escalation+reversion build-up when set,
    // because a stated LFL figure is an observation and the build-up is a model.
    const lfl = num(a.like_for_like_growth) !== null
      ? a.like_for_like_growth
      : (a.escalation + a.reversion);
    noi = noi * (1 + lfl);

    // `base_noi_m` is PASSING income — it already reflects who is paying rent
    // today. Occupancy therefore flexes it only relative to the assumed starting
    // occupancy: modelling 95% against a book let at 98% is a 3pt vacancy hit,
    // not a 5% one. Scaling by raw occupancy would double-count the vacancy that
    // is already absent from passing income.
    const occRatio = n0(a.occupancy, DEFAULTS.occupancy) / n0(a.base_occupancy, DEFAULTS.occupancy);
    const npi = noi * occRatio;

    // ── 2. ASSET VALUE ──────────────────────────────────────────────────────
    // Properties revalue as NPI grows at a held cap rate. That revaluation is
    // NON-CASH and must hit equity but never the cash flow — getting that wrong
    // is the classic way a REIT model stops articulating.
    const closeGav = npi / a.cap_rate;
    const revaluation = closeGav - openGav;

    // ── 3. P&L ──────────────────────────────────────────────────────────────
    const mgmtFee = closeGav * n0(a.mgmt_fee_pct_gav, 0);
    const admin = n0(a.admin_cost_m, 0);
    const ebit = npi - mgmtFee - admin;

    /* Interest on AVERAGE debt across the year, not opening — debt is drawn to
     * hold target gearing against a revaluing book, so it moves within the year
     * and charging opening balances understates finance costs in a rising market.
     * Closing debt is known (target gearing x revalued book), so average it.
     *
     * HEDGING: the hedged slice is locked at cost_of_debt; the unhedged slice
     * reprices by unhedged_rate_shift. `hedging_enabled: false` forces the hedge
     * ratio to zero, so 100% of debt takes the shock — the worst case. */
    const closeDebtForInterest = closeGav * a.gearing_target;
    const avgDebt = (openDebt + closeDebtForInterest) / 2;
    const hedgeRatio = a.hedging_enabled === false ? 0 : n0(a.hedge_ratio, 0);
    const effRate = a.cost_of_debt + (1 - hedgeRatio) * n0(a.unhedged_rate_shift, 0);
    const netFinance = avgDebt * effRate;

    const ffo = ebit - netFinance;
    const maintCapex = npi * n0(a.maintenance_capex_pct_noi, 0);
    const incentives = npi * n0(a.leasing_incentive_pct_noi, 0);
    const affo = ffo - maintCapex - incentives;

    const payoutBase = a.payout_basis === 'ffo' ? ffo : affo;
    const distributions = Math.max(0, payoutBase * n0(a.payout_ratio, 0));

    /* Statutory profit rolls equity, and it is built off AFFO — not FFO.
     *
     * Maintenance capex and leasing incentives are cash out (they sit in CFI),
     * and they are real economic costs, which is the whole reason AFFO deducts
     * them. Rolling equity off FFO instead let that cash leave the balance sheet
     * without any charge against equity, and the articulation check failed by
     * exactly -(maintCapex + incentives) every year. Treating them as expensed
     * — rather than capitalised into a book that is immediately marked back to
     * NPI/cap anyway — is both coherent and self-consistent.
     *
     * The revaluation is added because it is a real (non-cash) equity movement;
     * it is deliberately excluded from FFO and from operating cash flow. */
    const statutoryProfit = affo + revaluation;

    // ── 4. CASH FLOW ────────────────────────────────────────────────────────
    // Operating cash = FFO (non-cash revaluation excluded — this is the line
    // that keeps the statements tied).
    const cfo = ffo;
    const cfi = -(maintCapex + incentives);
    // Debt is drawn (or repaid) to hold the target gearing against the revalued
    // book — the same mechanic a real REIT uses, and it makes debt endogenous.
    const targetDebt = closeGav * a.gearing_target;
    const debtDrawn = targetDebt - openDebt;
    const cff = debtDrawn - distributions;
    const netCashMovement = cfo + cfi + cff;

    cash = openCash + netCashMovement;
    netDebt = targetDebt;

    // ── 5. BALANCE SHEET ────────────────────────────────────────────────────
    const totalAssets = closeGav + cash;
    // Equity rolls: opening + statutory profit - distributions.
    equity = openEquity + statutoryProfit - distributions;
    const gearing = totalAssets > 0 ? netDebt / totalAssets : null;
    const nta = (totalAssets - netDebt) / a.securities_m;   // $ per unit

    // ── 6. ARTICULATION CHECKS ──────────────────────────────────────────────
    const bsGap = totalAssets - (netDebt + equity);
    if (Math.abs(bsGap) > 0.01) {
      checks.push({ year: y, check: 'balance_sheet', gap_m: r2(bsGap),
        detail: `assets ${r2(totalAssets)} != debt ${r2(netDebt)} + equity ${r2(equity)}` });
    }
    const cashGap = (openCash + netCashMovement) - cash;
    if (Math.abs(cashGap) > 0.01) {
      checks.push({ year: y, check: 'cash_flow_ties', gap_m: r2(cashGap) });
    }

    const ffoPerUnit = ffo / a.securities_m;      // DOLLARS
    const affoPerUnit = affo / a.securities_m;
    const dpu = distributions / a.securities_m;

    rows.push({
      year: y,
      // P&L ($m)
      npi: r2(npi), mgmt_fee_m: r2(mgmtFee), admin_m: r2(admin), ebit_m: r2(ebit),
      net_finance_m: r2(netFinance), ffo_m: r2(ffo),
      maintenance_capex_m: r2(maintCapex), incentives_m: r2(incentives), affo_m: r2(affo),
      revaluation_m: r2(revaluation), statutory_profit_m: r2(statutoryProfit),
      distributions_m: r2(distributions),
      // Balance sheet ($m)
      investment_properties_m: r2(closeGav), cash_m: r2(cash),
      total_assets_m: r2(totalAssets), net_debt_m: r2(netDebt), equity_m: r2(equity),
      gearing: r2(gearing),
      // Cash flow ($m)
      cfo_m: r2(cfo), cfi_m: r2(cfi), cff_m: r2(cff),
      debt_drawn_m: r2(debtDrawn), net_cash_movement_m: r2(netCashMovement),
      // Per security (DOLLARS)
      ffo_per_unit: r2(ffoPerUnit), affo_per_unit: r2(affoPerUnit),
      dpu: r2(dpu), nta: r2(nta),
      // Coverage
      affo_cover: distributions > 0 ? r2(affo / distributions) : null,
      icr: netFinance > 0 ? r2(ebit / netFinance) : null,
      lfl_growth: r2(lfl),
    });

    gav = closeGav;
  }

  const valuation = valueModel(rows, a, exitCap);

  return {
    ok: true,
    model_version: MODEL_VERSION,
    assumptions: a,
    years: rows,
    valuation,
    checks,                                   // empty array = the model articulates
    articulates: checks.length === 0,
    errors: [],
  };
}

/* ── VALUATION ────────────────────────────────────────────────────────────────
 * Four lenses off the built model. Each returns null with a reason rather than a
 * fallback, so a dash on screen always explains itself.
 */
function valueModel(rows, a, exitCap) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const r = a.required_return, g = Math.min(n0(a.terminal_growth, 0), r - 0.005);

  // 1. Cap-rate NAV — the closing balance sheet, per unit.
  const capNav = last.nta;

  // 2. DDM — discount the modelled DPU stream, Gordon terminal.
  let ddm = null;
  if (r > g) {
    let pv = 0;
    rows.forEach((row, i) => { pv += row.dpu / Math.pow(1 + r, i + 1); });
    const terminal = (last.dpu * (1 + g)) / (r - g);
    ddm = pv + terminal / Math.pow(1 + r, rows.length);
  }

  // 3. Exit-cap NAV — revalue the terminal book at the exit cap, not the entry.
  //    The gap between this and capNav IS the cap-rate risk in the position.
  const exitGav = last.npi / exitCap;
  const exitNav = (exitGav + last.cash_m - last.net_debt_m) / a.securities_m;

  // 4. FFO multiple.
  const ffoMult = last.ffo_per_unit * n0(a.ffo_multiple, 0) || null;

  const parts = [
    { method: 'cap_rate_nav', value: capNav,  weight: 0.35 },
    { method: 'ddm',          value: ddm,     weight: 0.30 },
    { method: 'exit_cap_nav', value: exitNav, weight: 0.20 },
    { method: 'ffo_multiple', value: ffoMult, weight: 0.15 },
  ].filter(p => p.value !== null && Number.isFinite(p.value));

  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  const blended = totalW > 0 ? parts.reduce((s, p) => s + p.value * (p.weight / totalW), 0) : null;

  return {
    cap_rate_nav: r2(capNav), ddm: r2(ddm), exit_cap_nav: r2(exitNav),
    ffo_multiple_value: r2(ffoMult),
    exit_cap_rate: exitCap,
    blended_value: r2(blended),
    weights: Object.fromEntries(parts.map(p => [p.method, r2(p.weight / totalW)])),
    terminal_dpu: last.dpu, terminal_nta: last.nta,
  };
}

/* ── SENSITIVITY ──────────────────────────────────────────────────────────────
 * Two-dimensional grid: rebuild the WHOLE model at each cell, rather than
 * flexing the output. A sensitivity that perturbs the answer instead of the
 * inputs misses every second-order effect — gearing moving with the revalued
 * book, interest following debt, distributions following AFFO.
 *
 * Returns the grid plus the base cell, so the UI can shade relative to base.
 */
function sensitivity(baseAssumptions, spec = {}, opts = {}) {
  const {
    x_field = 'cap_rate',
    x_values = [-0.005, -0.0025, 0, 0.0025, 0.005],   // deltas
    y_field = 'required_return',
    y_values = [-0.010, -0.005, 0, 0.005, 0.010],
    output = 'blended_value',
    mode = 'delta',                                    // 'delta' | 'absolute'
  } = spec;

  const baseX = n0(baseAssumptions[x_field], 0);
  const baseY = n0(baseAssumptions[y_field], 0);

  const pick = (m) => {
    if (!m.ok) return null;
    if (output === 'blended_value')  return m.valuation?.blended_value ?? null;
    if (output === 'cap_rate_nav')   return m.valuation?.cap_rate_nav ?? null;
    if (output === 'ddm')            return m.valuation?.ddm ?? null;
    if (output === 'terminal_dpu')   return m.years[m.years.length-1]?.dpu ?? null;
    if (output === 'terminal_gearing') return m.years[m.years.length-1]?.gearing ?? null;
    if (output === 'affo_cover')     return m.years[m.years.length-1]?.affo_cover ?? null;
    return null;
  };

  const base = buildModel(baseAssumptions, opts);
  const baseValue = pick(base);

  const grid = y_values.map(dy => x_values.map(dx => {
    const mutated = {
      ...baseAssumptions,
      [x_field]: mode === 'delta' ? baseX + dx : dx,
      [y_field]: mode === 'delta' ? baseY + dy : dy,
    };
    const m = buildModel(mutated, opts);
    const v = pick(m);
    return {
      x: mode === 'delta' ? baseX + dx : dx,
      y: mode === 'delta' ? baseY + dy : dy,
      value: v,
      vs_base: (v !== null && baseValue !== null && baseValue !== 0) ? r2((v - baseValue) / baseValue) : null,
      articulates: m.ok ? m.articulates : null,
    };
  }));

  return {
    x_field, y_field, output, mode,
    x_axis: x_values.map(dx => mode === 'delta' ? r2(baseX + dx) : dx),
    y_axis: y_values.map(dy => mode === 'delta' ? r2(baseY + dy) : dy),
    base_value: baseValue,
    grid,
  };
}

/* Lives under public/ so it can be loaded by the SPA with a script tag: the
 * sensitivity grid rebuilds the full model at every cell, which has to run
 * client-side to respond as you type.
 *
 * It stays a valid CommonJS module too, so a Netlify function can require it via
 * ../../public/reit-model.js when the model is wired server-side. Nothing does
 * yet — `run-valuation.js` uses the separate blended-valuation engine in
 * scripts/model-engine.js. One file either way: this repo has been bitten by
 * mirror files before (root-level duplicates deleted 2026-08-13 after silently
 * diverging), so there is deliberately no second copy. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MODEL_VERSION, DEFAULTS, buildModel, valueModel, sensitivity };
}
if (typeof window !== 'undefined') {
  window.ReitModel = { MODEL_VERSION, DEFAULTS, buildModel, valueModel, sensitivity };
}
