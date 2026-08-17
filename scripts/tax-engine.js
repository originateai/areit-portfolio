'use strict';
// ============================================================================
// scripts/tax-engine.js — the post-tax overlay (SPEC.md §4)
//
// PURE FUNCTIONS ONLY. No database calls, no fetch, no Date.now() inside a
// calculation, no mutation of the caller's objects. Same inputs -> same output,
// always. All I/O lives in netlify/functions/tax-rollup.js.
//
// CONVENTIONS (SPEC.md §1.1-1.3, non-negotiable):
//   * money is DOLLARS everywhere in this file. No cents. Ever.
//   * rates are DECIMAL fractions: 0.47 means 47%. Formatting to % is the UI's
//     job. Passing 47 where 0.47 belongs is caught and thrown, not absorbed.
//   * NO TAX RATE IS HARDCODED. Every rate arrives via `settings`, which the
//     caller reads from public.tax_settings. If settings are missing the engine
//     THROWS — it never falls back to a plausible number (SPEC §9).
//
// THE ONE THING TO GET RIGHT
//   Tax-deferred distributions are DEFERRED, NOT EXEMPT. They are not taxed on
//   receipt; they reduce the cost base; the deferred amount comes back as a
//   capital gain on sale, at which point the CGT discount applies. Treating
//   them as tax free overstates after-tax return by (tax_deferred * m * (1 -
//   cgt_discount)) and is the single easiest mistake in this module. See
//   `deferred` in the return shape, and the disagreement with SPEC §4.5's
//   worked table documented at the bottom of this header.
//
// THE CONTRACT WITH THE VALUE ENGINE (SPEC §7)
//   taxAdjust(cashflow, profile, settings) -> { cash, credits, gross, tax, net }
//   Those five keys are the contract and do not change. Everything else in the
//   returned object is additive detail (breakdown, flags, assumptions) that a
//   caller may ignore.
//
// SPEC §4.5 WORKED TABLE — WHERE THIS ENGINE DISAGREES
//   The spec's illustration, at m = 0.47 on a 7.0% cash yield:
//     unfranked interest  cash 7.00%  gross  7.00%  post-tax 3.71%   <- engine agrees
//     equity 100% franked cash 7.00%  gross 10.00%  post-tax 5.30%   <- engine agrees
//     REIT 30% tax-deferred cash 7.00% gross 7.00%  post-tax ~4.68%  <- ENGINE DISAGREES
//   7.00 * 0.70 * (1 - 0.47) = 2.597 taxed portion kept, plus the full 2.10
//   tax-deferred = 4.697%, which is the ~4.68% in the spec. That figure treats
//   the tax-deferred slice as TAX FREE, which §4.2 of the same document
//   explicitly forbids. Deferring it correctly costs
//     2.10% * 0.47 * (1 - 0.5) = 0.4935%
//   giving 4.2035%. This engine returns 4.20%, and says so. The spec table is
//   the thing that is wrong; the spec's own prose is right.
// ============================================================================

const ENGINE_VERSION = 'tax-engine-1.0.0';

const DISCLAIMER =
  'Estimate only. Modelling tool, not tax advice. Component splits are assumptions until an annual tax statement is loaded.';

// §0 hurdles. These are investment targets, not tax rates, and are overridable.
const DEFAULT_HURDLES = { yield_target: 0.07, irr_target: 0.12 };

// Fallback franking gross-up rate, used ONLY when tax_settings has no
// company_tax_rate column (pre-migration DBs). It is the statutory company rate
// written into SPEC §4.2's formula, not a preference.
const FALLBACK_COMPANY_TAX_RATE = 0.30;

const COMPONENT_KEYS = [
  'franked_amount', 'franking_credit', 'unfranked_amount', 'interest_income',
  'tax_deferred', 'cgt_concession', 'foreign_income', 'foreign_credit',
  'amit_cost_base_net'
];

