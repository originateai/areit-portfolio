// netlify/functions/strategy-engine.js
// The core algo brain — runs 6-layer analysis on every stock
// Called by morning-scan and pre-screen functions

import { fetchYahoo, BOND_YIELD } from './_shared.js';

// ── CANDLESTICK PATTERN DETECTION ─────────────────────────────────────────────

export function detectCandlesticks(candles) {
  // candles = array of { open, high, low, close } last 3 days
  if (!candles || candles.length < 3) return { pattern: null, bullish: false, bearish: false };

  const [c2, c1, c0] = candles.slice(-3); // c0 = today, c1 = yesterday, c2 = 2 days ago
  const patterns = [];
  let bullish = false;
  let bearish = false;

  if (!c0 || !c1 || !c2) return { pattern: null, bullish: false, bearish: false };

  const body0  = Math.abs(c0.close - c0.open);
  const body1  = Math.abs(c1.close - c1.open);
  const body2  = Math.abs(c2.close - c2.open);
  const range0 = c0.high - c0.low;
  const range1 = c1.high - c1.low;
  const bull0  = c0.close > c0.open;
  const bull1  = c1.close > c1.open;
  const bull2  = c2.close > c2.open;
  const bear0  = c0.close < c0.open;
  const bear1  = c1.close < c1.open;
  const bear2  = c2.close < c2.open;
  const upperShadow0 = c0.high - Math.max(c0.open, c0.close);
  const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low;
  const upperShadow1 = c1.high - Math.max(c1.open, c1.close);
  const lowerShadow1 = Math.min(c1.open, c1.close) - c1.low;

  // HAMMER — small body at top, long lower shadow, bullish reversal
  if (bear1 && lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5 && range0 > 0) {
    patterns.push('Hammer');
    bullish = true;
  }

  // SHOOTING STAR — small body at bottom, long upper shadow, bearish
  if (bull1 && upperShadow0 > body0 * 2 && lowerShadow0 < body0 * 0.5 && range0 > 0) {
    patterns.push('Shooting Star');
    bearish = true;
  }

  // BULLISH ENGULFING — bearish candle followed by larger bullish candle
  if (bear1 && bull0 && c0.open < c1.close && c0.close > c1.open && body0 > body1) {
    patterns.push('Bullish Engulfing');
    bullish = true;
  }

  // BEARISH ENGULFING — bullish candle followed by larger bearish candle
  if (bull1 && bear0 && c0.open > c1.close && c0.close < c1.open && body0 > body1) {
    patterns.push('Bearish Engulfing');
    bearish = true;
  }

  // DOJI — open and close almost equal (within 0.1% of range)
  if (range0 > 0 && body0 / range0 < 0.05) {
    patterns.push('Doji');
    // Doji is neutral but at support = bullish
  }

  // MORNING STAR — bearish, doji/small, bullish (3 candle reversal)
  const doji1 = range1 > 0 && body1 / range1 < 0.1;
  if (bear2 && doji1 && bull0 && c0.close > (c2.open + c2.close) / 2) {
    patterns.push('Morning Star');
    bullish = true;
  }

  // EVENING STAR — bullish, doji/small, bearish (3 candle reversal)
  if (bull2 && doji1 && bear0 && c0.close < (c2.open + c2.close) / 2) {
    patterns.push('Evening Star');
    bearish = true;
  }

  // THREE WHITE SOLDIERS — 3 consecutive bullish candles, each closing higher
  if (bull0 && bull1 && bull2 && c0.close > c1.close && c1.close > c2.close &&
      body0 > range0 * 0.5 && body1 > range1 * 0.5) {
    patterns.push('Three White Soldiers');
    bullish = true;
  }

  return {
    pattern:  patterns.length > 0 ? patterns.join(', ') : null,
    patterns,
    bullish,
    bearish,
    hammer:           patterns.includes('Hammer'),
    shootingStar:     patterns.includes('Shooting Star'),
    bullishEngulfing: patterns.includes('Bullish Engulfing'),
    bearishEngulfing: patterns.includes('Bearish Engulfing'),
    doji:             patterns.includes('Doji'),
    morningStar:      patterns.includes('Morning Star'),
    eveningStar:      patterns.includes('Evening Star'),
    threeSoldiers:    patterns.includes('Three White Soldiers')
  };
}

// ── CALCULATE ALL INDICATORS ──────────────────────────────────────────────────

