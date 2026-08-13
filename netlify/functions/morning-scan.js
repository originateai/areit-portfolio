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
const { getBulkPrices, fetchMacro }  = require('./eodhd-client.js');

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
  const { market, macro, reitMacro, equityTrades, reitResults, headlines, reitHeadlines, rateNews } = data;
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, aud, audChange, vnqChange } = market;
  const { score, signal, reasons } = macro;

  const rawBps    = Math.round((market.us10yrChange||0)*10000);
  const bpsMove   = Math.max(-20, Math.min(20, rawBps));
  const dateStr   = new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const reitTrig  = reitResults.filter(r=>r.yield_trigger_fired);
  const exc       = equityTrades.filter(t=>t.total_score>=6);

  const macroLabel = signal==='RISK_ON' ? 'RISK ON' : signal==='RISK_OFF' ? 'RISK OFF' : 'NEUTRAL';

  const exitDay = new Date(); exitDay.setDate(exitDay.getDate() + 3);
  const exitDayStr = exitDay.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'});

  const subject = `Morning Update — ${macroLabel} (${score>0?'+':''}${score})`
    + (reitTrig.length ? ` | REIT Triggers: ${reitTrig.map(r=>r.ticker).join(', ')}` : '')
    + (exc.length ? ` | ${exc.length} Exceptional` : '');

  // ── Brand palette (no 360 Capital marks; colours only) ──────────────────────
  const NAVY='#063D58', INK='#00273E', SKY='#00B0F0', TEAL='#4B97B2',
        UP='#1f8a4c', DN='#c0392b', TXT='#33414a', MUT='#8a96a0', RULE='#e3e9ec', ALT='#f4f8fa';

  const pct  = v => v==null?'--':(v>=0?'+':'')+((v)*100).toFixed(2)+'%';
  const $3   = v => v==null?'--':'$'+parseFloat(v).toFixed(3);
  const chgColor = v => v>0?UP:v<0?DN:MUT;
  const bpsColor = v => v<-3?UP:v>3?DN:MUT;

  // shared inline styles
  const S = {
    th:   `color:#ffffff;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:7px 10px;font-weight:600;text-align:left;`,
    th_r: `color:#ffffff;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:7px 10px;font-weight:600;text-align:right;`,
    td:   `font-size:12px;color:${TXT};padding:7px 10px;border-bottom:1px solid ${RULE};vertical-align:middle;`,
    td_r: `font-size:12px;color:${TXT};padding:7px 10px;border-bottom:1px solid ${RULE};text-align:right;vertical-align:middle;font-family:Courier New,monospace;`,
    label:`font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${NAVY};border-bottom:2px solid ${NAVY};padding-bottom:6px;`,
    sec:  `padding:18px 32px 6px;`,
    secT: `padding:6px 32px 10px;`,
  };
  const headRow = `<tr style="background:${NAVY};">
      <th style="${S.th}">Indicator</th><th style="${S.th_r}">Level</th><th style="${S.th_r}">Change</th><th style="${S.th}">Signal</th></tr>`;

  // ── MACRO ROWS ──────────────────────────────────────────────────────────────
  const macroData = [
    ['S&P 500', sp500Change!=null?pct(sp500Change):'--', pct(sp500Change), chgColor(sp500Change), sp500Change>0.005?'Positive':sp500Change<-0.005?'Negative':'Flat'],
    ['Nasdaq',  nasdaqChange!=null?pct(nasdaqChange):'--', pct(nasdaqChange), chgColor(nasdaqChange), nasdaqChange>0.005?'Positive':nasdaqChange<-0.005?'Negative':'Flat'],
    ['VIX',     vix?vix.toFixed(1):'--', '--', MUT, vix<15?'Low':vix<22?'Normal':vix<28?'Elevated':'High'],
    ['US 10yr', us10yr?(us10yr*100).toFixed(2)+'%':'--', bpsMove?(bpsMove>0?'+':'')+bpsMove+'bps':'--', bpsColor(bpsMove), bpsMove<-3?'Falling':bpsMove>3?'Rising':'Stable'],
    ['AUS 10yr',aus10yr?(aus10yr*100).toFixed(2)+'%':'--', '--', MUT, 'Proxy GSBG37'],
    ['AUD/USD', aud?aud.toFixed(4):'--', audChange!=null?pct(audChange):'--', chgColor(audChange), audChange>0.003?'Rising':audChange<-0.003?'Falling':'Stable'],
    ['VNQ',     '--', vnqChange!=null?pct(vnqChange):'--', chgColor(vnqChange), vnqChange>0.005?'Positive':vnqChange<-0.005?'Negative':'Flat'],
  ].map(([ind,val,chg,col,sig],i)=>`<tr${i%2?` style="background:${ALT};"`:''}>
      <td style="${S.td}">${ind}</td><td style="${S.td_r}">${val}</td>
      <td style="${S.td_r};color:${col};font-weight:700;">${chg}</td>
      <td style="${S.td};color:${MUT};font-size:11px;">${sig}</td></tr>`).join('');

  // ── REIT trigger rows ─────────────────────────────────────────────────────
  const reitRow = (r,alt) => {
    const yld = r.dps_yield ? (r.dps_yield*100).toFixed(1)+'%' : '--';
    const nta = r.nta ? $3(r.nta) : '--';
    const disc = r.nta && r.price ? ((r.price/r.nta-1)*100) : null;
    const discStr = disc==null?'--':(disc>=0?'+':'')+disc.toFixed(1)+'%';
    return `<tr${alt?` style="background:${ALT};"`:''}>
      <td style="${S.td};font-weight:700;font-family:Courier New,monospace;color:${NAVY};">${r.ticker}</td>
      <td style="${S.td};font-size:11px;">${r.name||''}</td>
      <td style="${S.td_r}">${$3(r.price)}</td>
      <td style="${S.td_r};color:${UP};font-weight:700;">${yld}</td>
      <td style="${S.td_r}">${nta}</td>
      <td style="${S.td_r};font-size:12px;color:${disc==null?MUT:disc>=0?UP:DN};">${discStr}</td></tr>`;
  };
  const reitTrigRows = reitTrig.map((r,i)=>reitRow(r,i%2)).join('');
  const reitAllRows  = reitResults.filter(r=>!r.yield_trigger_fired)
    .sort((a,b)=>(b.dps_yield||0)-(a.dps_yield||0)).map((r,i)=>reitRow(r,i%2)).join('');

  // ── Equity signal cards (nested tables — Outlook safe) ────────────────────
  const tradeRows = equityTrades.map(t=>`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #d7e0e5;border-left:3px solid ${SKY};margin-bottom:10px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-family:Arial,Helvetica,sans-serif;">
            <span style="font-size:16px;font-weight:700;color:${NAVY};font-family:Courier New,monospace;">${t.ticker}</span>
            <span style="font-size:11px;color:${MUT};margin-left:8px;">${t.name||''}</span>
            <div style="font-size:10px;color:${NAVY};font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:3px;">${t.conviction||''} &middot; ${t.total_score}/7</div>
          </td>
          <td align="right" style="font-family:Arial,Helvetica,sans-serif;"><span style="font-size:18px;font-weight:700;color:${TXT};font-family:Courier New,monospace;">${$3(t.price)}</span></td>
        </tr></table>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5a6b75;line-height:1.7;margin:8px 0 0;">${(t.signal_reasons||[]).slice(0,4).join(' &nbsp;&middot;&nbsp; ')}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-top:1px solid ${RULE};"><tr>
          <td align="center" style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;"><div style="font-size:9px;color:${MUT};text-transform:uppercase;letter-spacing:1px;">Entry</div><div style="font-size:14px;font-weight:700;font-family:Courier New,monospace;color:${TXT};margin-top:3px;">${$3(t.price)}</div><div style="font-size:9px;color:${MUT};margin-top:2px;">Open</div></td>
          <td align="center" style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;"><div style="font-size:9px;color:${MUT};text-transform:uppercase;letter-spacing:1px;">Stop</div><div style="font-size:14px;font-weight:700;font-family:Courier New,monospace;color:${DN};margin-top:3px;">${$3(t.stop_price)}</div><div style="font-size:9px;color:${MUT};margin-top:2px;">&minus;2%</div></td>
          <td align="center" style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;"><div style="font-size:9px;color:${MUT};text-transform:uppercase;letter-spacing:1px;">Target</div><div style="font-size:14px;font-weight:700;font-family:Courier New,monospace;color:${UP};margin-top:3px;">${$3(t.target_price)}</div><div style="font-size:9px;color:${MUT};margin-top:2px;">+5%</div></td>
          <td align="center" style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;"><div style="font-size:9px;color:${MUT};text-transform:uppercase;letter-spacing:1px;">Size</div><div style="font-size:14px;font-weight:700;font-family:Courier New,monospace;color:${NAVY};margin-top:3px;">$${(t.position_size||0).toLocaleString()}</div><div style="font-size:9px;color:${MUT};margin-top:2px;">${t.units||0} units</div></td>
        </tr></table>
        <div style="background:${ALT};border-left:3px solid ${NAVY};padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#444;line-height:1.9;margin-top:10px;">
          <strong>CommSec:</strong> BUY ${t.ticker} &middot; Market &middot; ${t.units||0} units &middot; 10:00am &nbsp;|&nbsp; Stop sell ${$3(t.stop_price)} GTC &nbsp;|&nbsp; Target ${$3(t.target_price)} &middot; Day-3 exit ${exitDayStr}
        </div>
      </td></tr>
    </table>`).join('');

  const macroBg = signal==='RISK_ON'?'#eef6f0':signal==='RISK_OFF'?'#fbeeee':ALT;
  const macroBar= signal==='RISK_ON'?UP:signal==='RISK_OFF'?DN:TEAL;

  // ── ASSEMBLE ────────────────────────────────────────────────────────────────
  const html = `<!doctype html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting">
<title>Morning Update</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>table{border-collapse:collapse;}td{mso-line-height-rule:exactly;}@media only screen and (max-width:620px){.container{width:100%!important;}.px{padding-left:18px!important;padding-right:18px!important;}}</style>
</head>
<body style="margin:0;padding:0;background:#e9eef1;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#e9eef1;">${macroLabel} &middot; ${reitTrig.length} REIT triggers &middot; ${equityTrades.length} equity signals</div>
<center style="width:100%;background:#e9eef1;">
<!--[if mso]><table role="presentation" width="660" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="container" align="center" cellpadding="0" cellspacing="0" border="0" width="660" style="width:660px;max-width:660px;margin:0 auto;background:#ffffff;">

  <tr><td style="background:${NAVY};padding:26px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.2px;">Morning Update</td>
      <td align="right" style="font-family:Arial,Helvetica,sans-serif;color:${TEAL};font-size:11px;letter-spacing:1px;text-transform:uppercase;">7:00am AEST</td>
    </tr></table>
    <div style="font-family:Arial,Helvetica,sans-serif;color:#9fc3d4;font-size:12px;margin-top:6px;">ASX Trading Platform &middot; ${dateStr}</div>
  </td></tr>
  <tr><td style="height:3px;background:${SKY};font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- MACRO -->
  <tr><td class="px" style="${S.sec}"><div style="${S.label}">Market Macro</div></td></tr>
  <tr><td class="px" style="padding:10px 32px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding:12px 16px;background:${macroBg};border-left:3px solid ${macroBar};font-family:Arial,Helvetica,sans-serif;">
        <span style="font-size:13px;font-weight:700;color:${macroBar};">${macroLabel} &nbsp; Score ${score>0?'+':''}${score}</span><br>
        <span style="font-size:11px;color:#5a6b75;line-height:1.8;">${reasons.slice(0,5).join(' &nbsp;&middot;&nbsp; ')}</span>
      </td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="${S.secT}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">${headRow}${macroData}</table>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:${MUT};margin:8px 0 0;">Sources: EODHD &middot; FRED</p>
  </td></tr>

  ${reitTrig.length?`<tr><td class="px" style="${S.sec}"><div style="${S.label}">REIT Yield Triggers &mdash; ${reitTrig.length} Fired</div></td></tr>
  <tr><td class="px" style="${S.secT}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">
      <tr style="background:${NAVY};"><th style="${S.th}">Ticker</th><th style="${S.th}">Name</th><th style="${S.th_r}">Price</th><th style="${S.th_r}">Yield</th><th style="${S.th_r}">NTA</th><th style="${S.th_r}">Disc</th></tr>
      ${reitTrigRows}</table>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:${MUT};margin:8px 0 0;">Trigger: DPS FY26 / price &ge; 8.0% &middot; NTA from Moelis research</p>
  </td></tr>`:''}

  ${equityTrades.length?`<tr><td class="px" style="${S.sec}"><div style="${S.label}">Equity Signals &mdash; ${equityTrades.length} Signal${equityTrades.length>1?'s':''}</div></td></tr>
  <tr><td class="px" style="padding:10px 32px 4px;">${tradeRows}</td></tr>`
  :`<tr><td class="px" style="${S.sec}"><div style="${S.label}">Equity Signals</div></td></tr>
  <tr><td class="px" style="padding:8px 32px 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${MUT};">No signals today &mdash; min score 5/7 required.</td></tr>`}

  <!-- REIT UNIVERSE -->
  <tr><td class="px" style="${S.sec}"><div style="${S.label}">REIT Universe &mdash; Moelis Coverage (${reitResults.length})</div></td></tr>
  <tr><td class="px" style="${S.secT}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">
      <tr style="background:${NAVY};"><th style="${S.th}">Ticker</th><th style="${S.th}">Name</th><th style="${S.th_r}">Price</th><th style="${S.th_r}">Yield</th><th style="${S.th_r}">NTA</th><th style="${S.th_r}">Disc</th></tr>
      ${reitTrigRows}${reitAllRows}</table>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:${MUT};margin:8px 0 0;">NTA &amp; DPS from Moelis research &middot; Yield = DPS FY26 / last price</p>
  </td></tr>

  ${headlines?.length?`<tr><td class="px" style="padding:14px 32px;border-top:1px solid ${RULE};"><div style="${S.label}">Market News</div>${headlines.map(h=>`<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${TXT};margin:8px 0 0;line-height:1.6;">${h}</p>`).join('')}</td></tr>`:''}
  ${rateNews?.length?`<tr><td class="px" style="padding:14px 32px;border-top:1px solid ${RULE};"><div style="${S.label}">RBA &amp; Rates</div>${rateNews.map(h=>`<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${TXT};margin:8px 0 0;line-height:1.6;">${h}</p>`).join('')}</td></tr>`:''}

  <tr><td style="height:18px;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="background:${INK};padding:20px 32px;">
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9fc3d4;margin:0 0 8px;"><a href="https://areit.netlify.app" style="color:${SKY};font-weight:700;text-decoration:none;">areit.netlify.app</a> &nbsp;&middot;&nbsp; Data: EODHD &middot; FRED &middot; Moelis Australia</p>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#6f93a4;line-height:1.6;margin:0;">This is a personal automated research tool for paper trading purposes only. Not financial advice. Signals are generated algorithmically and should be reviewed before execution. Past performance is not indicative of future results.</p>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</center>
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
           goldData, oilData, copperData, gsbgData, vnqData] = await Promise.all([
      fetchMacro('^GSPC'), fetchMacro('^IXIC'),
      fetchMacro('^DJI'),  fetchMacro('^VIX'),
      fetchMacro('AUDUSD=X'), fetchMacro('^TNX'),
      fetchMacro('^N225'),
      fetchMacro('000001.SS'),
      fetchMacro('^AXJO'),
      fetchMacro('GC=F'),   // Gold
      fetchMacro('CL=F'),   // WTI oil
      fetchMacro('HG=F'),   // Copper
      fetchMacro('GSBG37.AX'), // AUS govt bond — proxy for AUS 10yr
      fetchMacro('VNQ'),    // US REIT ETF — lead indicator for ASX REITs
    ]);
    // Iron ore has no clean ticker on this plan — reuse gold as the prior code did.
    const ironOreData = goldData;
    
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

    // Write scoring updates in chunks — these upsert only scoring columns onto existing indicator rows
    const SCORE_CHUNK = 50;
    for (let i = 0; i < scoringUpdates.length; i += SCORE_CHUNK) {
      await db.from('daily_analysis')
        .upsert(scoringUpdates.slice(i, i + SCORE_CHUNK), { onConflict: 'ticker,analysis_date' });
    }
    console.log(`Scoring saved: ${scoringUpdates.length} stocks`);

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

    // 12. Send email — send-once guard (atomic claim via unique constraint)
    const { subject, html } = buildEmail({
      market, macro, reitMacro, equityTrades: topEquities, reitResults,
      headlines, reitHeadlines, rateNews, sectorSignals,
      nikkei: nikkeiData, shanghai: shanghaiData, futures: futuresData
    });
    const sendDate = today; // YYYY-MM-DD for AEST trading day
    const { error: claimErr } = await db
      .from('email_log')
      .insert({ email_type: 'morning_scan', send_date: sendDate });

    if (claimErr && claimErr.code === '23505') {
      // TRUE duplicate: a prior invocation already claimed today. Skip silently.
      console.log(`Morning email already sent for ${sendDate} — skipping duplicate.`);
    } else {
      // Either we claimed cleanly (no error) OR the claim failed for a NON-duplicate
      // reason (e.g. table missing, transient DB error). In the latter case we send
      // anyway — a possible duplicate is far better than silently missing the email.
      if (claimErr) {
        console.error(`email_log claim failed (sending anyway): ${claimErr.message}`);
      }
      try {
        await sendEmail(subject, html);
        console.log('Morning scan complete — email sent');
      } catch (sendErr) {
        // Send failed AFTER we claimed the row — roll it back so a retry can re-send.
        if (!claimErr) {
          await db.from('email_log').delete()
            .eq('email_type', 'morning_scan').eq('send_date', sendDate);
        }
        throw sendErr;
      }
    }

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
