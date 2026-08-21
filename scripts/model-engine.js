#!/usr/bin/env node
/* =====================================================================
 * model-engine.js — the fundamental value engine (SPEC.md §5)
 *
 * Replaces "scrape the answer out of a spreadsheet" with "compute the answer
 * from the assumptions". `scripts/export-model.js` remains the ingest path: the
 * workbooks SEED reit_model_assumptions / _forecasts, and this file does the
 * arithmetic. That split is deliberate — the workbook hardening (label, range
 * and null guards) is the only thing standing between a shifted row and a wrong
 * real-money BUY, so it stays.
 *
 * PURE. No I/O, no database, no Date.now() inside a calculation. Same inputs
 * always produce the same valuation, which is what makes a stored run auditable
 * (SPEC §5.1). `netlify/functions/run-valuation.js` does all the fetching.
 *
 * ── UNITS, and they are not uniform (SPEC §1.1) ───────────────────────────────
 * The workbooks mix conventions and the database faithfully preserves the mix:
 *
 *   reit_model_forecasts.dpu / .epu ........ CENTS   ("(cps)" in the workbooks)
 *   reit_model_actuals.ffo_per_unit ........ CENTS
 *   reit_model_*.nta, prices, valuations ... DOLLARS
 *   *_m columns (noi_m, ffo_m) ............. MILLIONS of dollars
 *   reit_models.securities_m ............... MILLIONS of units
 *   cap rates, gearing, discount rates ..... DECIMAL fractions (0.0625 = 6.25%)
 *
 * Everything crossing the boundary INTO this engine is normalised to dollars and
 * decimals by `normaliseInputs`, and every function below then works in dollars
 * only. Do not pass a raw forecast row to a valuation method — normalise first,
 * or every per-unit figure lands 100x out and looks entirely plausible.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────────
 * Every method returns `{value: null, reason: '...'}` when an input is missing,
 * never a fallback or a substituted average. A blend of three real methods and
 * one invented one is not a valuation. `reason` is surfaced in the UI so a `—`
 * always explains itself.
 * ===================================================================== */

const { irrFromSeries } = require('./irr.js');

const ENGINE_VERSION = 'model-engine-1.0.0';

/* Blend weights, stated here rather than buried in the blending function, because
 * weights ARE the methodology (SPEC §5.2). They are per REIT sub-class: a landlord
 * is worth the assets it holds, so the cap-rate NAV dominates; a fund manager's
 * value is an earnings stream, so an asset lens is close to meaningless.
 *
 * Weights are renormalised over whichever methods actually produced a value, so a
 * missing input shifts weight to the survivors rather than silently scoring zero. */
const BLEND_WEIGHTS = {
  landlord:     { asset_nav: 0.40, cap_rate_nav: 0.40, nta: 0.15, ddm: 0.25, ffo_multiple: 0.20 },
  developer:    { asset_nav: 0.20, cap_rate_nav: 0.20, nta: 0.20, ddm: 0.20, ffo_multiple: 0.40 },
  fund_manager: { asset_nav: 0.00, cap_rate_nav: 0.00, nta: 0.10, ddm: 0.30, ffo_multiple: 0.60 },
  default:      { asset_nav: 0.30, cap_rate_nav: 0.30, nta: 0.15, ddm: 0.30, ffo_multiple: 0.25 },
};

/* asset_nav and cap_rate_nav are the SAME LENS at different resolutions — one
 * values every asset at its own cap rate, the other values the portfolio at a
 * blended one. Counting both double-weights the asset view and drowns out the
 * earnings and book lenses. Where the bottom-up figure exists it wins outright;
 * the top-down one is the fallback for REITs with no asset register. */
const SUPERSEDES = { asset_nav: 'cap_rate_nav' };

const M = 1e6;
const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const ok  = v => v !== null && Number.isFinite(v);

/** A method result. `value` in DOLLARS per unit, or null with a reason. */
const val  = (value, inputs) => ({ value, reason: null, inputs });
const skip = (reason)        => ({ value: null, reason, inputs: null });

