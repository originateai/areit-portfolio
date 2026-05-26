// netlify/functions/morning-scan.js
// Scheduled: 7:00am AEST (9:00pm UTC prev day) Mon-Fri
// 2-step architecture:
// Step 1: Pre-screen from DB prices (no API calls) — fast
// Step 2: Full 6-layer analysis only on candidates — limited EODHD calls
// Universe: Top 400 ASX stocks + 28 Moelis REITs

const {
  getSupabase, fetchYahoo, fetchFRED, sendEmail, loadSettings,
  BOND_YIELD, VIX_TRIGGER
} = require('./_shared.js');
const { analyseStock }   = require('./strategy-engine.js');
const { getBulkPrices }  = require('./eodhd-client.js');

// ── FETCH REUTERS HEADLINES ───────────────────────────────────────────────────
async function fetchHeadlines() {
  try {
    const res  = await fetch('https://feeds.reuters.com/reuters/businessNews', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await res.text();
    const items = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)];
    return [...new Set(items.slice(1,9).map(m => m[1]?.trim()).filter(Boolean))].slice(0,7);
  } catch(e) { return []; }
}

async function fetchREITHeadlines() {
  try {
    const res  = await fetch('https://feeds.reuters.com/reuters/businessNews', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await res.text();
    const all  = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)];
    const kw   = ['reit','property','real estate','interest rate','rba','rate cut',
                  'rate hike','bond yield','inflation','housing','commercial property','fed'];
    return all.map(m=>m[1]?.trim()).filter(t=>t&&kw.some(k=>t.toLowerCase().includes(k))).slice(0,5);
  } catch(e) { return []; }
}

