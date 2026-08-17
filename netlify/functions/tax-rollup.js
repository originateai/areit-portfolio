// netlify/functions/tax-rollup.js
// ============================================================================
// Applies the post-tax overlay (SPEC.md §4) to the whole portfolio.
//
// It does the I/O; scripts/tax-engine.js does the arithmetic. Nothing in this
// file computes tax — if you find yourself typing a rate here, stop: rates live
// in public.tax_settings (SPEC §4.1) and the maths lives in the engine.
//
// INPUT — per-holding PRE-TAX income, from Agent A's income-rollup.js, keyed by
// ticker (listed) or property_id (direct property). Three ways in, tried in
// order:
//   1. POST body { income: <income-rollup payload> }  — preferred, no round trip
//   2. POST body { holdings: [...] }                  — same thing, bare array
//   3. GET/POST with neither: this function calls /.netlify/functions/income-rollup
// If none of those yields data it returns an error. It NEVER invents a holding
// or an income figure (SPEC §9).
//
// OUTPUT — per holding and for the portfolio, the SPEC §4.5 block:
//   cash_income, franking_credits, gross_income, tax_payable, post_tax_income,
//   cash/gross/post_tax yield on cost AND on market  (six figures),
//   tax_deferred_pct, franked_pct,
// plus the hurdle test: post_tax_yield >= 7% and post_tax_irr >= 12%.
//
// UNITS: dollars everywhere, rates as decimals (SPEC §1.1-1.3).
// EVERY figure returned is an ESTIMATE — `disclaimer` and `is_estimate` travel
// with the payload so the UI can label it (SPEC §1.6).
// ============================================================================

const { getSupabase } = require('./_shared.js');
const TAX = require('../../scripts/tax-engine.js');

const FN_VERSION = 'tax-rollup-1.0.0';

// ── helpers ─────────────────────────────────────────────────────────────────

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const first = (...vals) => { for (const v of vals) { const n = num(v); if (n !== null) return n; } return null; };

/** Australian financial year ending 30 June: 2026-08-17 -> FY2027. */
function financialYear(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? y + 1 : y; // month 6 = July
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── 1. tax settings (SPEC §4.1) ─────────────────────────────────────────────
// The latest row effective on or before as_of. No row => hard error. There is
// no default marginal rate in this codebase and there must never be one.
async function loadTaxSettings(db, asOf) {
  const { data, error } = await db
    .from('tax_settings').select('*')
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .limit(1);
  if (error) throw new Error(`tax_settings unreadable (${error.code || ''} ${error.message}). Run supabase/migrations/*_tax_overlay.sql first — SPEC §1.7.`);
  if (!data || !data.length) throw new Error('tax_settings is empty. Seed it (the tax_overlay migration inserts the default row). The engine refuses to assume a tax rate — SPEC §4.1.');
  return data[0];
}

// ── 2. the pre-tax income rollup (Agent A) ──────────────────────────────────
function baseUrl(event) {
  if (process.env.URL) return process.env.URL;
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  const host = event && event.headers && (event.headers.host || event.headers.Host);
  return host ? `https://${host}` : null;
}

async function fetchIncomeRollup(event) {
  const base = baseUrl(event);
  if (!base) throw new Error('Cannot resolve the site URL to call income-rollup. POST the payload as { income: ... } instead.');
  const url = `${base}/.netlify/functions/income-rollup`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`income-rollup returned ${res.status}. Deploy Agent A's income-rollup.js, or POST { income: ... }.`);
  return res.json();
}

/** Agent A's payload shape is not fixed yet, so accept any of the plausible ones. */
function collectItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const out = [];
  ['holdings', 'items', 'listed', 'positions', 'rows', 'property', 'properties', 'property_holdings']
    .forEach(k => { if (Array.isArray(payload[k])) out.push(...payload[k]); });
  return out;
}