/* ── NORMALISATION ────────────────────────────────────────────────────────────
 * The single place cents become dollars and millions become dollars. Every
 * method below assumes it has already run. */
function normaliseInputs(raw) {
  const a = raw.assumptions || {};
  const m = raw.model       || {};
  const forecasts = (raw.forecasts || [])
    .slice()
    .sort((x, y) => String(x.fy).localeCompare(String(y.fy)))
    .map(f => ({
      fy:       f.fy,
      noi:      ok(num(f.noi_m)) ? num(f.noi_m) * M : null,   // $m  -> $
      ffo:      ok(num(f.ffo_m)) ? num(f.ffo_m) * M : null,   // $m  -> $
      dpu:      ok(num(f.dpu))   ? num(f.dpu)  / 100 : null,  // cps -> $
      epu:      ok(num(f.epu))   ? num(f.epu)  / 100 : null,  // cps -> $
      nta:      num(f.nta),                                    // already $
      gearing:  num(f.gearing),                                // already decimal
    }));

  return {
    ticker:     raw.ticker,
    subclass:   raw.subclass || 'landlord',
    price:      num(raw.price),                                // $
    securities: ok(num(m.securities_m)) ? num(m.securities_m) * M : null,
    cap_rate:   num(a.cap_rate),
    req_return: num(a.req_return),
    exit_cap:   num(a.exit_cap),
    gearing:    num(a.gearing_current),
    payout:     num(a.payout_ratio),
    base_pe:    num(a.base_pe),
    escalation: num(a.escalation),
    base_noi:   ok(num(a.base_noi_m)) ? num(a.base_noi_m) * M : null,
    net_debt:   num(raw.net_debt),                             // $ if known
    npi:        num(raw.npi),                                  // $ ANNUALISED
    assets:     raw.assets || [],                              // reit_assets rows, raw
    forecasts,
  };
}

/* ── METHOD 1: cap-rate NAV ───────────────────────────────────────────────────
 * The landlord's core lens. Capitalise net property income at the market cap
 * rate to get gross asset value, strip the debt, divide by units.
 *
 *   asset value = NOI / cap rate
 *   equity      = asset value - net debt
 *   per unit    = equity / securities
 *
 * Net debt is taken directly when known; otherwise it is implied from gearing,
 * since gearing is defined as net debt / total assets.
 *
 * Worked: NOI $60m, cap 6.25%, gearing 33% , 400m units
 *   assets  = 60,000,000 / 0.0625 = $960,000,000
 *   equity  = 960,000,000 x (1 - 0.33) = $643,200,000
 *   / units = 643,200,000 / 400,000,000 = $1.608
 */
function capRateNav(i) {
  const noi = i.forecasts.find(f => ok(f.noi))?.noi ?? i.base_noi;
  if (!ok(noi))          return skip('no NOI in forecasts or assumptions');
  if (!ok(i.cap_rate))   return skip('no cap rate');
  if (!ok(i.securities)) return skip('no securities on issue');

  const assets = noi / i.cap_rate;
  const netDebt = ok(i.net_debt) ? i.net_debt
                : ok(i.gearing)  ? assets * i.gearing
                : null;
  if (netDebt === null) return skip('no net debt and no gearing to imply it from');

  const equity = assets - netDebt;
  return val(equity / i.securities, {
    noi, cap_rate: i.cap_rate, asset_value: assets, net_debt: netDebt,
    net_debt_source: ok(i.net_debt) ? 'reported' : 'implied from gearing',
    securities: i.securities,
  });
}

