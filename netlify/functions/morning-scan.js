// netlify/functions/morning-scan.js
// Scheduled: 7:00am AEST (9:00pm UTC prev day) Mon-Fri
// 2-step architecture:
// Step 1: Pre-screen from DB prices (no API calls) — fast
// Step 2: Full 6-layer analysis only on candidates — limited EODHD calls
// Universe: Top 400 ASX stocks + 28 Moelis REITs

const {
  getSupabase, fetchYahoo, fetchFRED, sendEmail, loadSettings,
  BOND_YIELD, VIX_TRIGGER, emailStyles
} = require('./_shared.js');
const { analyseStock, scoreStock, getPositionSize } = require('./strategy-engine.js');
const { getBulkPrices }  = require('./eodhd-client.js');

// ── FETCH HEADLINES ───────────────────────────────────────────────────────────
async function fetchHeadlines() {
  const feeds = [
    'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en',
    'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
    'https://www.afr.com/rss/feed',
  ];
  for (const url of feeds) {
    try {
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      const items = [...text.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)];
      const headlines = [...new Set(items.slice(1,10).map(m => m[1]?.trim()).filter(Boolean))].slice(0,7);
      if (headlines.length > 0) return headlines;
    } catch(e) { continue; }
  }
  return [];
}

async function fetchREITHeadlines() {
  const feeds = [
    'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en',
    'https://www.rba.gov.au/rss/rss-cb-media-releases.xml',
    'https://www.rba.gov.au/rss/rss-cb-speeches.xml',
  ];
  const kw = ['reit','property','real estate','interest rate','rba','rate cut',
              'rate hike','bond yield','inflation','housing','commercial property',
              'fed','cash rate','monetary policy','yield','cap rate','landlord'];
  const items = [];
  for (const url of feeds) {
    try {
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      const all  = [...text.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)];
      all.map(m=>m[1]?.trim()).filter(t=>t&&kw.some(k=>t.toLowerCase().includes(k))).forEach(t => {
        if (!items.includes(t)) items.push(t);
      });
    } catch(e) { continue; }
  }
  return items.slice(0,5);
}

