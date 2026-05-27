// netlify/functions/fetch-indicators.js
// Runs at 6:50am AEST (8:50pm UTC prev day) Mon-Fri
// Reads adjusted_close from Supabase prices table
// Calculates ALL indicators from scratch using correct rolling formulas
// Stores to daily_analysis so morning-scan just reads and scores

const { schedule }    = require('@netlify/functions');
const { getSupabase } = require('./_shared');

// ── INDICATOR CALCULATIONS ────────────────────────────────────────────────────

function wilderRSI(closes, period=14) {
  if (closes.length < period + 1) return 50;
  const d = closes.slice(1).map((v,i) => v - closes[i]);
  const g = d.map(v => v > 0 ? v : 0);
  const l = d.map(v => v < 0 ? -v : 0);
  let ag = g.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let al = l.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < d.length; i++) {
    ag = (ag*(period-1) + g[i]) / period;
    al = (al*(period-1) + l[i]) / period;
  }
  return al === 0 ? 100 : 100 - (100 / (1 + ag/al));
}

function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a,b)=>a+b,0) / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function bollingerBands(closes, period=20) {
  if (closes.length < period) return null;
  const sl   = closes.slice(-period);
  const mean = sl.reduce((a,b)=>a+b,0) / period;
  const std  = Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/period);
  return { upper: mean+2*std, lower: mean-2*std, mid: mean, std };
}

function macdCalc(closes) {
  if (closes.length < 26) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  return { macd: macdLine, signal: macdLine * 0.85 }; // simplified signal
}

function atrCalc(highs, lows, closes, period=14) {
  if (closes.length < period+1) return null;
  const trs = highs.slice(1).map((h,i) => Math.max(
    h - lows[i+1],
    Math.abs(h - closes[i]),
    Math.abs(lows[i+1] - closes[i])
  ));
  return trs.slice(-period).reduce((a,b)=>a+b,0) / period;
}

function roc(closes, period=20) {
  if (closes.length <= period) return null;
  const prev = closes[closes.length - 1 - period];
  return prev > 0 ? (closes[closes.length-1] - prev) / prev : null;
}