/* ── METHOD 1b: ASSET-LEVEL NAV (bottom-up) ───────────────────────────────────
 * The honest version of method 1. Instead of one portfolio NOI over one blended
 * cap rate, value EVERY asset at ITS OWN cap rate and sum:
 *
 *   asset value_i = income_i / cap_i
 *   portfolio     = sum(asset value_i x ownership_i)
 *   equity        = portfolio - net debt
 *   per unit      = equity / securities
 *
 * This matters because a blended cap rate is a weighted average that hides the
 * spread. A portfolio of one 4.9% data centre and one 5.4% secondary industrial
 * is not the same asset as two 5.15% assets, and only the bottom-up view can
 * show which end of the book is carrying the valuation.
 *
 * Overrides win over scraped values, so an edited cap rate survives a workbook
 * re-export. Excluded rows drop out entirely.
 *
 * Worked: two assets, $61.5m @ 5.0% and $17.3m @ 4.9%, net debt $400m, 600m units
 *   61.5/0.05 = $1,230m ; 17.3/0.049 = $353.06m ; portfolio = $1,583.06m
 *   equity = 1,583.06 - 400 = $1,183.06m -> /600m = $1.9718
 */
function assetLevelNav(i) {
  const rows = (i.assets || []).filter(a => !a.is_excluded);
  if (!rows.length)      return skip('no asset register rows');
  if (!ok(i.securities)) return skip('no securities on issue');

  const priced = [];
  const unpriced = [];
  for (const a of rows) {
    const income = num(a.income_override_m) ?? num(a.passing_income_m);
    const cap    = num(a.cap_rate_override) ?? num(a.cap_rate);
    const own    = num(a.ownership_pct) ?? 1;
    if (!ok(income) || !ok(cap) || cap <= 0) { unpriced.push(a.asset_name); continue; }
    priced.push({
      asset_name: a.asset_name, sector: a.sector, state: a.state,
      income_m: income, cap_rate: cap, ownership_pct: own,
      value_m: (income / cap) * own,
      overridden: num(a.cap_rate_override) !== null || num(a.income_override_m) !== null,
    });
  }
  if (!priced.length) return skip('no asset row has both income and a cap rate');

  const portfolioM = priced.reduce((s, a) => s + a.value_m, 0);
  const assets = portfolioM * M;
  const incomeM = priced.reduce((s, a) => s + a.income_m * a.ownership_pct, 0);

  const netDebt = ok(i.net_debt) ? i.net_debt
                : ok(i.gearing)  ? assets * i.gearing
                : null;
  if (netDebt === null) return skip('no net debt and no gearing to imply it from');

  // The blended cap rate this bottom-up view implies — the number a top-down
  // model would have used, now derived rather than assumed.
  const impliedBlended = portfolioM > 0 ? incomeM / portfolioM : null;

  return val((assets - netDebt) / i.securities, {
    assets_priced: priced.length,
    assets_unpriced: unpriced,
    portfolio_value_m: portfolioM,
    income_m: incomeM,
    implied_blended_cap: impliedBlended,
    cap_rate_range: [Math.min(...priced.map(a => a.cap_rate)), Math.max(...priced.map(a => a.cap_rate))],
    net_debt: netDebt,
    net_debt_source: ok(i.net_debt) ? 'reported' : 'implied from gearing',
    securities: i.securities,
    breakdown: priced,
  });
}

/* ── METHOD 2: NTA ────────────────────────────────────────────────────────────
 * Book net tangible assets per security. Not a valuation so much as a floor
 * reference — it is the directors' cap rates, not the market's. Carried at a
 * low weight for exactly that reason. */
function ntaValue(i) {
  const f = i.forecasts.find(x => ok(x.nta));
  if (!f) return skip('no NTA in forecasts');
  return val(f.nta, { nta: f.nta, fy: f.fy });
}