async function fetchRateNews() {
  const feeds = [
    'https://www.rba.gov.au/rss/rss-cb-media-releases.xml',
    'https://www.rba.gov.au/rss/rss-cb-speeches.xml',
  ];
  const items = [];
  for (const url of feeds) {
    try {
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      const titles = [...text.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)];
      titles.slice(1, 4).forEach(m => { if (m[1]?.trim()) items.push('RBA: ' + m[1].trim()); });
    } catch(e) { continue; }
  }
  return items.slice(0, 3);
}


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
    const tickers = stocks.map(s => s.ticker);

    // Fetch 365 calendar days per-ticker = ~252 trading days = exactly 1 year (52 weeks)
    // stocks.high_52w is never populated (all null) so we calculate it ourselves.
    // Per-ticker fetch avoids Supabase's 1000-row cap on multi-ticker queries.
    const cutoff52w = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const priceMap = {};
    const PARALLEL = 8;
    for (let i = 0; i < tickers.length; i += PARALLEL) {
      const group = tickers.slice(i, i + PARALLEL);
      const results = await Promise.all(group.map(ticker =>
        db.from('prices')
          .select('ticker,market_date,close,high,low,volume')
          .eq('ticker', ticker)
          .gte('market_date', cutoff52w)
          .order('market_date', { ascending: false })
          .limit(280)  // 280 rows covers 365 calendar days of trading
      ));
      results.forEach(({ data }) => {
        (data||[]).forEach(p => {
          if (!priceMap[p.ticker]) priceMap[p.ticker] = [];
          priceMap[p.ticker].push(p);
        });
      });
    }

    if (!Object.keys(priceMap).length) return breakouts;

    for (const stock of stocks) {
      try {
        const ticker   = stock.ticker;
        const live     = livePrices[ticker];
        const prices   = priceMap[ticker] || [];
        if (!live || prices.length < 10) continue;

        const price    = live.close || live.price;
        if (!price) continue;

        // Calculate 52W high/low from price history (prices are desc order)
        const high52w = Math.max(...prices.map(p => parseFloat(p.high || p.close || 0)));
        const low52w  = Math.min(...prices.filter(p => parseFloat(p.low || p.close) > 0).map(p => parseFloat(p.low || p.close)));

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

        // For morning scan: flag stocks within 3% of 52W high as candidates for ORB scan
        // The ORB scan at 10:30am confirms the actual breakout with live intraday prices
        // Don't require actual break here — that's the ORB scan's job
        const near52wHigh = high52w && price >= high52w * 0.97;
        if (!near52wHigh) continue;          // must be within 3% of 52W high
        if (volRatio < 1.5) continue;        // some volume confirmation
        if (breakoutScore < 3) continue;

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
  const { market, macro, reitMacro, equityTrades, breakouts, reitResults, headlines, reitHeadlines, rateNews } = data;
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, aud, audChange, vnqChange } = market;
  const { score, signal, reasons } = macro;

  const rawBps    = Math.round((market.us10yrChange||0)*10000);
  const bpsMove   = Math.max(-20, Math.min(20, rawBps));
  const dateStr   = new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const reitTrig  = reitResults.filter(r=>r.yield_trigger_fired);
  const exc       = equityTrades.filter(t=>t.total_score>=6);

  const macroLabel = signal==='RISK_ON' ? 'RISK ON' : signal==='RISK_OFF' ? 'RISK OFF' : 'NEUTRAL';
  const macroColor = signal==='RISK_ON' ? '#1a6b2e' : signal==='RISK_OFF' ? '#8b1a1a' : '#5a5a5a';

  const exitDay = new Date();
  exitDay.setDate(exitDay.getDate() + 3);
  const exitDayStr = exitDay.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});

  const subject = `ASX Morning Scan — ${macroLabel} (${score>0?'+':''}${score})`
    + (reitTrig.length ? ` | REIT Triggers: ${reitTrig.map(r=>r.ticker).join(', ')}` : '')
    + (exc.length ? ` | ${exc.length} Exceptional` : '');

  const pct  = v => v==null?'--':(v>=0?'+':'')+((v)*100).toFixed(2)+'%';
  const $3   = v => v==null?'--':'$'+parseFloat(v).toFixed(3);
  const $2   = v => v==null?'--':'$'+parseFloat(v).toFixed(2);
  const chgColor = v => v>0?'#1a6b2e':v<0?'#8b1a1a':'#666';
  const bpsColor = v => v<-3?'#1a6b2e':v>3?'#8b1a1a':'#666';

  // ── STYLES ────────────────────────────────────────────────────────────────
  const S = {
    wrap:     'max-width:680px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a1a1a;background:#ffffff;',
    header:   'background:#0a1628;padding:24px 32px;',
    h_firm:   'font-size:11px;color:#8899aa;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px;',
    h_title:  'font-size:20px;font-weight:700;color:#ffffff;margin:0 0 2px;letter-spacing:-0.3px;',
    h_sub:    'font-size:11px;color:#6688aa;margin:0;',
    divider:  'height:1px;background:#e8e8e8;margin:0;border:none;',
    sec:      'padding:20px 32px;border-bottom:1px solid #efefef;',
    sec_sm:   'padding:12px 32px;border-bottom:1px solid #efefef;',
    label:    'font-size:10px;font-weight:700;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px;',
    th:       'font-size:10px;font-weight:700;color:#888;letter-spacing:1px;text-transform:uppercase;padding:6px 8px;text-align:left;border-bottom:2px solid #e8e8e8;white-space:nowrap;',
    th_r:     'font-size:10px;font-weight:700;color:#888;letter-spacing:1px;text-transform:uppercase;padding:6px 8px;text-align:right;border-bottom:2px solid #e8e8e8;white-space:nowrap;',
    td:       'font-size:12px;color:#333;padding:7px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;',
    td_r:     'font-size:12px;color:#333;padding:7px 8px;text-align:right;border-bottom:1px solid #f0f0f0;vertical-align:middle;font-family:Courier New,monospace;',
    mono:     'font-family:Courier New,monospace;',
    footer:   'padding:20px 32px;background:#f8f8f8;border-top:1px solid #e8e8e8;',
    disc:     'font-size:10px;color:#aaa;line-height:1.6;margin:8px 0 0;',
  };

  // ── MACRO TABLE ───────────────────────────────────────────────────────────
  const macroRows = [
    ['S&P 500',   sp500Change!=null?pct(sp500Change):'--',   sp500Change!=null?pct(sp500Change):'--',   chgColor(sp500Change),  sp500Change>0.005?'Positive':sp500Change<-0.005?'Negative':'Flat'],
    ['Nasdaq',    nasdaqChange!=null?pct(nasdaqChange):'--', nasdaqChange!=null?pct(nasdaqChange):'--', chgColor(nasdaqChange), nasdaqChange>0.005?'Positive':nasdaqChange<-0.005?'Negative':'Flat'],
    ['VIX',       vix?vix.toFixed(1):'--',                  '--',                                       '#666',                 vix<15?'Low':vix<22?'Normal':vix<28?'Elevated':'High'],
    ['US 10yr',   us10yr?(us10yr*100).toFixed(2)+'%':'--',  bpsMove?(bpsMove>0?'+':'')+bpsMove+'bps':'--', bpsColor(bpsMove), bpsMove<-3?'Falling':bpsMove>3?'Rising':'Stable'],
    ['AUS 10yr',  aus10yr?(aus10yr*100).toFixed(2)+'%':'--','--',                                       '#666',                 'Proxy GSBG37'],
    ['AUD/USD',   aud?aud.toFixed(4):'--',                  audChange!=null?pct(audChange):'--',        chgColor(audChange),    audChange>0.003?'Rising':audChange<-0.003?'Falling':'Stable'],
    ['VNQ',       '--',                                      vnqChange!=null?pct(vnqChange):'--',        chgColor(vnqChange),    vnqChange>0.005?'Positive':vnqChange<-0.005?'Negative':'Flat'],
  ].map(([ind, val, chg, col, sig]) => `
    <tr>
      <td style="${S.td}">${ind}</td>
      <td style="${S.td_r}">${val}</td>
      <td style="${S.td_r};color:${col};font-weight:600;">${chg}</td>
      <td style="${S.td};color:#888;font-size:11px;">${sig}</td>
    </tr>`).join('');

  // ── REIT TRIGGER ROWS ─────────────────────────────────────────────────────
  const reitTrigRows = reitTrig.map(r => {
    const yld = r.dps_yield ? (r.dps_yield*100).toFixed(1)+'%' : '--';
    const nta = r.nta ? $3(r.nta) : '--';
    const disc = r.nta && r.price ? ((r.price/r.nta-1)*100).toFixed(1)+'%' : '--';
    return `
    <tr>
      <td style="${S.td};font-weight:700;font-family:Courier New,monospace;">${r.ticker}</td>
      <td style="${S.td};font-size:11px;">${r.name||''}</td>
      <td style="${S.td_r}">${$3(r.price)}</td>
      <td style="${S.td_r};color:#1a6b2e;font-weight:700;">${yld}</td>
      <td style="${S.td_r}">${nta}</td>
      <td style="${S.td_r};font-size:11px;color:#888;">${disc}</td>
    </tr>`;
  }).join('');

  // ── REIT UNIVERSE ROWS ────────────────────────────────────────────────────
  const reitAllRows = reitResults
    .filter(r=>!r.yield_trigger_fired)
    .sort((a,b)=>(b.dps_yield||0)-(a.dps_yield||0))
    .map(r => {
      const yld = r.dps_yield ? (r.dps_yield*100).toFixed(1)+'%' : '--';
      const nta = r.nta ? $3(r.nta) : '--';
      return `
      <tr>
        <td style="${S.td};font-family:Courier New,monospace;">${r.ticker}</td>
        <td style="${S.td};font-size:11px;color:#555;">${r.name||''}</td>
        <td style="${S.td_r}">${$3(r.price)}</td>
        <td style="${S.td_r}">${yld}</td>
        <td style="${S.td_r}">${nta}</td>
        <td style="${S.td_r};font-size:11px;color:#aaa;">--</td>
      </tr>`;
    }).join('');

  // ── EQUITY TRADE CARDS ────────────────────────────────────────────────────
  const tradeRows = equityTrades.map(t => `
    <tr style="border-top:2px solid #0a1628;">
      <td colspan="6" style="padding:16px 0 8px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;">
              <span style="font-size:16px;font-weight:700;font-family:Courier New,monospace;color:#0a1628;">${t.ticker}</span>
              <span style="font-size:11px;color:#888;margin-left:8px;">${t.name||''}</span><br>
              <span style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;">${t.conviction||''} &nbsp;${t.total_score}/7</span>
            </td>
            <td style="text-align:right;vertical-align:top;">
              <span style="font-size:18px;font-weight:700;font-family:Courier New,monospace;">${$3(t.price)}</span>
            </td>
          </tr>
        </table>
        <div style="font-size:11px;color:#555;margin:6px 0;line-height:1.8;">${(t.signal_reasons||[]).slice(0,4).join(' &nbsp;·&nbsp; ')}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border-top:1px solid #efefef;border-bottom:1px solid #efefef;">
          <tr>
            <td style="padding:10px 16px 10px 0;text-align:center;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Entry</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;">${$3(t.price)}</div>
              <div style="font-size:10px;color:#888;">Market open</div>
            </td>
            <td style="padding:10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Stop Loss</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;color:#8b1a1a;">${$3(t.stop_price)}</div>
              <div style="font-size:10px;color:#888;">&#8209;2%</div>
            </td>
            <td style="padding:10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Target</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;color:#1a6b2e;">${$3(t.target_price)}</div>
              <div style="font-size:10px;color:#888;">+5%</div>
            </td>
            <td style="padding:10px 0 10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Size</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;color:#0a1628;">$${(t.position_size||0).toLocaleString()}</div>
              <div style="font-size:10px;color:#888;">${t.units||0} units</div>
            </td>
          </tr>
        </table>
        <div style="background:#f8f9fa;border-left:3px solid #0a1628;padding:10px 14px;font-size:11px;color:#444;line-height:2;">
          <strong>CommSec:</strong> BUY ${t.ticker} · Market · ${t.units||0} units · 10:00am AEST &nbsp;|&nbsp;
          Set stop sell ${$3(t.stop_price)} GTC &nbsp;|&nbsp;
          Target ${$3(t.target_price)} · Day 3 exit ${exitDayStr}
        </div>
      </td>
    </tr>`).join('');

  // ── BREAKOUT CARDS ────────────────────────────────────────────────────────
  const breakoutRows = breakouts.map(b => `
    <tr style="border-top:2px solid #8b6a00;">
      <td colspan="6" style="padding:16px 0 8px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;">
              <span style="font-size:16px;font-weight:700;font-family:Courier New,monospace;color:#8b6a00;">${b.ticker}</span>
              <span style="font-size:11px;color:#888;margin-left:8px;">${b.name||''}</span><br>
              <span style="font-size:10px;color:#8b6a00;letter-spacing:1px;text-transform:uppercase;">BREAKOUT &nbsp;${b.breakout_score}/8 &nbsp;·&nbsp; Vol ${b.vol_ratio?b.vol_ratio.toFixed(1)+'x':'--'}</span>
            </td>
            <td style="text-align:right;vertical-align:top;">
              <span style="font-size:18px;font-weight:700;font-family:Courier New,monospace;">${$3(b.price)}</span>
            </td>
          </tr>
        </table>
        <div style="font-size:11px;color:#555;margin:6px 0;line-height:1.8;">${(b.signals||[]).slice(0,3).join(' &nbsp;·&nbsp; ')}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border-top:1px solid #efefef;border-bottom:1px solid #efefef;">
          <tr>
            <td style="padding:10px 16px 10px 0;text-align:center;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">52W High</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;">${b.high52w?$3(b.high52w):'--'}</div>
            </td>
            <td style="padding:10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Stop</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;color:#8b1a1a;">${$3(b.stop_price)}</div>
            </td>
            <td style="padding:10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Target</div>
              <div style="font-size:15px;font-weight:700;font-family:Courier New,monospace;color:#1a6b2e;">${$3(b.target_price)}</div>
              <div style="font-size:10px;color:#888;">+6%</div>
            </td>
            <td style="padding:10px 0 10px 16px;text-align:center;border-left:1px solid #efefef;">
              <div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Entry</div>
              <div style="font-size:13px;font-weight:700;color:#8b6a00;">10:45am AEST</div>
              <div style="font-size:10px;color:#888;">After ORB confirm</div>
            </td>
          </tr>
        </table>
        <div style="background:#fffdf0;border-left:3px solid #8b6a00;padding:10px 14px;font-size:11px;color:#555;line-height:1.8;">
          Confirm price still above ${$3(b.price)} at 10:45am before entering. Wait for ORB confirmation email at 10:30am.
        </div>
      </td>
    </tr>`).join('');

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f0f0f0;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;">
<tr><td>

