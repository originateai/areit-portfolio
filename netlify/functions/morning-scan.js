// netlify/functions/morning-scan.js
// Scheduled: 8:00am AEST (10:00pm UTC) Mon-Fri
// 1. Macro scoring — US overnight, bonds, VIX, AUD
// 2. Pre-screens stock universe (ASX500 + REITs)
// 3. Runs 6-layer strategy engine on candidates
// 4. Sends morning briefing email with ranked trades
// 5. Saves all analysis to Supabase

import {
  getSupabase, fetchYahoo, fetchFRED, sendEmail, loadSettings,
  BOND_YIELD, VIX_TRIGGER, emailStyles, pct, pctRaw, bps, dollar, colorClass, scoreDots
} from './_shared.js';
import { analyseStock } from './strategy-engine.js';

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
  else               { score -= 2; reasons.push('VIX extreme — risk off'); }

  if      (yieldCurve >  0.005) { score += 1; reasons.push('Curve steepening'); }
  else if (yieldCurve < -0.002) { score -= 1; reasons.push('Curve inverted'); }

  if      (audChange >  0.003) { score += 1; reasons.push('AUD rising — risk on'); }
  else if (audChange < -0.003) { score -= 1; reasons.push('AUD falling — risk off'); }

  const signal = score >= 3 ? 'RISK_ON' : score <= -3 ? 'RISK_OFF' : 'NEUTRAL';
  return { score, signal, reasons };
}

