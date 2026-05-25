// netlify/functions/morning-scan.js
// Scheduled: 8:00am AEST (10:00pm UTC) Mon-Fri
// Uses EODHD for live prices and pre-screening
// Uses Yahoo Finance only for US market data (S&P, Nasdaq, VIX, AUD)

const {
  getSupabase, fetchYahoo, fetchFRED, sendEmail, loadSettings,
  BOND_YIELD, VIX_TRIGGER, emailStyles, pct, pctRaw, bps, dollar,
  colorClass, scoreDots
} = require('./_shared.js');

const { analyseStock }              = require('./strategy-engine.js');
const { getBulkPrices, screenStocks, getTechnicals } = require('./eodhd-client.js');

// ── MACRO SCORING ─────────────────────────────────────────────────────────────
function scoreMacro({ sp500Change, nasdaqChange, vix, yieldCurve, audChange }) {
  let score = 0;
  const reasons = [];

  if      (sp500Change >  0.015) { score += 3; reasons.push(`S&P strong ${pct(sp500Change)}`); }
  else if (sp500Change >  0.005) { score += 2; reasons.push(`S&P positive ${pct(sp500Change)}`); }
  else if (sp500Change >  0)     { score += 1; reasons.push('S&P slightly positive'); }
  else if (sp500Change > -0.005) { score -= 1; reasons.push('S&P slightly negative'); }
  else if (sp500Change > -0.015) { score -= 2; reasons.push(`S&P negative ${pct(sp500Change)}`); }
  else                           { score -= 3; reasons.push(`S&P weak ${pct(sp500Change)}`); }

  if      (nasdaqChange >  0.01) { score += 2; reasons.push('Nasdaq strong'); }
  else if (nasdaqChange >  0)    { score += 1; reasons.push('Nasdaq positive'); }
  else if (nasdaqChange < -0.01) { score -= 2; reasons.push('Nasdaq weak'); }
  else                           { score -= 1; reasons.push('Nasdaq negative'); }

  if      (vix < 15) { score += 2; }
  else if (vix < 20) { score += 1; reasons.push('VIX normal'); }
  else if (vix < 25) { }
  else if (vix < 35) { score -= 1; reasons.push('VIX elevated'); }
  else               { score -= 2; reasons.push('VIX extreme'); }

  if      (yieldCurve >  0.005) { score += 1; reasons.push('Curve steepening'); }
  else if (yieldCurve < -0.002) { score -= 1; reasons.push('Curve inverted'); }

  if      (audChange >  0.003) { score += 1; reasons.push('AUD rising'); }
  else if (audChange < -0.003) { score -= 1; reasons.push('AUD falling'); }

  const signal = score >= 3 ? 'RISK_ON' : score <= -3 ? 'RISK_OFF' : 'NEUTRAL';
  return { score, signal, reasons };
}

// ── PRE-SCREEN VIA EODHD ──────────────────────────────────────────────────────
// Use EODHD screener to find candidates before running full 6-layer analysis
async function preScreen(macroScore) {
  try {
    // Only screen for longs when macro is positive
    if (macroScore < -2) return [];

    // Use EODHD screener — filters server-side, no need to fetch all 500
    const candidates = await screenStocks({
      exchange:            'AU',
      volume_more_than:    300000,   // liquid stocks only
      market_cap_more_than: 100,     // >$100m market cap
    });

    console.log(`EODHD screener returned ${candidates.length} candidates`);
    return candidates.map(c => c.code?.replace('.AU','') || c.ticker).filter(Boolean);

  } catch(e) {
    console.error('Pre-screen failed:', e.message);
    // Fallback — get stocks from DB
    return [];
  }
}