export function calculateIndicators(closes, volumes, highs, lows, opens) {
  const n = closes.length;
  if (n < 20) return null;

  // Moving averages
  const ma20  = avg(closes.slice(-20));
  const ma50  = n >= 50  ? avg(closes.slice(-50))  : null;
  const ma200 = n >= 200 ? avg(closes.slice(-200)) : null;

  const price = closes[n - 1];

  // RSI 14
  const rsi = calcRSI(closes, 14);

  // Rate of change 20 day
  const roc20 = n >= 21 ? (closes[n-1] - closes[n-21]) / closes[n-21] : null;

  // MACD (12, 26, 9)
  const macdData = calcMACD(closes);

  // Bollinger Bands (20, 2)
  const bb = calcBollinger(closes, 20, 2);

  // Volume ratio
  const volMa20 = volumes ? Math.round(avg(volumes.slice(-20))) : null;
  const volRatio = volMa20 && volumes ? volumes[volumes.length-1] / volMa20 : null;

  // Relative strength vs index (placeholder — needs index data)
  const pctFromMa20 = ma20 ? (price - ma20) / ma20 : null;

  // Candlestick detection (last 3 days)
  const candles = [];
  for (let i = Math.max(0, n-3); i < n; i++) {
    candles.push({
      open:  opens?.[i]  || closes[i],
      high:  highs?.[i]  || closes[i],
      low:   lows?.[i]   || closes[i],
      close: closes[i]
    });
  }
  const candleSignals = detectCandlesticks(candles);

  // Golden/death cross
  const goldenCross = ma50 && ma200 && ma50 > ma200;
  const deathCross  = ma50 && ma200 && ma50 < ma200;

  return {
    price, ma20, ma50, ma200,
    above_ma20:   ma20  ? price > ma20  : null,
    above_ma50:   ma50  ? price > ma50  : null,
    above_ma200:  ma200 ? price > ma200 : null,
    golden_cross: goldenCross,
    death_cross:  deathCross,
    rsi14:        rsi,
    roc20,
    macd:         macdData?.macd,
    macd_signal:  macdData?.signal,
    macd_hist:    macdData?.hist,
    bb_upper:     bb?.upper,
    bb_lower:     bb?.lower,
    bb_mid:       bb?.mid,
    bb_position:  bb?.position,
    pct_from_ma20: pctFromMa20,
    vol_ma20:     volMa20,
    vol_ratio:    volRatio,
    candleSignals
  };
}

// ── 6-LAYER SCORING ───────────────────────────────────────────────────────────