// ── CALCULATE ALL INDICATORS FOR ONE TICKER ───────────────────────────────────
function calcIndicators(ticker, priceRows, today) {
  if (!priceRows || priceRows.length < 30) return null;

  // Sort chronologically, use adjusted_close for calculations
  const rows   = [...priceRows].sort((a,b) => a.market_date.localeCompare(b.market_date));
  const closes = rows.map(r => parseFloat(r.adjusted_close || r.close));
  const highs  = rows.map(r => parseFloat(r.high  || r.close));
  const lows   = rows.map(r => parseFloat(r.low   || r.close));
  const opens  = rows.map(r => parseFloat(r.open  || r.close));
  const vols   = rows.map(r => parseInt(r.volume  || 0));
  const n      = rows.length;
  const price  = parseFloat(rows[n-1].close); // display price = raw close
  const adjPx  = closes[n-1];

  const rsi14   = wilderRSI(closes, 14);
  const ma20    = sma(closes, 20);
  const ma50    = sma(closes, 50);
  const ma200   = sma(closes, 200);
  const bb      = bollingerBands(closes, 20);
  const macdRes = macdCalc(closes);
  const atr14   = atrCalc(highs, lows, closes, 14);
  const roc20   = roc(closes, 20);
  const roc5    = roc(closes, 5);

  // Volume ratio
  const avgVol20  = vols.slice(-21,-1).reduce((a,b)=>a+b,0) / 20;
  const vol_ratio = avgVol20 > 0 ? vols[n-1] / avgVol20 : 1;

  // Candle features
  const body         = Math.abs(price - opens[n-1]);
  const range        = highs[n-1] - lows[n-1];
  const lower_shadow = Math.min(opens[n-1], price) - lows[n-1];
  const upper_shadow = highs[n-1] - Math.max(opens[n-1], price);
  const hammer       = lower_shadow > body * 2 && upper_shadow < body * 0.5;
  const bull_candle  = price > opens[n-1];

  const bb_pos = bb ? (adjPx - bb.lower) / (bb.upper - bb.lower) : null;
  const pct_from_ma20  = ma20  ? (adjPx - ma20)  / ma20  : null;
  const pct_from_ma200 = ma200 ? (adjPx - ma200) / ma200 : null;
  const above_ma20     = ma20  ? adjPx > ma20  : null;
  const above_ma200    = ma200 ? adjPx > ma200 : null;
  const golden_cross   = ma50 && ma200 ? ma50 > ma200 : null;

  return {
    ticker,
    analysis_date:   today,
    close:           price,
    rsi14:           parseFloat(rsi14.toFixed(4)),
    ma20:            ma20  ? parseFloat(ma20.toFixed(4))  : null,
    ma50:            ma50  ? parseFloat(ma50.toFixed(4))  : null,
    ma200:           ma200 ? parseFloat(ma200.toFixed(4)) : null,
    bb_upper:        bb    ? parseFloat(bb.upper.toFixed(4)) : null,
    bb_lower:        bb    ? parseFloat(bb.lower.toFixed(4)) : null,
    bb_position:     bb_pos ? parseFloat(bb_pos.toFixed(6)) : null,
    macd:            macdRes ? parseFloat(macdRes.macd.toFixed(6))   : null,
    macd_signal:     macdRes ? parseFloat(macdRes.signal.toFixed(6)) : null,
    adx:             null, // ADX requires DI+/DI- — skip for now, use from EODHD if needed
    atr:             atr14 ? parseFloat(atr14.toFixed(4)) : null,
    roc20:           roc20 ? parseFloat(roc20.toFixed(6)) : null,
    roc5:            roc5  ? parseFloat(roc5.toFixed(6))  : null,
    vol_ratio:       parseFloat(vol_ratio.toFixed(4)),
    above_ma20,
    above_ma200,
    golden_cross,
    pct_from_ma20:   pct_from_ma20  ? parseFloat(pct_from_ma20.toFixed(6))  : null,
    pct_from_ma200:  pct_from_ma200 ? parseFloat(pct_from_ma200.toFixed(6)) : null,
    candle_hammer:   hammer,
    candle_engulfing_bull: bull_candle && body > 0.01 * price,
    candle_doji:     body < range * 0.1,
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
const run = async () => {
  const db    = getSupabase();
  const today = new Date(Date.now() + 10*60*60*1000).toISOString().split('T')[0];
  // Need 400 calendar days to guarantee 200+ trading days (ASX ~250 trading days/year)
  // 260 calendar days = only ~186 trading days — not enough for MA200
  const cutoff = new Date(Date.now() - 400*24*60*60*1000).toISOString().split('T')[0];
  console.log(`Fetch indicators starting: ${today}`);

  try {
    // Load all active stocks
    const { data: stocks } = await db.from('stocks')
      .select('ticker')
      .eq('active', true)
      .neq('ticker', 'GSBG37')
      .order('id', { ascending: true });

    if (!stocks?.length) return { statusCode: 200, body: 'No stocks' };
    console.log(`Processing ${stocks.length} stocks`);

    const tickers = stocks.map(s => s.ticker);

    // Load price history per-ticker to avoid Supabase's 1000-row default limit.
    // Fetching multi-ticker batches with .limit(N*270) silently caps at 1000 rows,
    // giving only ~100 rows per ticker instead of 270 — not enough for MA200/RSI.
    // Per-ticker fetch with .limit(270) guarantees each ticker gets its full history.
    const priceMap = {};
    const PARALLEL = 8; // concurrent per-ticker fetches

    for (let i = 0; i < tickers.length; i += PARALLEL) {
      const group = tickers.slice(i, i + PARALLEL);
      const results = await Promise.all(group.map(ticker =>
        db.from('prices')
          .select('ticker,market_date,open,high,low,close,adjusted_close,volume')
          .eq('ticker', ticker)
          .gte('market_date', cutoff)
          .order('market_date', { ascending: true })
          .limit(400)  // 400 calendar days guarantees 200+ trading days for MA200
      ));
      results.forEach(({ data }) => {
        (data||[]).forEach(p => {
          if (!priceMap[p.ticker]) priceMap[p.ticker] = [];
          priceMap[p.ticker].push(p);
        });
      });
    }
    console.log(`Prices loaded for ${Object.keys(priceMap).length} tickers`);

    // Calculate indicators for each ticker
    const rows = [];
    for (const ticker of tickers) {
      const ind = calcIndicators(ticker, priceMap[ticker], today);
      if (ind) rows.push(ind);
    }
    console.log(`Indicators calculated for ${rows.length} tickers`);

    // Upsert to daily_analysis in chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.from('daily_analysis')
        .upsert(rows.slice(i, i+CHUNK), { onConflict: 'ticker,analysis_date' });
    }

    console.log(`Fetch indicators complete: ${rows.length}/${stocks.length} saved`);
    return { statusCode: 200, body: JSON.stringify({ saved: rows.length, total: stocks.length, date: today }) };

  } catch(e) {
    console.error('Fetch indicators failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

exports.handler = schedule('50 20 * * 0-4', run); // 6:50am AEST = 8:50pm UTC prev day