// Fractions of CASH received. The franking credit is NOT cash and is therefore
// not one of these fractions — it is derived from the franked slice.
const FRACTION_KEYS = ['franked', 'unfranked', 'interest', 'tax_deferred', 'cgt_concession', 'foreign'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Finite number or null. Never NaN, never a silent 0 (SPEC §6: `—`, not 0). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Finite number or 0 — only for genuinely additive component amounts. */
function amt(v) {
  const n = num(v);
  return n === null ? 0 : n;
}

/**
 * Decimal-rate guard (SPEC §1.3). A rate of 47 instead of 0.47 is a 100x error
 * that produces plausible-looking output, so it throws rather than warns.
 */
function rate(v, name, { required = false } = {}) {
  const n = num(v);
  if (n === null) {
    if (required) throw new Error(`tax-engine: ${name} is required and must be a decimal rate (0.47 = 47%)`);
    return null;
  }
  if (n > 1 || n < -1) {
    throw new Error(`tax-engine: ${name}=${n} looks like a percentage. Rates are DECIMALS (SPEC §1.3): 0.47, not 47.`);
  }
  return n;
}

const round = (n, dp = 10) => (n === null || n === undefined ? null : Number(n.toFixed(dp)));

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * resolveSettings(row) -> normalised tax parameters + structural entity rules.
 *
 * `row` is a public.tax_settings row (SPEC §4.1). THROWS if absent — an empty
 * settings table must break loudly, not silently model at 0%.
 *
 * Worked example:
 *   resolveSettings({ marginal_rate: 0.45, medicare_levy: 0.02,
 *                     cgt_discount: 0.5, entity_type: 'individual' })
 *   -> effective_rate            0.47      (0.45 + 0.02)
 *      cgt_discount              0.5
 *      cgt_effective_rate        0.235     (0.47 * (1 - 0.5))
 *      company_tax_rate          0.30
 *      gross_up_factor           0.428571… (0.30 / 0.70)
 *      credits_refundable        true
 *
 *   entity_type 'company': medicare NOT added, cgt_discount forced to 0,
 *   credits_refundable false (excess franking converts to a loss, not a refund).
 *   entity_type 'smsf':    medicare NOT added, settings cgt_discount used as
 *   given, but warns if it is still 0.5 (an SMSF's discount is one third).
 */
function resolveSettings(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('tax-engine: tax_settings row required (SPEC §4.1). Never hardcode a tax rate — load public.tax_settings.');
  }
  const warnings = [];

  const marginal = rate(row.marginal_rate, 'marginal_rate', { required: true });
  const medicareRaw = rate(row.medicare_levy, 'medicare_levy') ?? 0;
  const cgtRaw = rate(row.cgt_discount, 'cgt_discount') ?? 0;
  const companyRate = rate(row.company_tax_rate, 'company_tax_rate') ?? FALLBACK_COMPANY_TAX_RATE;

  const entity = String(row.entity_type || 'individual').toLowerCase();
  if (!['individual', 'smsf', 'company'].includes(entity)) {
    throw new Error(`tax-engine: entity_type '${row.entity_type}' not one of individual | smsf | company (SPEC §4.1)`);
  }

  // Medicare levy is a feature of individual taxpayers only. This is a
  // structural rule about WHERE a rate applies, not a hardcoded rate.
  const medicare = entity === 'individual' ? medicareRaw : 0;
  if (entity !== 'individual' && medicareRaw > 0) {
    warnings.push(`medicare_levy ${medicareRaw} ignored: it does not apply to entity_type '${entity}'`);
  }

  // Companies get no CGT discount.
  let cgtDiscount = cgtRaw;
  if (entity === 'company' && cgtRaw !== 0) {
    cgtDiscount = 0;
    warnings.push('cgt_discount forced to 0: companies do not receive the CGT discount');
  }
  if (entity === 'smsf' && cgtRaw === 0.5) {
    warnings.push('cgt_discount is 0.5 but entity_type is smsf — a complying super fund\'s discount is one third (0.3333). Check tax_settings.');
  }
  if (row.company_tax_rate === undefined || row.company_tax_rate === null) {
    warnings.push(`tax_settings.company_tax_rate absent — franking gross-up defaulted to ${FALLBACK_COMPANY_TAX_RATE}. Run the tax_overlay migration.`);
  }

  const effective = marginal + medicare;

  return {
    entity_type: entity,
    marginal_rate: marginal,
    medicare_levy: medicare,
    effective_rate: effective,                       // m — the rate applied to taxable income
    cgt_discount: cgtDiscount,
    cgt_effective_rate: effective * (1 - cgtDiscount), // the rate a discounted gain actually bears
    company_tax_rate: companyRate,
    gross_up_factor: companyRate / (1 - companyRate),  // credit per $1 of franked cash at 100% franking
    // Franking credits are refundable to individuals and complying super funds;
    // for a company the excess becomes a tax loss, not cash.
    credits_refundable: entity !== 'company',
    effective_from: row.effective_from || null,
    warnings
  };
}

// ---------------------------------------------------------------------------
// tax profiles
// ---------------------------------------------------------------------------

/**
 * defaultProfile(assetClass, overrides) -> component mix ASSUMPTION (SPEC §4.3).
 *
 * Every profile this function returns carries `is_assumption: true`. It is used
 * only when no actual distribution_components / tax statement exists. It never
 * invents a split for a NAMED SECURITY (SPEC §9) — these are class-level
 * defaults and the flag travels all the way into the API response so the UI can
 * mark the number as an estimate.
 *
 *   credit, bond_hybrid -> 100% unfranked interest. Worst case, and correct for
 *                          MXT / GCI / QRI style vehicles.
 *   reit                -> 30% tax-deferred, 70% unfranked. The 30% mirrors the
 *                          SPEC §4.5 illustration; the remainder is assumed
 *                          unfranked because that is the conservative side.
 *   equity, lit         -> 100% franked at 100% franking. This one is
 *                          OPTIMISTIC: §4.3 says "franked per actual franking
 *                          history", and history is not available to a pure
 *                          function. Pass franking_level explicitly whenever the
 *                          real figure is known.
 *   property            -> not a distribution at all; routed to the §4.4 path.
 *   anything else       -> 100% unfranked. Worst case beats a flattering guess.
 *
 * Worked example:
 *   defaultProfile('reit')
 *   -> { tax_deferred: 0.30, unfranked: 0.70, franked: 0, interest: 0,
 *        cgt_concession: 0, foreign: 0, franking_level: 0,
 *        is_assumption: true, source: 'default:reit' }
 */
function defaultProfile(assetClass, overrides = {}) {
  const cls = String(assetClass || '').toLowerCase();
  const base = {
    franked: 0, unfranked: 0, interest: 0, tax_deferred: 0, cgt_concession: 0, foreign: 0,
    franking_level: 0,             // fraction of the franked slice that carries credits
    foreign_withholding_rate: 0,
    is_assumption: true,
    is_estimate: true
  };
  let p;
  switch (cls) {
    case 'credit':
    case 'bond_hybrid':
      p = { ...base, interest: 1, source: `default:${cls}`,
            assumption_note: '100% unfranked interest assumed (SPEC §4.3) — worst case for a credit/hybrid vehicle.' };
      break;
    case 'reit':
      p = { ...base, tax_deferred: 0.30, unfranked: 0.70, source: 'default:reit',
            assumption_note: 'ASSUMED 30% tax-deferred / 70% unfranked (SPEC §4.3, §4.5 illustration). Class-level default, not a figure for any named REIT. Supersede with the annual tax statement.' };
      break;
    case 'equity':
    case 'lit':
      p = { ...base, franked: 1, franking_level: 1, source: `default:${cls}`,
            assumption_note: 'ASSUMED 100% franked at 100% franking (SPEC §4.3 says use actual franking history). This is the OPTIMISTIC end — supply franking_level from history where known.' };
      break;
    case 'property':
      p = { ...base, path: 'property', source: 'default:property',
            assumption_note: 'Direct property uses the SPEC §4.4 path (rent less costs less depreciation and capital works), not the distribution path.' };
      break;
    default:
      p = { ...base, unfranked: 1, source: cls ? `default:${cls}` : 'default:unknown',
            assumption_note: `No default tax profile for asset_class '${assetClass}' — assumed 100% unfranked (worst case).` };
  }
  return { ...p, asset_class: cls || null, ...overrides };
}

/**
 * profileFromComponents(rows) -> an ACTUAL mix derived from distribution_components.
 *
 * Returns fractions of cash rather than dollars on purpose: the component rows
 * tell us the MIX, the income rollup tells us the forward AMOUNT, and mixing
 * per-unit rows with holding totals is how a 100x error gets in. Returns null
 * if the rows carry no cash at all.
 *
 * Worked example:
 *   profileFromComponents([{ franked_amount: 300, franking_credit: 128.5714,
 *                            unfranked_amount: 200, tax_deferred: 500,
 *                            source: 'statement', is_estimate: false }])
 *   cash total = 300 + 200 + 500 = 1000
 *   -> franked 0.30, unfranked 0.20, tax_deferred 0.50,
 *      franking_level = 128.5714 / (300 * 0.428571) = 1.0
 *      is_assumption false, is_estimate false, source 'components:statement'
 */
function profileFromComponents(rows, settings) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (!list.length) return null;

  const s = settings && settings.gross_up_factor !== undefined
    ? settings
    : { gross_up_factor: FALLBACK_COMPANY_TAX_RATE / (1 - FALLBACK_COMPANY_TAX_RATE) };

  const t = {};
  COMPONENT_KEYS.forEach(k => { t[k] = 0; });
  let anyEstimate = false;
  const sources = new Set();

  list.forEach(r => {
    COMPONENT_KEYS.forEach(k => { t[k] += amt(r[k]); });
    if (r.is_estimate !== false) anyEstimate = true;
    if (r.source) sources.add(r.source);
  });

  const cash = t.franked_amount + t.unfranked_amount + t.interest_income +
               t.tax_deferred + t.cgt_concession + t.foreign_income;
  if (!(cash > 0)) return null;

  const frankingLevel = t.franked_amount > 0
    ? Math.min(1, Math.max(0, t.franking_credit / (t.franked_amount * s.gross_up_factor)))
    : 0;
  const foreignWithholding = t.foreign_income > 0
    ? Math.min(0.99, Math.max(0, t.foreign_credit / (t.foreign_income + t.foreign_credit)))
    : 0;

  const warnings = [];
  if (t.tax_deferred > 0 && t.amit_cost_base_net > 0) {
    warnings.push('both tax_deferred and amit_cost_base_net are populated — check the statement, the cost-base reduction may be double counted');
  }

  return {
    franked: t.franked_amount / cash,
    unfranked: t.unfranked_amount / cash,
    interest: t.interest_income / cash,
    tax_deferred: t.tax_deferred / cash,
    cgt_concession: t.cgt_concession / cash,
    foreign: t.foreign_income / cash,
    franking_level: frankingLevel,
    foreign_withholding_rate: foreignWithholding,
    amit_cost_base_net_pct: t.amit_cost_base_net / cash,
    is_assumption: false,
    is_estimate: anyEstimate,
    source: `components:${[...sources].join('+') || 'unknown'}`,
    assumption_note: anyEstimate
      ? 'Derived from distribution_components rows still flagged is_estimate — supersede with the annual tax statement.'
      : null,
    warnings
  };
}

