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
  const rows      = [...priceRows].sort((a,b) => a.market_date.localeCompare(b.market_date));
  const adjCloses = rows.map(r => parseFloat(r.adjusted_close || r.close)); // adjusted for RSI/MA/MACD
  const closes    = rows.map(r => parseFloat(r.close));                     // raw close for candles/display
  const highs     = rows.map(r => parseFloat(r.high  || r.close));
  const lows      = rows.map(r => parseFloat(r.low   || r.close));
  const opens     = rows.map(r => parseFloat(r.open  || r.close));
  const vols      = rows.map(r => parseInt(r.volume  || 0));
  const n         = rows.length;
  const price     = closes[n-1];   // raw close for display
  const adjPx     = adjCloses[n-1]; // adjusted close for indicator comparisons

  // Use adjusted closes for all indicator calculations (continuity across dividends/splits)
  const rsi14   = wilderRSI(adjCloses, 14);
  const ma20    = sma(adjCloses, 20);
  const ma50    = sma(adjCloses, 50);
  const ma200   = sma(adjCloses, 200);
  const bb      = bollingerBands(adjCloses, 20);
  const macdRes = macdCalc(adjCloses);
  const atr14   = atrCalc(highs, lows, adjCloses, 14);
  const roc20   = roc(adjCloses, 20);
  const roc5    = roc(adjCloses, 5);

  // Volume ratio
  const avgVol20  = vols.slice(-21,-1).reduce((a,b)=>a+b,0) / 20;
  const vol_ratio = avgVol20 > 0 ? vols[n-1] / avgVol20 : 1;

  // Candle detection — use RAW closes only (not adjusted), all on same price scale
  // Candle 0 = today, Candle 1 = yesterday, Candle 2 = day before
  const c0_close = closes[n-1], c0_open = opens[n-1], c0_high = highs[n-1], c0_low = lows[n-1];
  const c1_close = closes[n-2], c1_open = opens[n-2], c1_high = highs[n-2], c1_low = lows[n-2];
  const c2_close = n >= 3 ? closes[n-3] : c1_close;
  const c2_open  = n >= 3 ? opens[n-3]  : c1_open;

  const body0  = Math.abs(c0_close - c0_open);
  const body1  = Math.abs(c1_close - c1_open);
  const range0 = c0_high - c0_low;
  const range1 = c1_high - c1_low;
  const lower_shadow = Math.min(c0_open, c0_close) - c0_low;
  const upper_shadow = c0_high - Math.max(c0_open, c0_close);
  const bull0  = c0_close > c0_open;
  const bull1  = c1_close > c1_open;
  const bear1  = !bull1;
  const bear2  = c2_close < c2_open;

  // Hammer: bearish prev day, long lower shadow > 2x body, small upper shadow
  const hammer = bear1 && lower_shadow > body0 * 2 && upper_shadow < body0 * 0.5 && range0 > 0;

  // Bullish Engulfing: bearish prev day, today bullish and engulfs prev body
  const bull_engulfing = bear1 && bull0 && c0_open < c1_close && c0_close > c1_open && body0 > body1;

  // Morning Star: bearish 2 days ago, doji/small body yesterday, bullish today above midpoint
  const doji1 = range1 > 0 && body1 / range1 < 0.1;
  const morning_star = bear2 && doji1 && bull0 && c0_close > (c2_open + c2_close) / 2;

  const body   = body0;
  const range  = range0;

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
    candle_hammer:        hammer,
    candle_engulfing_bull: bull_engulfing,
    candle_morning_star:  morning_star,
    candle_doji:          body < range * 0.1,
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
    // No cutoff date — fetch all available history so MA200 always has enough rows.
    // .limit(550) covers 2+ years of trading days (ASX ~250/year) safely under 1000-row cap.
    const priceMap = {};
    const PARALLEL = 8; // concurrent per-ticker fetches

    for (let i = 0; i < tickers.length; i += PARALLEL) {
      const group = tickers.slice(i, i + PARALLEL);
      const results = await Promise.all(group.map(ticker =>
        db.from('prices')
          .select('ticker,market_date,open,high,low,close,adjusted_close,volume')
          .eq('ticker', ticker)
          .order('market_date', { ascending: true })
          .limit(550)  // 550 rows = ~2.2 years of trading days, well under 1000-row cap
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
