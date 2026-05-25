// netlify/functions/morning-scan.js
// Scheduled: 7:00am AEST (9:00pm UTC) Mon-Fri
// Full morning briefing — mobile optimised email
// Includes: US overnight, bonds, commodities, Asian markets,
//           sector correlations, Reuters headlines, REIT rate analysis

const {
  getSupabase, fetchYahoo, fetchFRED, sendEmail, loadSettings,
  BOND_YIELD, VIX_TRIGGER, YIELD_TARGET
} = require('./_shared.js');
const { analyseStock }    = require('./strategy-engine.js');
const { getBulkPrices, screenStocks } = require('./eodhd-client.js');

// ── FETCH REUTERS HEADLINES ───────────────────────────────────────────────────
async function fetchHeadlines() {
  try {
    const feeds = [
      'https://feeds.reuters.com/reuters/businessNews',
      'https://feeds.reuters.com/reuters/companyNews'
    ];
    const headlines = [];
    for (const url of feeds) {
      try {
        const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const items = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)];
        items.slice(1, 6).forEach(m => {
          if (m[1] && !m[1].includes('Reuters')) headlines.push(m[1].trim());
        });
      } catch(e) {}
    }
    // Deduplicate
    return [...new Set(headlines)].slice(0, 8);
  } catch(e) {
    console.error('Headlines error:', e.message);
    return [];
  }
}

// ── FETCH REIT HEADLINES ──────────────────────────────────────────────────────
async function fetchREITHeadlines() {
  try {
    const res  = await fetch('https://feeds.reuters.com/reuters/businessNews', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await res.text();
    const all  = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)];
    const reitKeywords = ['reit', 'property', 'real estate', 'interest rate', 'fed rate',
      'rba', 'rate cut', 'rate hike', 'bond yield', 'inflation', 'housing', 'commercial property'];
    return all
      .map(m => m[1]?.trim())
      .filter(t => t && reitKeywords.some(k => t.toLowerCase().includes(k)))
      .slice(0, 5);
  } catch(e) {
    return [];
  }
}