/* ── METHOD 3: dividend discount ──────────────────────────────────────────────
 * Discount the forecast distribution stream, then a Gordon terminal on the last
 * forecast year. This is the method that most directly reflects an income
 * mandate, which is why it carries real weight here.
 *
 *   V = sum( DPU_t / (1+r)^t ) + [ DPU_N x (1+g) / (r-g) ] / (1+r)^N
 *
 * Growth `g` comes from the rent escalation assumption, capped below the
 * discount rate — a Gordon terminal with g >= r is infinite, and returning a
 * huge number rather than null is precisely the failure this engine must not
 * have.
 *
 * Worked: DPU 0.18/0.185/0.19, r 8.5%, g 2.5%
 *   PV(explicit) = .18/1.085 + .185/1.085^2 + .19/1.085^3 = 0.1659+0.1571+0.1487 = 0.4717
 *   terminal     = 0.19 x 1.025 / (0.085-0.025) = 3.2458  -> /1.085^3 = 2.5405
 *   V            = 3.012
 */
function ddmValue(i) {
  const dpus = i.forecasts.filter(f => ok(f.dpu)).map(f => f.dpu);
  if (!dpus.length)      return skip('no forecast DPU');
  if (!ok(i.req_return)) return skip('no required return');

  const r = i.req_return;
  const g = ok(i.escalation) ? Math.min(i.escalation, r - 0.005) : 0;
  if (g >= r) return skip(`terminal growth ${g} >= discount rate ${r} — Gordon model undefined`);

  let pv = 0;
  dpus.forEach((d, k) => { pv += d / Math.pow(1 + r, k + 1); });

  const last = dpus[dpus.length - 1];
  const terminal = (last * (1 + g)) / (r - g);
  const pvTerminal = terminal / Math.pow(1 + r, dpus.length);

  return val(pv + pvTerminal, {
    dpu_stream: dpus, discount_rate: r, terminal_growth: g,
    pv_explicit: pv, terminal_value: terminal, pv_terminal: pvTerminal,
  });
}

/* ── METHOD 4: FFO multiple ───────────────────────────────────────────────────
 * Earnings lens. FFO per unit x a sector multiple. For a fund manager or a
 * developer this is the dominant method, because their value is not the balance
 * sheet. */
function ffoMultipleValue(i) {
  if (!ok(i.base_pe)) return skip('no base PE / multiple assumption');

  const f = i.forecasts.find(x => ok(x.ffo)) || null;
  let ffoPerUnit = null;
  if (f && ok(i.securities)) ffoPerUnit = f.ffo / i.securities;
  else {
    const e = i.forecasts.find(x => ok(x.epu));
    if (e) ffoPerUnit = e.epu;
  }
  if (!ok(ffoPerUnit)) return skip('no FFO per unit (needs ffo_m + securities, or epu)');

  return val(ffoPerUnit * i.base_pe, {
    ffo_per_unit: ffoPerUnit, multiple: i.base_pe,
    source: f ? `ffo_m ${f.fy} / securities` : 'epu',
  });
}

/* ── Implied cap rate (SPEC §5.2, landlords ONLY) ─────────────────────────────
 *   implied = capitalised passing income / (price x securities + net debt)
 *
 * The signal is the GAP to the book (WACR) cap rate: the market pricing the
 * portfolio above or below where the directors carry it.
 *
 * THE NUMERATOR IS CAPITALISED PASSING INCOME, NOT REPORTED NPI — and this is a
 * correctness point, not a convenience one.
 *
 *   passing income = portfolio value x WACR
 *
 * A valuer sets WACR by capitalising PASSING income, so portfolio value x WACR
 * recovers exactly the income the book was struck on. Statutory NPI is a
 * different quantity: it carries straight-lining, it includes acquisitions for
 * the part-year they were owned, and on a REIT with equity-accounted holdings it
 * excludes income from assets that ARE in the portfolio value. Dividing statutory
 * NPI by enterprise value and comparing the answer to a valuer's WACR compares
 * two different definitions of income and calls the difference a market signal.
 *
 * Measured on the two names carrying both figures: HDN capitalises to $280.1m
 * against $279.0m reported, 0.4% apart. CLW capitalises to $330.1m against
 * $286.7m reported, 15.1% apart — that gap is CLW's equity-accounted portfolio,
 * exactly the case where statutory NPI understates the income behind the book.
 *
 * It also unblocks the measure. Reported NPI exists for 2 of the 11 REITs with a
 * results pack, because no vendor feed carries it and it has to be read out of a
 * PDF; portfolio value and WACR exist for 6 and are on the front page of every
 * pack. A signal that renders "—" on four fifths of the universe is not a signal.
 *
 * Reported NPI remains the fallback, annualised, and the basis used is always
 * reported so the two are never silently mixed across names.
 *
 * Meaningless for developers and fund managers — enterprise value there captures
 * earnings that have nothing to do with a property portfolio — so it refuses
 * rather than returning a number nobody should use. */