/** Normalise + validate a profile. Accepts `franked` or `franked_pct` spellings. */
function normaliseProfile(profile) {
  const p = profile || {};
  const out = {};
  FRACTION_KEYS.forEach(k => {
    const v = num(p[k]) !== null ? num(p[k]) : num(p[`${k}_pct`]);
    out[k] = v === null ? 0 : v;
  });
  const sum = FRACTION_KEYS.reduce((a, k) => a + out[k], 0);
  if (sum <= 0) {
    throw new Error('tax-engine: profile has no components. Use defaultProfile(asset_class) or profileFromComponents().');
  }
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`tax-engine: profile fractions sum to ${sum}, must sum to 1. They are fractions of CASH received (the franking credit is not cash).`);
  }
  FRACTION_KEYS.forEach(k => {
    if (out[k] < 0) throw new Error(`tax-engine: profile.${k} is negative (${out[k]})`);
  });
  out.franking_level = Math.min(1, Math.max(0, num(p.franking_level) !== null ? num(p.franking_level) : (out.franked > 0 ? 0 : 0)));
  out.foreign_withholding_rate = Math.min(0.99, Math.max(0, num(p.foreign_withholding_rate) ?? 0));
  out.amit_cost_base_net_pct = num(p.amit_cost_base_net_pct) ?? 0;
  out.is_assumption = p.is_assumption !== false;
  out.is_estimate = p.is_estimate !== false;
  out.source = p.source || (out.is_assumption ? 'unspecified-assumption' : 'unspecified');
  out.assumption_note = p.assumption_note || null;
  out.asset_class = p.asset_class || null;
  // Deferral modelling knobs (see deferralFactor).
  out.deferral_years = num(p.deferral_years) ?? 0;
  out.deferral_discount_rate = num(p.deferral_discount_rate) ?? 0;
  out.cgt_discount_eligible = p.cgt_discount_eligible !== false; // assumes held >12 months
  out.warnings = Array.isArray(p.warnings) ? p.warnings.slice() : [];
  return out;
}