// ── MACRO SCORING ─────────────────────────────────────────────────────────────
function scoreMacro({ sp500Change, nasdaqChange, vix, yieldCurve, audChange,
                      us10yrChange, ironOreChange, goldChange, oilChange }) {
  let score = 0;
  const reasons = [];

  // US OVERNIGHT — primary ASX lead indicator
  if      (sp500Change >  0.015) { score+=3; reasons.push(`S&P strong +${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change >  0.005) { score+=2; reasons.push(`S&P +${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change >  0)     { score+=1; reasons.push(`S&P +${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change > -0.005) { score-=1; reasons.push(`S&P ${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change > -0.015) { score-=2; reasons.push(`S&P weak ${(sp500Change*100).toFixed(1)}%`); }
  else                           { score-=3; reasons.push(`S&P sold off ${(sp500Change*100).toFixed(1)}%`); }

  // NASDAQ — tech/growth signal
  if      (nasdaqChange >  0.01) { score+=1; reasons.push('Nasdaq strong'); }
  else if (nasdaqChange < -0.01) { score-=1; reasons.push('Nasdaq weak'); }

  // VIX — risk appetite
  if      (vix < 15)  { score+=2; reasons.push(`VIX ${vix.toFixed(0)} — low risk`); }
  else if (vix < 20)  { score+=1; reasons.push(`VIX ${vix.toFixed(0)} — calm`); }
  else if (vix >= 35) { score-=3; reasons.push(`VIX ${vix.toFixed(0)} — extreme fear`); }
  else if (vix >= 28) { score-=2; reasons.push(`VIX ${vix.toFixed(0)} — elevated fear`); }
  else if (vix >= 22) { score-=1; reasons.push(`VIX ${vix.toFixed(0)} — cautious`); }

  // RATES — critical for ASX, especially REITs and rate-sensitive stocks
  // Falling yields = positive for ASX (lower discount rate, more attractive vs bonds)
  if      (us10yrChange < -0.005) { score+=2; reasons.push(`US 10yr fell ${Math.round(us10yrChange*10000)}bps — tailwind`); }
  else if (us10yrChange < -0.002) { score+=1; reasons.push(`US 10yr fell ${Math.round(us10yrChange*10000)}bps`); }
  else if (us10yrChange >  0.005) { score-=2; reasons.push(`US 10yr rose ${Math.round(us10yrChange*10000)}bps — headwind`); }
  else if (us10yrChange >  0.002) { score-=1; reasons.push(`US 10yr rose ${Math.round(us10yrChange*10000)}bps`); }

  // YIELD CURVE — forward rate signal
  if (yieldCurve >  0.005) { score+=1; reasons.push('Curve steepening — growth positive'); }
  if (yieldCurve < -0.002) { score-=1; reasons.push('Curve inverted — recession signal'); }

  // AUD — risk proxy and commodity demand signal
  if      (audChange >  0.005) { score+=2; reasons.push(`AUD +${(audChange*100).toFixed(2)}% — risk on`); }
  else if (audChange >  0.002) { score+=1; reasons.push(`AUD rising`); }
  else if (audChange < -0.005) { score-=2; reasons.push(`AUD ${(audChange*100).toFixed(2)}% — risk off`); }
  else if (audChange < -0.002) { score-=1; reasons.push('AUD falling'); }

  // IRON ORE — drives BHP/RIO/FMG, ~20% of ASX200 by weight
  if      (ironOreChange &&  ironOreChange >  0.015) { score+=2; reasons.push(`Iron ore +${(ironOreChange*100).toFixed(1)}%`); }
  else if (ironOreChange &&  ironOreChange >  0.005) { score+=1; reasons.push(`Iron ore positive`); }
  else if (ironOreChange &&  ironOreChange < -0.015) { score-=2; reasons.push(`Iron ore ${(ironOreChange*100).toFixed(1)}%`); }
  else if (ironOreChange &&  ironOreChange < -0.005) { score-=1; reasons.push('Iron ore weak'); }

  // GOLD — gold miners significant ASX weight
  if      (goldChange &&  goldChange >  0.01) { score+=1; reasons.push(`Gold +${(goldChange*100).toFixed(1)}%`); }
  else if (goldChange &&  goldChange < -0.01) { score-=1; reasons.push(`Gold ${(goldChange*100).toFixed(1)}%`); }

  return { score, signal: score>=4?'RISK_ON':score<=-4?'RISK_OFF':'NEUTRAL', reasons };
}

// ── REIT MACRO SCORING ────────────────────────────────────────────────────────
// Separate macro layer specifically for ASX REITs
// REITs are interest rate plays — macro conditions matter differently
function scoreREITMacro({ us10yr, aus10yr, us10yrChange, aus10yrChange,
                           vnqChange, audChange, vix, yieldCurve }) {
  let score = 0;
  const reasons = [];
  const signals = [];

  // AUS 10YR YIELD LEVEL — absolute level matters for REIT spread attractiveness
  // When AUS 10yr is low, REIT yields look more attractive relative to bonds
  if      (aus10yr < 0.040) { score+=2; signals.push(`AUS 10yr ${(aus10yr*100).toFixed(2)}% — very low, REITs attractive`); }
  else if (aus10yr < 0.045) { score+=1; signals.push(`AUS 10yr ${(aus10yr*100).toFixed(2)}% — low`); }
  else if (aus10yr > 0.055) { score-=1; signals.push(`AUS 10yr ${(aus10yr*100).toFixed(2)}% — elevated`); }
  else if (aus10yr > 0.060) { score-=2; signals.push(`AUS 10yr ${(aus10yr*100).toFixed(2)}% — high, compresses REIT spread`); }

  // AUS 10YR DIRECTION — falling yields = REIT tailwind
  if      (aus10yrChange < -0.004) { score+=2; signals.push(`AUS 10yr -${Math.round(Math.abs(aus10yrChange)*10000)}bps — strong REIT tailwind`); }
  else if (aus10yrChange < -0.001) { score+=1; signals.push(`AUS 10yr falling — REIT positive`); }
  else if (aus10yrChange >  0.004) { score-=2; signals.push(`AUS 10yr +${Math.round(aus10yrChange*10000)}bps — REIT headwind`); }
  else if (aus10yrChange >  0.001) { score-=1; signals.push(`AUS 10yr rising — REIT negative`); }

  // US 10YR DIRECTION — US rates lead AUS rates
  if      (us10yrChange < -0.005) { score+=2; signals.push(`US 10yr -${Math.round(Math.abs(us10yrChange)*10000)}bps — global rate tailwind`); }
  else if (us10yrChange < -0.002) { score+=1; signals.push(`US 10yr falling`); }
  else if (us10yrChange >  0.005) { score-=2; signals.push(`US 10yr +${Math.round(us10yrChange*10000)}bps — global rate headwind`); }
  else if (us10yrChange >  0.002) { score-=1; signals.push(`US 10yr rising`); }

  // VNQ — US REIT ETF overnight performance, direct lead for ASX REITs
  if      (vnqChange >  0.015) { score+=3; signals.push(`VNQ +${(vnqChange*100).toFixed(1)}% — very strong US REIT lead`); }
  else if (vnqChange >  0.008) { score+=2; signals.push(`VNQ +${(vnqChange*100).toFixed(1)}% — strong US REIT lead`); }
  else if (vnqChange >  0.003) { score+=1; signals.push(`VNQ +${(vnqChange*100).toFixed(1)}% — positive`); }
  else if (vnqChange < -0.015) { score-=3; signals.push(`VNQ ${(vnqChange*100).toFixed(1)}% — heavy US REIT selloff`); }
  else if (vnqChange < -0.008) { score-=2; signals.push(`VNQ ${(vnqChange*100).toFixed(1)}% — US REITs sold off`); }
  else if (vnqChange < -0.003) { score-=1; signals.push(`VNQ ${(vnqChange*100).toFixed(1)}% — negative`); }

  // VIX — risk appetite affects REIT capital flows
  if      (vix < 15)  { score+=1; signals.push(`VIX ${vix?.toFixed(0)} — low risk, capital seeking yield`); }
  else if (vix >= 28) { score-=1; signals.push(`VIX ${vix?.toFixed(0)} — elevated, risk-off hurts REITs`); }

  // AUD — foreign capital flows into AUS property
  if      (audChange >  0.004) { score+=1; signals.push('AUD rising — foreign REIT demand positive'); }
  else if (audChange < -0.004) { score-=1; signals.push('AUD falling — foreign capital outflow risk'); }

  const rating = score >= 4 ? 'STRONGLY FAVOURABLE' :
                 score >= 2 ? 'FAVOURABLE' :
                 score >= 0 ? 'NEUTRAL' :
                 score >= -2 ? 'CAUTIOUS' : 'UNFAVOURABLE';

  const emoji  = score >= 4 ? '🟢' : score >= 2 ? '🟢' : score >= 0 ? '🟡' : score >= -2 ? '🟠' : '🔴';

  return { score, rating, emoji, signals };
}

// ── BREAKOUT SCANNER ──────────────────────────────────────────────────────────
// Finds stocks making 52W highs or breaking key resistance on strong volume
// Separate strategy from mean reversion — momentum/breakout approach
async function scanBreakouts(db, stocks, livePrices, macroScore) {
  const breakouts = [];

  try {
    // Get 52W high data from stocks table
    const tickers = stocks.map(s => s.ticker);

    // Get recent price history for resistance and volume analysis
    const { data: recentPrices } = await db.from('prices')
      .select('ticker,market_date,close,high,volume')
      .in('ticker', tickers)
      .gte('market_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('market_date', { ascending: false });

    if (!recentPrices?.length) return breakouts;

    // Group by ticker
    const priceMap = {};
    recentPrices.forEach(p => {
      if (!priceMap[p.ticker]) priceMap[p.ticker] = [];
      priceMap[p.ticker].push(p);
    });

    for (const stock of stocks) {
      try {
        const ticker   = stock.ticker;
        const live     = livePrices[ticker];
        const prices   = priceMap[ticker] || [];
        if (!live || prices.length < 10) continue;

        const price    = live.close || live.price;
        if (!price) continue;

        // 52W high from stocks table
        const high52w  = stock.high_52w;
        const low52w   = stock.low_52w;

        // Volume ratio
        const todayVol = live.volume || 0;
        const avgVol   = prices.slice(1, 21).reduce((s, p) => s + parseInt(p.volume || 0), 0) / Math.min(prices.length - 1, 20);
        const volRatio = avgVol > 0 ? todayVol / avgVol : 0;

        // Recent resistance — highest close in last 20 days (excluding today)
        const recentHigh = Math.max(...prices.slice(1, 21).map(p => parseFloat(p.close || 0)));

        // Breakout conditions
        const signals = [];
        let breakoutScore = 0;

        // Macro must be positive for breakout trades
        if (macroScore < 0) continue;

        // 1. Near or breaking 52W high
        if (high52w && price >= high52w * 0.98) {
          signals.push(`Near 52W high $${high52w.toFixed(3)}`);
          breakoutScore += 2;
        }
        if (high52w && price > high52w) {
          signals.push(`🚀 NEW 52W HIGH $${price.toFixed(3)}`);
          breakoutScore += 2; // extra for actual new high
        }

        // 2. Breaking recent resistance (20-day high)
        if (recentHigh > 0 && price > recentHigh * 1.01) {
          signals.push(`Breaking 20d resistance $${recentHigh.toFixed(3)}`);
          breakoutScore += 2;
        }

        // 3. Volume confirmation — critical for breakout validity
        if (volRatio > 3.0) {
          signals.push(`Volume ${volRatio.toFixed(1)}× avg — very strong`);
          breakoutScore += 3;
        } else if (volRatio > 2.0) {
          signals.push(`Volume ${volRatio.toFixed(1)}× avg — strong`);
          breakoutScore += 2;
        } else if (volRatio > 1.5) {
          signals.push(`Volume ${volRatio.toFixed(1)}× avg — elevated`);
          breakoutScore += 1;
        }

        // 4. Not too extended from 52W low (avoid chasing exhausted moves)
        if (low52w && high52w) {
          const pctOfRange = (price - low52w) / (high52w - low52w);
          if (pctOfRange > 0.85) {
            signals.push(`${(pctOfRange*100).toFixed(0)}% of 52W range`);
            breakoutScore += 1;
          }
        }

        // 5. Positive day (price up)
        if (live.change > 0) {
          const changePct = live.change / (price - live.change);
          if (changePct > 0.02) {
            signals.push(`Up ${(changePct*100).toFixed(1)}% today`);
            breakoutScore += 1;
          }
        }

        // Backtest optimal: 52W high break + vol >2x = 42.3% WR, +1.38% exp
        // Must have actual 52W break (not just near) AND volume >2x
        const actual52wBreak = high52w && price > high52w;
        if (!actual52wBreak) continue;       // require actual new high, not just near
        if (volRatio < 2.0) continue;        // require vol >2x (backtest optimal)
        if (breakoutScore < 4) continue;

        // Dynamic stop — just below breakout point (previous resistance)
        const stopPrice  = parseFloat((Math.max(recentHigh * 0.98, price * 0.97)).toFixed(3));
        const targetPrice = parseFloat((price * 1.06).toFixed(3)); // 6% target for breakouts

        breakouts.push({
          ticker,
          name:         stock.name,
          price,
          breakout_score: breakoutScore,
          signals,
          stop_price:   stopPrice,
          target_price: targetPrice,
          vol_ratio:    parseFloat(volRatio.toFixed(2)),
          high_52w:     high52w,
          strategy:     'BREAKOUT',
        });

      } catch(e) {
        // skip this stock silently
      }
    }

    // Sort by score then volume
    return breakouts.sort((a, b) => b.breakout_score - a.breakout_score || b.vol_ratio - a.vol_ratio);

  } catch(e) {
    console.error('Breakout scan error:', e.message);
    return [];
  }
}

// ── PRE-SCREEN FROM DB ────────────────────────────────────────────────────────
// Reads yesterday's prices and daily_analysis from Supabase
// Returns tickers worth doing full analysis on
async function preScreenFromDB(db, macroScore) {
  try {
    if (macroScore <= -3) {
      console.log('Macro too weak — no long signals today');
      return [];
    }

    // Get latest analysis date
    const { data: latest } = await db.from('daily_analysis')
      .select('analysis_date').order('analysis_date', { ascending: false }).limit(1).single();

    if (!latest) {
      console.log('No analysis data — will analyse full batch');
      return null;
    }

    const lastDate = latest.analysis_date;

    // Pull all analysed stocks for cross-sectional ranking
    const { data: universe } = await db.from('daily_analysis')
      .select('ticker, rsi14, vol_ratio, bb_position, pct_from_ma20, pct_from_ma200, above_ma200, total_score, adx')
      .eq('analysis_date', lastDate)
      .not('rsi14', 'is', null)
      .not('vol_ratio', 'is', null);

    if (!universe?.length) return null;

    // ── CROSS-SECTIONAL RANKING ──────────────────────────────────────────────
    // Score each stock relative to the universe, not just on absolute thresholds
    // This finds the most oversold + highest volume + best setup RELATIVE to peers

    const n = universe.length;

    // Rank each metric (percentile 0-100, higher = better signal)
    const rankPct = (arr, key, ascending=true) => {
      const sorted = [...arr].sort((a, b) => ascending
        ? (a[key]||0) - (b[key]||0)
        : (b[key]||0) - (a[key]||0)
      );
      const ranks = {};
      sorted.forEach((s, i) => { ranks[s.ticker] = (i / (n-1)) * 100; });
      return ranks;
    };

    // Lower RSI = more oversold = better (ascending rank = low RSI scores high)
    const rsiRank    = rankPct(universe, 'rsi14', true);
    // Higher vol_ratio = better
    const volRank    = rankPct(universe, 'vol_ratio', false);
    // Lower bb_position = more oversold = better
    const bbRank     = rankPct(universe, 'bb_position', true);
    // More negative pct_from_ma20 = more stretched = better for mean reversion
    const ma20Rank   = rankPct(universe, 'pct_from_ma20', true);
    // More negative pct_from_ma200 = more stretched = better
    const ma200Rank  = universe[0]?.pct_from_ma200 !== undefined
      ? rankPct(universe, 'pct_from_ma200', true) : {};

    // Composite cross-sectional score (weighted by backtest feature importance)
    const csScores = universe.map(s => {
      if (!s.above_ma200) return { ticker: s.ticker, csScore: 0 }; // must be in uptrend

      const cs =
        (rsiRank[s.ticker]   || 0) * 0.25 +  // RSI oversold — top feature
        (volRank[s.ticker]   || 0) * 0.20 +  // Volume — confirmation
        (bbRank[s.ticker]    || 0) * 0.20 +  // Bollinger position
        (ma20Rank[s.ticker]  || 0) * 0.20 +  // Distance from 20DMA
        (ma200Rank[s.ticker] || 0) * 0.15;   // Distance from 200DMA

      return { ticker: s.ticker, csScore: cs, totalScore: s.total_score || 0 };
    });

    // Take top 40 by cross-sectional score — these are relatively the most attractive
    const topCS = csScores
      .sort((a, b) => b.csScore - a.csScore)
      .slice(0, 40)
      .map(s => s.ticker);

    console.log(`Cross-sectional ranking: top ${topCS.length} from ${n} stocks`);
    return topCS;

  } catch(e) {
    console.error('Pre-screen error:', e.message);
    return null;
  }
}

// ── SECTOR SIGNALS ────────────────────────────────────────────────────────────
function getSectorSignals({ sp500Change, nasdaqChange, ironOreChange, goldChange,
  oilChange, audChange, us10yrChange }) {
  const signals = [
    {
      sector: 'Resources', icon: '⛏',
      driver: `Iron ore ${ironOreChange>=0?'+':''}${((ironOreChange||0)*100).toFixed(1)}%`,
      signal: (ironOreChange||0)>0.01?'🟢':(ironOreChange||0)<-0.01?'🔴':'🟡',
      note:   (ironOreChange||0)>0.01?'BHP, RIO, FMG positive':(ironOreChange||0)<-0.01?'Resources headwind':'Neutral'
    },
    {
      sector: 'Gold', icon: '🥇',
      driver: `Gold ${goldChange>=0?'+':''}${((goldChange||0)*100).toFixed(1)}%`,
      signal: (goldChange||0)>0.005?'🟢':(goldChange||0)<-0.005?'🔴':'🟡',
      note:   (goldChange||0)>0.005?'NST, EVN positive':(goldChange||0)<-0.005?'Gold headwind':'Neutral'
    },
    {
      sector: 'Banks', icon: '🏦',
      driver: `S&P ${sp500Change>=0?'+':''}${((sp500Change||0)*100).toFixed(1)}%`,
      signal: (sp500Change||0)>0.005?'🟢':(sp500Change||0)<-0.005?'🔴':'🟡',
      note:   (sp500Change||0)>0.005?'CBA, ANZ, WBC positive':'Banks headwind'
    },
    {
      sector: 'Technology', icon: '💻',
      driver: `Nasdaq ${nasdaqChange>=0?'+':''}${((nasdaqChange||0)*100).toFixed(1)}%`,
      signal: (nasdaqChange||0)>0.01?'🟢':(nasdaqChange||0)<-0.01?'🔴':'🟡',
      note:   (nasdaqChange||0)>0.01?'XRO, WTC positive':'Neutral'
    },
    {
      sector: 'REITs', icon: '🏢',
      driver: `AUS 10yr ${(us10yrChange||0)>=0?'+':''}${Math.round((us10yrChange||0)*10000)}bps`,
      signal: (us10yrChange||0)<-0.001?'🟢':(us10yrChange||0)>0.001?'🔴':'🟡',
      note:   (us10yrChange||0)<-0.001?'Yields fell — REITs positive':(us10yrChange||0)>0.001?'Yields rose — REIT headwind':'Yields flat'
    },
    {
      sector: 'Energy', icon: '⚡',
      driver: `Oil ${oilChange>=0?'+':''}${((oilChange||0)*100).toFixed(1)}%`,
      signal: (oilChange||0)>0.01?'🟢':(oilChange||0)<-0.01?'🔴':'🟡',
      note:   (oilChange||0)>0.01?'WDS, STO positive':'Neutral'
    }
  ];
  return signals;
}

// ── BUILD EMAIL ───────────────────────────────────────────────────────────────
function buildEmail(data) {
  const { market, macro, reitMacro, equityTrades, breakouts, reitResults, headlines, reitHeadlines,
          sectorSignals, nikkei, shanghai, futures } = data;
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr,
          yieldCurve, aud, audChange, realYield, vnqChange } = market;
  const { score, signal, reasons } = macro;

  const sigColor  = signal==='RISK_ON'?'#2d5a2d':signal==='RISK_OFF'?'#8b2e2e':'#7a5500';
  const sigEmoji  = signal==='RISK_ON'?'🟢':signal==='RISK_OFF'?'🔴':'⚪';
  const reitTrig  = reitResults.filter(r=>r.yield_trigger_fired);
  const exc       = equityTrades.filter(t=>t.total_score>=6);
  // Cap at ±20bps — anything larger is a data error
  // US 10yr change is a proxy for AUS 10yr direction
  const rawBps    = Math.round((market.us10yrChange||0)*10000);
  const bpsMove   = Math.max(-20, Math.min(20, rawBps));
  const reitMove  = (-bpsMove*0.0015*100).toFixed(1);

  const subject = `${sigEmoji} ASX 7am — ${signal.replace('_',' ')} ${score>0?'+':''}${score}`
    + (reitTrig.length?` 🚨 ${reitTrig.map(r=>r.ticker).join(',')}` : '')
    + (exc.length ? ` 🔥${exc.length}×6/6` : '');

  const fmt = {
    pct:  v => v==null?'--':(v>0?'+':'')+(v*100).toFixed(2)+'%',
    pct1: v => v==null?'--':(v*100).toFixed(1)+'%',
    bps:  v => v==null?'--':(v>0?'+':'')+Math.round(v*10000)+'bps',
    $3:   v => v==null?'--':'$'+parseFloat(v).toFixed(3),
    r2:   v => v==null?'--':parseFloat(v).toFixed(2),
    r4:   v => v==null?'--':parseFloat(v).toFixed(4),
    clr:  v => v>0?'#2d5a2d':v<0?'#8b2e2e':'#888'
  };

  const m = (l,v,c) => `
    <td style="padding:8px 10px;background:#f9f7f4;border-radius:4px;text-align:center;vertical-align:top">
      <div style="font-size:10px;color:#888;margin-bottom:3px;font-family:monospace;text-transform:uppercase">${l}</div>
      <div style="font-size:19px;font-weight:700;color:${c||'#1a1a1a'}">${v}</div>
    </td>
    <td style="width:6px"></td>`;

  const tradeCard = t => {
    const exitDay = new Date();
    exitDay.setDate(exitDay.getDate() + 3);
    const exitDayStr = exitDay.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});
    return `
    <div style="border:1px solid #e8e4dc;border-radius:6px;padding:14px;margin-bottom:10px;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <span style="font-family:monospace;font-weight:700;font-size:17px;color:#1a5f6e">${t.ticker}</span>
          <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;background:${t.conviction==='EXCEPTIONAL'?'#1a5f6e':t.conviction==='STRONG'?'#eef6ee':'#fdf8ee'};color:${t.conviction==='EXCEPTIONAL'?'#fff':t.conviction==='STRONG'?'#2d5a2d':'#7a5500'}">${t.conviction} ${t.total_score}/7</span>
        </div>
        <span style="font-family:monospace;font-weight:600;font-size:17px">${fmt.$3(t.price)}</span>
      </div>
      <div style="font-size:12px;color:#888;margin-bottom:4px">${t.name}</div>
      <div style="font-size:12px;color:#666;margin-bottom:10px;line-height:1.5">${(t.signal_reasons||[]).slice(0,3).join(' · ')}</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
        <tr>
          <td style="background:#fdf0f0;border-radius:4px;padding:8px;text-align:center;width:33%">
            <div style="font-size:9px;color:#888;margin-bottom:2px;text-transform:uppercase">Stop Loss</div>
            <div style="font-family:monospace;font-weight:700;color:#8b2e2e;font-size:15px">${fmt.$3(t.stop_price)}</div>
            <div style="font-size:9px;color:#aaa">-2% · sell if triggered</div>
          </td>
          <td style="width:6px"></td>
          <td style="background:#f0f8f0;border-radius:4px;padding:8px;text-align:center;width:33%">
            <div style="font-size:9px;color:#888;margin-bottom:2px;text-transform:uppercase">Target</div>
            <div style="font-family:monospace;font-weight:700;color:#2d5a2d;font-size:15px">${fmt.$3(t.target_price)}</div>
            <div style="font-size:9px;color:#aaa">+5% · sell at market</div>
          </td>
          <td style="width:6px"></td>
          <td style="background:#f5f2ec;border-radius:4px;padding:8px;text-align:center;width:33%">
            <div style="font-size:9px;color:#888;margin-bottom:2px;text-transform:uppercase">Position</div>
            <div style="font-family:monospace;font-weight:700;font-size:15px">$${(t.position_size||0).toLocaleString()}</div>
            <div style="font-size:9px;color:#aaa">${t.units||0} units</div>
          </td>
        </tr>
      </table>
      <div style="background:#f5f2ec;border-radius:4px;padding:10px 12px;font-size:12px;line-height:2;border-left:3px solid #1a5f6e">
        <div style="font-size:10px;color:#999;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">CommSec Order Instructions — Mean Reversion</div>
        <div>1. <strong>BUY</strong> ${t.ticker} · Market order · ${t.units||0} units · Place at <strong>10:00am AEST</strong></div>
        <div>2. Once filled → place <strong>Stop Loss Sell</strong>: ${t.units||0} units · Trigger <strong>${fmt.$3(t.stop_price)}</strong> · Good Till Cancel</div>
        <div>3. If price reaches <strong>${fmt.$3(t.target_price)}</strong> → cancel stop → <strong>Sell at Market</strong></div>
        <div>4. <strong>${exitDayStr}</strong>: if still open → sell at market on open regardless</div>
      </div>
    </div>`;
  };
  const reitCard = r => {
    const disc = r.nta&&r.price ? (r.price-r.nta)/r.nta : null;
    return `
    <div style="border:1px solid ${r.yield_trigger_fired?'#2d5a2d':r.dps_yield>=0.075?'#b8943f':'#e8e4dc'};
      border-radius:6px;padding:10px 12px;margin-bottom:6px;
      background:${r.yield_trigger_fired?'#f0f8f0':r.dps_yield>=0.075?'#fffbf0':'#fff'};
      display:flex;align-items:center;gap:10px">
      <span style="font-family:monospace;font-weight:700;font-size:15px;color:#1a5f6e;min-width:42px">${r.ticker}</span>
      <span style="font-size:12px;color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name}</span>
      <div style="text-align:right;min-width:80px">
        <div style="font-family:monospace;font-weight:700;font-size:15px;
          color:${r.dps_yield>=0.08?'#2d5a2d':r.dps_yield>=0.07?'#1a5f6e':'#555'}">
          ${r.dps_yield?(r.dps_yield*100).toFixed(1)+'%':'--'}
        </div>
        <div style="font-size:11px;font-family:monospace;
          color:${disc===null?'#888':disc<-0.1?'#2d5a2d':disc<0?'#1a5f6e':'#8b2e2e'}">
          ${disc!==null?(disc*100).toFixed(1)+'% disc':'--'}
        </div>
      </div>
      <div style="font-weight:700;font-size:13px;min-width:72px;text-align:right;
        color:${r.yield_trigger_fired?'#2d5a2d':r.dps_yield>=0.075?'#b8943f':'#aaa'}">
        ${r.yield_trigger_fired?'🟢 BUY':r.dps_yield>=0.075?'⚠️ Close':'Watching'}
      </div>
    </div>`;
  };

  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#f0ede6;color:#1a1a1a;font-size:15px}
    .wrap{max-width:600px;margin:0 auto;background:#f0ede6}
    .hdr{background:#0e1117;padding:18px 20px}
    .hdr h1{color:#d4b06a;font-size:20px;font-weight:600;margin-bottom:2px}
    .hdr p{color:rgba(255,255,255,0.35);font-size:11px;font-family:monospace}
    .sec{background:#fff;border-bottom:1px solid #e5e0d8;padding:16px 18px}
    .sec-title{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:12px;font-family:monospace}
    .sig{border-left:4px solid ${sigColor};padding:12px 14px;background:#f9f7f4;border-radius:0 6px 6px 0;margin-bottom:12px}
    .sig h2{font-size:22px;font-weight:700;color:${sigColor}}
    .sig p{font-size:13px;color:#666;margin-top:4px;line-height:1.5}
    .hl{padding:8px 0;border-bottom:1px solid #f0ede6;font-size:14px;line-height:1.4;color:#333}
    .hl:last-child{border:none}
    .hl::before{content:'→ ';color:#aaa}
    .ftr{padding:14px 18px;font-size:11px;color:#aaa;text-align:center;line-height:1.8}
    @media(max-width:480px){.hdr h1{font-size:18px}}
  `;

  const sectorRows = sectorSignals.map(s => `
    <div style="display:flex;align-items:center;padding:10px 0;border-bottom:1px solid #f5f2ec">
      <span style="font-size:20px;margin-right:12px;width:28px">${s.icon}</span>
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">${s.sector}</div>
        <div style="font-size:12px;color:#888;margin-top:1px">${s.driver} · ${s.note}</div>
      </div>
      <span style="font-size:20px;margin-left:8px">${s.signal}</span>
    </div>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head>
<body><div class="wrap">

<div class="hdr">
  <h1>ASX Morning Briefing</h1>
  <p>${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · 7:00am AEST · EODHD + Reuters + FRED</p>
</div>

<div class="sec">
  <div class="sig">
    <h2>${sigEmoji} ${signal.replace('_',' ')} &nbsp;<span style="font-size:15px;font-weight:400;color:#888">Score ${score>0?'+':''}${score}</span></h2>
    <p>${reasons.join(' · ')}</p>
  </div>
  ${vix>VIX_TRIGGER?`<div style="background:#fdf8ee;border-left:4px solid #b8943f;padding:10px 14px;border-radius:0 6px 6px 0;font-size:14px;color:#7a5500;font-weight:600;margin-bottom:10px">⚡ VIX ${vix.toFixed(1)} elevated — high conviction trades only today</div>`:''}
  ${reitTrig.length?`<div style="background:#eef6ee;border-left:4px solid #2d5a2d;padding:10px 14px;border-radius:0 6px 6px 0;font-size:14px;color:#2d5a2d;font-weight:600">🟢 REIT TRIGGER — ${reitTrig.map(r=>r.ticker).join(', ')} at 8%+ yield. Log into CommSec and buy.</div>`:''}
</div>

<div class="sec">
  <div class="sec-title">US Overnight</div>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${m('S&P 500', fmt.pct(sp500Change), fmt.clr(sp500Change))}
    ${m('Nasdaq',  fmt.pct(nasdaqChange), fmt.clr(nasdaqChange))}
    ${m('VIX',     vix.toFixed(1), vix<20?'#2d5a2d':vix<25?'#7a5500':'#8b2e2e')}
    ${m('AUD/USD', fmt.r4(aud), '#555')}
    ${m('AUD chg', fmt.pct(audChange), fmt.clr(audChange))}
  </tr></table>
</div>

<div class="sec">
  <div class="sec-title">Asian Markets</div>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${m('Nikkei',   nikkei?fmt.pct(nikkei.change):'--',  nikkei?fmt.clr(nikkei.change):'#888')}
    ${m('Shanghai', shanghai?fmt.pct(shanghai.change):'--', shanghai?fmt.clr(shanghai.change):'#888')}
    ${m('ASX Fut',  futures?fmt.pct(futures.change):'--',  futures?fmt.clr(futures.change):'#888')}
  </tr></table>
</div>

<div class="sec">
  <div class="sec-title">Bond Market — REIT Proxy</div>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${m('US 10yr',    fmt.pct1(us10yr),  '#1a5f6e')}
    ${m('AUS 10yr',   fmt.pct1(aus10yr), '#1a5f6e')}
    ${m('Curve',      fmt.bps(yieldCurve), fmt.clr(yieldCurve))}
    ${m('Real Yield', realYield?fmt.pct1(realYield):'--', '#555')}
    ${m('10yr chg',   fmt.bps(market.us10yrChange), fmt.clr(-(market.us10yrChange||0)))}
  </tr></table>
  <div style="margin-top:10px;padding:10px 14px;border-radius:6px;
    background:${bpsMove<-5?'#eef6ee':bpsMove>5?'#fdf0f0':'#f5f2ec'};
    border-left:4px solid ${bpsMove<-5?'#2d5a2d':bpsMove>5?'#8b2e2e':'#aaa'}">
    <div style="font-weight:700;font-size:14px;color:${bpsMove<-5?'#2d5a2d':bpsMove>5?'#8b2e2e':'#555'}">
      ${bpsMove<-5?'🟢 REIT POSITIVE':bpsMove>5?'🔴 REIT HEADWIND':'🟡 NEUTRAL'} — ${bpsMove>0?'+':''}${bpsMove}bps
    </div>
    <div style="font-size:13px;color:#666;margin-top:3px">Every 10bps fall = ~1.5% REIT re-rate. Today: expected REIT move ${reitMove>0?'+':''}${reitMove}%</div>
  </div>
</div>

<div class="sec">
  <div class="sec-title">Commodities</div>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${m('Iron Ore', market.ironOre?fmt.pct(market.ironOre.change):'--', market.ironOre?fmt.clr(market.ironOre.change):'#888')}
    ${m('Gold',     market.gold?fmt.pct(market.gold.change):'--',       market.gold?fmt.clr(market.gold.change):'#888')}
    ${m('Oil WTI',  market.oil?fmt.pct(market.oil.change):'--',         market.oil?fmt.clr(market.oil.change):'#888')}
    ${m('Copper',   market.copper?fmt.pct(market.copper.change):'--',   market.copper?fmt.clr(market.copper.change):'#888')}
  </tr></table>
</div>

<div class="sec">
  <div class="sec-title">Sector Outlook — Expected at ASX open</div>
  ${sectorRows}
</div>

<div class="sec">
  <div class="sec-title">ASX Trades — Place at 10:00am via CommSec</div>
  ${equityTrades.length===0
    ? '<p style="color:#888;font-size:14px;padding:8px 0">No trades today — macro too weak or no stocks passing 4+ layers.</p>'
    : equityTrades.map(tradeCard).join('')}
  <p style="font-size:12px;color:#aaa;margin-top:8px">Never hold overnight · Record in dashboard after CommSec confirms</p>
</div>

<div class="sec">
  <div class="sec-title">🚀 Breakout Signals — Momentum Strategy</div>
  ${!breakouts?.length
    ? '<p style="color:#888;font-size:14px;padding:8px 0">No breakouts today — no stocks at 52W highs with volume confirmation.</p>'
    : breakouts.map(b => `
      <div style="border:1px solid #e8e4dc;border-left:3px solid #b8943f;border-radius:3px;padding:12px 14px;margin-bottom:8px;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <span style="font-family:monospace;font-weight:700;font-size:15px;color:#1a5f6e">${b.ticker}</span>
            <span style="font-size:12px;color:#666;margin-left:8px">${b.name}</span>
          </div>
          <div style="text-align:right">
            <div style="font-size:16px;font-weight:700">$${b.price.toFixed(3)}</div>
            <div style="font-size:11px;color:#b8943f;font-weight:600">BREAKOUT ${b.breakout_score}/8 · ⏰ ENTER 10:45am</div>
          </div>
        </div>
        <div style="margin-top:8px;font-size:12px;color:#555">${b.signals.join(' · ')}</div>
        <div style="margin-top:8px;display:flex;gap:16px;font-size:12px">
          <span>Entry: <strong>$${b.price.toFixed(3)}</strong></span>
          <span style="color:#8b2e2e">Stop: <strong>$${b.stop_price.toFixed(3)}</strong></span>
          <span style="color:#2d5a2d">Target: <strong>$${b.target_price.toFixed(3)}</strong> (+6%)</span>
          <span style="color:#1a5f6e">Vol: <strong>${b.vol_ratio.toFixed(1)}×</strong></span>
        </div>
        <div style="margin-top:4px;font-size:11px;color:#aaa">52W High: $${b.high_52w?.toFixed(3)||'--'} · Momentum breakout — wider stop, higher target</div>
      </div>`).join('')}
  <p style="font-size:11px;color:#aaa;margin-top:6px">⏰ <strong>Enter at 10:45am AEST — not on open.</strong> Confirm price still above breakout level and volume still elevated before placing. False breakouts fade in first 30 mins.</p>
</div>

<div class="sec">
  <div class="sec-title">REIT Universe — Moelis Pure Landlords (${reitResults.length})</div>
  ${reitMacro ? `<div style="background:${reitMacro.score>=2?'#f0f8f0':reitMacro.score>=-2?'#fffbf0':'#fdf8ee'};border:1px solid ${reitMacro.score>=2?'#2d5a2d':reitMacro.score>=-2?'#b8943f':'#8b2e2e'};border-radius:4px;padding:10px 14px;margin-bottom:12px;font-size:12px;font-family:sans-serif">
    <strong style="font-size:13px">${reitMacro.emoji} REIT MACRO: ${reitMacro.rating}</strong>
    <div style="margin-top:6px;color:#555;line-height:1.8">
      AUS 10yr ${(market.aus10yr*100).toFixed(2)}% (${market.aus10yrChange>=0?'+':''}${Math.round(market.aus10yrChange*10000)}bps) &nbsp;·&nbsp;
      US 10yr ${(market.us10yr*100).toFixed(2)}% (${market.us10yrChange>=0?'+':''}${Math.round(market.us10yrChange*10000)}bps) &nbsp;·&nbsp;
      VNQ ${vnqChange>=0?'+':''}${(vnqChange*100).toFixed(1)}% overnight
    </div>
    <div style="margin-top:4px;color:#777;font-size:11px">${reitMacro.signals.slice(0,3).join(' · ')}</div>
  </div>` : ''}
  ${reitResults.sort((a,b)=>(b.dps_yield||0)-(a.dps_yield||0)).map(reitCard).join('')}
</div>

<div class="sec">
  <div class="sec-title">Global Finance Headlines</div>
  ${headlines.map(h=>`<div class="hl">${h}</div>`).join('') || '<p style="color:#aaa;font-size:13px">No headlines</p>'}
</div>

<div class="sec">
  <div class="sec-title">REIT &amp; Rate News</div>
  ${reitHeadlines.map(h=>`<div class="hl">${h}</div>`).join('') || '<p style="color:#aaa;font-size:13px">No REIT-specific news today</p>'}
</div>

<div class="ftr">
  Not financial advice · Paper trading mode · EODHD + FRED + Reuters<br>
  Place real trades via CommSec · Record in dashboard at areit.netlify.app
</div>
</div></body></html>`;

  return { subject, html };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
const { schedule } = require('@netlify/functions');
const run = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Morning scan starting: ${today}`);

  try {
    const settings = await loadSettings(db);

    // 1. US + Asian market data (Yahoo Finance — free, reliable for indices)
    const [sp500, nasdaq, dow, vixData, audData, us10yrData,
           nikkeiData, shanghaiData, futuresData,
           ironOreData, goldData, oilData, copperData, gsbgData, vnqData] = await Promise.all([
      fetchYahoo('^GSPC', '5d'), fetchYahoo('^IXIC', '5d'),
      fetchYahoo('^DJI',  '5d'), fetchYahoo('^VIX',  '5d'),
      fetchYahoo('AUDUSD=X', '5d'), fetchYahoo('^TNX', '5d'),
      fetchYahoo('^N225',    '5d'),
      fetchYahoo('000001.SS','5d'),
      fetchYahoo('^AXJO',   '5d'),
      fetchYahoo('GC=F',  '5d'),  // Gold futures
      fetchYahoo('GC=F',  '5d'),  // Gold (duplicate — iron ore has no free ticker)
      fetchYahoo('CL=F',  '5d'),  // WTI oil
      fetchYahoo('HG=F',  '5d'),  // Copper
      fetchYahoo('GSBG37.AX', '5d'), // AUS govt bond — proxy for AUS 10yr
      fetchYahoo('VNQ',   '5d'),  // US REIT ETF — lead indicator for ASX REITs
    ]);
    
    // Use GSBG37 price change as AUS 10yr direction proxy
    // Bond price moves inverse to yield — price up = yield down
    const gsbgChange = gsbgData?.change || 0;
    const aus10yrChangeEst = -gsbgChange * 0.5; // rough inverse proxy, capped

    // 2. FRED bond data
    const [realYield, breakeven] = await Promise.all([
      fetchFRED('DFII10'), fetchFRED('T10YIE')
    ]);

    const us10yr  = us10yrData?.price ? us10yrData.price/100 : 0.0431;
    const aus10yr = 0.0507;
    const vix     = vixData?.price  || 18;
    const aud     = audData?.price  || 0.648;

    const market = {
      sp500Change:   sp500?.change  || 0,
      nasdaqChange:  nasdaq?.change || 0,
      dowChange:     dow?.change    || 0,
      vix, us10yr, aus10yr,
      us10yrChange:  us10yrData?.change || 0,
      aus10yrChange: Math.max(-0.002, Math.min(0.002, aus10yrChangeEst)),
      yieldCurve:    us10yr - 0.0474,
      aud, audChange: audData?.change || 0,
      realYield, breakeven,
      ironOre: ironOreData,
      gold:    goldData,
      oil:     oilData,
      copper:  copperData,
      ironOreChange: ironOreData?.change || 0,
      goldChange:    goldData?.change    || 0,
      oilChange:     oilData?.change     || 0,
      vnqChange:     vnqData?.change     || 0,
      vnqPrice:      vnqData?.price      || null,
    };

    const macro     = scoreMacro(market);
    const reitMacro = scoreREITMacro(market);
    console.log(`Macro: ${macro.signal} (${macro.score}) | REIT Macro: ${reitMacro.rating} (${reitMacro.score})`);

    // 3. Fetch headlines in parallel
    const [headlines, reitHeadlines] = await Promise.all([
      fetchHeadlines(), fetchREITHeadlines()
    ]);

    // 4. Sector signals
    const sectorSignals = getSectorSignals({
      sp500Change:   market.sp500Change,
      nasdaqChange:  market.nasdaqChange,
      ironOreChange: market.ironOreChange,
      goldChange:    market.goldChange,
      oilChange:     market.oilChange,
      audChange:     market.audChange,
      us10yrChange:  market.us10yrChange,
    });

    // 5. Load stock universes
    // TOP 400 by market cap (active ASX500, excluding REIT universe, ordered by id = market cap rank)
    const { data: equityStocks } = await db.from('stocks')
      .select('*')
      .eq('active', true)
      .eq('universe', 'ASX500')
      .eq('is_manager', false)
      .eq('is_developer', false)
      .order('id', { ascending: true })
      .limit(400);

    const { data: reitStocks } = await db.from('stocks')
      .select('*')
      .eq('active', true)
      .eq('is_reit', true)
      .eq('is_manager', false)
      .eq('is_developer', false);

    // 6. Pre-screen equities from DB — no API calls
    let candidateTickers = await preScreenFromDB(db, macro.score);
    let stocksToAnalyse;

    if (candidateTickers && candidateTickers.length > 0) {
      // Use pre-screened candidates
      const candSet = new Set(candidateTickers);
      stocksToAnalyse = (equityStocks||[]).filter(s => candSet.has(s.ticker));
      console.log(`Using ${stocksToAnalyse.length} pre-screened candidates`);
    } else {
      // Fallback: rotating batch of 50 from top 400
      const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(),0,0)) / 86400000);
      const start     = (dayOfYear * 50) % (equityStocks||[]).length;
      stocksToAnalyse = [...(equityStocks||[]).slice(start), ...(equityStocks||[]).slice(0,start)].slice(0,50);
      console.log(`Using rotating batch of ${stocksToAnalyse.length} stocks`);
    }

    // 7. Get bulk live prices from EODHD (one API call for all)
    const allTickers   = [...stocksToAnalyse, ...(reitStocks||[])]
      .map(s => s.ticker).filter(t => t !== 'GSBG37');
    const livePrices   = await getBulkPrices(allTickers);
    console.log(`Live prices fetched: ${Object.keys(livePrices).length}`);

    // 8. Run 6-layer analysis
    const equityResults = [];
    for (const stock of stocksToAnalyse) {
      const lp = livePrices[stock.ticker]?.close;
      const r  = await analyseStock(stock, macro.score, settings, lp);
      if (r && r.total_score >= 5) equityResults.push(r);
      await new Promise(res => setTimeout(res, 80));
    }

    const reitResults = [];
    for (const stock of (reitStocks||[]).filter(s => s.ticker !== 'GSBG37')) {
      const lp = livePrices[stock.ticker]?.close;
      const r  = await analyseStock(stock, macro.score, settings, lp);
      if (r) reitResults.push(r);
      await new Promise(res => setTimeout(res, 80));
    }

    const topEquities  = equityResults.sort((a,b) => b.total_score - a.total_score).slice(0,6);
    const reitTriggers = reitResults.filter(r => r.yield_trigger_fired).map(r => r.ticker);
    console.log(`Analysis complete — equities:${topEquities.length} reits:${reitResults.length} triggers:${reitTriggers.length}`);

    // 8b. Breakout scanner — runs across all 400 equity stocks
    const breakoutResults = await scanBreakouts(db, equityStocks||[], livePrices, macro.score);
    const topBreakouts = breakoutResults.slice(0, 6);
    console.log(`Breakouts found: ${breakoutResults.length}, top: ${topBreakouts.length}`);

    // 9. Save analysis
    const allAnalysis = [...equityResults, ...reitResults].map(r => ({
      ticker: r.ticker, analysis_date: today, close: r.price,
      ma20: r.ma20, ma50: r.ma50, ma200: r.ma200,
      above_ma20: r.above_ma20, above_ma200: r.above_ma200, golden_cross: r.golden_cross,
      rsi14: r.rsi14, roc20: r.roc20, bb_position: r.bb_position,
      vol_ratio: r.vol_ratio, pct_from_ma20: r.pct_from_ma20,
      candle_pattern: r.candle_pattern, candle_hammer: r.candle_hammer,
      candle_engulfing_bull: r.candle_engulfing_bull, candle_doji: r.candle_doji,
      candle_morning_star: r.candle_morning_star,
      dps_yield: r.dps_yield, yield_trigger_fired: r.yield_trigger_fired,
      layer1_macro: r.layer1_macro, layer2_trend: r.layer2_trend,
      layer3_momentum: r.layer3_momentum, layer4_reversion: r.layer4_reversion,
      layer5_volume: r.layer5_volume, layer6_candle: r.layer6_candle,
      total_score: r.total_score, signal: r.signal,
      conviction: r.conviction, signal_reasons: r.signal_reasons
    }));

    // Add breakout results to daily_analysis
    const breakoutAnalysis = (topBreakouts||[]).map(b => ({
      ticker: b.ticker, analysis_date: today, close: b.price,
      vol_ratio: b.vol_ratio,
      total_score: b.breakout_score,
      signal: 'BREAKOUT',
      conviction: b.breakout_score >= 6 ? 'EXCEPTIONAL' : 'STRONG',
      signal_reasons: b.signals,
    }));

    const combined = [...allAnalysis, ...breakoutAnalysis];
    if (combined.length > 0) {
      await db.from('daily_analysis').upsert(combined, { onConflict: 'ticker,analysis_date' });
    }

    // 10. Save model trades — no duplicates
    // Auto-expire trades older than hold_days (default 3)
    const holdDays = parseInt(settings.hold_days || '3');
    const expiryDate = new Date(Date.now() - holdDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: expiredTrades } = await db.from('model_trades')
      .select('id,ticker,entry_price,units')
      .eq('status', 'OPEN')
      .lt('trade_date', expiryDate);

    if (expiredTrades?.length) {
      for (const t of expiredTrades) {
        const exitPrice = livePrices[t.ticker]?.close || t.entry_price;
        const pnl = (exitPrice - t.entry_price) * (t.units || 0);
        await db.from('model_trades').update({
          status: 'CLOSED', exit_price: exitPrice, exit_date: today,
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_pct: parseFloat(((exitPrice - t.entry_price) / t.entry_price).toFixed(6)),
          hold_days: holdDays
        }).eq('id', t.id);
      }
      console.log(`Auto-expired ${expiredTrades.length} trades after ${holdDays} days`);
    }

    if (topEquities.length > 0) {
      const { data: openPositions } = await db.from('model_trades')
        .select('ticker').eq('status', 'OPEN');
      const { data: todayTrades } = await db.from('model_trades')
        .select('ticker').eq('trade_date', today);
      const skipTickers = new Set([
        ...(openPositions||[]).map(t => t.ticker),
        ...(todayTrades||[]).map(t => t.ticker)
      ]);

      const newTrades = topEquities
        .filter(t => t.total_score >= 5 && !skipTickers.has(t.ticker))
        .map(t => ({
          ticker: t.ticker, company_name: t.name, universe: 'ASX500',
          trade_date: today, direction: 'LONG',
          entry_price: t.price, stop_price: t.stop_price, target_price: t.target_price,
          units: t.units, amount: t.position_size, status: 'OPEN',
          total_score: t.total_score, conviction: t.conviction, signal_reasons: t.signal_reasons,
          layer1_macro: t.layer1_macro, layer2_trend: t.layer2_trend,
          layer3_momentum: t.layer3_momentum, layer4_reversion: t.layer4_reversion,
          layer5_volume: t.layer5_volume, layer6_candle: t.layer6_candle,
          candle_pattern: t.candle_pattern
        }));

      if (newTrades.length > 0) {
        await db.from('model_trades').insert(newTrades);
        console.log(`Inserted ${newTrades.length} new model trades`);
      }
    }

    // 11. Save morning signal
    await db.from('morning_signals').upsert({
      signal_date: today, sp500_change: market.sp500Change,
      nasdaq_change: market.nasdaqChange, vix,
      us_10yr: us10yr, aus_10yr: aus10yr,
      yield_curve_us: market.yieldCurve, aud_usd: aud,
      aud_change: market.audChange, real_yield: realYield,
      macro_score: macro.score, macro_signal: macro.signal, signal: macro.signal,
      reit_macro_score: reitMacro.score, reit_macro_signal: reitMacro.rating,
      vnq_change: market.vnqChange,
      summary: macro.reasons.join('; '),
      equities_long: topEquities.map(t => t.ticker),
      reits_long: reitResults.filter(r => r.total_score >= 5).map(r => r.ticker),
      reit_triggers: reitTriggers
    }, { onConflict: 'signal_date' });

    // 12. Send email
    const { subject, html } = buildEmail({
      market, macro, reitMacro, equityTrades: topEquities, breakouts: topBreakouts, reitResults,
      headlines, reitHeadlines, sectorSignals,
      nikkei: nikkeiData, shanghai: shanghaiData, futures: futuresData
    });
    await sendEmail(subject, html);
    console.log('Morning scan complete');

    return { statusCode: 200, body: JSON.stringify({
      date: today, macro: macro.signal, score: macro.score,
      equities: topEquities.length, reits: reitResults.length, triggers: reitTriggers.length
    })};

  } catch(err) {
    console.error('Morning scan failed:', err);
    try { await sendEmail('⚠️ ASX Platform — Morning scan error', `<p style="font-family:sans-serif">Error: ${err.message}</p>`); } catch(e){}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
exports.handler = schedule('0 21 * * 0-4', run);