function impliedCapRate(i) {
  if (i.subclass !== 'landlord') return skip('implied cap rate is meaningless outside landlord REITs');
  if (!ok(i.price))      return skip('no price');
  if (!ok(i.securities)) return skip('no securities on issue');

  /* Preference order. Capitalised passing income first because it is definitionally
   * consistent with the WACR it will be compared against. */
  /* The DISCLOSED WACR is preferred over the workbook cap rate for both jobs
   * here — capitalising the book and being the thing the result is compared
   * against. They are usually close, but only one of them is what the directors
   * actually struck the carrying value on, and using the workbook's number would
   * make the gap partly an artefact of our own assumption. */
  const bookCap = ok(i.wacr) ? i.wacr : i.cap_rate;

  let income = null, basis = null, reconciliation = null;
  if (ok(i.portfolio_value) && ok(bookCap)) {
    income = i.portfolio_value * bookCap;
    basis  = `capitalised passing income (portfolio value x ${ok(i.wacr) ? 'disclosed WACR' : 'workbook cap rate'})`;
    if (ok(i.npi)) {
      reconciliation = {
        reported_npi: i.npi, capitalised: income,
        gap_pct: Math.round(((income - i.npi) / i.npi) * 1000) / 10,
        note: 'a wide gap usually means equity-accounted assets sit in the portfolio value but not in statutory NPI, or that acquisitions landed part-way through the year',
      };
    }
  } else if (ok(i.npi)) {
    income = i.npi;
    basis  = 'reported NPI (annualised) — no portfolio value and WACR to capitalise from';
  } else {
    return skip('no portfolio value + WACR to capitalise, and no reported NPI to fall back to');
  }

  const mktCap = i.price * i.securities;
  const netDebt = ok(i.net_debt) ? i.net_debt
                : ok(i.gearing) && ok(bookCap) ? (income / bookCap) * i.gearing
                : null;
  if (netDebt === null) return skip('no net debt and nothing to imply it from');

  const ev = mktCap + netDebt;
  if (!(ev > 0)) return skip('non-positive enterprise value');

  const implied = income / ev;
  return val(implied, {
    income, income_basis: basis, reconciliation,
    market_cap: mktCap, net_debt: netDebt, enterprise_value: ev,
    book_cap_rate: bookCap,
    book_cap_source: ok(i.wacr) ? 'disclosed WACR' : 'workbook cap rate',
    gap_bps: ok(bookCap) ? Math.round((implied - bookCap) * 10000) : null,
    note: ok(bookCap)
      ? 'the gap is the market repricing the same book: positive means the market wants a wider rate than the directors carry it at'
      : null,
  });
}

/* ── BLEND ────────────────────────────────────────────────────────────────────
 * Weighted mean over the methods that produced a value, with weights
 * renormalised so a missing method does not drag the result toward zero.
 * The applied weights are returned and stored — a blend whose weights are not
 * recorded cannot be audited (SPEC §5.2). */
