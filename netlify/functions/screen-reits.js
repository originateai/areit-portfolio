// netlify/functions/screen-reits.js
// The alpha layer. Ranks the A-REIT universe on the questions an analyst
// actually asks, bottom-up, from everything the platform holds:
//
//   · Who is a takeover target?
//   · Who is simply cheap on fundamentals?
//   · Whose tenants are shaky?
//   · Who has the best and the worst balance sheet?
//   · Whose income is least at risk?
//
// Every score is decomposed: each returns the components and the reasoning, so a
// ranking can be argued with rather than taken on faith. A screen you cannot
// interrogate is a horoscope.
//
// GET /.netlify/functions/screen-reits
// Returns { as_of, universe, screens:{...}, coverage:{...}, warnings:[] }

const { getSupabase } = require('./_shared.js');

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const r3  = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;

/* Score helper: map a value onto 0–1 within a band, either direction.
 * Returns null when the input is missing — a missing input must not score zero,
 * because zero is a judgement and null is an absence. */
const band = (v, lo, hi, higherIsBetter = true) => {
  if (v == null || !Number.isFinite(v)) return null;
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return higherIsBetter ? t : 1 - t;
};
const avg = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,c)=>a+c,0)/v.length : null; };

exports.handler = async () => {
  const db = getSupabase();
  const asOf = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
  const warnings = [];

  try {
    const [stocksR, valsR, assetsR, assumpR, modelsR, bondR, pricesR] = await Promise.all([
      db.from('stocks').select('*').eq('asset_class', 'reit'),
      db.from('valuation_runs').select('*').order('as_of', { ascending: false }),
      db.from('reit_assets').select('*'),
      db.from('reit_model_assumptions').select('*'),
      db.from('reit_models').select('*').eq('is_current', true),
      db.from('bond_data').select('*').order('data_date', { ascending: false }).limit(1),
      db.from('reit_prices').select('*'),
    ]);

    const stocks = stocksR.data || [];
    const bond = bondR.data?.[0] || null;

    // Latest valuation run per ticker (the table is append-only).
    const latestVal = {};
    (valsR.data || []).forEach(v => { if (!(v.ticker in latestVal)) latestVal[v.ticker] = v; });
    const assumps = Object.fromEntries((assumpR.data || []).map(a => [a.ticker, a]));
    const models  = Object.fromEntries((modelsR.data || []).map(m => [m.ticker, m]));
    const prices  = Object.fromEntries((pricesR.data || []).map(p => [p.ticker, p]));

    // Tenant concentration, bottom-up from the asset register. The largest
    // single tenant's share of passing income is the sharpest available proxy
    // for tenant risk — a 20%+ single tenant is a different asset from a
    // diversified book at the same WALE.
    const assetsByTicker = {};
    (assetsR.data || []).forEach(a => { (assetsByTicker[a.ticker] = assetsByTicker[a.ticker] || []).push(a); });
    const tenantRisk = {};
    Object.entries(assetsByTicker).forEach(([tk, rows]) => {
      const live = rows.filter(r => !r.is_excluded && num(r.passing_income_m) > 0);
      const total = live.reduce((s, r) => s + num(r.passing_income_m), 0);
      if (!total) return;
      const byTenant = {};
      live.forEach(r => { const t = (r.major_tenant || 'unattributed').trim();
        byTenant[t] = (byTenant[t] || 0) + num(r.passing_income_m); });
      const ranked = Object.entries(byTenant).map(([t, m]) => ({ tenant: t, income_m: r3(m), share: r3(m/total) }))
        .sort((a,b) => b.share - a.share);
      tenantRisk[tk] = {
        top_tenant: ranked[0]?.tenant || null,
        top_share: ranked[0]?.share ?? null,
        top3_share: r3(ranked.slice(0,3).reduce((s,x)=>s+x.share,0)),
        assets_priced: live.length,
        concentration: ranked.slice(0,5),
      };
    });

    const rows = stocks.map(s => {
      const tk = s.ticker;
      const v  = latestVal[tk];
      const a  = assumps[tk];
      const px = prices[tk]?.last_price != null ? Number(prices[tk].last_price) : (v?.price ?? null);
      const tr = tenantRisk[tk];

      const nta      = num(s.nta);
      const gearing  = num(a?.gearing_current) ?? num(s.gearing);
      const icr      = num(s.icr);
      const hedge    = num(a?.hedge_ratio) ?? (num(s.hedged_pct) != null ? num(s.hedged_pct) : null);
      const wale     = num(s.wale);
      const occ      = num(s.occupancy);
      const mcap     = num(s.market_cap);
      const external = s.is_manager === false || s.is_fund_manager === false ? null : null; // see below
      const isExternallyManaged = models[tk]?.mgmt_model === 'external';

      const discNta  = (nta && px) ? (nta - px) / px : null;                 // + = trades below NTA
      const discFv   = v?.discount_to_fair_value != null ? Number(v.discount_to_fair_value) : null;

      /* ── BALANCE SHEET ─────────────────────────────────────────────────
       * Gearing 20–45% (lower better), ICR 1.5–5x, hedging 30–90%. Bands are
       * the A-REIT working range, not theoretical bounds. */
      const bsParts = {
        gearing: band(gearing, 0.20, 0.45, false),
        icr:     band(icr, 1.5, 5.0, true),
        hedging: band(hedge, 0.30, 0.90, true),
      };
      const bsScore = avg(Object.values(bsParts));

      /* ── TENANT / INCOME RISK ──────────────────────────────────────────
       * WALE 2–8yrs, occupancy 90–100%, top-tenant share 5–40% (lower better). */
      const tenantParts = {
        wale:       band(wale, 2, 8, true),
        occupancy:  band(occ, 0.90, 1.00, true),
        concentration: band(tr?.top_share, 0.05, 0.40, false),
      };
      const tenantScore = avg(Object.values(tenantParts));

      /* ── TAKEOVER APPEAL ───────────────────────────────────────────────
       * What makes a REIT bid-able: it trades below the value of its assets, it
       * is small enough to swallow, it is externally managed (so there is an
       * internalisation prize and a manager who can be bought out), and it is
       * under-geared (an acquirer can lever it further). */
      const takeoverParts = {
        discount_to_nta: band(discNta, 0.00, 0.40, true),
        size:            band(mcap, 200e6, 3000e6, false),
        external_mgmt:   isExternallyManaged ? 1 : 0,
        low_gearing:     band(gearing, 0.20, 0.45, false),
      };
      const takeoverScore = avg(Object.values(takeoverParts));

      /* ── FUNDAMENTAL VALUE ─────────────────────────────────────────────
       * Cheap against OUR fair value, clearing the gross IRR and yield hurdles. */
      const valueParts = {
        discount_to_fv: band(discFv, 0.00, 0.35, true),
        irr:            band(v?.irr_pre_tax, 0.06, 0.18, true),
        yield:          band(v?.yield_pre_tax, 0.04, 0.10, true),
      };
      const valueScore = avg(Object.values(valueParts));

      const singleMethod = v ? Object.keys(v.weights || {}).length === 1 : null;

      return {
        ticker: tk, name: s.name, subclass: s.reit_subclass, sector: s.landlord_sector,
        price: px, nta, discount_to_nta: r3(discNta),
        fair_value: v?.fair_value ?? null, discount_to_fair_value: r3(discFv),
        irr_pre_tax: v?.irr_pre_tax ?? null, yield_pre_tax: v?.yield_pre_tax ?? null,
        meets_hurdle: v?.meets_hurdle ?? null,
        valuation_is_single_method: singleMethod,
        gearing: r3(gearing), icr: r3(icr), hedge_ratio: r3(hedge),
        wale, occupancy: r3(occ), market_cap: mcap,
        externally_managed: isExternallyManaged,
        tenant: tr || null,
        scores: {
          balance_sheet: r3(bsScore), balance_sheet_parts: bsParts,
          tenant_risk:   r3(tenantScore), tenant_parts: tenantParts,
          takeover:      r3(takeoverScore), takeover_parts: takeoverParts,
          value:         r3(valueScore), value_parts: valueParts,
        },
        // How much of the picture we actually have. A high score on two inputs
        // is not the same as a high score on six.
        data_completeness: r3(avg([
          nta != null ? 1 : 0, gearing != null ? 1 : 0, icr != null ? 1 : 0,
          hedge != null ? 1 : 0, wale != null ? 1 : 0, occ != null ? 1 : 0,
          v ? 1 : 0, tr ? 1 : 0,
        ])),
      };
    });

    const rank = (key, dir = -1) => rows
      .filter(r => r.scores[key] != null)
      .sort((a, b) => dir * (a.scores[key] - b.scores[key]))
      .slice(0, 12);

    const screens = {
      takeover_targets:  rank('takeover'),
      fundamental_value: rank('value'),
      best_balance_sheet: rank('balance_sheet'),
      worst_balance_sheet: rank('balance_sheet', 1),
      shakiest_tenants:  rank('tenant_risk', 1),
      safest_income:     rank('tenant_risk'),
    };

    const withVal = rows.filter(r => r.fair_value != null).length;
    if (withVal < rows.length) warnings.push(`${rows.length - withVal} of ${rows.length} REITs have no valuation run — they cannot appear in the value screen. Run the value engine, or add assumptions for them.`);
    const noTenant = rows.filter(r => !r.tenant).length;
    if (noTenant) warnings.push(`${noTenant} REITs have no asset register, so tenant concentration is unknown and their tenant-risk score rests on WALE and occupancy alone.`);
    if (!bond?.aus_10yr) warnings.push('No live AUS 10yr — REIT yields cannot be spread against the long bond.');

    return json(200, {
      as_of: asOf,
      universe: rows.length,
      bond_anchor: bond ? { aus_10yr: bond.aus_10yr, source: bond.aus_10yr_source, as_at: bond.data_date } : null,
      screens, all: rows,
      coverage: { with_valuation: withVal, with_asset_register: rows.length - noTenant, total: rows.length },
      warnings,
    });
  } catch (err) {
    console.error('screen-reits failed:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' }, body: JSON.stringify(body) };
}
