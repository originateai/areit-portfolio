// netlify/functions/strategy-engine.js
// 6-layer strategy engine — uses EODHD server-side indicators (ground truth)
// No manual indicator calculation — EODHD does it correctly with adjusted prices

const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── FETCH EODHD TECHNICAL INDICATORS ─────────────────────────────────────────
async function fetchEODHDIndicators(ticker) {
  const epic = `${ticker}.AU`;
  const results = {};

  try {
    // Fetch all indicators in parallel
    const [rsiRes, sma20Res, sma50Res, sma200Res, bbRes, macdRes, roc20Res, adxRes, atrRes] = await Promise.all([
      fetch(`${BASE}/technical/${epic}?function=rsi&period=14&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=sma&period=20&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=sma&period=50&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=sma&period=200&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=bbands&period=20&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=macd&fast_period=12&slow_period=26&signal_period=9&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=roc&period=20&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=adx&period=14&api_token=${KEY()}&fmt=json`),
      fetch(`${BASE}/technical/${epic}?function=atr&period=14&api_token=${KEY()}&fmt=json`),
    ]);

    // RSI
    const rsiData = await rsiRes.json();
    if (Array.isArray(rsiData) && rsiData.length > 0) {
      results.rsi14 = parseFloat(rsiData[rsiData.length-1].rsi);
    }

    // SMA 20, 50, 200
    const sma20Data = await sma20Res.json();
    if (Array.isArray(sma20Data) && sma20Data.length > 0) {
      results.ma20 = parseFloat(sma20Data[sma20Data.length-1].sma);
    }
    const sma50Data = await sma50Res.json();
    if (Array.isArray(sma50Data) && sma50Data.length > 0) {
      results.ma50 = parseFloat(sma50Data[sma50Data.length-1].sma);
    }
    const sma200Data = await sma200Res.json();
    if (Array.isArray(sma200Data) && sma200Data.length > 0) {
      results.ma200 = parseFloat(sma200Data[sma200Data.length-1].sma);
    }

    // Bollinger Bands
    const bbData = await bbRes.json();
    if (Array.isArray(bbData) && bbData.length > 0) {
      const last = bbData[bbData.length-1];
      results.bb_upper    = parseFloat(last.uband);
      results.bb_lower    = parseFloat(last.lband);
      results.bb_mid      = parseFloat(last.mband);
    }

    // MACD
    const macdData = await macdRes.json();
    if (Array.isArray(macdData) && macdData.length > 0) {
      const last = macdData[macdData.length-1];
      results.macd        = parseFloat(last.macd);
      results.macd_signal = parseFloat(last.signal);
      results.macd_hist   = parseFloat(last.divergence);
    }

    // ROC 20
    const rocData = await roc20Res.json();
    if (Array.isArray(rocData) && rocData.length > 0) {
      results.roc20 = parseFloat(rocData[rocData.length-1].roc) / 100;
    }

    // ADX — trend strength (14 period)
    const adxData = await adxRes.json();
    if (Array.isArray(adxData) && adxData.length > 0) {
      results.adx = parseFloat(adxData[adxData.length-1].adx);
    }

    // ATR — Average True Range for dynamic stops (14 period)
    const atrData = await atrRes.json();
    if (Array.isArray(atrData) && atrData.length > 0) {
      results.atr = parseFloat(atrData[atrData.length-1].atr);
    }

    return results;
  } catch(e) {
    console.error(`EODHD indicators error ${ticker}:`, e.message);
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
  let mlSignals = 0;
  if (pctFromMa200 && pctFromMa200 < -0.05) mlSignals++;        // Stretched below 200DMA
  if (rsi14 && rsi14 < 40) mlSignals++;                          // RSI oversold
  if (volRatio && volRatio > 1.8) mlSignals++;                   // Volume confirmation
  if (candles?.bullish) mlSignals++;                             // Bullish reversal candle
  if (roc20 && roc20 > -0.15 && roc20 < 0.01) mlSignals++;      // Recent weakness not crash
  if (mlSignals >= 3) {
    l7 = 1; reasons.push(`Layer 7 ML: ${mlSignals}/5 signals confirm`);
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
async function analyseStock(stock, macroScore, settings, livePrice=null) {
  const db = getDB();
  try {
    // 1. Get EODHD indicators (ground truth, adjusted prices)
    const indicators = await fetchEODHDIndicators(stock.ticker);
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

    // 3. Volume ratio from DB
    const volRatio = await getVolumeRatio(db, stock.ticker);

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

    // 8. Position size — minimum score 5 required (raised from 4)
    const positionSize = scoring.total >= 5
      ? getPositionSize(scoring.conviction, settings, stock.is_reit) : 0;

    const stopPct   = parseFloat(settings.stop_loss_pct || '1.5') / 100;
    const targetPct = parseFloat(settings.target_pct    || '3.0') / 100;

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