/**
 * Present-value factor for a deferred CGT liability.
 * Default is 1.0 — the deferred tax is charged in full, undiscounted. That is
 * the CONSERVATIVE choice and it is the default on purpose: discounting it
 * requires assuming a holding period and a discount rate, and a wrong
 * assumption there flatters the after-tax return of exactly the assets this
 * platform is meant to scrutinise.
 *
 *   deferralFactor(0, 0)      -> 1
 *   deferralFactor(10, 0.08)  -> 1/1.08^10 = 0.463193…
 */
function deferralFactor(years, discountRate) {
  const y = num(years) ?? 0;
  const r = num(discountRate) ?? 0;
  if (!(y > 0) || !(r > 0)) return 1;
  return 1 / Math.pow(1 + r, y);
}

// ---------------------------------------------------------------------------
// the contract: taxAdjust
// ---------------------------------------------------------------------------

/**
 * taxAdjust(cashflow, profile, settings) -> { cash, credits, gross, tax, net, ... }
 *
 * THE INTERFACE WITH THE VALUE ENGINE (SPEC §7). Those five keys are fixed.
 *
 * `cashflow` — one of:
 *   a) a number: dollars of cash distribution, split by `profile`.
 *   b) { cash_income | amount | cash | total }: same, object form.
 *   c) explicit component dollars — any of franked_amount, franking_credit,
 *      unfranked_amount, interest_income, tax_deferred, cgt_concession,
 *      foreign_income, foreign_credit, amit_cost_base_net. `profile` is then
 *      only consulted for deferral knobs.
 *   d) property: { kind: 'property', gross_rent, agent_fees, rates, insurance,
 *      strata, maintenance, other_costs, interest_paid, depreciation,
 *      capital_works, ownership_pct } — routed to the SPEC §4.4 path.
 *
 * `profile`  — from defaultProfile() or profileFromComponents().
 * `settings` — a raw public.tax_settings row, or the output of resolveSettings().
 *
 * Return shape:
 *   cash    dollars actually received
 *   credits franking credits + foreign credits attached (NOT cash)
 *   gross   cash + credits                      (the grossed-up lens, §4.5)
 *   tax     total tax attributable to this cashflow, AFTER offsets, INCLUDING
 *           the deferred CGT on the cost-base reduction. Negative = a refund
 *           (negative gearing, or excess refundable franking credits).
 *   net     cash - tax                          (the post-tax lens, §4.5)
 * plus breakdown, flags, assumptions, warnings, is_estimate, disclaimer.
 *
 * WORKED EXAMPLES — all at settings { marginal_rate 0.45, medicare_levy 0.02,
 * cgt_discount 0.5, entity_type 'individual', company_tax_rate 0.30 },
 * i.e. m = 0.47, on $7,000 of cash (a 7.0% yield on $100,000):
 *
 *  1) 100% unfranked interest — defaultProfile('credit')
 *       cash 7000, credits 0, gross 7000
 *       taxable 7000, tax 7000*0.47 = 3290
 *       net 7000 - 3290 = 3710                 -> 3.71% on $100,000  [SPEC §4.5 agrees]
 *
 *  2) 100% franked equity — defaultProfile('equity')
 *       franking credit = 7000 * 0.30/0.70 = 3000
 *       cash 7000, credits 3000, gross 10000   -> 10.00% gross      [SPEC §4.5 agrees]
 *       tax on grossed-up income = 10000 * 0.47 = 4700
 *       less refundable credit 3000 -> tax 1700
 *       net 7000 - 1700 = 5300                 -> 5.30% on $100,000 [SPEC §4.5 agrees]
 *
 *  3) REIT, 30% tax-deferred — defaultProfile('reit')
 *       cash 7000 = 4900 unfranked + 2100 tax-deferred, credits 0, gross 7000
 *       tax on income = 4900 * 0.47 = 2303
 *       cost base reduced by 2100 -> deferred CGT = 2100 * 0.47 * (1-0.5) = 493.50
 *       tax 2796.50, net 4203.50               -> 4.2035% on $100,000
 *       [SPEC §4.5's ~4.68% treats the deferred slice as tax free — see header]
 *
 *  4) Property, negatively geared (SPEC §4.4) — m = 0.47, ownership_pct 1:
 *       gross_rent 40000, costs 10000, interest_paid 32000,
 *       depreciation 9000, capital_works 3000
 *       cash    = 40000 - 10000 - 32000 = -2000   (out of pocket)
 *       taxable = -2000 - 9000 - 3000  = -14000   (a LOSS)
 *       tax     = -14000 * 0.47 = -6580           (NEGATIVE = a tax benefit)
 *       capital works claw back on sale: 3000 * 0.47 * 0.5 = 705
 *       tax total = -6580 + 705 = -5875
 *       net = -2000 - (-5875) = +3875             (negative cash, positive after tax)
 *
 *  5) Property, depreciation exceeding taxable profit — m = 0.47:
 *       gross_rent 50000, costs 12000, interest_paid 28000,
 *       depreciation 12000, capital_works 0
 *       cash 10000, taxable -2000, tax -940, net 10940
 *       -> post-tax income EXCEEDS pre-tax cash income, which is the §4.4 point:
 *          depreciation is a deduction that never touched the bank account.
 */
