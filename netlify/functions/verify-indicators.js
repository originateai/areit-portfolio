// netlify/functions/verify-indicators.js
// Verification script — compares our calculated indicators
// against EODHD's server-side calculations (ground truth)
// Run manually: https://areit.netlify.app/.netlify/functions/verify-indicators
// Optional: ?ticker=BHP to test a specific stock

const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── FETCH EODHD TECHNICAL INDICATORS (GROUND TRUTH) ──────────────────────────
async function getEODHDTechnicals(ticker) {
  try {
    const epic = `${ticker}.AU`;
    const results = {};

    // RSI 14
    const rsiRes = await fetch(
      `${BASE}/technical/${epic}?function=rsi&period=14&api_token=${KEY()}&fmt=json`
    );
    const rsiData = await rsiRes.json();
    if (Array.isArray(rsiData) && rsiData.length > 0) {
      results.rsi14 = parseFloat(rsiData[rsiData.length-1].rsi);
    }

    // SMA 20
    const sma20Res = await fetch(
      `${BASE}/technical/${epic}?function=sma&period=20&api_token=${KEY()}&fmt=json`
    );
    const sma20Data = await sma20Res.json();
    if (Array.isArray(sma20Data) && sma20Data.length > 0) {
      results.sma20 = parseFloat(sma20Data[sma20Data.length-1].sma);
    }

    // SMA 50
    const sma50Res = await fetch(
      `${BASE}/technical/${epic}?function=sma&period=50&api_token=${KEY()}&fmt=json`
    );
    const sma50Data = await sma50Res.json();
    if (Array.isArray(sma50Data) && sma50Data.length > 0) {
      results.sma50 = parseFloat(sma50Data[sma50Data.length-1].sma);
    }

    // SMA 200
    const sma200Res = await fetch(
      `${BASE}/technical/${epic}?function=sma&period=200&api_token=${KEY()}&fmt=json`
    );
    const sma200Data = await sma200Res.json();
    if (Array.isArray(sma200Data) && sma200Data.length > 0) {
      results.sma200 = parseFloat(sma200Data[sma200Data.length-1].sma);
    }

    // Bollinger Bands
    const bbRes = await fetch(
      `${BASE}/technical/${epic}?function=bbands&period=20&api_token=${KEY()}&fmt=json`
    );
    const bbData = await bbRes.json();
    if (Array.isArray(bbData) && bbData.length > 0) {
      const last = bbData[bbData.length-1];
      results.bb_upper = parseFloat(last.uband);
      results.bb_lower = parseFloat(last.lband);
      results.bb_mid   = parseFloat(last.mband);
    }

    return results;
  } catch(e) {
    console.error(`EODHD technicals error ${ticker}:`, e.message);
    return null;
  }
}

// ── CALCULATE OUR INDICATORS FROM DB PRICES ───────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const diffs  = closes.slice(1).map((c, i) => c - closes[i]);
  const gains  = diffs.map(d => d > 0 ? d : 0);
  const losses = diffs.map(d => d < 0 ? Math.abs(d) : 0);
  const avgG   = gains.slice(-period).reduce((a,b) => a+b, 0) / period;
  const avgL   = losses.slice(-period).reduce((a,b) => a+b, 0) / period;
  if (avgL === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgG / avgL))).toFixed(2));
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((a,b) => a+b, 0) / period).toFixed(4));
}

function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const mid    = slice.reduce((a,b) => a+b, 0) / period;
  const std    = Math.sqrt(slice.reduce((s,v) => s + Math.pow(v-mid, 2), 0) / period);
  return {
    upper: parseFloat((mid + mult * std).toFixed(4)),
    lower: parseFloat((mid - mult * std).toFixed(4)),
    mid:   parseFloat(mid.toFixed(4))
  };
}

