// netlify/functions/income-rollup.js
// Agent A — the income lens. Implements SPEC.md §3 exactly.
//
// ONE LIST, not two tabs (SPEC §2.3): listed holdings and direct property are
// returned in a single `holdings` array, each reconciled to the same metric —
// cash in pocket per dollar of the owner's own capital (SPEC §3.1).
//
// ── UNITS, the 100x landmine (SPEC §1.1) ─────────────────────────────────────
//   reit_model_forecasts.dpu   CENTS  -> divided by 100 here
//   stocks.dps_fy26            DOLLARS -> used as-is
//   distributions.amount_per_unit DOLLARS -> used as-is
//   every figure this function EMITS is DOLLARS; every yield is a DECIMAL
//   fraction (0.0723 = 7.23%). The UI multiplies by 100, not this file.
//
// ── MISSING DATA (SPEC §3.3 item 4, §6, §9) ──────────────────────────────────
//   No forward distribution -> cash_income is null, NOT zero. Zeros silently
//   poison the portfolio total and make a data gap look like a bad holding.
//   The portfolio total sums only non-null rows and reports the coverage.
//
// ── PRE-TAX ONLY ─────────────────────────────────────────────────────────────
//   This function is the pre-tax layer. Agent B's tax engine consumes
//   `cash_income_by_key` plus each row's asset_class / franking / property
//   depreciation and capital_works to produce the gross and post-tax lenses
//   (SPEC §4.5). Nothing here applies a tax rate.
//
// Usage:
//   GET /.netlify/functions/income-rollup
//   GET /.netlify/functions/income-rollup?as_of=2026-08-17   (determinism/tests)
//   GET /.netlify/functions/income-rollup?fy=FY27            (pin the model FY)
//   GET /.netlify/functions/income-rollup?include_closed=1

const { createClient } = require('@supabase/supabase-js');

const ENGINE_VERSION = 'income-rollup@1.0.0';
const PRICE_LOOKBACK_DAYS = 30;   // how far back to accept a last price
const TRAILING_DAYS = 365;        // SPEC §3.3 item 3 — trailing 12 months

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE FUNCTIONS — no I/O, no Date.now(). SPEC §5.1: same inputs, same output.
// ─────────────────────────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startIso, endIso) {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Australian financial year in progress at `asOf` (FY ends 30 June — confirmed
 * against reit_models.fy_end = '30 June' for every current model).
 *
 * Worked examples:
 *   currentFy('2026-08-17') -> 'FY27'   (1 Jul 2026 - 30 Jun 2027)
 *   currentFy('2026-06-30') -> 'FY26'
 *   currentFy('2026-07-01') -> 'FY27'
 */
function currentFy(asOfIso) {
  const y = parseInt(asOfIso.slice(0, 4), 10);
  const m = parseInt(asOfIso.slice(5, 7), 10);
  const fyEndYear = m >= 7 ? y + 1 : y;
  return `FY${String(fyEndYear).slice(2)}`;
}

/** 'FY27E' / 'FY27' both normalise to 'FY27'. */
function normFy(label) {
  return String(label || '').toUpperCase().replace(/E$/, '').trim();
}

/**
 * SPEC §3.3 — forward annual distribution per unit, in DOLLARS, with the source
 * recorded so the UI can show provenance. First available wins; otherwise null.
 *
 *   1. reit_model_forecasts.dpu for the current FY, /100 (CENTS -> DOLLARS)
 *   2. stocks.dps_fy26 (already DOLLARS)
 *   3. trailing 12 months actual from distributions (DOLLARS)
 *   4. null — render as an em dash, never zero
 *
 * Worked examples:
 *   forwardDps({modelDpuCents: 17.903})
 *     -> { dps: 0.17903, source: 'model' }              // CIP FY27E, /100
 *   forwardDps({modelDpuCents: null, dpsFy26: 0.37})
 *     -> { dps: 0.37, source: 'stocks_dps_fy26' }       // DXS, already dollars
 *   forwardDps({modelDpuCents: null, dpsFy26: null, trailing: {total: 0.622, n: 12}})
 *     -> { dps: 0.622, source: 'trailing_12m' }         // TCF, 12 monthly pays
 *   forwardDps({})
 *     -> { dps: null, source: null }
 */