<!-- HEADER -->
<table width="100%" cellpadding="0" cellspacing="0" style="${S.wrap}">
<tr><td style="${S.header}">
  <p style="${S.h_firm}">ASX Trading Platform &nbsp;/&nbsp; James Storey</p>
  <p style="${S.h_title}">Morning Strategy Briefing</p>
  <p style="${S.h_sub}">${dateStr} &nbsp;·&nbsp; 7:00am AEST</p>
</td></tr>

<!-- MACRO -->
<tr><td style="${S.sec}">
  <p style="${S.label}">Market Macro</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
    <tr>
      <td style="padding:12px 16px;background:${signal==='RISK_ON'?'#f0f7f0':signal==='RISK_OFF'?'#fdf0f0':'#f8f8f8'};border-left:3px solid ${macroColor};">
        <span style="font-size:13px;font-weight:700;color:${macroColor};">${macroLabel} &nbsp; Score: ${score>0?'+':''}${score}</span><br>
        <span style="font-size:11px;color:#666;line-height:1.8;">${reasons.slice(0,5).join(' &nbsp;·&nbsp; ')}</span>
      </td>
    </tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="${S.th}">Indicator</th>
      <th style="${S.th_r}">Level</th>
      <th style="${S.th_r}">Change</th>
      <th style="${S.th}">Signal</th>
    </tr>
    ${macroRows}
  </table>
  <p style="font-size:10px;color:#aaa;margin:8px 0 0;">Sources: Yahoo Finance &nbsp;·&nbsp; FRED &nbsp;·&nbsp; EODHD</p>