export function scoreStock(indicators, macroScore, stock, currentYield) {
  const reasons = [];
  let l1 = 0, l2 = 0, l3 = 0, l4 = 0, l5 = 0, l6 = 0;

  if (!indicators) return { total: 0, l1, l2, l3, l4, l5, l6, reasons, signal: 'NEUTRAL', conviction: 'WEAK' };

  const { price, ma20, ma50, ma200, above_ma20, above_ma50, above_ma200,
    golden_cross, rsi14, roc20, macd, macd_signal, bb_lower, bb_position,
    pct_from_ma20, vol_ratio, candleSignals } = indicators;

  // ── LAYER 1: MACRO ────────────────────────────────────────────────────────
  // Pass/fail based on overnight macro signal
  if (macroScore >= 1) {
    l1 = 1;
    reasons.push('Macro positive');
  } else if (macroScore <= -2) {
    l1 = 0;
    reasons.push('Macro negative — caution');
  } else {
    l1 = 1; // neutral macro still allows trades
    reasons.push('Macro neutral');
  }

  // ── LAYER 2: TREND ────────────────────────────────────────────────────────
  // Must be in uptrend — above key moving averages
  if (above_ma200 && above_ma50) {
    l2 = 1;
    reasons.push('Above 200DMA + 50DMA — uptrend confirmed');
  } else if (above_ma200 && golden_cross) {
    l2 = 1;
    reasons.push('Golden cross — trend turning bullish');
  } else if (above_ma200) {
    l2 = 1;
    reasons.push('Above 200DMA — long term uptrend');
  } else {
    l2 = 0;
    reasons.push('Below 200DMA — avoid');
  }

  // ── LAYER 3: MOMENTUM ─────────────────────────────────────────────────────
  // Price momentum turning positive
  let momentumScore = 0;
  if (above_ma20) momentumScore++;
  if (roc20 && roc20 > 0.02) momentumScore++;
  if (macd && macd_signal && macd > macd_signal) momentumScore++;

  if (momentumScore >= 2) {
    l3 = 1;
    reasons.push(`Momentum positive (${momentumScore}/3 signals)`);
  } else if (momentumScore === 1 && above_ma20) {
    l3 = 1;
    reasons.push('Short term momentum building');
  } else {
    l3 = 0;
  }

  // ── LAYER 4: MEAN REVERSION ───────────────────────────────────────────────
  // Oversold conditions = opportunity
  if (rsi14 && rsi14 < 35) {
    l4 = 1;
    reasons.push(`RSI ${rsi14.toFixed(0)} — oversold`);
  } else if (bb_position && bb_position < 0.2) {
    l4 = 1;
    reasons.push('At Bollinger Band lower — oversold');
  } else if (pct_from_ma20 && pct_from_ma20 < -0.05) {
    l4 = 1;
    reasons.push(`${(pct_from_ma20*100).toFixed(1)}% below 20DMA — stretched`);
  } else if (rsi14 && rsi14 < 45) {
    l4 = 1;
    reasons.push(`RSI ${rsi14.toFixed(0)} — approaching oversold`);
  }

  // ── LAYER 5: VOLUME ───────────────────────────────────────────────────────
  // Smart money moving — volume spike
  if (vol_ratio && vol_ratio > 2.0) {
    l5 = 1;
    reasons.push(`Volume ${vol_ratio.toFixed(1)}x average — strong interest`);
  } else if (vol_ratio && vol_ratio > 1.5) {
    l5 = 1;
    reasons.push(`Volume ${vol_ratio.toFixed(1)}x average — elevated`);
  } else if (vol_ratio && vol_ratio > 1.2) {
    l5 = 1;
    reasons.push('Volume slightly above average');
  }

  // ── LAYER 6: CANDLESTICK ──────────────────────────────────────────────────
  // Bullish pattern confirmation
  if (candleSignals?.bullish) {
    l6 = 1;
    reasons.push(`Candle: ${candleSignals.pattern}`);
  }

  // REIT-specific: yield trigger
  if (stock?.is_reit && currentYield && currentYield >= (stock?.yield_trigger || 0.08)) {
    l6 = 1;
    reasons.push(`Yield trigger: ${(currentYield*100).toFixed(1)}% ≥ ${((stock?.yield_trigger||0.08)*100).toFixed(0)}%`);
  }

  const total = l1 + l2 + l3 + l4 + l5 + l6;

  const signal =
    total >= 6 ? 'STRONG_BUY' :
    total >= 5 ? 'BUY'        :
    total >= 4 ? 'WATCH'      :
    total >= 2 ? 'NEUTRAL'    : 'AVOID';

  const conviction =
    total >= 6 ? 'EXCEPTIONAL' :
    total >= 5 ? 'STRONG'      :
    total >= 4 ? 'MODERATE'    : 'WEAK';

  return { total, l1, l2, l3, l4, l5, l6, reasons, signal, conviction };
}

// ── POSITION SIZE ─────────────────────────────────────────────────────────────

export function getPositionSize(conviction, settings, isReit = false) {
  const prefix = isReit ? 'reit' : 'equity';
  const sizes = {
    EXCEPTIONAL: parseFloat(settings[`conviction_6_${prefix}`] || (isReit ? 4000 : 4000)),
    STRONG:      parseFloat(settings[`conviction_5_${prefix}`] || (isReit ? 2000 : 2000)),
    MODERATE:    parseFloat(settings[`conviction_4_${prefix}`] || (isReit ? 1000 : 1000)),
    WEAK:        0
  };
  return sizes[conviction] || 0;
}

// ── MATH HELPERS ──────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const diffs = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i-1]);
  const gains  = diffs.map(d => d > 0 ? d : 0);
  const losses = diffs.map(d => d < 0 ? Math.abs(d) : 0);
  const avgG   = avg(gains.slice(-period));
  const avgL   = avg(losses.slice(-period));
  if (avgL === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgG / avgL))).toFixed(2));
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  if (!emaFast || !emaSlow) return null;
  const macdLine = emaFast - emaSlow;
  // Simplified — would need full EMA series for accurate signal
  return { macd: parseFloat(macdLine.toFixed(4)), signal: 0, hist: parseFloat(macdLine.toFixed(4)) };
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid   = avg(slice);
  const std   = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period);
  const upper = mid + stdDev * std;
  const lower = mid - stdDev * std;
  const price = closes[closes.length - 1];
  const position = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  return { upper: parseFloat(upper.toFixed(4)), lower: parseFloat(lower.toFixed(4)), mid: parseFloat(mid.toFixed(4)), position: parseFloat(position.toFixed(4)) };
}

