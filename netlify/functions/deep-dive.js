// netlify/functions/deep-dive.js
// The full picture on one REIT: micro from the asset register up, macro from the
// rate environment down, and — the part that actually matters — how the two
// interact.
//
// GET /.netlify/functions/deep-dive?ticker=CIP
//     &narrative=1   also have Claude write it up
//
// ── THE FRAMING ──────────────────────────────────────────────────────────────
// An A-REIT's macro sensitivity is not a single number, and "REITs go up when
// rates fall" is too crude to invest on. What determines who benefits is the
// SHAPE of the income:
//
//   LONG WALE + TIGHT CAP  -> a bond proxy. The income is contracted and fixed,
//     so its value moves inversely with the discount rate. Falling rates are a
//     tailwind; inflation is a headwind, because rent is locked while the
//     replacement cost of the asset rises.
//
//   SHORT WALE + UNDER-RENTED -> an inflation beneficiary. Leases roll quickly
//     onto market rent, so a rising rent environment is captured within a couple
//     of years rather than a decade. The same short WALE is a risk when demand
//     is falling — it cuts both ways, which is exactly why it needs to be shown
//     alongside the reversion assumption rather than scored on its own.
//
//   HIGH GEARING + LOW HEDGING + NEAR MATURITY -> rate-exposed regardless of the
//     property. The balance sheet transmits the macro before the portfolio does.
//
// Everything below is computed from stored data; nothing is asserted that the
// numbers do not support, and gaps are reported as gaps.

const { getSupabase } = require('./_shared.js');

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const pct = v => v == null ? null : Math.round(v * 10000) / 100;