</td></tr>

${reitTrig.length?`
<!-- REIT TRIGGERS -->
<tr><td style="${S.sec}">
  <p style="${S.label}">REIT Yield Triggers &mdash; ${reitTrig.length} Fired</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="${S.th}">Ticker</th>
      <th style="${S.th}">Name</th>
      <th style="${S.th_r}">Price</th>
      <th style="${S.th_r}">Yield</th>
      <th style="${S.th_r}">NTA</th>
      <th style="${S.th_r}">Disc/Prem</th>
    </tr>
    ${reitTrigRows}
  </table>
  <p style="font-size:10px;color:#aaa;margin:8px 0 0;">Yield trigger: DPS FY26 / price &ge; 8.0% &nbsp;·&nbsp; NTA from Moelis broker research</p>
</td></tr>`:''}

${equityTrades.length?`
<!-- EQUITY SIGNALS -->
<tr><td style="${S.sec}">
  <p style="${S.label}">Equity Signals &mdash; ${equityTrades.length} Signal${equityTrades.length>1?'s':''}</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    ${tradeRows}
  </table>
</td></tr>`:`
<!-- NO EQUITY SIGNALS -->
<tr><td style="${S.sec}">
  <p style="${S.label}">Equity Signals</p>
  <p style="font-size:12px;color:#888;margin:0;">No signals today &mdash; macro conditions or insufficient setups. Min score 5/7 required.</p>
  <p style="font-size:10px;color:#aaa;margin:6px 0 0;">Strategy: 7-layer scoring (Macro &middot; Trend &middot; Momentum &middot; Reversion &middot; Volume &middot; Candle &middot; ML) &nbsp;·&nbsp; <a href="https://areit.netlify.app" style="color:#0a1628;">Dashboard</a></p>
</td></tr>`}