// ── FULL STOCK ANALYSIS ───────────────────────────────────────────────────────

export async function analyseStock(stock, macroScore, settings) {
  try {
    const ticker = stock.ticker;
    const asx    = stock.universe === 'REIT' ? ticker + '.AX' : ticker + '.AX';

    // Fetch 200+ days for full indicator calculation
    const data = await fetchYahoo(asx, '300d');
    if (!data?.closes || data.closes.length < 20) return null;

    const closes  = data.closes.filter(Boolean);
    const opens   = data.opens?.filter(Boolean);
    const highs   = data.highs?.filter(Boolean);
    const lows    = data.lows?.filter(Boolean);
    const volumes = data.volumes?.filter(v => v !== null);

    const indicators = calculateIndicators(closes, volumes, highs, lows, opens);
    if (!indicators) return null;

    // REIT-specific: calculate yield
    let currentYield = null;
    if (stock.is_reit && stock.dps_fy26 && indicators.price) {
      currentYield = stock.dps_fy26 / indicators.price;
    }

    const scoring = scoreStock(indicators, macroScore, stock, currentYield);

    // Calculate position size from settings
    const positionSize = scoring.total >= 4
      ? getPositionSize(scoring.conviction, settings, stock.is_reit)
      : 0;

    const stopPct   = parseFloat(settings.stop_loss_pct || '1.5') / 100;
    const targetPct = parseFloat(settings.target_pct    || '3.0') / 100;

    return {
      ticker,
      name:         stock.name,
      universe:     stock.universe,
      is_reit:      stock.is_reit,
      price:        indicators.price,
      // Indicators
      ma20:         indicators.ma20,
      ma50:         indicators.ma50,
      ma200:        indicators.ma200,
      rsi14:        indicators.rsi14,
      roc20:        indicators.roc20,
      bb_position:  indicators.bb_position,
      vol_ratio:    indicators.vol_ratio,
      pct_from_ma20: indicators.pct_from_ma20,
      above_ma20:   indicators.above_ma20,
      above_ma200:  indicators.above_ma200,
      golden_cross: indicators.golden_cross,
      // Candles
      candle_pattern:         indicators.candleSignals?.pattern,
      candle_hammer:          indicators.candleSignals?.hammer || false,
      candle_engulfing_bull:  indicators.candleSignals?.bullishEngulfing || false,
      candle_engulfing_bear:  indicators.candleSignals?.bearishEngulfing || false,
      candle_doji:            indicators.candleSignals?.doji || false,
      candle_morning_star:    indicators.candleSignals?.morningStar || false,
      candle_evening_star:    indicators.candleSignals?.eveningStar || false,
      candle_shooting_star:   indicators.candleSignals?.shootingStar || false,
      candle_three_soldiers:  indicators.candleSignals?.threeSoldiers || false,
      // REIT
      dps_yield:              currentYield,
      yield_trigger_fired:    currentYield && stock.yield_trigger ? currentYield >= stock.yield_trigger : false,
      // Scoring
      layer1_macro:    scoring.l1,
      layer2_trend:    scoring.l2,
      layer3_momentum: scoring.l3,
      layer4_reversion: scoring.l4,
      layer5_volume:   scoring.l5,
      layer6_candle:   scoring.l6,
      total_score:     scoring.total,
      signal:          scoring.signal,
      conviction:      scoring.conviction,
      signal_reasons:  scoring.reasons,
      // Trade levels
      position_size:   positionSize,
      stop_price:      indicators.price ? parseFloat((indicators.price * (1 - stopPct)).toFixed(3))   : null,
      target_price:    indicators.price ? parseFloat((indicators.price * (1 + targetPct)).toFixed(3)) : null,
      units:           indicators.price && positionSize ? Math.floor(positionSize / indicators.price) : 0
    };

  } catch (err) {
    console.error(`Analysis error for ${stock.ticker}:`, err.message);
    return null;
  }
}