// ── BUILD EMAIL ───────────────────────────────────────────────────────────────
function buildEmail(market, macro, equityTrades, reitTrades, reitTriggers) {
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, yieldCurve, aud, audChange } = market;

  const sigColor = macro.signal === 'RISK_ON' ? '#2d5a2d' : macro.signal === 'RISK_OFF' ? '#8b2e2e' : '#7a5500';
  const sigEmoji = macro.signal === 'RISK_ON' ? '🟢' : macro.signal === 'RISK_OFF' ? '🔴' : '⚪';
  const vixAlert = vix > VIX_TRIGGER;

  const tradeRow = (t) => `
    <tr>
      <td class="mono" style="font-weight:600;color:#1a5f6e">${t.ticker}</td>
      <td style="font-size:11px">${t.name}<br><span style="color:#6b6660;font-size:10px">${t.signal_reasons?.slice(0,2).join(' · ')}</span></td>
      <td class="mono">${dollar(t.price,3)}</td>
      <td><span class="badge badge-${t.conviction?.toLowerCase()}">${t.conviction} ${t.total_score}/6</span></td>
      <td class="mono" style="color:#8b2e2e">${dollar(t.stop_price,3)}</td>
      <td class="mono" style="color:#2d5a2d">${dollar(t.target_price,3)}</td>
      <td class="mono">$${(t.position_size||0).toLocaleString()}<br><span style="color:#6b6660;font-size:10px">${t.units||0} units</span></td>
    </tr>`;

  const reitRow = (r) => `
    <tr style="background:${r.yield_trigger_fired?'#f0f8f0':r.dps_yield>=0.075?'#fffbf0':'white'}">
      <td class="mono" style="font-weight:600">${r.ticker}</td>
      <td style="font-size:11px">${r.name}</td>
      <td class="mono">${dollar(r.price,3)}</td>
      <td class="mono ${r.dps_yield>=0.08?'positive':r.dps_yield>=0.07?'teal':''}" style="font-weight:${r.dps_yield>=0.07?600:400}">${r.dps_yield?pctRaw(r.dps_yield,1):'--'}</td>
      <td><span class="badge badge-${r.conviction?.toLowerCase()}">${r.total_score}/6</span></td>
      <td><span style="font-size:11px;${r.yield_trigger_fired?'color:#2d5a2d;font-weight:600':'color:#6b6660'}">${r.yield_trigger_fired?'🟢 BUY':r.dps_yield>=0.075?'⚠️ Close':'Watching'}</span></td>
    </tr>`;

  const subject = `${sigEmoji} ASX Morning — ${macro.signal} ${macro.score>0?'+':''}${macro.score} — ${new Date().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})}${reitTriggers.length?' 🚨 REIT TRIGGER':''}${equityTrades.some(t=>t.total_score>=6)?' 🔥 6/6 SIGNAL':''}`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${emailStyles}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>ASX Morning Briefing</h1>
    <p>${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · 8:00am AEST · Model Portfolio $50k</p>
  </div>

  <div class="section">
    <div class="signal-bar ${macro.signal==='RISK_ON'?'':macro.signal==='NEUTRAL'?'neutral':'bearish'}">
      <div class="signal-title" style="color:${sigColor}">${sigEmoji} ${macro.signal.replace('_',' ')} &nbsp;<span style="font-size:15px;font-weight:400;color:#6b6660">Macro score ${macro.score>0?'+':''}${macro.score}</span></div>
      <p class="signal-sub">${macro.reasons.join(' · ')}</p>
    </div>
    ${vixAlert?`<div style="background:#fdf8ee;border:1px solid #c8c2b4;border-left:3px solid #b8943f;padding:10px 14px;font-size:12px;color:#7a5500;font-weight:600">⚡ VIX ${vix.toFixed(1)} — ELEVATED. High conviction only today.</div>`:''}
    ${reitTriggers.length?`<div style="background:#eef6ee;border:1px solid #c8c2b4;border-left:3px solid #2d5a2d;padding:10px 14px;font-size:12px;color:#2d5a2d;font-weight:600;margin-top:8px">🟢 REIT YIELD TRIGGER — ${reitTriggers.join(', ')} at 8%+ yield. Log into CommSec and buy.</div>`:''}
  </div>

  <div class="section">
    <div class="section-title">US Overnight</div>
    <div class="metric-row">
      <div class="metric"><div class="ml">S&P 500</div><div class="mv ${colorClass(sp500Change)}">${pct(sp500Change)}</div></div>
      <div class="metric"><div class="ml">Nasdaq</div><div class="mv ${colorClass(nasdaqChange)}">${pct(nasdaqChange)}</div></div>
      <div class="metric"><div class="ml">VIX</div><div class="mv" style="color:${vix<20?'#2d5a2d':vix<25?'#7a5500':'#8b2e2e'}">${vix.toFixed(1)}</div></div>
      <div class="metric"><div class="ml">AUD/USD</div><div class="mv">${aud.toFixed(4)}</div></div>
      <div class="metric"><div class="ml">AUD chg</div><div class="mv ${colorClass(audChange)}">${pct(audChange)}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Bond Market</div>
    <div class="metric-row">
      <div class="metric"><div class="ml">US 10yr</div><div class="mv teal">${pctRaw(us10yr)}</div></div>
      <div class="metric"><div class="ml">AUS 10yr</div><div class="mv teal">${pctRaw(aus10yr)}</div></div>
      <div class="metric"><div class="ml">Yield curve</div><div class="mv ${colorClass(yieldCurve)}">${bps(yieldCurve)}</div></div>
    </div>
    <p style="font-size:11px;color:#6b6660;margin-top:8px">${yieldCurve>0.005?'📈 Steepening — growth signal.':yieldCurve<-0.002?'⚠️ Inverted — caution.':'→ Flat — neutral.'}</p>
  </div>

  <div class="section">
    <div class="section-title">ASX500 — Today's Trade Candidates (place at 10:00am open via CommSec)</div>
    ${equityTrades.length===0
      ? '<p style="color:#6b6660;font-size:12px">No trades today — macro too weak or no stocks passing 4+ layers.</p>'
      : `<table>
          <thead><tr>
            <th>Ticker</th><th>Company / Why</th><th>Entry</th>
            <th>Conviction</th><th style="color:#8b2e2e">Stop</th>
            <th style="color:#2d5a2d">Target</th><th>Size</th>
          </tr></thead>
          <tbody>${equityTrades.map(tradeRow).join('')}</tbody>
        </table>`}
    <p style="font-size:11px;color:#6b6660;margin-top:8px">⏱ Place at 10:00am AEST open · Record in dashboard after CommSec confirms · Never hold overnight</p>
  </div>

  <div class="section">
    <div class="section-title">REIT Universe — Yield &amp; Strategy Signals</div>
    ${reitTrades.length===0
      ? '<p style="color:#6b6660;font-size:12px">No REIT signals today.</p>'
      : `<table>
          <thead><tr>
            <th>Ticker</th><th>Name</th><th>Price</th>
            <th>Yield</th><th>Score</th><th>Status</th>
          </tr></thead>
          <tbody>${reitTrades.map(reitRow).join('')}</tbody>
        </table>`}
  </div>

  <div class="footer">
    Not financial advice · Model portfolio paper trading · Place real trades via CommSec · Record in dashboard
  </div>
</div></body></html>`;

  return { subject, html };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export const handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Morning scan v2 starting: ${today}`);

  try {
    const settings = await loadSettings(db);

    // 1. Fetch macro data
    const [sp500, nasdaq, vixData, audData, us10yrData] = await Promise.all([
      fetchYahoo('^GSPC', '5d'), fetchYahoo('^IXIC', '5d'),
      fetchYahoo('^VIX',  '5d'), fetchYahoo('AUDUSD=X', '5d'),
      fetchYahoo('^TNX',  '5d')
    ]);

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
      yieldCurve: us10yr - 0.0474,
      aud, audChange: audData?.change || 0,
      realYield, breakeven, igSpread
    };

    const macro = scoreMacro(market);
    console.log(`Macro: ${macro.signal} (${macro.score})`);

    // 2. Load stock universes
    const { data: allStocks } = await db.from('stocks').select('*').eq('active', true).eq('is_manager', false).eq('is_developer', false);
    if (!allStocks?.length) throw new Error('No stocks in database');

    const equityStocks = allStocks.filter(s => s.universe === 'ASX500');
    const reitStocks   = allStocks.filter(s => s.universe === 'REIT' && s.is_reit);

    // 3. Analyse REITs (smaller universe — do all of them)
    console.log(`Analysing ${reitStocks.length} REITs...`);
    const reitResults = [];
    for (const stock of reitStocks) {
      await new Promise(r => setTimeout(r, 300)); // rate limit
      const result = await analyseStock(stock, macro.score, settings);
      if (result) reitResults.push(result);
    }

    // 4. Pre-screen equities — only analyse those with sufficient volume and not in downtrend
    // Due to rate limiting, sample 50 stocks per day rotating through the universe
    const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const batchSize = 50;
    const startIdx  = (dayOfYear * batchSize) % equityStocks.length;
    const batch     = [...equityStocks.slice(startIdx), ...equityStocks.slice(0, startIdx)].slice(0, batchSize);

    console.log(`Analysing ${batch.length} equity stocks...`);
    const equityResults = [];
    for (const stock of batch) {
      await new Promise(r => setTimeout(r, 300));
      const result = await analyseStock(stock, macro.score, settings);
      if (result && result.total_score >= 4) equityResults.push(result);
    }

    // 5. Sort by score
    const topEquities = equityResults.sort((a,b) => b.total_score - a.total_score).slice(0,8);
    const topREITs    = reitResults.sort((a,b) => b.total_score - a.total_score);
    const reitTriggers = reitResults.filter(r => r.yield_trigger_fired).map(r => r.ticker);

    // 6. Save analysis to Supabase
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

    // 7. Save model trades for high conviction signals
    const tradesToSave = topEquities.filter(t => t.total_score >= 4).map(t => ({
      ticker:       t.ticker,
      company_name: t.name,
      universe:     'ASX500',
      trade_date:   today,
      direction:    'LONG',
      entry_price:  t.price,
      stop_price:   t.stop_price,
      target_price: t.target_price,
      units:        t.units,
      amount:       t.position_size,
      status:       'OPEN',
      total_score:  t.total_score,
      conviction:   t.conviction,
      signal_reasons: t.signal_reasons,
      layer1_macro:   t.layer1_macro,
      layer2_trend:   t.layer2_trend,
      layer3_momentum: t.layer3_momentum,
      layer4_reversion: t.layer4_reversion,
      layer5_volume:  t.layer5_volume,
      layer6_candle:  t.layer6_candle,
      candle_pattern: t.candle_pattern
    }));

    if (tradesToSave.length > 0) {
      await db.from('model_trades').insert(tradesToSave);
    }

    // 8. Save morning signal
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
      reits_long:     topREITs.filter(r => r.total_score >= 4).map(r => r.ticker),
      reit_triggers:  reitTriggers
    }, { onConflict: 'signal_date' });

    // 9. Save REIT trigger alerts
    if (reitTriggers.length > 0) {
      await db.from('alerts').insert(reitTriggers.map(ticker => {
        const r = reitResults.find(x => x.ticker === ticker);
        return {
          alert_type: 'yield_trigger',
          ticker,
          universe: 'REIT',
          message: `${ticker} YIELD TRIGGER — $${r?.price?.toFixed(3)} — ${r?.dps_yield?(r.dps_yield*100).toFixed(1)+'%':'--'} yield`,
          data: { price: r?.price, yield: r?.dps_yield },
          sent: false
        };
      }));
    }

    // 10. Save 6/6 score alerts
    const exceptional = [...topEquities, ...topREITs].filter(t => t.total_score >= 6);
    if (exceptional.length > 0) {
      await db.from('alerts').insert(exceptional.map(t => ({
        alert_type: 'score_6',
        ticker:     t.ticker,
        universe:   t.universe,
        message:    `🔥 ${t.ticker} — EXCEPTIONAL 6/6 signal — ${t.signal_reasons?.join(', ')}`,
        data:       { price: t.price, score: t.total_score, conviction: t.conviction },
        sent:       false
      })));
    }

    // 11. Send email
    const { subject, html } = buildEmail(market, macro, topEquities, topREITs, reitTriggers);
    await sendEmail(subject, html);
    console.log(`Morning scan complete. Equities: ${topEquities.length}, REITs analysed: ${reitResults.length}, Triggers: ${reitTriggers.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: today, macro: macro.signal, score: macro.score,
        equities: topEquities.length, reits: reitResults.length,
        triggers: reitTriggers.length, exceptional: exceptional.length
      })
    };

  } catch (err) {
    console.error('Morning scan v2 failed:', err);
    try { await sendEmail('⚠️ ASX Platform — Morning scan error', `<p style="font-family:sans-serif">Error: ${err.message}</p>`); } catch(e){}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