${breakouts.length?`
<!-- BREAKOUTS -->
<tr><td style="${S.sec}">
  <p style="${S.label}">Breakout Signals &mdash; Enter at 10:45am after ORB confirmation</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    ${breakoutRows}
  </table>
</td></tr>`:''}

<!-- REIT UNIVERSE -->
<tr><td style="${S.sec}">
  <p style="${S.label}">REIT Universe &mdash; Moelis Coverage (${reitResults.length})</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <th style="${S.th}">Ticker</th>
      <th style="${S.th}">Name</th>
      <th style="${S.th_r}">Price</th>
      <th style="${S.th_r}">Yield</th>
      <th style="${S.th_r}">NTA</th>
      <th style="${S.th_r}">Disc/Prem</th>
    </tr>
    ${reitTrigRows}
    ${reitAllRows}
  </table>
  <p style="font-size:10px;color:#aaa;margin:8px 0 0;">NTA and DPS from Moelis Australia broker research &nbsp;·&nbsp; Yield = DPS FY26 / last price</p>
</td></tr>

${headlines?.length?`
<!-- NEWS -->
<tr><td style="${S.sec_sm}">
  <p style="${S.label}">Market News</p>
  ${headlines.map(h=>`<p style="font-size:12px;color:#333;margin:0 0 6px;line-height:1.6;">${h}</p>`).join('')}
</td></tr>`:''}