function taxAdjust(cashflow, profile, settings) {
  const s = (settings && settings.effective_rate !== undefined && settings.gross_up_factor !== undefined)
    ? settings
    : resolveSettings(settings);

  const isProperty = cashflow && typeof cashflow === 'object' &&
    (cashflow.kind === 'property' || cashflow.type === 'property' ||
     cashflow.gross_rent !== undefined || (profile && profile.path === 'property'));

  return isProperty
    ? propertyTaxAdjust(cashflow, profile, s)
    : distributionTaxAdjust(cashflow, profile, s);
}

/** The listed / distribution path (SPEC §4.2). */
function distributionTaxAdjust(cashflow, profile, s) {
  const warnings = [];
  let comp = null;
  let p = null;
  let basis;

  const hasExplicit = cashflow && typeof cashflow === 'object' &&
    COMPONENT_KEYS.some(k => num(cashflow[k]) !== null);

  if (hasExplicit) {
    // (c) explicit component dollars — authoritative, the profile is not used
    // for the mix at all.
    comp = {};
    COMPONENT_KEYS.forEach(k => { comp[k] = amt(cashflow[k]); });
    basis = 'components';
    p = normaliseProfile({
      // a nominal profile so deferral knobs and flags still resolve
      unfranked: 1,
      is_assumption: false,
      is_estimate: cashflow.is_estimate !== false,
      source: cashflow.source ? `components:${cashflow.source}` : 'components:supplied',
      deferral_years: (profile || {}).deferral_years,
      deferral_discount_rate: (profile || {}).deferral_discount_rate,
      cgt_discount_eligible: (profile || {}).cgt_discount_eligible,
      asset_class: (profile || {}).asset_class
    });
  } else {
    // (a)/(b) scalar cash split by the profile
    const cashIn = typeof cashflow === 'number'
      ? num(cashflow)
      : num((cashflow || {}).cash_income) ?? num((cashflow || {}).amount) ??
        num((cashflow || {}).cash) ?? num((cashflow || {}).total);
    if (cashIn === null) {
      throw new Error('tax-engine: cashflow must be a dollar number, an object with cash_income/amount/cash/total, explicit components, or a property cashflow.');
    }
    p = normaliseProfile(profile);
    basis = 'profile';
    const franked = cashIn * p.franked;
    const foreignCash = cashIn * p.foreign;
    comp = {
      franked_amount: franked,
      franking_credit: franked * p.franking_level * s.gross_up_factor,
      unfranked_amount: cashIn * p.unfranked,
      interest_income: cashIn * p.interest,
      tax_deferred: cashIn * p.tax_deferred,
      cgt_concession: cashIn * p.cgt_concession,
      foreign_income: foreignCash,
      // cash received is net of withholding: gross = cash/(1-w), credit = gross - cash
      foreign_credit: p.foreign_withholding_rate > 0
        ? foreignCash * (p.foreign_withholding_rate / (1 - p.foreign_withholding_rate))
        : 0,
      amit_cost_base_net: cashIn * (p.amit_cost_base_net_pct || 0)
    };
  }
  warnings.push(...(p.warnings || []));

  const cash = comp.franked_amount + comp.unfranked_amount + comp.interest_income +
               comp.tax_deferred + comp.cgt_concession + comp.foreign_income;

  const frankingCredit = comp.franking_credit;
  const foreignCredit = comp.foreign_credit;
  const credits = frankingCredit + foreignCredit;
  const gross = cash + credits;

  // ── taxable income ────────────────────────────────────────────────────────
  // Tax-deferred and CGT-concession amounts are NOT taxable income on receipt.
  const foreignGross = comp.foreign_income + foreignCredit;
  const taxableIncome = comp.franked_amount + frankingCredit +
                        comp.unfranked_amount + comp.interest_income + foreignGross;
  const taxOnIncome = taxableIncome * s.effective_rate;

  // ── offsets, in ATO order: non-refundable first, refundable last ──────────
  // FITO is capped at the Australian tax on the foreign income and is never
  // refundable; franking credits are refundable except for a company.
  const fitoCap = Math.max(0, foreignGross * s.effective_rate);
  const fito = Math.min(foreignCredit, fitoCap, Math.max(0, taxOnIncome));
  const afterFito = taxOnIncome - fito;
  const frankingApplied = s.credits_refundable
    ? frankingCredit
    : Math.min(frankingCredit, Math.max(0, afterFito));
  const netIncomeTax = afterFito - frankingApplied;   // negative => refund
  const creditsWasted = (frankingCredit - frankingApplied) + (foreignCredit - fito);
  if (creditsWasted > 1e-9) {
    warnings.push(`${round(creditsWasted, 2)} of attached credits could not be used (foreign tax offset cap / non-refundable for this entity type)`);
  }

  // ── the deferral (SPEC §4.2) — NOT an exemption ───────────────────────────
  // Tax-deferred amounts and any AMIT net cost-base reduction lower the cost
  // base, so they surface as a capital gain on sale, discounted if held >12m.
  const costBaseReduction = comp.tax_deferred + comp.amit_cost_base_net;
  const cgtDiscount = p.cgt_discount_eligible ? s.cgt_discount : 0;
  if (!p.cgt_discount_eligible) {
    warnings.push('CGT discount not applied: holding assumed held <12 months (cgt_discount_eligible: false)');
  }
  const cgtRate = s.effective_rate * (1 - cgtDiscount);
  const pv = deferralFactor(p.deferral_years, p.deferral_discount_rate);
  const deferredCgtTax = costBaseReduction * cgtRate * pv;

  const tax = netIncomeTax + deferredCgtTax;
  const net = cash - tax;

  const pcts = cash > 0 ? {
    franked_pct: comp.franked_amount / cash,
    unfranked_pct: comp.unfranked_amount / cash,
    interest_pct: comp.interest_income / cash,
    tax_deferred_pct: comp.tax_deferred / cash,
    cgt_concession_pct: comp.cgt_concession / cash,
    foreign_pct: comp.foreign_income / cash
  } : { franked_pct: null, unfranked_pct: null, interest_pct: null,
        tax_deferred_pct: null, cgt_concession_pct: null, foreign_pct: null };

  return {
    // ── the SPEC §7 contract ────────────────────────────────────────────────
    cash, credits, gross, tax, net,
    // ── breakdown ───────────────────────────────────────────────────────────
    path: 'distribution',
    basis,
    franking_credits: frankingCredit,
    foreign_credits: foreignCredit,
    taxable_income: taxableIncome,
    tax_on_income: taxOnIncome,
    offsets_applied: fito + frankingApplied,
    credits_wasted: creditsWasted,
    tax_on_income_net_of_offsets: netIncomeTax,
    deferred: {
      cost_base_reduction: costBaseReduction,
      cgt_discount_applied: cgtDiscount,
      cgt_effective_rate: cgtRate,
      deferred_cgt_tax: deferredCgtTax,
      deferral_years: p.deferral_years,
      deferral_discount_rate: p.deferral_discount_rate,
      pv_factor: pv,
      note: 'Tax-deferred amounts are NOT tax free. They reduce the cost base and are taxed as a discounted capital gain on sale. Charged undiscounted (pv_factor 1) unless deferral_years and deferral_discount_rate are supplied.'
    },
    components: comp,
    ...pcts,
    effective_rate: s.effective_rate,
    effective_tax_rate_on_cash: cash > 0 ? tax / cash : null,
    entity_type: s.entity_type,
    // ── honesty flags (SPEC §1.6, §9) ───────────────────────────────────────
    is_estimate: p.is_estimate,
    is_assumption: p.is_assumption,
    profile_source: p.source,
    assumption_note: p.assumption_note,
    warnings: warnings.concat(s.warnings || []),
    disclaimer: DISCLAIMER,
    engine_version: ENGINE_VERSION
  };
}

