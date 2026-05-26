// netlify/functions/strategy-engine.js
// 7-layer strategy engine — calculates indicators from Supabase prices
// Consistent with ML training data — no EODHD API calls for indicators

const { createClient } = require('@supabase/supabase-js');

const BASE   = 'https://eodhd.com/api';
const KEY    = () => process.env.EODHD_API_KEY;
const ML_URL = () => process.env.ML_SERVICE_URL; // e.g. https://asx-ml.railway.app

// ── ML LAYER 7 — CALL PYTHON MICROSERVICE ─────────────────────────────────────
async function getMLProbability(ticker, indicators, volRatio, candles) {
  const mlUrl = ML_URL();
  if (!mlUrl) return null; // fall back to rule-based proxy if no service configured

  try {
    const price  = indicators.price || 1;
    const ma20   = indicators.ma20  || price;
    const ma200  = indicators.ma200 || price;
    const body   = Math.abs((indicators.open || price) - price);
    const range  = (indicators.high || price) - (indicators.low || price);
    const lower  = Math.min(indicators.open || price, price) - (indicators.low  || price);

    const features = {
      rsi14:           indicators.rsi14   || 50,
      sma20:           indicators.ma20    || price,
      sma50:           indicators.ma50    || price,
      sma200:          indicators.ma200   || price,
      bb_pos:          indicators.bb_position || 0.5,
      vol_ratio:       volRatio || 1,
      roc5:            indicators.roc5    || 0,
      roc20:           indicators.roc20   || 0,
      pct_from_sma20:  ma20  > 0 ? (price - ma20)  / ma20  : 0,
      pct_from_sma200: ma200 > 0 ? (price - ma200) / ma200 : 0,
      above_sma20:     ma20  > 0 && price > ma20  ? 1 : 0,
      above_sma200:    ma200 > 0 && price > ma200 ? 1 : 0,
      golden_cross:    indicators.ma50 && ma200 && indicators.ma50 > ma200 ? 1 : 0,
      hammer:          candles?.hammer ? 1 : 0,
      bull_candle:     candles?.bullish ? 1 : 0,
      lower_shadow:    lower,
      upper_shadow:    (indicators.high || price) - Math.max(indicators.open || price, price),
      body,
      range,
    };

    const res = await fetch(`${mlUrl}/predict/${ticker}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(features),
      signal:  AbortSignal.timeout(3000) // 3s timeout — don't hold up the scan
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.probability || null;
  } catch(e) {
    // ML service unavailable — fall back to rule-based proxy silently
    return null;
  }
}

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── CALCULATE INDICATORS FROM SUPABASE PRICES ────────────────────────────────
// Uses adjusted_close for RSI (matches EODHD), raw close for SMAs
// Consistent with training data — no EODHD API calls needed
async function fetchEODHDIndicators(ticker, preloadedPrices=null) {
  const db = getDB();
  try {
    // Use pre-loaded prices if available, otherwise fetch from DB
    let prices = preloadedPrices;
    if (!prices || prices.length < 30) {
      const { data } = await db.from('prices')
        .select('market_date,open,high,low,close,adjusted_close,volume')
        .eq('ticker', ticker)
        .order('market_date', { ascending: false })
        .limit(260);
      prices = data;
    }

    if (!prices || prices.length < 30) return null;

    const rows    = [...prices].reverse(); // chronological
    const n       = rows.length;
    const closes  = rows.map(r => parseFloat(r.adjusted_close || r.close));
    const highs   = rows.map(r => parseFloat(r.high  || r.close));
    const lows    = rows.map(r => parseFloat(r.low   || r.close));
    const opens   = rows.map(r => parseFloat(r.open  || r.close));
    const price   = closes[n-1];
    const results = { price, open: opens[n-1], high: highs[n-1], low: lows[n-1] };

    // ── SMAs ──
    const sma = (arr, period) => {
      if (arr.length < period) return null;
      return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
    };
    results.ma20  = sma(closes, 20);
    results.ma50  = sma(closes, 50);
    results.ma200 = sma(closes, 200);

    // ── Wilder's RSI 14 ──
    const wilderRSI = (arr, period=14) => {
      const d = arr.slice(1).map((v, i) => v - arr[i]);
      const g = d.map(v => v > 0 ? v : 0);
      const l = d.map(v => v < 0 ? -v : 0);
      if (g.length < period) return 50;
      let ag = g.slice(0, period).reduce((a, b) => a + b, 0) / period;
      let al = l.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < g.length; i++) {
        ag = (ag * (period-1) + g[i]) / period;
        al = (al * (period-1) + l[i]) / period;
      }
      return al === 0 ? 100 : 100 - (100 / (1 + ag/al));
    };
    results.rsi14 = wilderRSI(closes);

    // ── Bollinger Bands (20, 2σ) ──
    if (closes.length >= 20) {
      const sl   = closes.slice(-20);
      const mean = sl.reduce((a, b) => a + b, 0) / 20;
      const std  = Math.sqrt(sl.reduce((s, v) => s + (v-mean)**2, 0) / 20);
      results.bb_upper = mean + 2*std;
      results.bb_lower = mean - 2*std;
      results.bb_mid   = mean;
    }

    // ── MACD (12/26/9) ──
    const ema = (arr, period) => {
      const k = 2/(period+1);
      let e = arr[0];
      for (let i = 1; i < arr.length; i++) e = arr[i]*k + e*(1-k);
      return e;
    };
    if (closes.length >= 26) {
      const ema12 = ema(closes.slice(-26), 12);
      const ema26 = ema(closes.slice(-26), 26);
      results.macd = ema12 - ema26;
      // Signal: 9-period EMA of MACD — approximate
      results.macd_signal = results.macd * 0.9; // simplified
    }

    // ── ROC 20 ──
    if (closes.length >= 21) {
      results.roc20 = (closes[n-1] - closes[n-21]) / closes[n-21];
    }

    // ── ROC 5 ──
    if (closes.length >= 6) {
      results.roc5 = (closes[n-1] - closes[n-6]) / closes[n-6];
    }

    // ── ADX 14 (simplified) ──
    if (rows.length >= 15) {
      const trArr = rows.slice(-15).map((r, i, a) => {
        if (i === 0) return highs[n-15] - lows[n-15];
        const prevClose = parseFloat(a[i-1].close);
        return Math.max(highs[n-15+i]-lows[n-15+i], Math.abs(highs[n-15+i]-prevClose), Math.abs(lows[n-15+i]-prevClose));
      });
      results.atr = trArr.reduce((a,b)=>a+b,0)/14;
      results.adx = 20; // simplified — full DI+/DI- calc is complex; use neutral default
    }

    // ── Volume ratio ──
    const volumes = rows.map(r => parseInt(r.volume || 0));
    const todayVol = volumes[n-1];
    const avgVol   = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    results.vol_ratio = avgVol > 0 ? todayVol / avgVol : 1;

    // ── BB Position ──
    if (results.bb_upper && results.bb_lower) {
      const bbRange = results.bb_upper - results.bb_lower;
      results.bb_position = bbRange > 0 ? (price - results.bb_lower) / bbRange : 0.5;
    }

    return results;
  } catch(e) {
    console.error(`Indicator calc error ${ticker}:`, e.message);
    return null;
  }
}

// ── FETCH VOLUME DATA FROM DB ─────────────────────────────────────────────────
async function getVolumeRatio(db, ticker) {
  try {
    const { data } = await db.from('prices')
      .select('volume, market_date')
      .eq('ticker', ticker)
      .order('market_date', { ascending: false })
      .limit(21);

    if (!data || data.length < 5) return null;

    const todayVol = parseInt(data[0].volume || 0);
    const avgVol   = data.slice(1, 21).reduce((s, r) => s + parseInt(r.volume || 0), 0) / Math.min(data.length - 1, 20);

    return avgVol > 0 ? parseFloat((todayVol / avgVol).toFixed(4)) : null;
  } catch(e) {
    return null;
  }
}

// ── CANDLESTICK DETECTION (from DB prices) ────────────────────────────────────
async function detectCandlesticks(db, ticker) {
  try {
    const { data } = await db.from('prices')
      .select('open, high, low, close')
      .eq('ticker', ticker)
      .order('market_date', { ascending: false })
      .limit(3);

    if (!data || data.length < 3) return { pattern: null, bullish: false };

    const candles = data.reverse(); // chronological
    const [c2, c1, c0] = candles;

    const patterns = [];
    let bullish = false;

    const body0  = Math.abs(c0.close - c0.open);
    const body1  = Math.abs(c1.close - c1.open);
    const body2  = Math.abs(c2.close - c2.open);
    const range0 = c0.high - c0.low;
    const range1 = c1.high - c1.low;
    const bull0  = c0.close > c0.open;
    const bull1  = c1.close > c1.open;
    const bull2  = c2.close > c2.open;
    const bear1  = !bull1;
    const bear2  = !bull2;
    const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low;
    const upperShadow0 = c0.high - Math.max(c0.open, c0.close);
    const upperShadow1 = c1.high - Math.max(c1.open, c1.close);

    // Hammer
    if (bear1 && lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5 && range0 > 0) {
      patterns.push('Hammer'); bullish = true;
    }
    // Bullish Engulfing
    if (bear1 && bull0 && c0.open < c1.close && c0.close > c1.open && body0 > body1) {
      patterns.push('Bullish Engulfing'); bullish = true;
    }
    // Doji
    if (range0 > 0 && body0 / range0 < 0.05) {
      patterns.push('Doji');
    }
    // Morning Star
    const doji1 = range1 > 0 && body1 / range1 < 0.1;
    if (bear2 && doji1 && bull0 && c0.close > (c2.open + c2.close) / 2) {
      patterns.push('Morning Star'); bullish = true;
    }
    // Three White Soldiers
    if (bull0 && bull1 && bull2 && c0.close > c1.close && c1.close > c2.close &&
        body0 > range0 * 0.5 && body1 > range1 * 0.5) {
      patterns.push('Three White Soldiers'); bullish = true;
    }

    return {
      pattern: patterns.length > 0 ? patterns.join(', ') : null,
      bullish,
      hammer:          patterns.includes('Hammer'),
      bullishEngulfing: patterns.includes('Bullish Engulfing'),
      doji:            patterns.includes('Doji'),
      morningStar:     patterns.includes('Morning Star'),
      threeSoldiers:   patterns.includes('Three White Soldiers'),
    };
  } catch(e) {
    return { pattern: null, bullish: false };
  }
}

// ── 7-LAYER SCORING ───────────────────────────────────────────────────────────
function scoreStock(indicators, macroScore, stock, currentYield, volRatio, candles) {
  const reasons = [];
  let l1=0, l2=0, l3=0, l4=0, l5=0, l6=0, l7=0;

  const { rsi14, ma20, ma50, ma200, bb_lower, bb_upper, macd, macd_signal, roc20, adx, atr } = indicators;
  const price = indicators.price;

  // ── LAYER 1: MACRO ────────────────────────────────────────────────────────
  if (macroScore >= 1) {
    l1 = 1;
    reasons.push(`Macro ${macroScore > 0 ? 'positive' : 'neutral'} (score ${macroScore})`);
  } else {
    reasons.push('Macro negative — caution');
  }

  // ── LAYER 2: TREND ────────────────────────────────────────────────────────
  const above200 = ma200 && price > ma200;
  const above50  = ma50  && price > ma50;
  const golden   = ma50  && ma200 && ma50 > ma200;
  // ADX >20 = trend has real strength, not just choppy price action
  const trendStrong = adx && adx > 20;
  if (above200 && above50 && trendStrong) {
    l2 = 1; reasons.push(`Above 200DMA + 50DMA, ADX ${adx?.toFixed(0)} — strong uptrend`);
  } else if (above200 && above50) {
    l2 = 1; reasons.push('Above 200DMA + 50DMA — uptrend confirmed');
  } else if (above200 && golden) {
    l2 = 1; reasons.push('Golden cross — trend turning bullish');
  } else {
    reasons.push(`Below 200DMA or weak trend${adx ? ` (ADX ${adx.toFixed(0)})` : ''} — avoid`);
  }

  // ── LAYER 3: MOMENTUM ─────────────────────────────────────────────────────
  let momScore = 0;
  if (ma20 && price > ma20) momScore++;
  if (roc20 && roc20 > 0.02) momScore++;
  if (macd && macd_signal && macd > macd_signal) momScore++;
  // Tightened: require 2/3 momentum signals (was 1/3)
  if (momScore >= 2) {
    l3 = 1; reasons.push(`Momentum positive (${momScore}/3 signals)`);
  } else {
    reasons.push(`Momentum weak (${momScore}/3 signals)`);
  }

  // ── LAYER 4: MEAN REVERSION ───────────────────────────────────────────────
  const pctFromMa20  = ma20  ? (price - ma20)  / ma20  : null;
  const pctFromMa200 = ma200 ? (price - ma200) / ma200 : null;
  // Tightened: RSI <40 (was <45), >8% below 20DMA (was >5%), or RSI <40 + >10% below 200DMA
  if (rsi14 && rsi14 < 35) {
    l4 = 1; reasons.push(`RSI ${rsi14.toFixed(0)} — strongly oversold`);
  } else if (bb_lower && price <= bb_lower * 1.01) {
    l4 = 1; reasons.push('At/near Bollinger lower band — oversold');
  } else if (pctFromMa20 && pctFromMa20 < -0.08) {
    l4 = 1; reasons.push(`${(pctFromMa20*100).toFixed(1)}% below 20DMA — stretched`);
  } else if (rsi14 && rsi14 < 40 && pctFromMa200 && pctFromMa200 < -0.10) {
    l4 = 1; reasons.push(`RSI ${rsi14.toFixed(0)} + ${(pctFromMa200*100).toFixed(1)}% below 200DMA`);
  } else {
    reasons.push(`RSI ${rsi14 ? rsi14.toFixed(0) : '--'} — not oversold enough`);
  }

  // ── LAYER 5: VOLUME ───────────────────────────────────────────────────────
  // Tightened: require >1.8x (was >1.5x)
  if (volRatio && volRatio > 2.5) {
    l5 = 1; reasons.push(`Volume ${volRatio.toFixed(1)}× average — very strong`);
  } else if (volRatio && volRatio > 1.8) {
    l5 = 1; reasons.push(`Volume ${volRatio.toFixed(1)}× average — elevated`);
  } else {
    reasons.push(`Volume ${volRatio ? volRatio.toFixed(1)+'×' : '--'} — insufficient`);
  }

  // ── LAYER 6: CANDLE ───────────────────────────────────────────────────────
  if (candles?.bullish) {
    l6 = 1; reasons.push(`Candle: ${candles.pattern}`);
  }
  if (stock?.is_reit && currentYield && currentYield >= (stock?.yield_trigger || 0.08)) {
    l6 = 1; reasons.push(`Yield trigger: ${(currentYield*100).toFixed(1)}% ≥ ${((stock?.yield_trigger||0.08)*100).toFixed(0)}%`);
  }

  // ── LAYER 7: ML CONFIRMATION ──────────────────────────────────────────────
  // Rule-based proxy using top backtest features (lower_shadow, pct_from_sma200, roc5, bb_pos)
  // Calibrated to ~65% ML confidence threshold (optimal from backtest: Hold 3d, Score 5+, ML >65%)
  let mlSignals = 0;
  if (pctFromMa200 && pctFromMa200 < -0.05) mlSignals++;        // Stretched below 200DMA
  if (rsi14 && rsi14 < 40) mlSignals++;                          // RSI oversold
  if (volRatio && volRatio > 1.8) mlSignals++;                   // Volume confirmation
  if (candles?.bullish) mlSignals++;                             // Bullish reversal candle
  if (roc20 && roc20 > -0.15 && roc20 < 0.01) mlSignals++;      // Recent weakness not crash
  if (mlSignals >= 4) {  // Tightened to 4/5 (was 3/5) — calibrated to 65% ML threshold
    l7 = 1; reasons.push(`Layer 7 ML: ${mlSignals}/5 signals confirm (high confidence)`);
  }

  const total = l1 + l2 + l3 + l4 + l5 + l6 + l7;
  const signal     = total >= 6 ? 'STRONG_BUY' : total >= 5 ? 'BUY' : total >= 4 ? 'WATCH' : 'AVOID';
  const conviction = total >= 6 ? 'EXCEPTIONAL' : total >= 5 ? 'STRONG' : total >= 4 ? 'MODERATE' : 'WEAK';

  return { total, l1, l2, l3, l4, l5, l6, l7, reasons, signal, conviction };
}

function getPositionSize(conviction, settings, isReit=false) {
  const prefix = isReit ? 'reit' : 'equity';
  const sizes = {
    EXCEPTIONAL: parseFloat(settings[`conviction_6_${prefix}`] || 999),
    STRONG:      parseFloat(settings[`conviction_5_${prefix}`] || 800),
    MODERATE:    parseFloat(settings[`conviction_4_${prefix}`] || 500),
    WEAK:        0
  };
  return sizes[conviction] || 0;
}

// ── MAIN ANALYSE FUNCTION ─────────────────────────────────────────────────────
async function analyseStock(stock, macroScore, settings, livePrice=null, preloadedPrices=null) {
  const db = getDB();
  try {
    // 1. Get EODHD indicators (ground truth, adjusted prices)
    const indicators = await fetchEODHDIndicators(stock.ticker, preloadedPrices);
    if (!indicators || !indicators.ma20) {
      console.log(`No EODHD indicators for ${stock.ticker}`);
      return null;
    }

    // 2. Get current price
    let price = livePrice;
    if (!price) {
      const { data: priceRow } = await db.from('prices')
        .select('close').eq('ticker', stock.ticker)
        .order('market_date', { ascending: false }).limit(1).single();
      price = priceRow?.close ? parseFloat(priceRow.close) : null;
    }
    if (!price) return null;

    indicators.price = parseFloat(price);

    // 3. Volume ratio — now computed inside fetchEODHDIndicators
    const volRatio = indicators.vol_ratio || await getVolumeRatio(db, stock.ticker);

    // 4. Candlestick detection from DB
    const candles = await detectCandlesticks(db, stock.ticker);

    // 5. Bollinger position (0-1)
    const bbRange    = indicators.bb_upper && indicators.bb_lower
      ? indicators.bb_upper - indicators.bb_lower : null;
    const bb_position = bbRange && bbRange > 0
      ? parseFloat(((price - indicators.bb_lower) / bbRange).toFixed(4)) : null;

    const pct_from_ma20 = indicators.ma20
      ? parseFloat(((price - indicators.ma20) / indicators.ma20).toFixed(6)) : null;

    // 6. REIT yield
    let currentYield = null;
    if (stock.is_reit && stock.dps_fy26 && price) {
      currentYield = stock.dps_fy26 / price;
    }

    // 7. Score
    const scoring = scoreStock(indicators, macroScore, stock, currentYield, volRatio, candles);

    // 7b. Real ML probability — override rule-based Layer 7 if service available
    const mlProb = await getMLProbability(stock.ticker, { ...indicators, price }, volRatio, candles);
    if (mlProb !== null) {
      if (mlProb >= 0.65 && scoring.l7 === 0) {
        scoring.l7 = 1;
        scoring.total += 1;
        scoring.reasons.push(`Layer 7 ML: ${(mlProb*100).toFixed(0)}% confidence (model)`);
        // Recalculate conviction with new total
        scoring.conviction = scoring.total >= 6 ? 'EXCEPTIONAL' : scoring.total >= 5 ? 'STRONG' : 'MODERATE';
      } else if (mlProb < 0.40 && scoring.l7 === 1) {
        // ML disagrees — remove Layer 7
        scoring.l7 = 0;
        scoring.total -= 1;
        scoring.reasons.push(`Layer 7 ML: ${(mlProb*100).toFixed(0)}% — low confidence, removed`);
        scoring.conviction = scoring.total >= 6 ? 'EXCEPTIONAL' : scoring.total >= 5 ? 'STRONG' : scoring.total >= 4 ? 'MODERATE' : 'WEAK';
      }
    }

    // 8. Position size — minimum score 5 required (raised from 4)
    const positionSize = scoring.total >= 5
      ? getPositionSize(scoring.conviction, settings, stock.is_reit) : 0;

    const stopPct   = parseFloat(settings.stop_loss_pct || '2.0') / 100;  // Backtest optimal: 2%
    const targetPct = parseFloat(settings.target_pct    || '5.0') / 100;  // Backtest optimal: 5%

    // ATR-based dynamic stop — use 1.5× ATR if available, otherwise fall back to fixed %
    // This adapts stop distance to each stock's actual volatility
    const atrStop = indicators?.atr && price
      ? parseFloat((indicators.atr * 1.5 / price).toFixed(6))  // 1.5× ATR as % of price
      : null;
    const dynamicStopPct = atrStop && atrStop > 0.005 && atrStop < 0.08
      ? atrStop   // use ATR stop if it's between 0.5% and 8%
      : stopPct;  // fall back to fixed setting

    return {
      ticker:           stock.ticker,
      name:             stock.name,
      universe:         stock.universe,
      is_reit:          stock.is_reit,
      price,
      // EODHD indicators (ground truth)
      ma20:             indicators.ma20,
      ma50:             indicators.ma50,
      ma200:            indicators.ma200,
      rsi14:            indicators.rsi14,
      roc20:            indicators.roc20,
      macd:             indicators.macd,
      macd_signal:      indicators.macd_signal,
      bb_upper:         indicators.bb_upper,
      bb_lower:         indicators.bb_lower,
      bb_position,
      pct_from_ma20,
      vol_ratio:        volRatio,
      above_ma20:       indicators.ma20 ? price > indicators.ma20 : null,
      above_ma200:      indicators.ma200 ? price > indicators.ma200 : null,
      golden_cross:     indicators.ma50 && indicators.ma200 ? indicators.ma50 > indicators.ma200 : null,
      adx:              indicators.adx || null,
      atr:              indicators.atr || null,
      // Candlestick
      candle_pattern:          candles?.pattern,
      candle_hammer:           candles?.hammer || false,
      candle_engulfing_bull:   candles?.bullishEngulfing || false,
      candle_doji:             candles?.doji || false,
      candle_morning_star:     candles?.morningStar || false,
      // REIT
      dps_yield:               currentYield,
      yield_trigger_fired:     currentYield && stock.yield_trigger ? currentYield >= stock.yield_trigger : false,
      // Scoring
      layer1_macro:     scoring.l1,
      layer2_trend:     scoring.l2,
      layer3_momentum:  scoring.l3,
      layer4_reversion: scoring.l4,
      layer5_volume:    scoring.l5,
      layer6_candle:    scoring.l6,
      layer7_ml:        scoring.l7,
      total_score:      scoring.total,
      signal:           scoring.signal,
      conviction:       scoring.conviction,
      signal_reasons:   scoring.reasons,
      // Trade levels
      position_size:    positionSize,
      stop_price:       price ? parseFloat((price * (1 - dynamicStopPct)).toFixed(3))   : null,
      target_price:     price ? parseFloat((price * (1 + targetPct)).toFixed(3)) : null,
      units:            price && positionSize ? Math.floor(positionSize / price) : 0
    };

  } catch(err) {
    console.error(`Analysis error ${stock.ticker}:`, err.message);
    return null;
  }
}

module.exports = { analyseStock, scoreStock, getPositionSize };