function blend(methods, subclass) {
  const w = BLEND_WEIGHTS[subclass] || BLEND_WEIGHTS.default;
  let live = Object.keys(w).filter(k => methods[k] && ok(methods[k].value) && w[k] > 0);

  // Drop any method superseded by a finer-resolution one that actually produced
  // a value, so the same lens is never counted twice.
  const superseded = new Set();
  live.forEach(k => { if (SUPERSEDES[k]) superseded.add(SUPERSEDES[k]); });
  live = live.filter(k => !superseded.has(k));
  if (!live.length) return { fair_value: null, weights_applied: {}, reason: 'no method produced a value' };

  const totalW = live.reduce((s, k) => s + w[k], 0);
  const applied = {};
  let fv = 0;
  live.forEach(k => {
    const weight = w[k] / totalW;
    applied[k] = Number(weight.toFixed(4));
    fv += methods[k].value * weight;
  });
  return {
    fair_value: fv,
    weights_applied: applied,
    weights_nominal: w,
    methods_used: live,
    methods_skipped: Object.keys(w).filter(k => !live.includes(k)),
    reason: null,
  };
}

/* ── IRR (SPEC §5.3) ──────────────────────────────────────────────────────────
 *   price today = sum( DPU_t / (1+r)^t ) + terminal_N / (1+r)^N
 *
 * Terminal is the blended fair value grown at the terminal assumption, so the
 * IRR is only ever as honest as the valuation behind it — which is exactly why
 * the two live in one engine.
 *
 * Post-tax applies the tax engine to each distribution and the CGT discount to
 * the terminal gain. `taxFns` is injected rather than imported so this module
 * stays pure and testable; run-valuation.js supplies it. */
function computeIrr(i, fairValue, taxFns) {
  if (!ok(i.price) || i.price <= 0) return { pre_tax: null, post_tax: null, reason: 'no price' };
  const dpus = i.forecasts.filter(f => ok(f.dpu)).map(f => f.dpu);
  if (!dpus.length)   return { pre_tax: null, post_tax: null, reason: 'no forecast DPU' };
  if (!ok(fairValue)) return { pre_tax: null, post_tax: null, reason: 'no fair value for the terminal' };

  const g = ok(i.escalation) ? i.escalation : 0;
  const terminal = fairValue * Math.pow(1 + g, dpus.length);

  const pre = irrFromSeries({ price: i.price, cashflows: dpus, terminal_value: terminal });

  let post = null, postReason = null;
  if (taxFns && taxFns.taxAdjust && taxFns.profile && taxFns.settings) {
    try {
      const netDpus = dpus.map(d => taxFns.taxAdjust(d, taxFns.profile, taxFns.settings).net);
      // Terminal is a capital gain: taxed at the marginal rate less the CGT
      // discount, on the gain only, never on the returned capital.
      const s = taxFns.settings;
      const mr = (s.marginal_rate || 0) + (s.medicare_levy || 0);
      const cgtRate = mr * (1 - (s.cgt_discount || 0));
      const gain = Math.max(0, terminal - i.price);
      const netTerminal = terminal - gain * cgtRate;
      post = irrFromSeries({ price: i.price, cashflows: netDpus, terminal_value: netTerminal });
    } catch (e) { postReason = 'tax engine: ' + e.message; }
  } else {
    postReason = 'no tax profile supplied';
  }

  return {
    pre_tax: pre ? pre.irr : null,
    post_tax: post ? post.irr : null,
    terminal_value: terminal,
    periods: dpus.length,
    reason: postReason,
    detail: { pre, post },
  };
}

/* ── THE ENTRY POINT ──────────────────────────────────────────────────────────
 * raw -> a complete, self-describing valuation. Everything needed to reproduce
 * the number travels with it (SPEC §5.1: a valuation you cannot reproduce is
 * worthless). */