/** One normalised holding, or null with a reason if it cannot be taxed honestly. */
function normaliseItem(raw) {
  const propertyId = raw.property_id ?? raw.propertyId ?? (raw.kind === 'property' ? raw.id : null);
  const ticker = raw.ticker ? String(raw.ticker).toUpperCase().trim() : null;
  const isProperty = propertyId != null || raw.asset_class === 'property' || raw.kind === 'property';

  const cash = first(raw.cash_income, raw.forward_annual_income, raw.forward_income,
                     raw.annual_income, raw.income, raw.pre_tax_income);

  const equityInvested = first(raw.equity_invested, raw.equity_cost, raw.cost_basis,
    (num(raw.cost_base) !== null ? num(raw.cost_base) + (num(raw.brokerage) ?? 0) : null));
  const equityValue = first(raw.equity_value, raw.market_value, raw.value,
    (num(raw.units) !== null && num(raw.price) !== null ? num(raw.units) * num(raw.price) : null));

  return {
    key: isProperty ? `property:${propertyId ?? raw.name ?? 'unknown'}` : `ticker:${ticker || 'unknown'}`,
    ticker: isProperty ? null : ticker,
    property_id: isProperty ? propertyId : null,
    name: raw.name ?? null,
    asset_class: (raw.asset_class || (isProperty ? 'property' : null) || '').toLowerCase() || null,
    is_property: isProperty,
    units: num(raw.units),
    cash_income: cash,
    equity_invested: equityInvested,
    equity_value: equityValue,
    income_source: raw.income_source ?? raw.source ?? null,   // SPEC §3.3 precedence tag
    post_tax_irr: num(raw.post_tax_irr ?? raw.irr_post_tax),
    // property cashflow detail, if Agent A carries it forward
    property_cashflow: isProperty ? {
      gross_rent: num(raw.gross_rent),
      operating_costs: first(raw.operating_costs, raw.opex),
      agent_fees: num(raw.agent_fees), rates: num(raw.rates), insurance: num(raw.insurance),
      strata: num(raw.strata), maintenance: num(raw.maintenance), other_costs: num(raw.other_costs),
      interest_paid: first(raw.interest_paid, raw.interest),
      depreciation: num(raw.depreciation), capital_works: num(raw.capital_works),
      ownership_pct: num(raw.ownership_pct)
    } : null,
    raw_components: raw.components || null
  };
}

// ── 3. component splits (SPEC §4.2), actual beats default (§4.3) ────────────
async function loadComponents(db, tickers, fy) {
  if (!tickers.length) return { byTicker: {}, warnings: [] };
  const { data, error } = await db
    .from('distribution_components').select('*')
    .in('ticker', tickers);
  if (error) {
    return { byTicker: {}, warnings: [`distribution_components unreadable (${error.code || ''} ${error.message}) — every holding falls back to its SPEC §4.3 asset-class default.`] };
  }
  const byTicker = {};
  (data || []).forEach(r => {
    const t = String(r.ticker).toUpperCase().trim();
    (byTicker[t] = byTicker[t] || []).push(r);
  });
  // Pick one coherent group per ticker: prefer a real tax statement, then the
  // most recent financial year, then a single `basis` so per-unit and total
  // rows are never summed together.
  const picked = {};
  Object.entries(byTicker).forEach(([t, rows]) => {
    const usable = rows.filter(r => (num(r.financial_year) ?? 0) <= fy);
    const pool = usable.length ? usable : rows;
    const statements = pool.filter(r => r.source === 'statement' || r.is_estimate === false);
    const candidates = statements.length ? statements : pool;
    const bestFy = Math.max(...candidates.map(r => num(r.financial_year) ?? 0));
    const sameFy = candidates.filter(r => (num(r.financial_year) ?? 0) === bestFy);
    const basis = (sameFy.find(r => r.basis === 'total') || sameFy[0]).basis || 'per_unit';
    picked[t] = sameFy.filter(r => (r.basis || 'per_unit') === basis);
  });
  return { byTicker: picked, warnings: [] };
}

// ── 4. trailing property cashflows, when Agent A did not carry them ─────────
async function loadPropertyCashflows(db, propertyIds, asOf) {
  if (!propertyIds.length) return { byId: {}, warnings: [] };
  const from = new Date(`${asOf}T00:00:00Z`);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const fromIso = from.toISOString().slice(0, 10);
  const { data, error } = await db
    .from('property_cashflows').select('*')
    .in('property_id', propertyIds)
    .gte('period_end', fromIso);
  if (error) {
    return { byId: {}, warnings: [`property_cashflows unavailable (${error.code || ''} ${error.message}) — depreciation and capital works are treated as zero, which UNDERSTATES post-tax property yield (SPEC §4.4).`] };
  }
  const byId = {};
  (data || []).forEach(r => {
    const k = String(r.property_id);
    const t = byId[k] || (byId[k] = { gross_rent: 0, operating_costs: 0, interest_paid: 0, depreciation: 0, capital_works: 0, rows: 0 });
    t.gross_rent += num(r.gross_rent) ?? 0;
    t.operating_costs += (num(r.agent_fees) ?? 0) + (num(r.rates) ?? 0) + (num(r.insurance) ?? 0) +
                         (num(r.strata) ?? 0) + (num(r.maintenance) ?? 0) + (num(r.other_costs) ?? 0);
    t.interest_paid += num(r.interest_paid) ?? 0;
    t.depreciation += num(r.depreciation) ?? 0;
    t.capital_works += num(r.capital_works) ?? 0;
    t.rows += 1;
  });
  return { byId, warnings: [] };
}