// ── MACRO SCORING ─────────────────────────────────────────────────────────────
function scoreMacro({ sp500Change, nasdaqChange, vix, yieldCurve, audChange }) {
  let score = 0;
  const reasons = [];
  if      (sp500Change >  0.015) { score += 3; reasons.push(`S&P strong +${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change >  0.005) { score += 2; reasons.push(`S&P positive +${(sp500Change*100).toFixed(1)}%`); }
  else if (sp500Change >  0)     { score += 1; reasons.push('S&P slightly positive'); }
  else if (sp500Change > -0.005) { score -= 1; reasons.push('S&P slightly negative'); }
  else if (sp500Change > -0.015) { score -= 2; reasons.push(`S&P negative ${(sp500Change*100).toFixed(1)}%`); }
  else                           { score -= 3; reasons.push(`S&P weak ${(sp500Change*100).toFixed(1)}%`); }
  if      (nasdaqChange >  0.01) { score += 2; reasons.push('Nasdaq strong'); }
  else if (nasdaqChange >  0)    { score += 1; reasons.push('Nasdaq positive'); }
  else if (nasdaqChange < -0.01) { score -= 2; reasons.push('Nasdaq weak'); }
  else                           { score -= 1; reasons.push('Nasdaq negative'); }
  if      (vix < 15) { score += 2; }
  else if (vix < 20) { score += 1; }
  else if (vix >= 35){ score -= 2; reasons.push('VIX extreme panic'); }
  else if (vix >= 25){ score -= 1; reasons.push('VIX elevated'); }
  if (yieldCurve >  0.005) { score += 1; reasons.push('Curve steepening'); }
  if (yieldCurve < -0.002) { score -= 1; reasons.push('Curve inverted'); }
  if (audChange >  0.003)  { score += 1; reasons.push('AUD rising'); }
  if (audChange < -0.003)  { score -= 1; reasons.push('AUD falling'); }
  const signal = score >= 3 ? 'RISK_ON' : score <= -3 ? 'RISK_OFF' : 'NEUTRAL';
  return { score, signal, reasons };
}

// ── SECTOR CORRELATIONS ───────────────────────────────────────────────────────
function getSectorSignals({ sp500Change, nasdaqChange, ironOreChange, goldChange,
  oilChange, audChange, us10yrChange, vix }) {

  const signals = [];

  // Resources — driven by iron ore, copper, AUD
  const resourceScore = (ironOreChange||0)*2 + (audChange||0)*0.5;
  signals.push({
    sector: 'Resources', icon: '⛏',
    driver: `Iron ore ${ironOreChange>=0?'+':''}${((ironOreChange||0)*100).toFixed(1)}%`,
    signal: resourceScore > 0.01 ? '🟢' : resourceScore < -0.01 ? '🔴' : '🟡',
    note: resourceScore > 0.01 ? 'BHP, RIO, FMG positive open' : resourceScore < -0.01 ? 'Resources headwind' : 'Neutral'
  });

  // Gold — driven by gold price, USD weakness
  const goldScore = (goldChange||0);
  signals.push({
    sector: 'Gold', icon: '🥇',
    driver: `Gold ${goldChange>=0?'+':''}${((goldChange||0)*100).toFixed(1)}%`,
    signal: goldScore > 0.005 ? '🟢' : goldScore < -0.005 ? '🔴' : '🟡',
    note: goldScore > 0.005 ? 'NST, EVN, NCM positive' : goldScore < -0.005 ? 'Gold stocks headwind' : 'Neutral'
  });

  // Banks — driven by US banks, yield curve
  const bankScore = (sp500Change||0) + (us10yrChange||0)*2;
  signals.push({
    sector: 'Banks', icon: '🏦',
    driver: `S&P ${sp500Change>=0?'+':''}${((sp500Change||0)*100).toFixed(1)}% · Curve ${us10yrChange>=0?'steepening':'flattening'}`,
    signal: bankScore > 0.01 ? '🟢' : bankScore < -0.01 ? '🔴' : '🟡',
    note: bankScore > 0.01 ? 'CBA, ANZ, WBC positive' : bankScore < -0.01 ? 'Banks headwind' : 'Neutral'
  });

  // Tech — driven by Nasdaq
  signals.push({
    sector: 'Technology', icon: '💻',
    driver: `Nasdaq ${nasdaqChange>=0?'+':''}${((nasdaqChange||0)*100).toFixed(1)}%`,
    signal: (nasdaqChange||0) > 0.01 ? '🟢' : (nasdaqChange||0) < -0.01 ? '🔴' : '🟡',
    note: (nasdaqChange||0) > 0.01 ? 'XRO, WTC positive' : (nasdaqChange||0) < -0.01 ? 'Tech headwind' : 'Neutral'
  });

  // REITs — driven by bond yields (inverse)
  const reitScore = -(us10yrChange||0) * 3;
  signals.push({
    sector: 'REITs', icon: '🏢',
    driver: `AUS 10yr ${us10yrChange>=0?'+':''}${((us10yrChange||0)*10000).toFixed(0)}bps`,
    signal: reitScore > 0.005 ? '🟢' : reitScore < -0.005 ? '🔴' : '🟡',
    note: reitScore > 0.005 ? 'Yield fell — REITs re-rate positive' : reitScore < -0.005 ? 'Yield rose — REIT headwind' : 'Yields flat — neutral'
  });

  // Energy — driven by oil
  signals.push({
    sector: 'Energy', icon: '⚡',
    driver: `Oil ${oilChange>=0?'+':''}${((oilChange||0)*100).toFixed(1)}%`,
    signal: (oilChange||0) > 0.01 ? '🟢' : (oilChange||0) < -0.01 ? '🔴' : '🟡',
    note: (oilChange||0) > 0.01 ? 'WDS, STO positive' : (oilChange||0) < -0.01 ? 'Energy headwind' : 'Neutral'
  });

  return signals;
}

// ── REIT RATE IMPACT ──────────────────────────────────────────────────────────
function getReitRateImpact(us10yrChange, aus10yrChange, db_reit_holdings) {
  // Rule of thumb: 10bps move in 10yr = ~1.5-2% REIT price move (inverse)
  const bpsMove    = (aus10yrChange || 0) * 10000;
  const pctImpact  = -bpsMove * 0.0015; // -1.5% per 10bps rise

  let rateSignal, rateNote;
  if (bpsMove < -10) {
    rateSignal = '🟢 POSITIVE';
    rateNote   = `AUS 10yr fell ${Math.abs(bpsMove).toFixed(0)}bps overnight — REIT valuations re-rate upward ~${(Math.abs(pctImpact)*100).toFixed(1)}%`;
  } else if (bpsMove > 10) {
    rateSignal = '🔴 NEGATIVE';
    rateNote   = `AUS 10yr rose ${bpsMove.toFixed(0)}bps overnight — REIT headwind ~${(Math.abs(pctImpact)*100).toFixed(1)}%`;
  } else {
    rateSignal = '🟡 NEUTRAL';
    rateNote   = `AUS 10yr moved ${bpsMove>0?'+':''}${bpsMove.toFixed(0)}bps — minimal REIT impact`;
  }

  return { bpsMove, pctImpact, rateSignal, rateNote };
}

// ── BUILD EMAIL (MOBILE OPTIMISED) ────────────────────────────────────────────
function buildEmail(data) {
  const {
    market, macro, equityTrades, reitResults,
    headlines, reitHeadlines, sectorSignals, rateImpact,
    nikkei, shanghai, futures
  } = data;

  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, aus10yrChange,
          yieldCurve, aud, audChange, realYield, ironOre, gold, oil, copper } = market;
  const { score, signal, reasons } = macro;

  const sigColor = signal==='RISK_ON'?'#2d5a2d':signal==='RISK_OFF'?'#8b2e2e':'#7a5500';
  const sigEmoji = signal==='RISK_ON'?'🟢':signal==='RISK_OFF'?'🔴':'⚪';
  const reitTriggers = reitResults.filter(r => r.yield_trigger_fired);
  const exceptional  = equityTrades.filter(t => t.total_score >= 6);

  const subject = [
    `${sigEmoji} ASX 7am — ${signal.replace('_',' ')} ${score>0?'+':''}${score}`,
    reitTriggers.length ? ` 🚨 ${reitTriggers.map(r=>r.ticker).join(',')}` : '',
    exceptional.length  ? ` 🔥${exceptional.length}×6/6` : ''
  ].join('');

  // Mobile-first CSS
  const css = `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background:#f0ede6; color:#1a1a1a; font-size:15px; }
    .wrap { max-width:600px; margin:0 auto; background:#f0ede6; }
    .header { background:#0e1117; padding:18px 20px; }
    .header h1 { color:#d4b06a; font-size:20px; font-weight:600; margin-bottom:2px; }
    .header p  { color:rgba(255,255,255,0.4); font-size:12px; font-family:monospace; }
    .section   { background:#fff; border-bottom:1px solid #e0dbd4; padding:16px 20px; }
    .section-title { font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:#888; margin-bottom:12px; font-family:monospace; }
    .signal-box { border-left:4px solid ${sigColor}; padding:12px 16px; background:#f9f7f4; margin-bottom:12px; border-radius:0 6px 6px 0; }
    .signal-title { font-size:22px; font-weight:700; color:${sigColor}; }
    .signal-sub   { font-size:13px; color:#666; margin-top:4px; line-height:1.5; }
    .metric-grid  { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
    .metric { background:#f5f2ec; border-radius:6px; padding:10px 12px; }
    .metric .ml { font-size:10px; color:#888; margin-bottom:3px; font-family:monospace; text-transform:uppercase; }
    .metric .mv { font-size:18px; font-weight:600; }
    .pos { color:#2d5a2d; } .neg { color:#8b2e2e; } .neu { color:#7a5500; } .teal { color:#1a5f6e; }
    .sector-row { display:flex; align-items:center; padding:10px 0; border-bottom:1px solid #f0ede6; }
    .sector-row:last-child { border:none; }
    .sector-icon { font-size:20px; margin-right:12px; width:28px; text-align:center; }
    .sector-name { font-weight:600; font-size:14px; flex:1; }
    .sector-driver { font-size:12px; color:#888; margin-top:1px; }
    .sector-signal { font-size:20px; margin-left:8px; }
    .headline { padding:8px 0; border-bottom:1px solid #f0ede6; font-size:14px; line-height:1.4; }
    .headline:last-child { border:none; }
    .headline::before { content:'→ '; color:#888; }
    .trade-card { border:1px solid #e8e4dc; border-radius:6px; padding:12px; margin-bottom:8px; }
    .trade-ticker { font-family:monospace; font-weight:700; font-size:16px; color:#1a5f6e; }
    .trade-name   { font-size:12px; color:#888; margin-bottom:8px; }
    .trade-row    { display:flex; justify-content:space-between; font-size:13px; margin-top:4px; }
    .trade-label  { color:#888; }
    .trade-val    { font-family:monospace; font-weight:500; }
    .conv-badge   { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; font-family:monospace; }
    .conv-exc { background:#1a5f6e; color:#fff; }
    .conv-str { background:#eef6ee; color:#2d5a2d; }
    .conv-mod { background:#fdf8ee; color:#7a5500; }
    .reit-card { border:1px solid #e8e4dc; border-radius:6px; padding:10px 12px; margin-bottom:6px; display:flex; align-items:center; gap:10px; }
    .reit-card.fired { border-color:#2d5a2d; background:#f0f8f0; }
    .reit-card.close { border-color:#b8943f; background:#fffbf0; }
    .reit-tkr { font-family:monospace; font-weight:700; font-size:15px; color:#1a5f6e; min-width:45px; }
    .reit-name { font-size:12px; color:#888; flex:1; }
    .reit-yield { font-family:monospace; font-weight:700; font-size:15px; }
    .reit-disc { font-size:11px; font-family:monospace; }
    .reit-status { font-size:13px; font-weight:600; min-width:70px; text-align:right; }
    .rate-box { padding:12px 16px; border-radius:6px; margin-bottom:12px; }
    .rate-pos { background:#eef6ee; border-left:4px solid #2d5a2d; }
    .rate-neg { background:#fdf0f0; border-left:4px solid #8b2e2e; }
    .rate-neu { background:#f5f2ec; border-left:4px solid #888; }
    .asian-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
    .footer { padding:14px 20px; font-size:11px; color:#999; background:#f0ede6; text-align:center; line-height:1.8; }
    @media(max-width:480px) {
      .metric-grid { grid-template-columns:repeat(2,1fr); }
      .asian-grid  { grid-template-columns:repeat(2,1fr); }
      .header h1   { font-size:18px; }
      .signal-title{ font-size:19px; }
    }
  `;

  const fmt = {
    pct:  (v) => v==null?'--':(v>0?'+':'')+(v*100).toFixed(2)+'%',
    pct1: (v) => v==null?'--':(v*100).toFixed(1)+'%',
    bps:  (v) => v==null?'--':(v>0?'+':'')+Math.round(v*10000)+'bps',
    $3:   (v) => v==null?'--':'$'+parseFloat(v).toFixed(3),
    raw2: (v) => v==null?'--':parseFloat(v).toFixed(2),
    raw4: (v) => v==null?'--':parseFloat(v).toFixed(4),
    clr:  (v) => v>0?'pos':v<0?'neg':'neu'
  };

  // Metric box helper
  const m = (label, value, cls) =>
    `<div class="metric"><div class="ml">${label}</div><div class="mv ${cls||''}">${value}</div></div>`;

  // Trade cards
  const tradeCards = equityTrades.length === 0
    ? `<div style="color:#888;font-size:14px;padding:8px 0">No trades today — signal too weak or no stocks passing 4+ layers.</div>`
    : equityTrades.map(t => `
      <div class="trade-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px">
          <div>
            <span class="trade-ticker">${t.ticker}</span>
            <span class="conv-badge conv-${t.conviction==='EXCEPTIONAL'?'exc':t.conviction==='STRONG'?'str':'mod'}" style="margin-left:8px">${t.conviction} ${t.total_score}/6</span>
          </div>
          <div style="font-family:monospace;font-weight:600;font-size:16px">${fmt.$3(t.price)}</div>
        </div>
        <div class="trade-name">${t.name}</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px">${(t.signal_reasons||[]).slice(0,3).join(' · ')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:13px">
          <div style="background:#fdf0f0;border-radius:4px;padding:6px;text-align:center">
            <div style="font-size:10px;color:#888;margin-bottom:2px">STOP</div>
            <div style="font-family:monospace;font-weight:600;color:#8b2e2e">${fmt.$3(t.stop_price)}</div>
          </div>
          <div style="background:#f0f8f0;border-radius:4px;padding:6px;text-align:center">
            <div style="font-size:10px;color:#888;margin-bottom:2px">TARGET</div>
            <div style="font-family:monospace;font-weight:600;color:#2d5a2d">${fmt.$3(t.target_price)}</div>
          </div>
          <div style="background:#f5f2ec;border-radius:4px;padding:6px;text-align:center">
            <div style="font-size:10px;color:#888;margin-bottom:2px">SIZE</div>
            <div style="font-family:monospace;font-weight:600">$${(t.position_size||0).toLocaleString()}</div>
          </div>
        </div>
      </div>`).join('');

  // REIT cards
  const reitCards = reitResults
    .sort((a,b) => (b.dps_yield||0) - (a.dps_yield||0))
    .map(r => {
      const disc = r.nta && r.price ? (r.price - r.nta) / r.nta : null;
      const cls  = r.yield_trigger_fired ? 'fired' : r.dps_yield >= 0.075 ? 'close' : '';
      return `
      <div class="reit-card ${cls}">
        <span class="reit-tkr">${r.ticker}</span>
        <span class="reit-name">${r.name}</span>
        <div style="text-align:right">
          <div class="reit-yield ${r.dps_yield>=0.08?'pos':r.dps_yield>=0.07?'teal':'neu'}">${r.dps_yield?fmt.pct1(r.dps_yield):'--'}</div>
          <div class="reit-disc" style="color:${disc===null?'#888':disc<-0.1?'#2d5a2d':disc<0?'#1a5f6e':'#8b2e2e'}">${disc!==null?(disc*100).toFixed(1)+'% disc':'--'}</div>
        </div>
        <div class="reit-status" style="color:${r.yield_trigger_fired?'#2d5a2d':r.dps_yield>=0.075?'#b8943f':'#888'}">
          ${r.yield_trigger_fired?'🟢 BUY':r.dps_yield>=0.075?'⚠️ Close':'Watching'}
        </div>
      </div>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no">
<style>${css}</style></head>
<body><div class="wrap">

  <div class="header">
    <h1>ASX Morning Briefing</h1>
    <p>${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · 7:00am AEST · Data: EODHD + Reuters</p>
  </div>

  <!-- SIGNAL -->
  <div class="section">
    <div class="signal-box">
      <div class="signal-title">${sigEmoji} ${signal.replace('_',' ')} &nbsp;<span style="font-size:15px;font-weight:400;color:#888">Score ${score>0?'+':''}${score}</span></div>
      <div class="signal-sub">${reasons.join(' · ')}</div>
    </div>
    ${vix > VIX_TRIGGER ? `<div style="background:#fdf8ee;border-left:4px solid #b8943f;padding:10px 14px;border-radius:0 6px 6px 0;font-size:14px;color:#7a5500;font-weight:600;margin-bottom:12px">⚡ VIX ${vix.toFixed(1)} elevated — high conviction trades only</div>` : ''}
    ${reitTriggers.length ? `<div style="background:#eef6ee;border-left:4px solid #2d5a2d;padding:10px 14px;border-radius:0 6px 6px 0;font-size:14px;color:#2d5a2d;font-weight:600">🟢 REIT TRIGGER — ${reitTriggers.map(r=>r.ticker).join(', ')} at 8%+ yield. Log into CommSec and buy.</div>` : ''}
  </div>

  <!-- US OVERNIGHT -->
  <div class="section">
    <div class="section-title">US Overnight</div>
    <div class="metric-grid">
      ${m('S&P 500',   fmt.pct(sp500Change),   fmt.clr(sp500Change))}
      ${m('Nasdaq',    fmt.pct(nasdaqChange),   fmt.clr(nasdaqChange))}
      ${m('VIX',       vix.toFixed(1),          vix<20?'pos':vix<25?'neu':'neg')}
      ${m('AUD/USD',   fmt.raw4(aud),           '')}
      ${m('AUD chg',   fmt.pct(audChange),      fmt.clr(audChange))}
      ${m('Dow',       market.dowChange!=null?fmt.pct(market.dowChange):'--', fmt.clr(market.dowChange||0))}
    </div>
  </div>

  <!-- ASIAN MARKETS -->
  <div class="section">
    <div class="section-title">Asian Markets</div>
    <div class="asian-grid">
      ${m('Nikkei',   nikkei?fmt.pct(nikkei.change):'--',  nikkei?fmt.clr(nikkei.change):'neu')}
      ${m('Shanghai', shanghai?fmt.pct(shanghai.change):'--', shanghai?fmt.clr(shanghai.change):'neu')}
      ${m('ASX Fut',  futures?fmt.pct(futures.change):'--',  futures?fmt.clr(futures.change):'neu')}
    </div>
    <p style="font-size:12px;color:#888;margin-top:8px">Asian markets open before ASX and confirm or contradict US direction.</p>
  </div>

  <!-- BOND MARKET -->
  <div class="section">
    <div class="section-title">Bond Market</div>
    <div class="metric-grid">
      ${m('US 10yr',    fmt.pct1(us10yr),     'teal')}
      ${m('AUS 10yr',   fmt.pct1(aus10yr),    'teal')}
      ${m('Yield Curve',fmt.bps(yieldCurve),  fmt.clr(yieldCurve))}
      ${m('Real Yield', realYield?fmt.pct1(realYield):'--', '')}
      ${m('US 10yr chg',market.us10yrChange?fmt.bps(market.us10yrChange):'--', fmt.clr(-(market.us10yrChange||0)))}
      ${m('AUS 10yr chg',aus10yrChange?fmt.bps(aus10yrChange):'--', fmt.clr(-(aus10yrChange||0)))}
    </div>
    <p style="font-size:12px;color:#888;margin-top:8px">${yieldCurve>0.005?'📈 Curve steepening — growth signal, bullish banks & resources.':yieldCurve<-0.002?'⚠️ Curve inverted — recession risk elevated.':'→ Curve flat — neutral.'}</p>
  </div>

  <!-- COMMODITIES -->
  <div class="section">
    <div class="section-title">Commodities</div>
    <div class="metric-grid">
      ${m('Iron Ore',  ironOre?fmt.pct(ironOre.change):'--',  ironOre?fmt.clr(ironOre.change):'neu')}
      ${m('Gold',      gold?fmt.pct(gold.change):'--',        gold?fmt.clr(gold.change):'neu')}
      ${m('Oil (WTI)', oil?fmt.pct(oil.change):'--',          oil?fmt.clr(oil.change):'neu')}
      ${m('Copper',    copper?fmt.pct(copper.change):'--',    copper?fmt.clr(copper.change):'neu')}
      ${m('AUD/USD',   fmt.raw4(aud),   '')}
      ${m('USD Index', market.dxy?fmt.pct(market.dxy.change):'--', market.dxy?fmt.clr(-market.dxy.change):'neu')}
    </div>
  </div>

  <!-- SECTOR CORRELATIONS -->
  <div class="section">
    <div class="section-title">Sector Outlook — What to expect at open</div>
    ${sectorSignals.map(s => `
      <div class="sector-row">
        <span class="sector-icon">${s.icon}</span>
        <div style="flex:1">
          <div class="sector-name">${s.sector}</div>
          <div class="sector-driver">${s.driver} · ${s.note}</div>
        </div>
        <span class="sector-signal">${s.signal}</span>
      </div>`).join('')}
  </div>

  <!-- REIT RATE IMPACT -->
  <div class="section">
    <div class="section-title">REIT Rate Impact</div>
    <div class="rate-box ${rateImpact.bpsMove < -5 ? 'rate-pos' : rateImpact.bpsMove > 5 ? 'rate-neg' : 'rate-neu'}">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">${rateImpact.rateSignal}</div>
      <div style="font-size:14px;line-height:1.5">${rateImpact.rateNote}</div>
    </div>
    <p style="font-size:13px;color:#666;line-height:1.6">REITs are an interest rate proxy. Every 10bps fall in the AUS 10yr = ~1.5% REIT re-rate upward. Today: AUS 10yr ${aus10yrChange?fmt.bps(aus10yrChange):'unchanged'} → expected REIT move ${rateImpact.pctImpact>=0?'+':''}${(rateImpact.pctImpact*100).toFixed(1)}%</p>
  </div>

  <!-- REIT UNIVERSE -->
  <div class="section">
    <div class="section-title">REIT Universe — Moelis Pure Landlords</div>
    ${reitCards}
  </div>

  <!-- TODAY'S EQUITY TRADES -->
  <div class="section">
    <div class="section-title">ASX500 — Today's Trades · Place at 10:00am via CommSec</div>
    ${tradeCards}
    <p style="font-size:12px;color:#888;margin-top:10px">Never hold overnight · Record in dashboard after CommSec confirms</p>
  </div>

  <!-- GLOBAL HEADLINES -->
  <div class="section">
    <div class="section-title">Global Finance Headlines</div>
    ${headlines.length ? headlines.map(h => `<div class="headline">${h}</div>`).join('') : '<div style="color:#888;font-size:13px">No headlines available</div>'}
  </div>

  <!-- REIT & RATE NEWS -->
  <div class="section">
    <div class="section-title">REIT &amp; Interest Rate News</div>
    ${reitHeadlines.length ? reitHeadlines.map(h => `<div class="headline">${h}</div>`).join('') : '<div style="color:#888;font-size:13px">No REIT-specific headlines today</div>'}
  </div>

  <div class="footer">
    Not financial advice · Paper trading mode · EODHD + FRED + Reuters<br>
    Place real trades via CommSec · Record in dashboard
  </div>

</div></body></html>`;

  return { subject, html };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Morning scan (7am AEST) starting: ${today}`);

  try {
    const settings = await loadSettings(db);

    // 1. Fetch all market data in parallel
    const [
      sp500, nasdaq, dow, vixData, audData, us10yrData, us10yrPrev,
      nikkeiData, shanghaiData, futuresData,
      ironOreData, goldData, oilData, copperData, dxyData
    ] = await Promise.all([
      fetchYahoo('^GSPC',    '5d'),
      fetchYahoo('^IXIC',    '5d'),
      fetchYahoo('^DJI',     '5d'),
      fetchYahoo('^VIX',     '5d'),
      fetchYahoo('AUDUSD=X', '5d'),
      fetchYahoo('^TNX',     '5d'),
      fetchYahoo('^TNX',     '10d'),
      fetchYahoo('^N225',    '5d'),   // Nikkei
      fetchYahoo('000001.SS','5d'),   // Shanghai
      fetchYahoo('^AXJO',    '5d'),   // ASX200 futures proxy
      fetchYahoo('IRON.AX',  '5d').catch(() => fetchYahoo('BHP.AX', '5d')), // Iron ore proxy
      fetchYahoo('GC=F',     '5d'),   // Gold futures
      fetchYahoo('CL=F',     '5d'),   // WTI oil futures
      fetchYahoo('HG=F',     '5d'),   // Copper futures
      fetchYahoo('DX-Y.NYB', '5d'),   // USD index
    ]);

    // 2. FRED bond data
    const [realYield, breakeven, igSpread] = await Promise.all([
      fetchFRED('DFII10'), fetchFRED('T10YIE'), fetchFRED('BAMLC0A0CM')
    ]);

    // 3. Build market data
    const us10yr       = us10yrData?.price ? us10yrData.price / 100 : 0.0431;
    const aus10yr      = 0.0507;
    const aus10yrChange= null; // Would need AUS bond futures — use FRED if available
    const vix          = vixData?.price  || 18;
    const aud          = audData?.price  || 0.648;

    const market = {
      sp500Change:   sp500?.change  || 0,
      nasdaqChange:  nasdaq?.change || 0,
      dowChange:     dow?.change    || 0,
      vix, us10yr, aus10yr,
      us10yrChange:  us10yrData?.change || 0,
      aus10yrChange: 0,
      yieldCurve:    us10yr - 0.0474,
      aud, audChange: audData?.change || 0,
      realYield, breakeven, igSpread,
      ironOre:  ironOreData,
      gold:     goldData,
      oil:      oilData,
      copper:   copperData,
      dxy:      dxyData,
      ironOreChange: ironOreData?.change || 0,
      goldChange:    goldData?.change    || 0,
      oilChange:     oilData?.change     || 0
    };

    // 4. Score macro
    const macro = scoreMacro(market);
    console.log(`Macro: ${macro.signal} (${macro.score})`);

    // 5. Fetch headlines in parallel with stock analysis
    const [headlines, reitHeadlines] = await Promise.all([
      fetchHeadlines(),
      fetchREITHeadlines()
    ]);

    // 6. Sector signals
    const sectorSignals = getSectorSignals({
      sp500Change:   market.sp500Change,
      nasdaqChange:  market.nasdaqChange,
      ironOreChange: market.ironOreChange,
      goldChange:    market.goldChange,
      oilChange:     market.oilChange,
      audChange:     market.audChange,
      us10yrChange:  market.us10yrChange,
      vix
    });

    // 7. REIT rate impact
    const rateImpact = getReitRateImpact(
      market.us10yrChange,
      market.aus10yrChange,
      []
    );

    // 8. Load and analyse stocks
    const { data: equityStocks } = await db.from('stocks')
      .select('*').eq('active', true).eq('universe', 'ASX500')
      .eq('is_manager', false).eq('is_developer', false);

    const { data: reitStocks } = await db.from('stocks')
      .select('*').eq('active', true).eq('is_reit', true)
      .eq('is_manager', false).eq('is_developer', false);

    // Rotating batch of 80 equities
    const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(),0,0)) / 86400000);
    const start     = (dayOfYear * 80) % (equityStocks||[]).length;
    const batch     = [...(equityStocks||[]).slice(start), ...(equityStocks||[]).slice(0,start)].slice(0,80);

    // Get bulk live prices
    const allTickers = [...batch, ...(reitStocks||[])].map(s=>s.ticker).filter(t=>t!=='GSBG37');
    const livePrices = await getBulkPrices(allTickers);

    // Run analysis
    const equityResults = [];
    for (const stock of batch) {
      const lp = livePrices[stock.ticker]?.close;
      const r  = await analyseStock(stock, macro.score, settings, lp);
      if (r && r.total_score >= 4) equityResults.push(r);
      await new Promise(res => setTimeout(res, 80));
    }

    const reitResults = [];
    for (const stock of (reitStocks||[]).filter(s=>s.ticker!=='GSBG37')) {
      const lp = livePrices[stock.ticker]?.close;
      const r  = await analyseStock(stock, macro.score, settings, lp);
      if (r) reitResults.push(r);
      await new Promise(res => setTimeout(res, 80));
    }

    const topEquities  = equityResults.sort((a,b)=>b.total_score-a.total_score).slice(0,6);
    const reitTriggers = reitResults.filter(r=>r.yield_trigger_fired).map(r=>r.ticker);

    // 9. Save to Supabase
    const allAnalysis = [...equityResults, ...reitResults].map(r=>({
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

    if (allAnalysis.length > 0) {
      await db.from('daily_analysis').upsert(allAnalysis, { onConflict: 'ticker,analysis_date' });
    }

    if (topEquities.length > 0) {
      await db.from('model_trades').insert(topEquities.filter(t=>t.total_score>=4).map(t=>({
        ticker: t.ticker, company_name: t.name, universe: 'ASX500',
        trade_date: today, direction: 'LONG',
        entry_price: t.price, stop_price: t.stop_price, target_price: t.target_price,
        units: t.units, amount: t.position_size, status: 'OPEN',
        total_score: t.total_score, conviction: t.conviction, signal_reasons: t.signal_reasons,
        layer1_macro: t.layer1_macro, layer2_trend: t.layer2_trend,
        layer3_momentum: t.layer3_momentum, layer4_reversion: t.layer4_reversion,
        layer5_volume: t.layer5_volume, layer6_candle: t.layer6_candle,
        candle_pattern: t.candle_pattern
      })));
    }

    await db.from('morning_signals').upsert({
      signal_date: today, sp500_change: market.sp500Change,
      nasdaq_change: market.nasdaqChange, vix,
      us_10yr: us10yr, aus_10yr: aus10yr,
      yield_curve_us: market.yieldCurve, aud_usd: aud,
      aud_change: market.audChange, real_yield: realYield,
      credit_spread: igSpread, macro_score: macro.score,
      macro_signal: macro.signal, signal: macro.signal,
      summary: macro.reasons.join('; '),
      equities_long: topEquities.map(t=>t.ticker),
      reits_long: reitResults.filter(r=>r.total_score>=4).map(r=>r.ticker),
      reit_triggers: reitTriggers
    }, { onConflict: 'signal_date' });

    // 10. Build and send email
    const { subject, html } = buildEmail({
      market, macro, equityTrades: topEquities, reitResults,
      headlines, reitHeadlines, sectorSignals, rateImpact,
      nikkei: nikkeiData, shanghai: shanghaiData, futures: futuresData
    });

    await sendEmail(subject, html);
    console.log(`Morning scan complete. Equities:${topEquities.length} REITs:${reitResults.length} Triggers:${reitTriggers.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: today, macro: macro.signal, score: macro.score,
        equities: topEquities.length, reits: reitResults.length,
        triggers: reitTriggers.length
      })
    };

  } catch(err) {
    console.error('Morning scan failed:', err);
    try { await sendEmail('⚠️ ASX Platform — Morning scan error', `<p style="font-family:sans-serif">Error: ${err.message}</p>`); } catch(e){}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