function valuate(raw, taxFns) {
  const i = normaliseInputs(raw);

  const methods = {
    asset_nav:    assetLevelNav(i),
    cap_rate_nav: capRateNav(i),
    nta:          ntaValue(i),
    ddm:          ddmValue(i),
    ffo_multiple: ffoMultipleValue(i),
  };
  const implied = impliedCapRate(i);
  const b = blend(methods, i.subclass);
  const irrOut = computeIrr(i, b.fair_value, taxFns);

  const fwdDpu = i.forecasts.find(f => ok(f.dpu))?.dpu ?? null;
  const yieldPre = (ok(fwdDpu) && ok(i.price) && i.price > 0) ? fwdDpu / i.price : null;

  let yieldPost = null;
  if (ok(yieldPre) && taxFns && taxFns.taxAdjust && taxFns.profile && taxFns.settings) {
    try { yieldPost = taxFns.taxAdjust(fwdDpu, taxFns.profile, taxFns.settings).net / i.price; }
    catch (_) { /* leave null — a failed tax call must not invent a yield */ }
  }

  const discount = (ok(b.fair_value) && ok(i.price) && i.price > 0)
    ? (b.fair_value - i.price) / i.price : null;

  return {
    ticker: i.ticker,
    engine_version: ENGINE_VERSION,
    subclass: i.subclass,
    price: i.price,
    fair_value: b.fair_value,
    discount_to_fair_value: discount,
    method_values: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v.value])),
    method_detail: methods,
    implied_cap_rate: implied.value,
    implied_cap_detail: implied,
    weights: b.weights_applied,
    blend: b,
    irr_pre_tax: irrOut.pre_tax,
    irr_post_tax: irrOut.post_tax,
    irr_detail: irrOut,
    yield_pre_tax: yieldPre,
    yield_post_tax: yieldPost,
    forward_dpu: fwdDpu,
    inputs: i,
  };
}

/* Hurdle test (SPEC §5.4).
 *
 * Measured GROSS (SPEC §0). The 12% IRR is a statement about the ASSET, and an
 * asset's return does not change with who owns it — screening post-tax would make
 * the same security pass for one holder and fail for another, and would bake the
 * current marginal rate into what is meant to be a valuation judgement.
 *
 * The post-tax equivalent is computed and returned alongside, never instead: it
 * is what separates two assets that clear the gross hurdle equally, and a 7%
 * gross yield netting 3.71% is a different investment from one netting 5.30%.
 *
 * Sits BESIDE the 0-7 conviction score, never inside it — the score's >=5 BUY /
 * >=6 STRONG_BUY thresholds depend on that range staying 0-7. */
function hurdleTest(v, targets = { irr: 0.12, yield: 0.07 }) {
  const irr = v.irr_pre_tax, y = v.yield_pre_tax;
  if (irr === null && y === null) {
    return { status: 'UNKNOWN', meets_hurdle: null, failed: [], missing: ['irr', 'yield'], lens: 'gross' };
  }
  const failed = [], missing = [];
  if (irr === null) missing.push('irr'); else if (irr < targets.irr) failed.push('irr');
  if (y   === null) missing.push('yield'); else if (y < targets.yield) failed.push('yield');

  const meets = failed.length === 0 && missing.length === 0;
  return {
    status: missing.length ? 'INCOMPLETE' : (meets ? 'MEETS_HURDLE' : 'FAILS_HURDLE'),
    meets_hurdle: missing.length ? null : meets,
    failed, missing, targets,
    irr_gap:   irr === null ? null : irr - targets.irr,
    yield_gap: y   === null ? null : y   - targets.yield,
    lens: 'gross',
    // The overlay — displayed beside the verdict, never used to decide it.
    post_tax: {
      irr: v.irr_post_tax,
      yield: v.yield_post_tax,
      irr_drag_bps:   (irr !== null && v.irr_post_tax   !== null) ? Math.round((irr - v.irr_post_tax) * 10000) : null,
      yield_drag_bps: (y   !== null && v.yield_post_tax !== null) ? Math.round((y   - v.yield_post_tax) * 10000) : null,
    },
  };
}

module.exports = {
  ENGINE_VERSION, BLEND_WEIGHTS, SUPERSEDES,
  valuate, hurdleTest, blend, computeIrr, normaliseInputs,
  assetLevelNav, capRateNav, ntaValue, ddmValue, ffoMultipleValue, impliedCapRate,
};
