// netlify/functions/fetch-bond-yields.js
// Daily bond / macro snapshot into `bond_data`.
//
// WHY THIS EXISTS: the Australian 10-year yield was HARDCODED at 0.0507 in both
// morning-scan.js (`const aus10yr = 0.0507`) and public/index.html (`const BOND =
// 0.0507`). The REIT macro layer scores "AUS 10yr low -> REITs attractive" off
// that number, and A-REITs are priced off their spread to the long bond more than
// off anything else, so a frozen yield quietly freezes the whole REIT signal.
//
// THE RULE HERE: if no source resolves, aus_10yr is written NULL and
// aus_10yr_source is NULL. It is never backfilled with a constant. A missing
// yield that renders as an em dash is honest; a stale one that looks live is not.
//
// UNITS: every yield stored here is a DECIMAL fraction (0.0507 = 5.07%), per
// SPEC.md §1.3. Yahoo's ^TNX quotes percent (4.31 = 4.31%), so it is divided by
// 100 on the way in. FRED long-rate series are also percent.
//
// Manual run: POST /.netlify/functions/fetch-bond-yields   (?dry=1 to preview)

const { getSupabase, fetchYahoo, fetchFRED } = require('./_shared.js');

const EODHD_KEY = process.env.EODHD_API_KEY || process.env.EODHD_KEY;

/** EODHD government-bond yield. Returns a decimal fraction, or null. */
async function eodhdBond(symbol) {
  if (!EODHD_KEY) return null;
  try {
    const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const v = Number(j && (j.close ?? j.previousClose));
    // A government bond yield quoted in percent. Anything outside 0-25% is not a
    // yield — most likely a price — so refuse it rather than store nonsense.
    if (!Number.isFinite(v) || v <= 0 || v > 25) return null;
    return v / 100;
  } catch { return null; }
}

/** FRED series -> decimal fraction. FRED long rates are quoted in percent. */
async function fredRate(series) {
  try {
    const v = await fetchFRED(series);
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 25) return null;
    return n > 1 ? n / 100 : n;   // tolerate either convention, clamp to decimal
  } catch { return null; }
}

exports.handler = async (event) => {
  const db = getSupabase();
  const qs = (event && event.queryStringParameters) || {};
  const dry = qs.dry === '1' || qs.dry === 'true';
  const dataDate = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10); // AEST
  const warnings = [];

  try {
    const [tnx, vix, aud, gold, oil, copper] = await Promise.all([
      fetchYahoo('^TNX'), fetchYahoo('^VIX'), fetchYahoo('AUDUSD=X'),
      fetchYahoo('GC=F'), fetchYahoo('CL=F'), fetchYahoo('HG=F'),
    ]);

    const us10 = tnx?.price != null ? Number(tnx.price) / 100 : null;
    if (us10 == null) warnings.push('US 10yr (^TNX) unavailable — us_10yr is null.');

    // AUS 10yr: EODHD first, FRED second, then give up. Never a constant.
    let aus10 = await eodhdBond('AU10Y.GBOND');
    let ausSrc = aus10 != null ? 'eodhd' : null;
    if (aus10 == null) {
      aus10 = await fredRate('IRLTLT01AUM156N');   // OECD long-term rate, Australia
      ausSrc = aus10 != null ? 'fred' : null;
      if (aus10 != null) warnings.push('AUS 10yr from FRED IRLTLT01AUM156N — this series is MONTHLY and lags; treat as indicative.');
    }
    if (aus10 == null) {
      warnings.push('AUS 10yr unresolved from EODHD and FRED — written NULL. It is deliberately NOT defaulted to the old hardcoded 0.0507; a stale yield that looks live is worse than a blank.');
    }

    const [us2, realYield, breakeven] = await Promise.all([
      fredRate('DGS2'), fredRate('DFII10'), fredRate('T10YIE'),
    ]);

    // REIT spread — the actual A-REIT valuation signal. Forward portfolio yield
    // less the long bond. Needs a real AUS 10yr, so it is null when that is.
    let reitSpread = null, fwdYield = null;
    try {
      const { data: h } = await db.from('holdings').select('ticker, units, cost_base, brokerage, asset_class').eq('is_open', true);
      const reits = (h || []).filter(r => r.asset_class === 'reit');
      if (reits.length) {
        const { data: s } = await db.from('stocks').select('ticker, dps_fy26').in('ticker', reits.map(r => r.ticker));
        const dps = Object.fromEntries((s || []).map(r => [r.ticker, r.dps_fy26]));
        let inc = 0, cost = 0;
        reits.forEach(r => {
          const d = dps[r.ticker];
          if (d != null) { inc += Number(r.units) * Number(d); cost += Number(r.cost_base || 0) + Number(r.brokerage || 0); }
        });
        if (cost > 0) fwdYield = inc / cost;
      }
      if (fwdYield != null && aus10 != null) reitSpread = fwdYield - aus10;
    } catch (e) { warnings.push('REIT spread not computed: ' + e.message); }

    const row = {
      data_date: dataDate,
      us_10yr: us10, us_2yr: us2,
      aus_10yr: aus10, aus_10yr_source: ausSrc,
      us_10yr_source: us10 != null ? 'yahoo:^TNX' : null,
      yield_curve_us: (us10 != null && us2 != null) ? us10 - us2 : null,
      real_yield: realYield, breakeven_infl: breakeven,
      vix: vix?.price ?? null,
      aud_usd: aud?.price ?? null,
      gold_price: gold?.price ?? null,
      oil_price: oil?.price ?? null,
      copper_price: copper?.price ?? null,
      reit_spread: reitSpread,
    };

    if (dry) return json(200, { ok: true, dry_run: true, row, forward_reit_yield: fwdYield, warnings });

    const { error } = await db.from('bond_data').upsert(row, { onConflict: 'data_date' });
    if (error) throw new Error(`bond_data upsert: ${error.message}`);

    return json(200, {
      ok: true, data_date: dataDate, row, forward_reit_yield: fwdYield, warnings,
      message: aus10 != null
        ? `Bond snapshot written. AUS 10yr ${(aus10 * 100).toFixed(2)}% (${ausSrc})` +
          (reitSpread != null ? `, REIT spread ${(reitSpread * 10000).toFixed(0)}bps.` : '.')
        : 'Bond snapshot written, but AUS 10yr could not be resolved and is NULL.',
    });
  } catch (err) {
    console.error('fetch-bond-yields failed:', err.message);
    return json(500, { error: err.message, data_date: dataDate, warnings });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