function forwardDps({ modelDpuCents = null, modelFy = null, dpsFy26 = null, trailing = null } = {}) {
  const c = num(modelDpuCents);
  if (c !== null) {
    return { dps: c / 100, source: 'model', detail: `reit_model_forecasts.dpu ${modelFy || ''} (cents/100)`.trim() };
  }
  const d = num(dpsFy26);
  if (d !== null) {
    return { dps: d, source: 'stocks_dps_fy26', detail: 'stocks.dps_fy26 (dollars)' };
  }
  const t = trailing && num(trailing.total);
  if (t !== null && t !== undefined && trailing.n > 0) {
    return { dps: t, source: 'trailing_12m', detail: `distributions, trailing 12m, ${trailing.n} payment(s)` };
  }
  return { dps: null, source: null, detail: null };
}

/** SPEC §3.1 listed — forward annual income, DOLLARS. null in => null out. */
function listedIncome(units, dps) {
  const u = num(units), d = num(dps);
  if (u === null || d === null) return null;
  return u * d;
}

/**
 * SPEC §3.1 property — (gross rent - operating costs - interest) x ownership_pct.
 *
 * Figures are entered at 100% of the property (see the migration comment) and
 * apportioned here. `depreciation` and `capital_works` are NON-CASH and are
 * deliberately excluded — they belong to the tax overlay (SPEC §4.4).
 *
 * Worked example (a full-year period, 100% owned):
 *   gross_rent 52,000; agent_fees 3,640; rates 2,400; insurance 1,500;
 *   strata 0; maintenance 2,000; other 460; interest_paid 28,000;
 *   ownership_pct 1
 *   -> operating costs = 3640+2400+1500+0+2000+460 = 10,000
 *   -> (52,000 - 10,000 - 28,000) x 1 = 14,000
 *
 * Half-owned, same property: ownership_pct 0.5 -> 7,000.
 */
function propertyIncome(cf, ownershipPct) {
  if (!cf) return null;
  const own = num(ownershipPct);
  if (own === null) return null;
  const rent = num(cf.gross_rent) || 0;
  const opex = (num(cf.agent_fees) || 0) + (num(cf.rates) || 0) + (num(cf.insurance) || 0) +
               (num(cf.strata) || 0) + (num(cf.maintenance) || 0) + (num(cf.other_costs) || 0);
  const interest = num(cf.interest_paid) || 0;
  return (rent - opex - interest) * own;
}

/**
 * Annualise a cashflow period to a forward 12-month run rate.
 *   factor = 365 / days_in_period, days measured inclusive of both endpoints.
 *
 * Worked examples:
 *   annualisationFactor('2025-07-01','2026-06-30') -> {days:365, factor:1.000000}
 *   annualisationFactor('2026-01-01','2026-06-30') -> {days:181, factor:2.016575}
 *   annualisationFactor('2026-06-30','2026-01-01') -> {factor:1, usable:false}
 *
 * Returns factor 1 and usable:false when the period is unusable; the caller
 * then emits a null income rather than a wrong run rate.
 */
function annualisationFactor(periodStart, periodEnd) {
  const d = daysBetween(periodStart, periodEnd);
  if (d === null || d <= 0) return { factor: 1, days: null, usable: false };
  const days = d + 1;
  return { factor: 365 / days, days, usable: true };
}

/** SPEC §3.1 — yield. Returns null on a missing numerator or non-positive denominator. */
function ratio(income, denominator) {
  const i = num(income), d = num(denominator);
  if (i === null || d === null || d <= 0) return null;
  return i / d;
}