// ── COMPARE AND SCORE ─────────────────────────────────────────────────────────
function compare(label, ours, theirs, tolerance = 0.02) {
  if (ours == null || theirs == null) {
    return { label, ours, theirs, diff: null, pctDiff: null, pass: null, note: 'Missing data' };
  }
  const diff    = Math.abs(ours - theirs);
  const pctDiff = theirs !== 0 ? (diff / Math.abs(theirs)) * 100 : 0;
  const pass    = pctDiff <= tolerance * 100;
  return {
    label,
    ours:    parseFloat(ours.toFixed(4)),
    theirs:  parseFloat(theirs.toFixed(4)),
    diff:    parseFloat(diff.toFixed(4)),
    pctDiff: parseFloat(pctDiff.toFixed(2)),
    pass,
    note:    pass ? '✓ Within tolerance' : `✗ Off by ${pctDiff.toFixed(1)}%`
  };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const db      = getDB();
  const params  = event.queryStringParameters || {};
  
  // Test these stocks by default — liquid, well-known, good for validation
  const testTickers = params.ticker
    ? [params.ticker.toUpperCase()]
    : ['BHP', 'CBA', 'CSL', 'WBC', 'XRO', 'HDN', 'DXC', 'WPR'];

  console.log(`Verifying indicators for: ${testTickers.join(', ')}`);

  const results = [];

  for (const ticker of testTickers) {
    console.log(`Testing ${ticker}...`);

    try {
      // Get our prices from DB
      const { data: priceRows } = await db
        .from('prices')
        .select('market_date, close, high, low, open, volume')
        .eq('ticker', ticker)
        .order('market_date', { ascending: true })
        .limit(250);

      if (!priceRows || priceRows.length < 20) {
        results.push({
          ticker,
          error: `Only ${priceRows?.length || 0} days of price history — need 200+ for full validation`,
          checks: []
        });
        continue;
      }

      const closes = priceRows.map(p => parseFloat(p.close));
      const days   = closes.length;

      // Calculate our indicators
      const ourRSI    = calcRSI(closes, 14);
      const ourSMA20  = calcSMA(closes, 20);
      const ourSMA50  = calcSMA(closes, 50);
      const ourSMA200 = calcSMA(closes, 200);
      const ourBB     = calcBollinger(closes, 20, 2);

      // Get EODHD ground truth
      const eodhd = await getEODHDTechnicals(ticker);
      await new Promise(r => setTimeout(r, 500)); // rate limit

      if (!eodhd) {
        results.push({ ticker, error: 'EODHD technical fetch failed', checks: [] });
        continue;
      }

      // Compare
      const checks = [
        compare('RSI 14',     ourRSI,          eodhd.rsi14,   0.02),
        compare('SMA 20',     ourSMA20,        eodhd.sma20,   0.001),
        compare('SMA 50',     ourSMA50,        eodhd.sma50,   0.001),
        compare('SMA 200',    ourSMA200,       eodhd.sma200,  0.001),
        compare('BB Upper',   ourBB?.upper,    eodhd.bb_upper, 0.01),
        compare('BB Lower',   ourBB?.lower,    eodhd.bb_lower, 0.01),
        compare('BB Mid',     ourBB?.mid,      eodhd.bb_mid,   0.001),
      ];

      const passed = checks.filter(c => c.pass === true).length;
      const failed = checks.filter(c => c.pass === false).length;
      const missing = checks.filter(c => c.pass === null).length;

      results.push({
        ticker,
        days_of_history: days,
        passed,
        failed,
        missing,
        overall: failed === 0 ? '✓ ALL PASS' : `✗ ${failed} FAILED`,
        checks
      });

      console.log(`${ticker}: ${passed} passed, ${failed} failed, ${missing} missing data`);

    } catch(e) {
      results.push({ ticker, error: e.message, checks: [] });
    }
  }

  // Summary
  const totalPassed  = results.reduce((s,r) => s + (r.passed||0), 0);
  const totalFailed  = results.reduce((s,r) => s + (r.failed||0), 0);
  const totalMissing = results.reduce((s,r) => s + (r.missing||0), 0);

  const summary = {
    tested:        testTickers.length,
    total_checks:  totalPassed + totalFailed + totalMissing,
    passed:        totalPassed,
    failed:        totalFailed,
    missing_data:  totalMissing,
    verdict:       totalFailed === 0
      ? '✓ All indicators validated — formulas are correct'
      : `⚠️ ${totalFailed} indicator(s) off — review failed checks`,
    results
  };

  console.log(`\nSummary: ${totalPassed} passed, ${totalFailed} failed`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summary, null, 2)
  };
};