// ── BUILD EMAIL ───────────────────────────────────────────────────────────────
function buildEmail(market, macro, equityTrades, reitResults) {
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, yieldCurve, aud, audChange, realYield } = market;
  const { score, signal, reasons } = macro;
  const sigColor  = signal==='RISK_ON'?'#2d5a2d':signal==='RISK_OFF'?'#8b2e2e':'#7a5500';
  const sigEmoji  = signal==='RISK_ON'?'🟢':signal==='RISK_OFF'?'🔴':'⚪';
  const vixAlert  = vix > VIX_TRIGGER;
  const reitTriggers = reitResults.filter(r => r.yield_trigger_fired).map(r => r.ticker);
  const exceptional  = equityTrades.filter(t => t.total_score >= 6);

  const tradeRow = (t) => `
    <tr style="background:${t.total_score>=6?'#f0f7f8':t.total_score>=5?'#f5fff5':'white'}">
      <td style="padding:10px 8px;font-family:monospace;font-weight:600;color:#1a5f6e;font-size:13px">${t.ticker}</td>
      <td style="padding:10px 8px;font-size:11px;max-width:180px">${t.name}<br>
        <span style="color:#6b6660;font-size:10px">${(t.signal_reasons||[]).slice(0,2).join(' · ')}</span>
      </td>
      <td style="padding:10px 8px;font-family:monospace;text-align:right">${dollar(t.price,3)}</td>
      <td style="padding:10px 8px">
        <span style="font-family:monospace;font-size:9px;padding:3px 7px;border-radius:3px;font-weight:600;
          background:${t.conviction==='EXCEPTIONAL'?'#1a5f6e':t.conviction==='STRONG'?'#eef6ee':'#fdf8ee'};
          color:${t.conviction==='EXCEPTIONAL'?'#fff':t.conviction==='STRONG'?'#2d5a2d':'#7a5500'}">
          ${t.conviction} ${t.total_score}/6
        </span>
      </td>
      <td style="padding:10px 8px;font-family:monospace;text-align:right;color:#8b2e2e">${dollar(t.stop_price,3)}</td>
      <td style="padding:10px 8px;font-family:monospace;text-align:right;color:#2d5a2d">${dollar(t.target_price,3)}</td>
      <td style="padding:10px 8px;font-family:monospace;text-align:right">
        $${(t.position_size||0).toLocaleString()}<br>
        <span style="color:#6b6660;font-size:10px">${t.units||0} units</span>
      </td>
    </tr>`;

  const reitRow = (r) => {
    const disc = r.nta && r.price ? (r.price - r.nta) / r.nta : null;
    return `
    <tr style="background:${r.yield_trigger_fired?'#f0f8f0':r.dps_yield>=0.075?'#fffbf0':'white'}">
      <td style="padding:8px;font-family:monospace;font-weight:600;color:#1a5f6e">${r.ticker}</td>
      <td style="padding:8px;font-size:11px">${r.name}</td>
      <td style="padding:8px;font-family:monospace;text-align:right">${dollar(r.price,3)}</td>
      <td style="padding:8px;font-family:monospace;text-align:right;color:#6b6660">${r.nta?dollar(r.nta,2):'--'}</td>
      <td style="padding:8px;font-family:monospace;text-align:right;
        color:${disc===null?'#6b6660':disc<-0.1?'#2d5a2d':disc<0?'#1a5f6e':'#8b2e2e'};font-weight:600">
        ${disc!==null?(disc*100).toFixed(1)+'%':'--'}
      </td>
      <td style="padding:8px;font-family:monospace;text-align:right;
        color:${r.dps_yield>=0.08?'#2d5a2d':r.dps_yield>=0.07?'#1a5f6e':'#333'};
        font-weight:${r.dps_yield>=0.07?600:400}">
        ${r.dps_yield?pctRaw(r.dps_yield,1):'--'}
      </td>
      <td style="padding:8px;text-align:center">
        <span style="font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;
          background:${r.conviction==='EXCEPTIONAL'?'#1a5f6e':r.conviction==='STRONG'?'#eef6ee':'#fdf8ee'};
          color:${r.conviction==='EXCEPTIONAL'?'#fff':r.conviction==='STRONG'?'#2d5a2d':'#7a5500'}">
          ${r.total_score||0}/6
        </span>
      </td>
      <td style="padding:8px;font-weight:600;font-size:11px;
        color:${r.yield_trigger_fired?'#2d5a2d':r.dps_yield>=0.075?'#7a5500':'#6b6660'}">
        ${r.yield_trigger_fired?'🟢 BUY':r.dps_yield>=0.075?'⚠️ Close':'Watching'}
      </td>
    </tr>`;
  };

  const subject = [
    `${sigEmoji} ASX Morning — ${signal.replace('_',' ')} ${score>0?'+':''}${score}`,
    `— ${new Date().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})}`,
    reitTriggers.length ? ` 🚨 REIT TRIGGER: ${reitTriggers.join(', ')}` : '',
    exceptional.length  ? ` 🔥 ${exceptional.length}×6/6` : ''
  ].join('');

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${emailStyles}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>ASX Morning Briefing</h1>
    <p>${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · 8:00am AEST · Model $50k · Data: EODHD</p>
  </div>

  <div class="section">
    <div class="signal-bar ${signal==='RISK_ON'?'':signal==='NEUTRAL'?'neutral':'bearish'}">
      <div class="signal-title" style="color:${sigColor}">${sigEmoji} ${signal.replace('_',' ')} &nbsp;<span style="font-size:15px;font-weight:400;color:#6b6660">Score ${score>0?'+':''}${score}</span></div>
      <p class="signal-sub">${reasons.join(' · ')}</p>
    </div>
    ${vixAlert?`<div style="background:#fdf8ee;border-left:3px solid #b8943f;padding:10px 14px;font-size:12px;color:#7a5500;font-weight:600">⚡ VIX ${vix.toFixed(1)} elevated — high conviction trades only today.</div>`:''}
    ${reitTriggers.length?`<div style="background:#eef6ee;border-left:3px solid #2d5a2d;padding:10px 14px;font-size:12px;color:#2d5a2d;font-weight:600;margin-top:8px">🟢 REIT TRIGGER — ${reitTriggers.join(', ')} at 8%+ yield. Log into CommSec and buy.</div>`:''}
  </div>

  <div class="section">
    <div class="section-title">US Overnight</div>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        ${['S&P 500','Nasdaq','VIX','AUD/USD','AUD chg'].map((l,i) => {
          const vals  = [sp500Change,nasdaqChange,vix,aud,audChange];
          const types = ['pct','pct','raw','raw4','pct'];
          const cols  = [colorClass(sp500Change),colorClass(nasdaqChange),vix<20?'positive':vix<25?'neutral':'negative','',''+colorClass(audChange)];
          let v = vals[i];
          if (types[i]==='pct') v=pct(v);
          else if (types[i]==='raw') v=parseFloat(v).toFixed(2);
          else if (types[i]==='raw4') v=parseFloat(v).toFixed(4);
          return `<td style="padding:8px 12px;background:#f9f7f3;border-radius:4px;text-align:center">
            <div style="font-size:10px;color:#6b6660;margin-bottom:2px">${l}</div>
            <div style="font-size:18px;font-weight:600" class="${cols[i]}">${v}</div>
          </td><td style="width:4px"></td>`;
        }).join('')}
      </tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Bond Market</div>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        ${[['US 10yr',pctRaw(us10yr),'teal'],['AUS 10yr',pctRaw(aus10yr),'teal'],['Yield Curve',bps(yieldCurve),yieldCurve>0?'positive':'negative'],['Real Yield',realYield?pctRaw(realYield):'--','']].map(([l,v,c])=>`
        <td style="padding:8px 12px;background:#f9f7f3;border-radius:4px;text-align:center">
          <div style="font-size:10px;color:#6b6660;margin-bottom:2px">${l}</div>
          <div style="font-size:18px;font-weight:600" class="${c}">${v}</div>
        </td><td style="width:4px"></td>`).join('')}
      </tr>
    </table>
    <p style="font-size:11px;color:#6b6660;margin-top:8px">${yieldCurve>0.005?'📈 Curve steepening — growth signal.':yieldCurve<-0.002?'⚠️ Curve inverted — caution.':'→ Flat — neutral.'}</p>
  </div>

  <div class="section">
    <div class="section-title">ASX500 — Today's Trades (place at 10:00am via CommSec)</div>
    ${equityTrades.length===0
      ? '<p style="color:#6b6660;font-size:12px;padding:8px 0">No trades today — macro too weak or no stocks passing 4+ layers.</p>'
      : `<table>
          <thead><tr>
            <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Ticker</th>
            <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Company / Why</th>
            <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Entry</th>
            <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Conviction</th>
            <th style="padding:6px 8px;font-size:10px;color:#8b2e2e;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Stop</th>
            <th style="padding:6px 8px;font-size:10px;color:#2d5a2d;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Target</th>
            <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Size</th>
          </tr></thead>
          <tbody>${equityTrades.map(tradeRow).join('')}</tbody>
        </table>
        <p style="font-size:11px;color:#6b6660;margin-top:8px">⏱ 10:00am open · Record in dashboard after CommSec confirms · Never hold overnight</p>`}
  </div>

  <div class="section">
    <div class="section-title">REIT Universe — ${reitResults.length} Moelis Pure Landlords</div>
    <table>
      <thead><tr>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Ticker</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Name</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Price</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">NTA</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Disc NTA</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:right">Yield</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase;text-align:center">Score</th>
        <th style="padding:6px 8px;font-size:10px;color:#6b6660;font-weight:400;font-family:monospace;text-transform:uppercase">Status</th>
      </tr></thead>
      <tbody>${reitResults.sort((a,b)=>(b.dps_yield||0)-(a.dps_yield||0)).map(reitRow).join('')}</tbody>
    </table>
  </div>

  <div class="footer">
    Not financial advice · Paper trading mode · Data: EODHD + FRED · Place real trades via CommSec
  </div>
</div></body></html>`;

  return { subject, html };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Morning scan (EODHD) starting: ${today}`);

  try {
    const settings = await loadSettings(db);

    // 1. US market data via Yahoo (still free and works well for US indices)
    const [sp500, nasdaq, vixData, audData, us10yrData] = await Promise.all([
      fetchYahoo('^GSPC', '5d'), fetchYahoo('^IXIC', '5d'),
      fetchYahoo('^VIX',  '5d'), fetchYahoo('AUDUSD=X', '5d'),
      fetchYahoo('^TNX',  '5d')
    ]);

    // 2. FRED bond data
    const [realYield, breakeven, igSpread] = await Promise.all([
      fetchFRED('DFII10'), fetchFRED('T10YIE'), fetchFRED('BAMLC0A0CM')
    ]);

    const us10yr  = us10yrData?.price ? us10yrData.price / 100 : 0.0431;
    const aus10yr = 0.0507;
    const vix     = vixData?.price  || 18;
    const aud     = audData?.price  || 0.648;

    const market = {
      sp500Change:  sp500?.change  || 0,
      nasdaqChange: nasdaq?.change || 0,
      vix, us10yr, aus10yr,
      yieldCurve:  us10yr - 0.0474,
      aud, audChange: audData?.change || 0,
      realYield, breakeven, igSpread
    };

    const macro = scoreMacro(market);
    console.log(`Macro: ${macro.signal} (${macro.score})`);

    // 3. Pre-screen ASX500 via EODHD screener
    const candidateTickers = await preScreen(macro.score);

    // 4. Load ASX500 stocks from DB — filter to candidates if we got them
    const { data: equityStocks } = await db.from('stocks')
      .select('*').eq('active', true).eq('universe', 'ASX500')
      .eq('is_manager', false).eq('is_developer', false);

    // Filter to screener candidates if available, otherwise use DB batch
    let stocksToAnalyse = equityStocks || [];
    if (candidateTickers.length > 0) {
      const candidateSet = new Set(candidateTickers);
      stocksToAnalyse = stocksToAnalyse.filter(s => candidateSet.has(s.ticker));
      // Also add high-corr stocks that might have been missed
      const highCorr = (equityStocks||[]).filter(s => s.us_corr > 0.75);
      highCorr.forEach(s => { if (!candidateSet.has(s.ticker)) stocksToAnalyse.push(s); });
    } else {
      // Fallback — rotating batch of 80
      const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(),0,0)) / 86400000);
      const start = (dayOfYear * 80) % stocksToAnalyse.length;
      stocksToAnalyse = [...stocksToAnalyse.slice(start), ...stocksToAnalyse.slice(0,start)].slice(0,80);
    }

    // 5. Load REIT universe
    const { data: reitStocks } = await db.from('stocks')
      .select('*').eq('active', true).eq('is_reit', true)
      .eq('is_manager', false).eq('is_developer', false);

    console.log(`Analysing ${stocksToAnalyse.length} equities + ${(reitStocks||[]).length} REITs`);

    // 6. Get bulk prices from EODHD for all stocks at once
    const allTickers   = [...(stocksToAnalyse||[]), ...(reitStocks||[])]
      .map(s => s.ticker)
      .filter(t => t !== 'GSBG37');

    const livePrices = await getBulkPrices(allTickers);
    console.log(`Live prices fetched: ${Object.keys(livePrices).length}`);

    // 7. Run full 6-layer analysis
    const equityResults = [];
    for (const stock of (stocksToAnalyse||[])) {
      const livePrice = livePrices[stock.ticker]?.close;
      const result    = await analyseStock(stock, macro.score, settings, livePrice);
      if (result && result.total_score >= 4) equityResults.push(result);
      await new Promise(r => setTimeout(r, 100));
    }

    const reitResults = [];
    for (const stock of (reitStocks||[]).filter(s => s.ticker !== 'GSBG37')) {
      const livePrice = livePrices[stock.ticker]?.close;
      const result    = await analyseStock(stock, macro.score, settings, livePrice);
      if (result) reitResults.push(result);
      await new Promise(r => setTimeout(r, 100));
    }

    const topEquities   = equityResults.sort((a,b) => b.total_score - a.total_score).slice(0,8);
    const reitTriggers  = reitResults.filter(r => r.yield_trigger_fired).map(r => r.ticker);

    // 8. Save to Supabase
    const allAnalysis = [...equityResults, ...reitResults].map(r => ({
      ticker:           r.ticker,
      analysis_date:    today,
      close:            r.price,
      ma20:             r.ma20,
      ma50:             r.ma50,
      ma200:            r.ma200,
      above_ma20:       r.above_ma20,
      above_ma200:      r.above_ma200,
      golden_cross:     r.golden_cross,
      rsi14:            r.rsi14,
      roc20:            r.roc20,
      bb_position:      r.bb_position,
      vol_ratio:        r.vol_ratio,
      pct_from_ma20:    r.pct_from_ma20,
      candle_pattern:   r.candle_pattern,
      candle_hammer:    r.candle_hammer,
      candle_engulfing_bull: r.candle_engulfing_bull,
      candle_doji:      r.candle_doji,
      candle_morning_star: r.candle_morning_star,
      dps_yield:        r.dps_yield,
      yield_trigger_fired: r.yield_trigger_fired,
      layer1_macro:     r.layer1_macro,
      layer2_trend:     r.layer2_trend,
      layer3_momentum:  r.layer3_momentum,
      layer4_reversion: r.layer4_reversion,
      layer5_volume:    r.layer5_volume,
      layer6_candle:    r.layer6_candle,
      total_score:      r.total_score,
      signal:           r.signal,
      conviction:       r.conviction,
      signal_reasons:   r.signal_reasons
    }));

    if (allAnalysis.length > 0) {
      await db.from('daily_analysis').upsert(allAnalysis, { onConflict: 'ticker,analysis_date' });
    }

    // Save model trades
    const tradesToSave = topEquities.filter(t => t.total_score >= 4).map(t => ({
      ticker:           t.ticker,
      company_name:     t.name,
      universe:         'ASX500',
      trade_date:       today,
      direction:        'LONG',
      entry_price:      t.price,
      stop_price:       t.stop_price,
      target_price:     t.target_price,
      units:            t.units,
      amount:           t.position_size,
      status:           'OPEN',
      total_score:      t.total_score,
      conviction:       t.conviction,
      signal_reasons:   t.signal_reasons,
      layer1_macro:     t.layer1_macro,
      layer2_trend:     t.layer2_trend,
      layer3_momentum:  t.layer3_momentum,
      layer4_reversion: t.layer4_reversion,
      layer5_volume:    t.layer5_volume,
      layer6_candle:    t.layer6_candle,
      candle_pattern:   t.candle_pattern
    }));

    if (tradesToSave.length > 0) {
      await db.from('model_trades').insert(tradesToSave);
    }

    // Save morning signal
    await db.from('morning_signals').upsert({
      signal_date:    today,
      sp500_change:   market.sp500Change,
      nasdaq_change:  market.nasdaqChange,
      vix,
      us_10yr:        us10yr,
      aus_10yr:       aus10yr,
      yield_curve_us: market.yieldCurve,
      aud_usd:        aud,
      aud_change:     market.audChange,
      real_yield:     realYield,
      credit_spread:  igSpread,
      macro_score:    macro.score,
      macro_signal:   macro.signal,
      signal:         macro.signal,
      summary:        macro.reasons.join('; '),
      equities_long:  topEquities.map(t => t.ticker),
      reits_long:     reitResults.filter(r => r.total_score >= 4).map(r => r.ticker),
      reit_triggers:  reitTriggers
    }, { onConflict: 'signal_date' });

    // Save alerts
    const exceptional = [...topEquities, ...reitResults].filter(t => t.total_score >= 6);
    if (exceptional.length > 0) {
      await db.from('alerts').insert(exceptional.map(t => ({
        alert_type: 'score_6', ticker: t.ticker, universe: t.universe,
        message: `🔥 ${t.ticker} — EXCEPTIONAL 6/6 — ${(t.signal_reasons||[]).join(', ')}`,
        data: { price: t.price, score: t.total_score }, sent: false
      })));
    }

    if (reitTriggers.length > 0) {
      await db.from('alerts').insert(reitTriggers.map(ticker => {
        const r = reitResults.find(x => x.ticker === ticker);
        return {
          alert_type: 'yield_trigger', ticker, universe: 'REIT',
          message: `${ticker} YIELD TRIGGER — $${r?.price?.toFixed(3)} — ${r?.dps_yield?(r.dps_yield*100).toFixed(1)+'%':'--'}`,
          data: { price: r?.price, yield: r?.dps_yield }, sent: false
        };
      }));
    }

    // Send email
    const { subject, html } = buildEmail(market, macro, topEquities, reitResults);
    await sendEmail(subject, html);
    console.log(`Morning scan complete. Equities: ${topEquities.length}, REITs: ${reitResults.length}, Triggers: ${reitTriggers.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: today, macro: macro.signal, score: macro.score,
        equities: topEquities.length, reits: reitResults.length,
        triggers: reitTriggers.length, exceptional: exceptional.length,
        data_source: 'EODHD'
      })
    };

  } catch(err) {
    console.error('Morning scan failed:', err);
    try { await sendEmail('⚠️ ASX Platform — Morning scan error', `<p style="font-family:sans-serif">Error: ${err.message}</p>`); } catch(e){}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