/**
 * The direct-property path (SPEC §4.4). Rental income is taxed at m, but
 * depreciation and capital works reduce TAXABLE income without reducing CASH —
 * so post-tax yield can legitimately exceed pre-tax cash yield. Negative
 * gearing produces a tax BENEFIT: `tax` goes negative and `net` exceeds `cash`.
 *
 * Inputs are at 100% of the property and scaled by ownership_pct (SPEC §3.1).
 * `capital_works` is clawed back against the cost base on sale (Div 43), which
 * is the property analogue of a tax-deferred distribution — set
 * profile.clawback_capital_works = false to switch that off. Plant
 * depreciation is NOT clawed back by default.
 */
function propertyTaxAdjust(cf, profile, s) {
  const warnings = [];
  const p = profile || {};
  const own = num(cf.ownership_pct) ?? 1;
  if (own < 0 || own > 1) throw new Error(`tax-engine: ownership_pct ${own} must be a decimal fraction 0..1 (SPEC §1.3)`);

  const grossRent = amt(cf.gross_rent);
  const operatingCosts = num(cf.operating_costs) !== null
    ? amt(cf.operating_costs)
    : amt(cf.agent_fees) + amt(cf.rates) + amt(cf.insurance) + amt(cf.strata) +
      amt(cf.maintenance) + amt(cf.other_costs);
  const interest = amt(cf.interest_paid);
  const depreciation = amt(cf.depreciation);
  const capitalWorks = amt(cf.capital_works);

  if (depreciation === 0 && capitalWorks === 0) {
    warnings.push('no depreciation or capital works supplied — post-tax property yield is UNDERSTATED. Populate property_cashflows.depreciation / .capital_works (SPEC §4.4).');
  }

  const cash = (grossRent - operatingCosts - interest) * own;
  const taxableIncome = (grossRent - operatingCosts - interest - depreciation - capitalWorks) * own;
  const taxOnIncome = taxableIncome * s.effective_rate;   // negative => tax benefit
  if (taxableIncome < 0) {
    warnings.push('negatively geared: taxable loss offsets other income, so tax is negative (a benefit). Assumes sufficient other income to absorb it.');
  }

  const clawbackCapitalWorks = p.clawback_capital_works !== false;
  const clawbackDepreciation = p.clawback_depreciation === true;
  const costBaseReduction =
    (clawbackCapitalWorks ? capitalWorks * own : 0) +
    (clawbackDepreciation ? depreciation * own : 0);
  const cgtDiscount = p.cgt_discount_eligible === false ? 0 : s.cgt_discount;
  const cgtRate = s.effective_rate * (1 - cgtDiscount);
  const pv = deferralFactor(p.deferral_years, p.deferral_discount_rate);
  const deferredCgtTax = costBaseReduction * cgtRate * pv;

  const tax = taxOnIncome + deferredCgtTax;
  const net = cash - tax;

  return {
    cash, credits: 0, gross: cash, tax, net,
    path: 'property',
    basis: 'property_cashflow',
    franking_credits: 0,
    foreign_credits: 0,
    taxable_income: taxableIncome,
    tax_on_income: taxOnIncome,
    offsets_applied: 0,
    credits_wasted: 0,
    tax_on_income_net_of_offsets: taxOnIncome,
    deferred: {
      cost_base_reduction: costBaseReduction,
      cgt_discount_applied: cgtDiscount,
      cgt_effective_rate: cgtRate,
      deferred_cgt_tax: deferredCgtTax,
      deferral_years: num(p.deferral_years) ?? 0,
      deferral_discount_rate: num(p.deferral_discount_rate) ?? 0,
      pv_factor: pv,
      note: 'Capital works deductions reduce the cost base and are clawed back as a discounted capital gain on sale (Div 43). Plant depreciation is not clawed back unless clawback_depreciation is set.'
    },
    inputs: { gross_rent: grossRent, operating_costs: operatingCosts, interest_paid: interest,
              depreciation, capital_works: capitalWorks, ownership_pct: own },
    deductions_noncash: (depreciation + capitalWorks) * own,
    // Not applicable to property -> null, so the UI renders `—` and never 0
    // (SPEC §6). tax_deferred_pct IS meaningful: capital works clawed back
    // against the cost base is the property analogue of a tax-deferred
    // distribution, so it stays comparable across the portfolio.
    franked_pct: null, unfranked_pct: null, interest_pct: null,
    tax_deferred_pct: cash > 0 ? costBaseReduction / cash : null,
    cgt_concession_pct: null, foreign_pct: null,
    effective_rate: s.effective_rate,
    effective_tax_rate_on_cash: cash > 0 ? tax / cash : null,
    entity_type: s.entity_type,
    is_estimate: p.is_estimate !== false,
    is_assumption: p.is_assumption === true,
    profile_source: p.source || 'property_cashflow',
    assumption_note: p.assumption_note || null,
    warnings: warnings.concat(s.warnings || []),
    disclaimer: DISCLAIMER,
    engine_version: ENGINE_VERSION
  };
}