function round(n, dp) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const run = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  // as_of is resolved ONCE, here at the I/O boundary, and then threaded through
  // the pure functions — so a run can be reproduced by passing ?as_of=.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(q.as_of || '')
    ? q.as_of
    : new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10); // AEST day
  const fy = normFy(q.fy || currentFy(asOf));
  const includeClosed = q.include_closed === '1';

  const db = getDB();
  const warnings = [];

  try {
    // ── holdings ──────────────────────────────────────────────────────────────
    let hq = db.from('holdings')
      .select('id,ticker,asset_class,units,cost_base,adjusted_cost_base,brokerage,entry_date,account,source,is_open,property_id')
      .limit(5000);
    if (!includeClosed) hq = hq.eq('is_open', true);
    const { data: holdings, error: hErr } = await hq;
    if (hErr) throw new Error(`holdings read: ${hErr.message}`);

    const tickers = [...new Set((holdings || []).map(h => String(h.ticker || '').toUpperCase()).filter(Boolean))];

    // ── source 1: current-model forecast DPU (CENTS) for the current FY ───────
    const modelDpu = {};   // ticker -> { cents, fy }
    if (tickers.length) {
      const { data: models, error: mErr } = await db.from('reit_models')
        .select('ticker,model_version').eq('is_current', true).in('ticker', tickers);
      if (mErr) warnings.push(`reit_models read failed: ${mErr.message}`);
      const currentVersion = {};
      (models || []).forEach(m => { currentVersion[String(m.ticker).toUpperCase()] = m.model_version; });

      const modelTickers = Object.keys(currentVersion);
      if (modelTickers.length) {
        const { data: fc, error: fErr } = await db.from('reit_model_forecasts')
          .select('ticker,model_version,fy,dpu').in('ticker', modelTickers).limit(5000);
        if (fErr) warnings.push(`reit_model_forecasts read failed: ${fErr.message}`);
        (fc || []).forEach(f => {
          const tk = String(f.ticker).toUpperCase();
          if (f.model_version !== currentVersion[tk]) return;   // not the current model
          if (normFy(f.fy) !== fy) return;                      // not the current FY
          if (num(f.dpu) === null) return;
          modelDpu[tk] = { cents: num(f.dpu), fy: f.fy };
        });
      }
    }

    // ── source 2: stocks.dps_fy26 (DOLLARS), plus names/classes ──────────────
    const stockMap = {};
    if (tickers.length) {
      const { data: stocks, error: sErr } = await db.from('stocks')
        .select('ticker,name,asset_class,reit_subclass,landlord_sector,dps_fy26').in('ticker', tickers);
      if (sErr) warnings.push(`stocks read failed: ${sErr.message}`);
      (stocks || []).forEach(s => { stockMap[String(s.ticker).toUpperCase()] = s; });
    }

    // ── source 3: trailing 12m actual distributions (DOLLARS) ────────────────
    const trailing = {};  // ticker -> { total, n, first, last }
    const franking = {};  // ticker -> weighted franking_pct (informational, for Agent B)
    if (tickers.length) {
      const from = addDays(asOf, -TRAILING_DAYS);
      const { data: dists, error: dErr } = await db.from('distributions')
        .select('ticker,ex_date,amount_per_unit,franking_pct')
        .in('ticker', tickers).gt('ex_date', from).lte('ex_date', asOf).limit(5000);
      if (dErr) warnings.push(`distributions read failed: ${dErr.message}`);
      (dists || []).forEach(d => {
        const tk = String(d.ticker).toUpperCase();
        const amt = num(d.amount_per_unit);
        if (amt === null) return;
        const t = trailing[tk] = trailing[tk] || { total: 0, n: 0, first: d.ex_date, last: d.ex_date };
        t.total += amt; t.n += 1;
        if (d.ex_date < t.first) t.first = d.ex_date;
        if (d.ex_date > t.last) t.last = d.ex_date;
        const f = franking[tk] = franking[tk] || { weighted: 0, total: 0 };
        f.weighted += amt * (num(d.franking_pct) || 0);
        f.total += amt;
      });
    }

    // ── last price: `prices` first, `reit_prices` as fallback ────────────────
    const priceMap = {};  // ticker -> { price, date, src }
    if (tickers.length) {
      const from = addDays(asOf, -PRICE_LOOKBACK_DAYS);
      const { data: px, error: pErr } = await db.from('prices')
        .select('ticker,market_date,close')
        .in('ticker', tickers).gte('market_date', from).lte('market_date', asOf)
        .order('market_date', { ascending: false }).limit(5000);
      if (pErr) warnings.push(`prices read failed: ${pErr.message}`);
      (px || []).forEach(p => {
        const tk = String(p.ticker).toUpperCase();
        if (priceMap[tk]) return;   // ordered desc — first seen is the latest
        const c = num(p.close);
        if (c !== null) priceMap[tk] = { price: c, date: p.market_date, src: 'prices' };
      });

      const missing = tickers.filter(t => !priceMap[t]);
      if (missing.length) {
        const { data: rp } = await db.from('reit_prices')
          .select('ticker,last_price,price_date').in('ticker', missing);
        (rp || []).forEach(p => {
          const c = num(p.last_price);
          if (c !== null) priceMap[String(p.ticker).toUpperCase()] = { price: c, date: p.price_date, src: 'reit_prices' };
        });
      }
    }

    // ── property ─────────────────────────────────────────────────────────────
    // These tables arrive with this agent's migration. If the migration has not
    // been applied yet the reads fail; that is reported, not swallowed as zero.
    let props = [], vals = [], loans = [], cfs = [];
    {
      const { data, error } = await db.from('property_holdings').select('*').limit(1000);
      if (error) warnings.push(`property_holdings read failed (migration not applied?): ${error.message}`);
      props = data || [];
    }
    if (props.length) {
      const ids = props.map(p => p.id);
      const [{ data: v }, { data: l }, { data: c }] = await Promise.all([
        db.from('property_valuations').select('*').in('property_id', ids).lte('valuation_date', asOf)
          .order('valuation_date', { ascending: false }).limit(2000),
        db.from('property_loans').select('*').in('property_id', ids).lte('balance_date', asOf)
          .order('balance_date', { ascending: false }).limit(2000),
        db.from('property_cashflows').select('*').in('property_id', ids).lte('period_end', asOf)
          .order('period_end', { ascending: false }).limit(2000),
      ]);
      vals = v || []; loans = l || []; cfs = c || [];
    }

    const rows = [];

    // ── LISTED ───────────────────────────────────────────────────────────────
    for (const h of (holdings || [])) {
      const tk = String(h.ticker || '').toUpperCase();
      const s = stockMap[tk];
      const md = modelDpu[tk];
      const fwd = forwardDps({
        modelDpuCents: md ? md.cents : null,
        modelFy: md ? md.fy : null,
        dpsFy26: s ? s.dps_fy26 : null,
        trailing: trailing[tk] || null,
      });

      const units = num(h.units);
      const costBase = num(h.cost_base);
      const brokerage = num(h.brokerage) || 0;
      const px = priceMap[tk] || null;

      const cashIncome = listedIncome(units, fwd.dps);
      const equityInvested = costBase === null ? null : costBase + brokerage;
      const equityValue = (units !== null && px) ? units * px.price : null;

      const fr = franking[tk];

      rows.push({
        kind: 'listed',
        key: tk,
        ticker: tk,
        property_id: h.property_id ?? null,
        holding_id: h.id,
        name: s ? s.name : null,
        asset_class: h.asset_class || (s ? s.asset_class : null) || null,
        reit_subclass: s ? s.reit_subclass : null,
        landlord_sector: s ? s.landlord_sector : null,
        is_open: h.is_open !== false,
        source: h.source || null,

        units,
        cost_base: costBase,                                   // DOLLARS, total
        adjusted_cost_base: num(h.adjusted_cost_base),         // DOLLARS, total
        brokerage,                                             // DOLLARS
        entry_date: h.entry_date || null,
        account: h.account || null,

        last_price: px ? px.price : null,                      // DOLLARS
        price_date: px ? px.date : null,
        price_source: px ? px.src : null,

        forward_dps: round(fwd.dps, 6),                        // DOLLARS per unit
        forward_source: fwd.source,                            // 'model'|'stocks_dps_fy26'|'trailing_12m'|null
        forward_source_detail: fwd.detail,
        forward_fy: fwd.source === 'model' ? (md ? md.fy : fy) : null,

        cash_income: round(cashIncome, 2),                     // DOLLARS, null if unknown
        equity_invested: round(equityInvested, 2),             // DOLLARS
        equity_value: round(equityValue, 2),                   // DOLLARS

        cash_yield_on_cost: round(ratio(cashIncome, equityInvested), 6),     // DECIMAL
        cash_yield_on_market: round(ratio(cashIncome, equityValue), 6),      // DECIMAL

        // pass-through for Agent B's tax engine (SPEC §4.2/§4.3)
        trailing_12m_dps: trailing[tk] ? round(trailing[tk].total, 6) : null,
        trailing_12m_payments: trailing[tk] ? trailing[tk].n : 0,
        franking_pct_trailing: fr && fr.total > 0 ? round(fr.weighted / fr.total, 6) : null,
      });

      if (fwd.source === 'trailing_12m') {
        warnings.push(`${tk}: no model and no stocks.dps_fy26 — forward income is a TRAILING ` +
          `12m actual (${trailing[tk].n} payment(s), ${trailing[tk].first}..${trailing[tk].last}) used as a forward estimate.`);
      }
      if (fwd.dps === null) {
        warnings.push(`${tk}: no forward distribution from any source — cash_income is null (renders as an em dash, not 0).`);
      }
      if (!px) warnings.push(`${tk}: no close in \`prices\` within ${PRICE_LOOKBACK_DAYS}d of ${asOf} and no reit_prices row — yield_on_market is null.`);
      if (!h.asset_class) warnings.push(`${tk}: holdings.asset_class is null — the tax engine will fall back to a default profile (SPEC §4.3).`);
    }

    // ── PROPERTY ─────────────────────────────────────────────────────────────
    for (const p of props) {
      if (!includeClosed && p.is_open === false) continue;

      const own = num(p.ownership_pct);
      const val = vals.find(v => v.property_id === p.id) || null;                 // latest <= asOf
      const loan = loans.find(l => l.property_id === p.id) || null;               // latest <= asOf
      const propLoans = loans.filter(l => l.property_id === p.id);
      // SPEC §3.1 needs "loan drawn at purchase". §2.3 defines no such column, so
      // the OLDEST property_loans row is used as a proxy. Flagged per row.
      const firstLoan = propLoans.length ? propLoans[propLoans.length - 1] : null;
      const loanAtPurchase = firstLoan ? num(firstLoan.balance) : null;

      const cf = cfs.find(c => c.property_id === p.id) || null;                   // most recent period
      const ann = cf ? annualisationFactor(cf.period_start, cf.period_end) : { factor: 1, days: null, usable: false };
      const periodIncome = propertyIncome(cf, own);
      const cashIncome = (periodIncome === null || !ann.usable) ? null : periodIncome * ann.factor;

      // equity invested = purchase_price x own + acquisition_costs + capex - loan drawn at purchase
      const pp = num(p.purchase_price);
      const equityInvested = (pp === null || own === null) ? null
        : pp * own + (num(p.acquisition_costs) || 0) + (num(p.capex_to_date) || 0) - (loanAtPurchase || 0);

      // equity value = (latest valuation x own) - current loan balance
      const equityValue = (val && own !== null && num(val.valuation) !== null)
        ? num(val.valuation) * own - (loan ? (num(loan.balance) || 0) : 0)
        : null;

      const key = `property:${p.id}`;
      rows.push({
        kind: 'property',
        key,
        ticker: null,
        property_id: p.id,
        holding_id: null,
        name: p.name,
        asset_class: 'property',
        reit_subclass: null,
        landlord_sector: null,
        is_open: p.is_open !== false,
        source: 'property',

        address: p.address || null,
        property_type: p.property_type || null,
        ownership_pct: own,                                    // DECIMAL fraction
        purchase_price: pp,
        purchase_date: p.purchase_date || null,
        acquisition_costs: num(p.acquisition_costs),
        capex_to_date: num(p.capex_to_date),

        valuation: val ? num(val.valuation) : null,            // DOLLARS, 100%
        valuation_date: val ? val.valuation_date : null,
        valuation_is_estimate: val ? val.is_estimate !== false : null,
        loan_balance: loan ? num(loan.balance) : null,         // DOLLARS
        loan_balance_date: loan ? loan.balance_date : null,
        loan_interest_rate: loan ? num(loan.interest_rate) : null,  // DECIMAL
        loan_at_purchase: loanAtPurchase,
        loan_at_purchase_is_proxy: loanAtPurchase !== null,    // see comment above

        period_start: cf ? cf.period_start : null,
        period_end: cf ? cf.period_end : null,
        period_days: ann.days,
        annualisation_factor: round(ann.factor, 6),
        gross_rent_period: cf ? num(cf.gross_rent) : null,
        operating_costs_period: cf ? round(
          (num(cf.agent_fees) || 0) + (num(cf.rates) || 0) + (num(cf.insurance) || 0) +
          (num(cf.strata) || 0) + (num(cf.maintenance) || 0) + (num(cf.other_costs) || 0), 2) : null,
        interest_paid_period: cf ? num(cf.interest_paid) : null,

        forward_dps: null,
        forward_source: cf ? 'property_cashflows' : null,
        forward_source_detail: cf
          ? `property_cashflows ${cf.period_start}..${cf.period_end}, annualised x${round(ann.factor, 4)}`
          : null,
        forward_fy: null,

        cash_income: round(cashIncome, 2),                     // DOLLARS
        equity_invested: round(equityInvested, 2),             // DOLLARS
        equity_value: round(equityValue, 2),                   // DOLLARS

        cash_yield_on_cost: round(ratio(cashIncome, equityInvested), 6),
        cash_yield_on_market: round(ratio(cashIncome, equityValue), 6),

        // NON-CASH, annualised, for Agent B's §4.4 property tax path only.
        // These reduce taxable income without reducing cash.
        depreciation_annual: cf && ann.usable ? round((num(cf.depreciation) || 0) * ann.factor * (own || 0), 2) : null,
        capital_works_annual: cf && ann.usable ? round((num(cf.capital_works) || 0) * ann.factor * (own || 0), 2) : null,

        trailing_12m_dps: null,
        trailing_12m_payments: 0,
        franking_pct_trailing: 0,   // property rent carries no franking credits
      });

      if (!cf) warnings.push(`${key} (${p.name}): no property_cashflows row — cash_income is null.`);
      if (cf && !ann.usable) warnings.push(`${key} (${p.name}): period_start/period_end unusable — cannot annualise.`);
      if (!val) warnings.push(`${key} (${p.name}): no property_valuations row on or before ${asOf} — equity value and yield_on_market are null.`);
      if (!loan) warnings.push(`${key} (${p.name}): no property_loans row on or before ${asOf} — equity treated as ungeared.`);
      if (loanAtPurchase !== null) warnings.push(`${key} (${p.name}): "loan drawn at purchase" is a PROXY (oldest property_loans balance, ${firstLoan.balance_date}) — SPEC §2.3 defines no original-drawn column.`);
      if (equityInvested !== null && equityInvested <= 0) warnings.push(`${key} (${p.name}): equity invested is ${round(equityInvested, 2)} (loan at purchase exceeded the cash outlay) — yield_on_cost is null, not infinite. Check acquisition_costs/capex_to_date and the loan-at-purchase proxy.`);
    }

    // ── PORTFOLIO TOTAL (SPEC §3.1) ──────────────────────────────────────────
    // Sums NON-NULL income only, and says how much of the book that covers.
    // A total that quietly treats a missing forecast as zero is the exact bug
    // SPEC §3.3 item 4 exists to prevent.
    const open = rows.filter(r => r.is_open);
    const withIncome = open.filter(r => r.cash_income !== null);
    const missingIncome = open.filter(r => r.cash_income === null).map(r => r.key);

    const totalIncome = withIncome.reduce((a, r) => a + r.cash_income, 0);
    const costRows = withIncome.filter(r => r.equity_invested !== null && r.equity_invested > 0);
    const mktRows = withIncome.filter(r => r.equity_value !== null && r.equity_value > 0);

    const totalCost = costRows.reduce((a, r) => a + r.equity_invested, 0);
    const totalMkt = mktRows.reduce((a, r) => a + r.equity_value, 0);
    const incomeOnCostRows = costRows.reduce((a, r) => a + r.cash_income, 0);
    const incomeOnMktRows = mktRows.reduce((a, r) => a + r.cash_income, 0);

    const total = {
      cash_income: round(totalIncome, 2),                       // DOLLARS
      equity_invested: round(open.reduce((a, r) => a + (r.equity_invested || 0), 0), 2),
      equity_value: round(open.reduce((a, r) => a + (r.equity_value || 0), 0), 2),
      // Yields are computed only over the rows that have BOTH numerator and
      // denominator, so the ratio is internally consistent. The *_basis figures
      // say which slice of the book that was.
      cash_yield_on_cost: round(ratio(incomeOnCostRows, totalCost), 6),
      cash_yield_on_cost_basis: round(totalCost, 2),
      cash_yield_on_market: round(ratio(incomeOnMktRows, totalMkt), 6),
      cash_yield_on_market_basis: round(totalMkt, 2),
      holdings_open: open.length,
      holdings_with_income: withIncome.length,
      holdings_missing_income: missingIncome,
      income_complete: missingIncome.length === 0 && open.length > 0,
      listed_income: round(withIncome.filter(r => r.kind === 'listed').reduce((a, r) => a + r.cash_income, 0), 2),
      property_income: round(withIncome.filter(r => r.kind === 'property').reduce((a, r) => a + r.cash_income, 0), 2),
    };

    if (missingIncome.length) {
      warnings.push(`portfolio total EXCLUDES ${missingIncome.length} open holding(s) with no forward income ` +
        `(${missingIncome.join(', ')}) — the headline is understated, not wrong. Show income_complete=false in the UI.`);
    }
    if (open.some(r => r.kind === 'property')) {
      warnings.push('SPEC §3.2: property yield-on-equity is LEVERAGED, a listed yield is not. ' +
        'Comparable as cash return, not as risk. This note must be displayed on the Income page.');
    }

    // Flat map for Agent B's tax engine: key -> pre-tax cash income (DOLLARS).
    const cashIncomeByKey = {};
    rows.forEach(r => { cashIncomeByKey[r.key] = r.cash_income; });

    return json(200, {
      ok: true,
      engine: ENGINE_VERSION,
      as_of: asOf,
      fy,
      basis: 'pre_tax',
      units: { money: 'AUD dollars', rates: 'decimal fraction' },
      holdings: rows,
      total,
      cash_income_by_key: cashIncomeByKey,
      warnings,
    });

  } catch (err) {
    console.error('income-rollup failed:', err.message);
    return json(500, { error: err.message, as_of: asOf, engine: ENGINE_VERSION });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = run;
// Pure helpers exported for Agent B / Agent C and for hand-checking.
exports.currentFy = currentFy;
exports.normFy = normFy;
exports.forwardDps = forwardDps;
exports.listedIncome = listedIncome;
exports.propertyIncome = propertyIncome;
exports.annualisationFactor = annualisationFactor;
exports.ratio = ratio;
exports.ENGINE_VERSION = ENGINE_VERSION;