// ── 5. post-tax IRR, if Agent C has produced one ────────────────────────────
async function loadPostTaxIrr(db, tickers) {
  if (!tickers.length) return { byTicker: {}, warnings: [] };
  const { data, error } = await db
    .from('valuation_runs').select('ticker,irr_post_tax,as_of')
    .in('ticker', tickers)
    .order('as_of', { ascending: false });
  if (error) {
    return { byTicker: {}, warnings: [`valuation_runs unavailable (${error.code || ''} ${error.message}) — post-tax IRR is null, so the IRR half of the hurdle is INCOMPLETE rather than failed.`] };
  }
  const byTicker = {};
  (data || []).forEach(r => {
    const t = String(r.ticker).toUpperCase().trim();
    if (byTicker[t] === undefined && num(r.irr_post_tax) !== null) byTicker[t] = num(r.irr_post_tax);
  });
  return { byTicker, warnings: [] };
}

// ── 6. one holding through the engine ───────────────────────────────────────
function taxOneHolding(item, ctx) {
  const { settings, components, propertyCashflows } = ctx;
  const warnings = [];

  // -- property (SPEC §4.4) --------------------------------------------------
  if (item.is_property) {
    const carried = item.property_cashflow || {};
    const hasCarried = num(carried.gross_rent) !== null;
    const trailing = propertyCashflows[String(item.property_id)] || null;
    let cf, basis;

    if (hasCarried) {
      cf = { kind: 'property', ...carried, ownership_pct: carried.ownership_pct ?? 1 };
      basis = 'forward (income-rollup)';
    } else if (trailing) {
      cf = { kind: 'property', ...trailing, ownership_pct: carried.ownership_pct ?? 1 };
      basis = 'trailing 12m (property_cashflows)';
      warnings.push('property taxed off TRAILING 12m cashflows — the income rollup did not carry forward rent/interest/depreciation detail.');
    } else if (item.cash_income !== null) {
      // Last resort: tax the net cash with no non-cash deductions. Flagged,
      // because it understates the post-tax yield (SPEC §4.4 is the whole point).
      cf = { kind: 'property', gross_rent: item.cash_income, operating_costs: 0, interest_paid: 0,
             depreciation: 0, capital_works: 0, ownership_pct: 1 };
      basis = 'net cash only — NO depreciation/capital works';
      warnings.push('no property cashflow detail found: depreciation and capital works treated as ZERO, so post-tax property yield is UNDERSTATED (SPEC §4.4).');
    } else {
      return { skipped: true, reason: 'no cash income and no property cashflows' };
    }

    // Only the last-resort branch is an ASSUMPTION; real cashflows are not.
    const profile = {
      ...TAX.defaultProfile('property'),
      is_assumption: !hasCarried && !trailing,
      source: `property:${basis}`,
      assumption_note: (!hasCarried && !trailing)
        ? 'No depreciation or capital works available — post-tax property yield understated (SPEC §4.4).'
        : null
    };
    const adjusted = TAX.taxAdjust(cf, profile, settings);
    return { adjusted, profile, basis, warnings };
  }

  // -- listed (SPEC §4.2 / §4.3) --------------------------------------------
  if (item.cash_income === null) {
    return { skipped: true, reason: 'no forward income (SPEC §3.3 precedence exhausted — renders as —, never 0)' };
  }
  const rows = item.raw_components || (item.ticker ? components[item.ticker] : null);
  let profile = TAX.profileFromComponents(rows, settings);
  let basis;
  if (profile) {
    basis = `actual components (${profile.source})`;
    warnings.push(...(profile.warnings || []));
  } else {
    profile = TAX.defaultProfile(item.asset_class);
    basis = `ASSUMED default for asset_class '${item.asset_class || 'unknown'}' (SPEC §4.3)`;
    if (!item.asset_class) warnings.push('holding has no asset_class — defaulted to 100% unfranked (worst case). Populate holdings.asset_class / stocks.asset_class.');
  }
  const adjusted = TAX.taxAdjust(item.cash_income, profile, settings);
  return { adjusted, profile, basis, warnings };
}

// ── handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    let body = {};
    if (event && event.body) { try { body = JSON.parse(event.body); } catch (_) { body = {}; } }
    const qs = (event && event.queryStringParameters) || {};

    const asOf = body.as_of || qs.as_of || new Date().toISOString().slice(0, 10);
    const fy = financialYear(asOf);
    const targets = {
      yield_target: num(body.yield_target ?? qs.yield_target) ?? TAX.DEFAULT_HURDLES.yield_target,
      irr_target: num(body.irr_target ?? qs.irr_target) ?? TAX.DEFAULT_HURDLES.irr_target
    };

    const db = getSupabase();
    const warnings = [];

    // settings first — everything else is pointless without a rate
    const settingsRow = await loadTaxSettings(db, asOf);
    const settings = TAX.resolveSettings(settingsRow);
    warnings.push(...settings.warnings);

    // pre-tax income
    let incomePayload = body.income || (body.holdings ? { holdings: body.holdings } : null);
    let incomeSource = 'request body';
    if (!incomePayload) { incomePayload = await fetchIncomeRollup(event); incomeSource = 'income-rollup function'; }

    const items = collectItems(incomePayload).map(normaliseItem);
    if (!items.length) {
      return json(200, {
        as_of: asOf, financial_year: fy, function_version: FN_VERSION, engine_version: TAX.ENGINE_VERSION,
        income_source: incomeSource, holdings: [], totals: null, hurdle: null,
        warnings: warnings.concat('no holdings returned by the income rollup — nothing to tax. Populate `holdings` (SPEC §2.1).'),
        disclaimer: TAX.DISCLAIMER
      });
    }

    const tickers = [...new Set(items.filter(i => i.ticker).map(i => i.ticker))];
    const propertyIds = [...new Set(items.filter(i => i.is_property && i.property_id != null).map(i => String(i.property_id)))];

    const [comp, props, irrs] = await Promise.all([
      loadComponents(db, tickers, fy),
      loadPropertyCashflows(db, propertyIds, asOf),
      loadPostTaxIrr(db, tickers)
    ]);
    warnings.push(...comp.warnings, ...props.warnings, ...irrs.warnings);

    const ctx = { settings, components: comp.byTicker, propertyCashflows: props.byId };

    const holdings = [];
    const adjustedList = [];
    const skipped = [];

    for (const item of items) {
      const res = taxOneHolding(item, ctx);
      if (res.skipped) {
        skipped.push({ key: item.key, ticker: item.ticker, property_id: item.property_id, reason: res.reason });
        holdings.push({
          key: item.key, ticker: item.ticker, property_id: item.property_id, name: item.name,
          asset_class: item.asset_class, excluded: true, exclusion_reason: res.reason,
          cash_income: null, franking_credits: null, gross_income: null, tax_payable: null, post_tax_income: null,
          cash_yield_on_cost: null, gross_yield_on_cost: null, post_tax_yield_on_cost: null,
          cash_yield_on_market: null, gross_yield_on_market: null, post_tax_yield_on_market: null,
          tax_deferred_pct: null, franked_pct: null, hurdle: null, disclaimer: TAX.DISCLAIMER
        });
        continue;
      }
      const { adjusted, profile, basis } = res;
      adjustedList.push(adjusted);

      const lenses = TAX.yieldLenses(adjusted, {
        equity_invested: item.equity_invested, equity_value: item.equity_value
      });
      const irr = item.post_tax_irr !== null ? item.post_tax_irr : (item.ticker ? (irrs.byTicker[item.ticker] ?? null) : null);
      const hurdle = TAX.hurdleTest(
        { post_tax_yield: lenses.post_tax_yield_on_market ?? lenses.post_tax_yield_on_cost, post_tax_irr: irr },
        targets
      );

      holdings.push({
        key: item.key, ticker: item.ticker, property_id: item.property_id, name: item.name,
        asset_class: item.asset_class, excluded: false,
        units: item.units, income_source: item.income_source,

        // ── SPEC §4.5 block ──────────────────────────────────────────────
        ...lenses,

        // ── how the tax was arrived at ───────────────────────────────────
        tax_basis: basis,
        tax_profile: {
          source: profile.source, is_assumption: profile.is_assumption !== false,
          note: profile.assumption_note || null,
          franked: profile.franked ?? null, unfranked: profile.unfranked ?? null,
          interest: profile.interest ?? null, tax_deferred: profile.tax_deferred ?? null,
          cgt_concession: profile.cgt_concession ?? null, foreign: profile.foreign ?? null,
          franking_level: profile.franking_level ?? null
        },
        tax_detail: {
          taxable_income: adjusted.taxable_income,
          tax_on_income: adjusted.tax_on_income,
          offsets_applied: adjusted.offsets_applied,
          credits_wasted: adjusted.credits_wasted,
          deferred_cgt_tax: adjusted.deferred.deferred_cgt_tax,
          cost_base_reduction: adjusted.deferred.cost_base_reduction,
          cgt_discount_applied: adjusted.deferred.cgt_discount_applied,
          effective_tax_rate_on_cash: adjusted.effective_tax_rate_on_cash,
          deferral_note: adjusted.deferred.note
        },
        post_tax_irr: irr,
        hurdle,
        hurdle_denominator: lenses.post_tax_yield_on_market !== null ? 'market' : 'cost',
        warnings: res.warnings.concat(adjusted.warnings || []),
        disclaimer: TAX.DISCLAIMER
      });
    }

    // ── portfolio totals — sum the dollars, then divide once ────────────────
    const totals = TAX.sumAdjusted(adjustedList);
    const included = holdings.filter(h => !h.excluded);
    const sumDen = key => {
      const vals = included.map(h => num(h[key])).filter(v => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const totalCost = sumDen('equity_invested');
    const totalMarket = sumDen('equity_value');
    const missingCost = included.filter(h => num(h.equity_invested) === null).length;
    const missingMarket = included.filter(h => num(h.equity_value) === null).length;
    if (missingCost) warnings.push(`${missingCost} holding(s) have no equity_invested — portfolio yield-on-cost is computed over the remainder only.`);
    if (missingMarket) warnings.push(`${missingMarket} holding(s) have no equity_value — portfolio yield-on-market is computed over the remainder only.`);

    const portfolioLenses = TAX.yieldLenses(totals, { equity_invested: totalCost, equity_value: totalMarket });

    // Portfolio post-tax IRR: only meaningful if every holding has one. A
    // value-weighted average of IRRs is an APPROXIMATION, not an IRR, and is
    // labelled as such — the real solve belongs to Agent C (SPEC §5.3).
    const withIrr = included.filter(h => num(h.post_tax_irr) !== null && num(h.equity_value) !== null);
    const irrWeight = withIrr.reduce((a, h) => a + num(h.equity_value), 0);
    const irrCoverage = totalMarket && totalMarket > 0 ? irrWeight / totalMarket : 0;
    const irrApprox = irrCoverage >= 0.999 && irrWeight > 0
      ? withIrr.reduce((a, h) => a + num(h.post_tax_irr) * num(h.equity_value), 0) / irrWeight
      : null;
    if (irrApprox === null) {
      warnings.push(`portfolio post-tax IRR not computed: ${(irrCoverage * 100).toFixed(0)}% of market value has a post-tax IRR. Needs Agent C's valuation_runs for every holding — reported as INCOMPLETE, never as a fail.`);
    }

    const hurdleOnMarket = TAX.hurdleTest({ post_tax_yield: portfolioLenses.post_tax_yield_on_market, post_tax_irr: irrApprox }, targets);
    const hurdleOnCost = TAX.hurdleTest({ post_tax_yield: portfolioLenses.post_tax_yield_on_cost, post_tax_irr: irrApprox }, targets);

    return json(200, {
      as_of: asOf,
      financial_year: fy,
      function_version: FN_VERSION,
      engine_version: TAX.ENGINE_VERSION,
      income_source: incomeSource,
      tax_settings: {
        entity_type: settings.entity_type,
        marginal_rate: settings.marginal_rate,
        medicare_levy: settings.medicare_levy,
        effective_rate: settings.effective_rate,
        cgt_discount: settings.cgt_discount,
        cgt_effective_rate: settings.cgt_effective_rate,
        company_tax_rate: settings.company_tax_rate,
        effective_from: settings.effective_from
      },
      holdings,
      totals: {
        ...portfolioLenses,
        holdings_included: included.length,
        holdings_excluded: skipped.length,
        deferred_cgt_tax: totals.deferred_cgt_tax,
        cost_base_reduction: totals.cost_base_reduction,
        is_estimate: totals.is_estimate,
        is_assumption: totals.is_assumption
      },
      hurdle: {
        ...hurdleOnMarket,
        denominator: 'market',
        note: 'Headline hurdle is measured on MARKET value — the capital that could be redeployed today. The on-cost view is beside it.',
        on_market: hurdleOnMarket,
        on_cost: { ...hurdleOnCost, denominator: 'cost' },
        post_tax_irr_is_approximation: irrApprox !== null,
        post_tax_irr_method: irrApprox !== null ? 'value-weighted average of per-holding post-tax IRRs — an approximation, not a solved portfolio IRR' : null,
        irr_coverage: irrCoverage
      },
      excluded: skipped,
      warnings,
      disclaimer: TAX.DISCLAIMER
    });

  } catch (err) {
    console.error('tax-rollup failed:', err);
    return json(500, { error: err.message, function_version: FN_VERSION, disclaimer: TAX.DISCLAIMER });
  }
};