// ---------------------------------------------------------------------------
// the three lenses (SPEC §4.5)
// ---------------------------------------------------------------------------

/**
 * yieldLenses(adjusted, denominators) -> the six figures of SPEC §4.5.
 *
 * denominators: { equity_invested, equity_value } — both from SPEC §3.1, both
 * DOLLARS. A missing or non-positive denominator yields null, never 0 and never
 * Infinity: SPEC §6 says missing data renders `—`.
 *
 * Worked example — the §4.5 table, $100,000 invested and $100,000 market value,
 * 100% franked equity paying $7,000 at m = 0.47:
 *   cash 7000, credits 3000, gross 10000, tax 1700, net 5300
 *   -> cash_yield_on_cost 0.07, gross_yield_on_cost 0.10,
 *      post_tax_yield_on_cost 0.053, and the same three on market.
 */
function yieldLenses(adjusted, denominators = {}) {
  const cost = num(denominators.equity_invested);
  const market = num(denominators.equity_value);
  const r = (n, d) => (d === null || !(d > 0) || n === null || n === undefined ? null : n / d);

  return {
    cash_income: adjusted.cash,
    franking_credits: adjusted.franking_credits ?? adjusted.credits,
    gross_income: adjusted.gross,
    tax_payable: adjusted.tax,
    post_tax_income: adjusted.net,

    equity_invested: cost,
    equity_value: market,

    cash_yield_on_cost: r(adjusted.cash, cost),
    gross_yield_on_cost: r(adjusted.gross, cost),
    post_tax_yield_on_cost: r(adjusted.net, cost),

    cash_yield_on_market: r(adjusted.cash, market),
    gross_yield_on_market: r(adjusted.gross, market),
    post_tax_yield_on_market: r(adjusted.net, market),

    tax_deferred_pct: adjusted.tax_deferred_pct ?? null,
    franked_pct: adjusted.franked_pct ?? null,

    is_estimate: adjusted.is_estimate,
    is_assumption: adjusted.is_assumption,
    disclaimer: DISCLAIMER
  };
}