exports.handler = async (event) => {
  const db = getSupabase();
  const qs = event.queryStringParameters || {};
  const ticker = String(qs.ticker || '').toUpperCase().trim();
  if (!ticker) return json(400, { error: 'ticker is required' });

  try {
    const [stockR, assetsR, fundR, valR, bondR, brokerR, docsR, holdR, peersR] = await Promise.all([
      db.from('stocks').select('*').eq('ticker', ticker).limit(1),
      db.from('reit_assets').select('*').eq('ticker', ticker).eq('is_excluded', false),
      db.from('reit_fundamentals').select('*').eq('ticker', ticker).order('release_date', { ascending: false }).limit(4),
      db.from('valuation_runs').select('*').eq('ticker', ticker).order('as_of', { ascending: false }).limit(1),
      db.from('bond_data').select('*').order('data_date', { ascending: false }).limit(1),
      db.from('reit_broker_forecasts').select('*').eq('ticker', ticker).order('note_date', { ascending: false }),
      db.from('document_uploads').select('doc_type,title,doc_date,summary,author,rating,price_target').eq('ticker', ticker).order('doc_date', { ascending: false }).limit(20),
      db.from('holdings').select('*').eq('ticker', ticker).limit(1),
      // Sector peers, for cap-rate context. A 5.8% WACR means nothing in isolation.
      db.from('reit_fundamentals').select('ticker,wacr,gearing,wale,occupancy,release_date').not('wacr', 'is', null),
    ]);

    const s = stockR.data?.[0] || null;
    const assets = (assetsR.data || []).filter(a => num(a.passing_income_m) > 0 && num(a.cap_rate) > 0);
    const fund = fundR.data?.[0] || null;
    const val = valR.data?.[0] || null;
    const bond = bondR.data?.[0] || null;
    const holding = holdR.data?.[0] || null;

    const warnings = [];
    if (!assets.length) warnings.push(`No asset register for ${ticker} — every micro figure below is unavailable. Load a property compendium to unlock it.`);
    if (!fund) warnings.push(`No point-in-time fundamentals for ${ticker}.`);

    // ── MICRO ────────────────────────────────────────────────────────────────
    const totalIncome = assets.reduce((t, a) => t + num(a.passing_income_m), 0);
    const totalValue = assets.reduce((t, a) => t + (num(a.book_value_m) || 0), 0);
    const impliedWacr = totalValue > 0 ? totalIncome / totalValue : null;

    const groupBy = (key) => {
      const m = {};
      assets.forEach(a => { const k = (a[key] || 'unattributed').trim(); m[k] = (m[k] || 0) + num(a.passing_income_m); });
      return Object.entries(m).map(([k, v]) => ({ key: k, income_m: r3(v), share: r3(v / totalIncome) }))
        .sort((x, y) => y.share - x.share);
    };
    const byTenant = groupBy('major_tenant'), bySector = groupBy('sector'), byState = groupBy('state');

    // Lease expiry buckets, weighted by INCOME rather than by asset count —
    // a short lease on a small asset is not the same risk as one on a big asset.
    const waleBuckets = { '0-2y': 0, '2-5y': 0, '5-10y': 0, '10y+': 0, unknown: 0 };
    assets.forEach(a => {
      const w = num(a.wale_years), inc = num(a.passing_income_m);
      if (w == null) waleBuckets.unknown += inc;
      else if (w < 2) waleBuckets['0-2y'] += inc;
      else if (w < 5) waleBuckets['2-5y'] += inc;
      else if (w < 10) waleBuckets['5-10y'] += inc;
      else waleBuckets['10y+'] += inc;
    });
    Object.keys(waleBuckets).forEach(k => waleBuckets[k] = r3(waleBuckets[k] / (totalIncome || 1)));

    const incomeWeightedWale = totalIncome > 0
      ? assets.filter(a => num(a.wale_years) != null)
          .reduce((t, a) => t + num(a.wale_years) * num(a.passing_income_m), 0) /
        assets.filter(a => num(a.wale_years) != null).reduce((t, a) => t + num(a.passing_income_m), 0)
      : null;

    // Cap-rate outliers: the assets the market (or the valuer) is treating very
    // differently from the rest of the book. Both ends are informative — the
    // tight end is where the value is concentrated, the wide end is where the
    // doubt is.
    const sorted = [...assets].sort((a, b) => num(a.cap_rate) - num(b.cap_rate));
    const tightest = sorted.slice(0, 5).map(a => ({ asset: a.asset_name, cap_rate: num(a.cap_rate), value_m: num(a.book_value_m), wale: num(a.wale_years), tenant: a.major_tenant }));
    const widest = sorted.slice(-5).reverse().map(a => ({ asset: a.asset_name, cap_rate: num(a.cap_rate), value_m: num(a.book_value_m), wale: num(a.wale_years), tenant: a.major_tenant }));

    const largest = [...assets].sort((a, b) => (num(b.book_value_m) || 0) - (num(a.book_value_m) || 0)).slice(0, 5)
      .map(a => ({ asset: a.asset_name, value_m: num(a.book_value_m), share_of_value: r3((num(a.book_value_m) || 0) / totalValue), cap_rate: num(a.cap_rate), wale: num(a.wale_years), tenant: a.major_tenant }));

    const lowOccupancy = assets.filter(a => num(a.occupancy) != null && num(a.occupancy) < 0.9)
      .map(a => ({ asset: a.asset_name, occupancy: num(a.occupancy), value_m: num(a.book_value_m), tenant: a.major_tenant }))
      .sort((a, b) => a.occupancy - b.occupancy);

    // ── MACRO POSITIONING ────────────────────────────────────────────────────
    const aus10 = bond?.aus_10yr != null ? Number(bond.aus_10yr) : null;
    const spreadToBond = (impliedWacr != null && aus10 != null) ? impliedWacr - aus10 : null;

    const gearing = num(fund?.gearing) ?? num(s?.gearing);
    const hedge = num(fund?.hedge_pct);
    const shortWaleShare = waleBuckets['0-2y'] + waleBuckets['2-5y'];

    /* Bond-proxy vs inflation-beneficiary. Deliberately expressed as two separate
     * readings rather than one axis, because a REIT can be neither (a mid-WALE
     * book at a mid cap rate is simply not strongly positioned either way) and
     * collapsing that into a single score would invent a view. */
    const bondProxy = (incomeWeightedWale != null && impliedWacr != null)
      ? r3(Math.min(1, Math.max(0, (incomeWeightedWale - 3) / 9)) * 0.6 +
           Math.min(1, Math.max(0, (0.075 - impliedWacr) / 0.03)) * 0.4)
      : null;
    const inflationBeneficiary = (incomeWeightedWale != null)
      ? r3(Math.min(1, Math.max(0, (6 - incomeWeightedWale) / 4)) * 0.6 + Math.min(1, shortWaleShare) * 0.4)
      : null;
    const rateExposure = (gearing != null)
      ? r3(Math.min(1, Math.max(0, (gearing - 0.20) / 0.25)) * 0.6 +
           (hedge != null ? (1 - hedge) * 0.4 : 0.2))
      : null;

    // Peer cap-rate context — a cap rate only means something against its cohort.
    const peers = (peersR.data || []).filter(p => p.ticker !== ticker);
    const peerWacrs = peers.map(p => Number(p.wacr)).filter(Number.isFinite);
    const peerMedian = peerWacrs.length
      ? peerWacrs.sort((a, b) => a - b)[Math.floor(peerWacrs.length / 2)] : null;

    const micro = {
      assets: assets.length, portfolio_value_m: r3(totalValue), passing_income_m: r3(totalIncome),
      implied_wacr: r3(impliedWacr),
      cap_rate_range: assets.length ? [Math.min(...assets.map(a => num(a.cap_rate))), Math.max(...assets.map(a => num(a.cap_rate)))] : null,
      cap_spread_bps: assets.length ? Math.round((Math.max(...assets.map(a => num(a.cap_rate))) - Math.min(...assets.map(a => num(a.cap_rate)))) * 10000) : null,
      income_weighted_wale: r3(incomeWeightedWale),
      lease_expiry_by_income: waleBuckets,
      tenant_concentration: { top1: byTenant[0] || null, top3_share: r3(byTenant.slice(0, 3).reduce((t, x) => t + x.share, 0)), full: byTenant.slice(0, 10) },
      sector_mix: bySector, state_mix: byState,
      largest_assets: largest, tightest_cap_rates: tightest, widest_cap_rates: widest,
      low_occupancy_assets: lowOccupancy,
    };

    const macro = {
      aus_10yr: aus10, aus_10yr_source: bond?.aus_10yr_source || null,
      spread_to_bond_bps: spreadToBond != null ? Math.round(spreadToBond * 10000) : null,
      peer_median_wacr: r3(peerMedian),
      vs_peer_bps: (impliedWacr != null && peerMedian != null) ? Math.round((impliedWacr - peerMedian) * 10000) : null,
      positioning: {
        bond_proxy: bondProxy,
        inflation_beneficiary: inflationBeneficiary,
        rate_exposure: rateExposure,
        gearing, hedge_pct: hedge,
        reading: bondProxy == null ? 'insufficient data'
          : bondProxy > 0.6 ? 'Bond proxy — long contracted income at a tight cap rate. Benefits from falling rates; inflation erodes the real value of locked rent.'
          : inflationBeneficiary > 0.6 ? 'Inflation beneficiary — short WALE rolls onto market rent quickly. Benefits from rising rents; the same short WALE is the risk if demand turns.'
          : 'Neither strongly — mid WALE at a mid cap rate. Macro is not the main driver of this one; asset and tenant selection is.',
      },
    };

    const payload = {
      ticker, name: s?.name || null, subclass: s?.reit_subclass || null,
      as_of: new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10),
      micro, macro,
      reported: fund ? {
        period_end: fund.period_end, release_date: fund.release_date,
        nta: num(fund.nta), wacr: num(fund.wacr), gearing: num(fund.gearing),
        icr: num(fund.icr), hedge_pct: num(fund.hedge_pct),
        wale: num(fund.wale), occupancy: num(fund.occupancy), dps: num(fund.dps),
        ffo: num(fund.ffo), npi: num(fund.npi),
        portfolio_value: num(fund.portfolio_value),
        lfl_noi_growth: num(fund.lfl_noi_growth),
        wade_years: num(fund.wade_years),
      } : null,

      /* The company's OWN forward view. Without this the narrative can only
       * describe the past — and guidance is the one forward number that is
       * published rather than modelled, so it anchors everything. */
      guidance: fund?.guidance_fy ? {
        fy: fund.guidance_fy,
        ffo_per_security_low: num(fund.guidance_ffo_low),
        ffo_per_security_high: num(fund.guidance_ffo_high),
        dps_per_security: num(fund.guidance_dps),
        implied_dps_growth: (num(fund.guidance_dps) != null && num(fund.dps))
          ? r3((num(fund.guidance_dps) - num(fund.dps)) / num(fund.dps)) : null,
      } : null,

      /* Several periods of reported history, so the reader can see whether the
       * trajectory is improving or deteriorating rather than judging one point
       * in isolation. */
      history: (fundR.data || []).map(h => ({
        period_end: h.period_end, release_date: h.release_date,
        nta: num(h.nta), wacr: num(h.wacr), gearing: num(h.gearing),
        occupancy: num(h.occupancy), wale: num(h.wale), dps: num(h.dps),
        lfl_noi_growth: num(h.lfl_noi_growth),
      })),
      valuation: val ? {
        price: num(val.price), fair_value: num(val.fair_value),
        discount: num(val.discount_to_fair_value), irr_pre_tax: num(val.irr_pre_tax),
        yield_pre_tax: num(val.yield_pre_tax), meets_hurdle: val.meets_hurdle,
        methods: Object.keys(val.weights || {}),
      } : null,
      our_position: holding ? { units: num(holding.units), cost_base: num(holding.cost_base) } : null,
      broker_panel: (brokerR.data || []).map(b => ({ broker: b.broker_name, date: b.note_date, rating: b.rating, target: num(b.valuation) })),
      research_on_file: (docsR.data || []).length,
      warnings,
    };

    if (qs.narrative !== '1') return json(200, payload);

    // ── NARRATIVE ────────────────────────────────────────────────────────────
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return json(200, { ...payload, narrative_error: 'ANTHROPIC_API_KEY not set' });

    const SYSTEM = `You are writing a deep-dive on one Australian REIT for its owner, a
professional investor building a retirement income portfolio against a 12% IRR and
7% yield hurdle measured gross.

Write for a peer. No preamble, no disclaimers, no restating the question.

Use ONLY the supplied context. Every number you cite must be in it. If something
is not there, say what is missing and why it matters — a gap is a finding.

Structure, omitting any section the data cannot support:

## The portfolio
What this REIT actually owns, from the asset level. Concentration, quality, where
the value sits.

## Micro risks
Specific and asset-named. Tenant concentration, lease expiry against the reversion
assumption, occupancy, single-asset dependency, cap rates that look wrong versus
the rest of the book.

## Micro opportunities
Where the upside is and what has to happen for it to arrive.

## Macro: who this benefits
Is it a bond proxy or an inflation beneficiary, and WHY, from its WALE and cap
rate — not from a generic view on REITs. Say what rate path helps and what hurts.
Where the balance sheet transmits macro before the portfolio does, say so.

## Track record and outlook
What the reported history shows about the trajectory — is NTA, occupancy, gearing
and LFL growth improving or deteriorating? Then what the company GUIDES for next
year, and whether that guidance looks conservative or brave against what they have
actually delivered. Guidance is the only published forward number; treat it as a
claim to be tested, not a fact.

## What would change the view
The two or three observable things that would move this from hold to buy or sell.

Be concrete. One sharp sentence with a number beats three general ones. Always cite
guidance and reported history where the context carries them — a view that ignores
what the company has said about its own next year is not a view.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 3000, system: SYSTEM,
        messages: [{ role: 'user', content: `Deep dive on ${ticker}.\n\n<context>\n${JSON.stringify(payload, null, 1)}\n</context>` }],
      }),
    });
    if (!res.ok) return json(200, { ...payload, narrative_error: `Anthropic ${res.status}` });
    const out = await res.json();
    const narrative = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

    return json(200, { ...payload, narrative });
  } catch (err) {
    console.error('deep-dive failed:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