${rateNews?.length?`
<tr><td style="${S.sec_sm}">
  <p style="${S.label}">RBA &amp; Rates</p>
  ${rateNews.map(h=>`<p style="font-size:12px;color:#333;margin:0 0 6px;line-height:1.6;">${h}</p>`).join('')}
</td></tr>`:''}

<!-- FOOTER -->
<tr><td style="${S.footer}">
  <p style="font-size:11px;color:#888;margin:0 0 4px;"><a href="https://areit.netlify.app" style="color:#0a1628;font-weight:700;">areit.netlify.app</a> &nbsp;&middot;&nbsp; Data: EODHD &middot; Yahoo Finance &middot; FRED &middot; Moelis Australia</p>
  <p style="${S.disc}">This is a personal automated research tool for paper trading purposes only. Not financial advice. Signals are generated algorithmically and should be reviewed before execution. Past performance is not indicative of future results.</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  return { subject, html };
}



const { schedule } = require('@netlify/functions');
const run = async () => {
  const db    = getSupabase();
  // Use AEST (UTC+10) date — Netlify runs in UTC
  const today = new Date(Date.now() + 10*60*60*1000).toISOString().split('T')[0];
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
      us10yrChange:  us10yrData?.price && us10yrData?.prev
        ? (us10yrData.price - us10yrData.prev) / 100  // TNX in %, convert to decimal yield move
        : 0,
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
    const [headlines, reitHeadlines, rateNews] = await Promise.all([
      fetchHeadlines(), fetchREITHeadlines(), fetchRateNews()
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

    // 6. Score full universe — no pre-screen
    // fetch-indicators already calculated all indicators for all 510 stocks.
    // No need to pre-screen — just read daily_analysis and score everything.
    console.log(`Scoring full universe from daily_analysis`);

    // 7. Get bulk live prices for ALL stocks (equities + REITs)
    const allTickers = [...(equityStocks||[]), ...(reitStocks||[])]
      .map(s => s.ticker).filter(t => t !== 'GSBG37');
    const livePrices = await getBulkPrices(allTickers);
    console.log(`Live prices fetched: ${Object.keys(livePrices).length}`);

    // 8b. Read pre-calculated indicators from daily_analysis (populated by fetch-indicators at 6:50am)
    const { data: todayIndicators } = await db.from('daily_analysis')
      .select('*').eq('analysis_date', today).not('rsi14', 'is', null);

    const analysisMap = {};
    (todayIndicators||[]).forEach(a => { analysisMap[a.ticker] = a; });
    console.log(`Loaded ${Object.keys(analysisMap).length} pre-calculated indicators`);

    // Build stock metadata map
    const stockMeta = {};
    [...(equityStocks||[]), ...(reitStocks||[])].forEach(s => { stockMeta[s.ticker] = s; });

    // Score all stocks in memory — no per-stock DB/API calls
    const equityResults = [];
    const reitResults   = [];

    for (const ticker of Object.keys(analysisMap)) {
      const a     = analysisMap[ticker];
      const stock = stockMeta[ticker];
      if (!stock) continue;

      const lp    = livePrices[ticker];
      const price = lp?.close || parseFloat(a.close) || 0;
      if (!price) continue;

      // Volume ratio — use pre-calculated value from fetch-indicators (full history)
      // priceHistoryMap only has data for pre-screened candidates, not all 510 stocks
      const volRatio = parseFloat(a.vol_ratio) || 0;

      // Current yield for REITs
      const currentYield = stock.dps_fy26 && price ? stock.dps_fy26 / price : null;

      // Candle detection from pre-calculated flags
      const candles = {
        bullish:  a.candle_hammer || a.candle_engulfing_bull || a.candle_morning_star || false,
        hammer:   a.candle_hammer || false,
        pattern:  a.candle_pattern || 'None',
        bullishEngulfing: a.candle_engulfing_bull || false,
      };

      // Score using pre-calculated indicators from daily_analysis
      const scoring = scoreStock(
        {
          price,
          rsi14:       a.rsi14,
          ma20:        a.ma20,
          ma50:        a.ma50,
          ma200:       a.ma200,
          bb_lower:    a.bb_lower,
          bb_upper:    a.bb_upper,
          bb_position: a.bb_position,
          macd:        a.macd,
          macd_signal: a.macd_signal,
          roc20:       a.roc20,
          adx:         a.adx,
          atr:         a.atr,
          open:        price, high: price, low: price,
        },
        macro.score, stock, currentYield, volRatio, candles
      );

      // ATR-based dynamic stop
      const stopPct   = parseFloat(settings.stop_loss_pct || '2.0') / 100;
      const targetPct = parseFloat(settings.target_pct    || '5.0') / 100;
      const atrStop   = a.atr && price ? parseFloat((a.atr * 1.5 / price).toFixed(6)) : null;
      const dynStop   = atrStop && atrStop > 0.005 && atrStop < 0.08 ? atrStop : stopPct;

      const posSize  = scoring.total >= 5 ? getPositionSize(scoring.conviction, settings, stock.is_reit) : 0;
      const units    = posSize && price ? Math.floor(posSize / price) : 0;

      const result = {
        ticker,
        name:              stock.name,
        price,
        total_score:       scoring.total,
        signal:            scoring.signal,
        conviction:        scoring.conviction,
        signal_reasons:    scoring.reasons,
        layer1_macro:      scoring.l1,
        layer2_trend:      scoring.l2,
        layer3_momentum:   scoring.l3,
        layer4_reversion:  scoring.l4,
        layer5_volume:     scoring.l5,
        layer6_candle:     scoring.l6,
        layer7_ml:         scoring.l7,
        rsi14:             a.rsi14,
        vol_ratio:         parseFloat(volRatio.toFixed(2)),
        bb_position:       a.bb_position,
        pct_from_ma20:     a.pct_from_ma20,
        pct_from_ma200:    a.pct_from_ma200,
        above_ma20:        a.above_ma20,
        above_ma200:       a.above_ma200,
        golden_cross:      a.golden_cross,
        candle_pattern:    a.candle_pattern,
        candle_hammer:     a.candle_hammer,
        candle_engulfing_bull: a.candle_engulfing_bull,
        candle_doji:       a.candle_doji,
        dps_yield:         currentYield,
        yield_trigger_fired: stock.is_reit && currentYield >= (stock.yield_trigger || 0.08),
        stop_price:        price ? parseFloat((price * (1 - dynStop)).toFixed(3)) : null,
        target_price:      price ? parseFloat((price * (1 + targetPct)).toFixed(3)) : null,
        position_size:     posSize,
        units,
        ma20:  a.ma20, ma50: a.ma50, ma200: a.ma200,
        nta:   stock.nta,   gearing:   stock.gearing,
        wale:  stock.wale,  occupancy: stock.occupancy,
        cap_rate: stock.cap_rate,
      };

      if (stock.is_reit || stock.is_manager) {
        reitResults.push(result);
      } else if (scoring.total >= 5) {
        equityResults.push(result);
      }
    }

    const topEquities  = equityResults.sort((a,b) => b.total_score - a.total_score).slice(0,6);
    const reitTriggers = reitResults.filter(r => r.yield_trigger_fired).map(r => r.ticker);
    console.log(`Analysis complete — equities:${equityResults.length} scored, top:${topEquities.length} reits:${reitResults.length} triggers:${reitTriggers.length}`);

    // 8c. Breakout scanner
    const breakoutResults = await scanBreakouts(db, equityStocks||[], livePrices, macro.score);
    const topBreakouts = breakoutResults.slice(0, 6);
    console.log(`Breakouts found: ${breakoutResults.length}, top: ${topBreakouts.length}`);

    // 9. Save scoring results back to daily_analysis
    // IMPORTANT: only write scoring/signal columns — never overwrite the indicator columns
    // (rsi14, ma200, above_ma200, bb_position etc) that fetch-indicators already populated.
    // Writing nulls for those columns via upsert would destroy the indicator data.
    const scoringUpdates = [...equityResults, ...reitResults].map(r => ({
      ticker: r.ticker, analysis_date: today,
      // Scoring output only — no indicator columns
      layer1_macro: r.layer1_macro, layer2_trend: r.layer2_trend,
      layer3_momentum: r.layer3_momentum, layer4_reversion: r.layer4_reversion,
      layer5_volume: r.layer5_volume, layer6_candle: r.layer6_candle,
      total_score: r.total_score, signal: r.signal,
      conviction: r.conviction, signal_reasons: r.signal_reasons,
      dps_yield: r.dps_yield, yield_trigger_fired: r.yield_trigger_fired,
    }));

    // Breakout signals — these are new rows so safe to write all columns
    const breakoutAnalysis = (topBreakouts||[]).map(b => ({
      ticker: b.ticker, analysis_date: today, close: b.price,
      vol_ratio: b.vol_ratio,
      breakout_score: b.breakout_score,  // separate from 7-layer total_score
      total_score: null,                 // never overwrite 7-layer score with breakout score
      signal: 'BREAKOUT',
      conviction: b.breakout_score >= 6 ? 'EXCEPTIONAL' : 'STRONG',
      signal_reasons: b.signals,
    }));

    // Write scoring updates in chunks — these upsert only scoring columns onto existing indicator rows
    const SCORE_CHUNK = 50;
    for (let i = 0; i < scoringUpdates.length; i += SCORE_CHUNK) {
      await db.from('daily_analysis')
        .upsert(scoringUpdates.slice(i, i + SCORE_CHUNK), { onConflict: 'ticker,analysis_date' });
    }
    if (breakoutAnalysis.length > 0) {
      await db.from('daily_analysis')
        .upsert(breakoutAnalysis, { onConflict: 'ticker,analysis_date' });
    }
    console.log(`Scoring saved: ${scoringUpdates.length} stocks, ${breakoutAnalysis.length} breakouts`);

    // 10. Save model trades — no duplicates
    // Auto-expire trades older than hold_days (default 3)
    // Exit at YESTERDAY'S close (Day 3 close), not today's live price
    const holdDays = parseInt(settings.hold_days || '3');
    const expiryDate = new Date(Date.now() - holdDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: expiredTrades } = await db.from('model_trades')
      .select('id,ticker,entry_price,units')
      .eq('status', 'OPEN')
      .lt('trade_date', expiryDate);

    if (expiredTrades?.length) {
      // Fetch yesterday's close for expired tickers
      const expiredTickers = expiredTrades.map(t => t.ticker);
      const { data: yesterdayPrices } = await db.from('prices')
        .select('ticker,close,market_date')
        .in('ticker', expiredTickers)
        .order('market_date', { ascending: false })
        .limit(expiredTickers.length * 2);

      // Get most recent close per ticker (yesterday's close)
      const prevCloseMap = {};
      (yesterdayPrices||[]).forEach(p => {
        if (!prevCloseMap[p.ticker]) prevCloseMap[p.ticker] = parseFloat(p.close);
      });

      for (const t of expiredTrades) {
        const exitPrice = prevCloseMap[t.ticker] || livePrices[t.ticker]?.close || t.entry_price;
        const pnl = (exitPrice - t.entry_price) * (t.units || 0) - 6; // deduct $6 brokerage
        await db.from('model_trades').update({
          status: 'CLOSED', exit_price: exitPrice, exit_date: today,
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_pct: parseFloat(((exitPrice - t.entry_price) / t.entry_price).toFixed(6)),
          hold_days: holdDays
        }).eq('id', t.id);
      }
      console.log(`Auto-expired ${expiredTrades.length} trades at Day ${holdDays} close`);
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
      headlines, reitHeadlines, rateNews, sectorSignals,
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