// ---------------------------------------------------------------------------
// the hurdle test (SPEC §0, §5.4)
// ---------------------------------------------------------------------------

/**
 * hurdleTest({ post_tax_yield, post_tax_irr }, targets) -> pass/fail + the gap.
 *
 * BOTH tests are post-tax. A null input is INCOMPLETE, never a fail and never a
 * pass — an unsolved IRR must not be scored (SPEC §5.3: never return a fallback
 * number).
 *
 * Worked examples (targets 0.07 / 0.12):
 *   { post_tax_yield: 0.053, post_tax_irr: 0.14 }
 *     -> FAILS_HURDLE, failed ['yield'], yield_gap -0.017, irr_gap +0.02
 *   { post_tax_yield: 0.075, post_tax_irr: 0.13 }
 *     -> MEETS_HURDLE, failed []
 *   { post_tax_yield: 0.075, post_tax_irr: null }
 *     -> INCOMPLETE, irr_pass null, reason names the missing input
 */
function hurdleTest(values = {}, targets = {}) {
  const yTarget = rate(targets.yield_target ?? DEFAULT_HURDLES.yield_target, 'yield_target');
  const iTarget = rate(targets.irr_target ?? DEFAULT_HURDLES.irr_target, 'irr_target');
  const y = num(values.post_tax_yield);
  const i = num(values.post_tax_irr);

  const yPass = y === null ? null : y >= yTarget;
  const iPass = i === null ? null : i >= iTarget;

  const failed = [];
  if (yPass === false) failed.push('yield');
  if (iPass === false) failed.push('irr');

  const missing = [];
  if (y === null) missing.push('post_tax_yield');
  if (i === null) missing.push('post_tax_irr');

  let status;
  if (failed.length) status = 'FAILS_HURDLE';
  else if (missing.length) status = 'INCOMPLETE';
  else status = 'MEETS_HURDLE';

  return {
    status,
    lens: 'post-tax',
    yield_target: yTarget,
    irr_target: iTarget,
    post_tax_yield: y,
    post_tax_irr: i,
    yield_pass: yPass,
    irr_pass: iPass,
    yield_gap: y === null ? null : y - yTarget,   // negative = short by this much
    irr_gap: i === null ? null : i - iTarget,
    failed,
    missing,
    reason: failed.length
      ? `Fails on ${failed.join(' and ')} (post-tax lens).`
      : (missing.length ? `Cannot be scored: ${missing.join(', ')} not available.` : 'Meets both post-tax hurdles.'),
    disclaimer: DISCLAIMER
  };
}

/**
 * Sum a list of taxAdjust() outputs into one portfolio-level figure.
 * Sums dollars — it never averages yields, because a weighted average of
 * yields is not the portfolio yield.
 */
function sumAdjusted(list) {
  const t = { cash: 0, credits: 0, gross: 0, tax: 0, net: 0,
              franking_credits: 0, foreign_credits: 0, taxable_income: 0,
              deferred_cgt_tax: 0, cost_base_reduction: 0 };
  let anyEstimate = false, anyAssumption = false;
  (list || []).forEach(a => {
    if (!a) return;
    t.cash += num(a.cash) ?? 0;
    t.credits += num(a.credits) ?? 0;
    t.gross += num(a.gross) ?? 0;
    t.tax += num(a.tax) ?? 0;
    t.net += num(a.net) ?? 0;
    t.franking_credits += num(a.franking_credits) ?? 0;
    t.foreign_credits += num(a.foreign_credits) ?? 0;
    t.taxable_income += num(a.taxable_income) ?? 0;
    t.deferred_cgt_tax += num(a.deferred && a.deferred.deferred_cgt_tax) ?? 0;
    t.cost_base_reduction += num(a.deferred && a.deferred.cost_base_reduction) ?? 0;
    if (a.is_estimate) anyEstimate = true;
    if (a.is_assumption) anyAssumption = true;
  });
  t.tax_deferred_pct = t.cash > 0 ? t.cost_base_reduction / t.cash : null;
  t.franked_pct = null; // meaningless across mixed asset classes; per holding only
  t.is_estimate = anyEstimate;
  t.is_assumption = anyAssumption;
  t.disclaimer = DISCLAIMER;
  return t;
}

module.exports = {
  ENGINE_VERSION,
  DISCLAIMER,
  DEFAULT_HURDLES,
  taxAdjust,
  resolveSettings,
  defaultProfile,
  profileFromComponents,
  normaliseProfile,
  deferralFactor,
  yieldLenses,
  hurdleTest,
  sumAdjusted
};
