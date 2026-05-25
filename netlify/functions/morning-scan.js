import {
  getSupabase, fetchYahoo, fetchFRED, sendEmail,
  BOND_YIELD, VIX_TRIGGER, YIELD_TARGET, REIT_HOLDINGS,
  emailStyles, pct, pctRaw, bps, dollar, colorClass
} from './_shared.js';

function scoreSignal({ sp500Change, nasdaqChange, vix, yieldCurve, audChange, realYield }) {
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

  if      (vix < 15) { score += 2; reasons.push('VIX low'); }
  else if (vix < 20) { score += 1; reasons.push('VIX normal'); }
  else if (vix < 25) { score += 0; }
  else if (vix < 35) { score -= 1; reasons.push('VIX elevated'); }
  else               { score -= 2; reasons.push('VIX extreme'); }

  if      (yieldCurve >  0.005) { score += 1; reasons.push('Curve steep'); }
  else if (yieldCurve < -0.002) { score -= 1; reasons.push('Curve inverted'); }

  if      (audChange >  0.003) { score += 1; reasons.push('AUD rising'); }
  else if (audChange < -0.003) { score -= 1; reasons.push('AUD falling'); }

  if (realYield !== null) {
    if      (realYield < 0.015) { score += 1; reasons.push('Real yield falling'); }
    else if (realYield > 0.025) { score -= 1; reasons.push('Real yield high'); }
  }

  const signal =
    score >= 7  ? 'STRONG_LONG'  :
    score >= 4  ? 'LONG'         :
    score >= 1  ? 'MILD_LONG'    :
    score >= -1 ? 'NEUTRAL'      :
    score >= -4 ? 'MILD_SHORT'   :
    score >= -7 ? 'SHORT'        : 'STRONG_SHORT';

  return { score, signal, reasons };
}

async function selectTrades(signal, vix, sp500Change, db) {
  const isPositive = ['STRONG_LONG', 'LONG', 'MILD_LONG'].includes(signal);
  if (!isPositive) return [];

  const { data: watchlist } = await db
    .from('watchlist')
    .select('*')
    .eq('active', true)
    .neq('sector', 'REIT');

  if (!watchlist?.length) return [];

  const candidates = [];
  const vixBoost   = vix > VIX_TRIGGER;

  for (const stock of watchlist) {
    const data = await fetchYahoo(stock.ticker + '.AX', '30d');
    if (!data?.closes || data.closes.length < 20) continue;

    const price  = data.price;
    const closes = data.closes.filter(Boolean);
    const ma20   = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    const diffs  = [];
    for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);
    const gains  = diffs.map(d => d > 0 ? d : 0);
    const losses = diffs.map(d => d < 0 ? Math.abs(d) : 0);
    const avgG   = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const avgL   = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const rsi    = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));

    let stockScore = 0;
    const stockReasons = [];

    if (price < ma20)                              { stockScore += 2; stockReasons.push('below 20DMA'); }
    if (rsi < 35)                                  { stockScore += 2; stockReasons.push(`RSI ${rsi.toFixed(0)} oversold`); }
    else if (rsi < 45)                             { stockScore += 1; stockReasons.push(`RSI ${rsi.toFixed(0)}`); }
    else if (rsi > 70)                             { stockScore -= 2; }
    if (stock.us_corr > 0.7 && sp500Change > 0)   { stockScore += 2; stockReasons.push(`corr ${stock.us_corr}`); }

    if (stockScore >= 2 && rsi < 65 && price <= ma20 * 1.02) {
      const amount = vixBoost ? 4000 : 2000;
      candidates.push({
        ticker:      stock.ticker,
        name:        stock.name,
        sector:      stock.sector,
        price,
        stopPrice:   parseFloat((price * 0.985).toFixed(3)),
        targetPrice: parseFloat((price * 1.030).toFixed(3)),
        units:       Math.floor(amount / price),
        amount,
        score:       stockScore,
        reasons:     stockReasons,
        vixBoost
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function checkREITs() {
  const results = [];
  for (const h of REIT_HOLDINGS.filter(h => h.ticker !== 'GSBG37')) {
    const data = await fetchYahoo(h.ticker + '.AX', '2d');
    if (!data) continue;
    const price  = data.price;
    const yield_ = h.dps / price;
    const target = h.dps / YIELD_TARGET;
    const gap    = (target - price) / price;
    results.push({
      ticker: h.ticker,
      name:   h.name,
      price,
      yield_,
      target,
      gap,
      change: data.changePct,
      fired:  yield_ >= YIELD_TARGET,
      close:  yield_ < YIELD_TARGET && gap > -0.13
    });
  }
  return results.sort((a, b) => b.yield_ - a.yield_);
}

function buildEmail(market, scored, trades, reits) {
  const { sp500Change, nasdaqChange, vix, us10yr, aus10yr, yieldCurve, aud, audChange, realYield } = market;
  const { score, signal, reasons } = scored;

  const sigColor = {
    STRONG_LONG: '#2d5a2d', LONG: '#2d5a2d', MILD_LONG: '#1a5f6e',
    NEUTRAL: '#7a5500',
    MILD_SHORT: '#7a5500', SHORT: '#8b2e2e', STRONG_SHORT: '#8b2e2e'
  }[signal] || '#333';

  const sigEmoji = {
    STRONG_LONG: '🟢🟢', LONG: '🟢', MILD_LONG: '🟡',
    NEUTRAL: '⚪',
    MILD_SHORT: '🟠', SHORT: '🔴', STRONG_SHORT: '🔴🔴'
  }[signal] || '⚪';

  const isPositive = ['STRONG_LONG','LONG','MILD_LONG'].includes(signal);
  const vixAlert   = vix > VIX_TRIGGER;
  const firedREITs = reits.filter(r => r.fired);

  const tradesHtml = trades.length === 0
    ? `<tr><td colspan="6" style="padding:12px;color:#6b6660;text-align:center">No trades today — signal too weak or no setups passing all filters</td></tr>`
    : trades.map(t => `
        <tr>
          <td class="mono" style="font-weight:600;color:#1a5f6e">${t.ticker}</td>
          <td>${t.name}</td>
          <td class="mono">${dollar(t.price, 3)}</td>
          <td class="mono" style="color:#8b2e2e">${dollar(t.stopPrice, 3)}</td>
          <td class="mono" style="color:#2d5a2d">${dollar(t.targetPrice, 3)}</td>
          <td class="mono">$${t.amount.toLocaleString()}${t.vixBoost ? ' ⚡' : ''}</td>
        </tr>`).join('');

  const reitsHtml = reits.map(r => `
    <tr style="background:${r.fired ? '#f0f8f0' : r.close ? '#fffbf0' : 'white'}">
      <td class="mono" style="font-weight:600">${r.ticker}</td>
      <td>${r.name}</td>
      <td class="mono">${dollar(r.price, 3)} <span style="font-size:10px;color:${r.change >= 0 ? '#2d5a2d' : '#8b2e2e'}">${pct(r.change)}</span></td>
      <td class="mono" style="color:${r.yield_>=0.08?'#2d5a2d':r.yield_>=0.07?'#1a5f6e':'#333'};font-weight:${r.yield_>=0.07?600:400}">${pctRaw(r.yield_, 1)}</td>
      <td class="mono">${dollar(r.target, 3)}</td>
      <td><span class="badge ${r.fired?'badge-buy':r.close?'badge-watch':'badge-hold'}">${r.fired ? '🟢 BUY NOW' : r.close ? `${(Math.abs(r.gap)*100).toFixed(0)}% away` : `${(Math.abs(r.gap)*100).toFixed(0)}% away`}</span></td>
    </tr>`).join('');

  const subject = `${sigEmoji} ASX Morning — ${signal.replace('_',' ')} ${score}/10 — ${new Date().toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' })}${firedREITs.length ? ' 🚨 REIT TRIGGER' : ''}`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${emailStyles}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>ASX Morning Briefing</h1>
    <p>${new Date().toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' })} · 8:00am AEST</p>
  </div>
  <div class="section">
    <div class="signal-bar ${isPositive?'':signal==='NEUTRAL'?'neutral':'bearish'}">
      <div class="signal-title" style="color:${sigColor}">${sigEmoji} ${signal.replace('_',' ')} &nbsp;<span style="font-size:15px;font-weight:400;color:#6b6660">Score ${score}/10</span></div>
      <p class="signal-sub">${reasons.join(' · ')}</p>
    </div>
    ${vixAlert ? `<div style="background:#fdf8ee;border:1px solid #c8c2b4;border-left:3px solid #b8943f;padding:10px 14px;font-size:12px;color:#7a5500;font-weight:600">⚡ VIX ${vix.toFixed(1)} — ELEVATED. Double monthly REIT deployment this month.</div>` : ''}
    ${firedREITs.length ? `<div style="background:#eef6ee;border:1px solid #c8c2b4;border-left:3px solid #2d5a2d;padding:10px 14px;font-size:12px;color:#2d5a2d;font-weight:600;margin-top:8px">🟢 REIT TRIGGER — ${firedREITs.map(r=>r.ticker).join(', ')} at 8%+ yield. Log into IG and buy.</div>` : ''}
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
      <div class="metric"><div class="ml">Real yield</div><div class="mv">${realYield !== null ? pctRaw(realYield) : '--'}</div></div>
    </div>
    <p style="font-size:11px;color:#6b6660;margin-top:8px">
      ${yieldCurve > 0.005 ? '📈 Curve steepening — growth signal. Bullish banks and resources.' :
        yieldCurve < -0.002 ? '⚠️ Curve inverted — recession risk. Favour defensives.' :
        '→ Flat — neutral. Trade on equity signal.'}
    </p>
  </div>
  <div class="section">
    <div class="section-title">Today's Play Portfolio — Long Only · Real Shares · Paper Mode</div>
    <table>
      <thead><tr>
        <th>Ticker</th><th>Company</th><th>Entry</th>
        <th style="color:#8b2e2e">Stop −1.5%</th>
        <th style="color:#2d5a2d">Target +3%</th>
        <th>Size</th>
      </tr></thead>
      <tbody>${tradesHtml}</tbody>
    </table>
    <p style="font-size:11px;color:#6b6660;margin-top:8px">⏱ Execute 10:00am AEST · Exit by 4:00pm · Never hold overnight</p>
  </div>
  <div class="section">
    <div class="section-title">REIT Portfolio — Wife's Account · Yield Triggers</div>
    <table>
      <thead><tr>
        <th>Ticker</th><th>Name</th><th>Price</th>
        <th>Yield</th><th>8% Target</th><th>Status</th>
      </tr></thead>
      <tbody>${reitsHtml}</tbody>
    </table>
  </div>
  <div class="footer">
    Not financial advice · Paper trading mode · Yahoo Finance + FRED API · Dashboard: your Netlify URL
  </div>
</div></body></html>`;

  return { subject, html };
}

export const handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Morning scan starting: ${today}`);

  try {
    const [sp500, nasdaq, vixData, audData, us10yrData] = await Promise.all([
      fetchYahoo('^GSPC', '5d'),
      fetchYahoo('^IXIC', '5d'),
      fetchYahoo('^VIX',  '5d'),
      fetchYahoo('AUDUSD=X', '5d'),
      fetchYahoo('^TNX',  '5d'),
    ]);

    const [realYield, breakeven, igSpread] = await Promise.all([
      fetchFRED('DFII10'),
      fetchFRED('T10YIE'),
      fetchFRED('BAMLC0A0CM')
    ]);

    const us10yr  = us10yrData?.price ? us10yrData.price / 100 : 0.0431;
    const us2yr   = 0.0474;
    const aus10yr = 0.0507;
    const vix     = vixData?.price  || 18;
    const aud     = audData?.price  || 0.648;

    const market = {
      sp500Change:  sp500?.change  || 0,
      nasdaqChange: nasdaq?.change || 0,
      vix, us10yr, us2yr, aus10yr,
      yieldCurve:   us10yr - us2yr,
      aud,
      audChange:    audData?.change || 0,
      realYield, breakeven, igSpread
    };

    const scored = scoreSignal(market);
    const trades = await selectTrades(scored.signal, vix, market.sp500Change, db);
    const reits  = await checkREITs();
    const fired  = reits.filter(r => r.fired);

    await db.from('morning_signals').upsert({
      signal_date:     today,
      sp500_change:    market.sp500Change,
      nasdaq_change:   market.nasdaqChange,
      vix,
      us_10yr:         us10yr,
      us_2yr:          us2yr,
      yield_curve:     market.yieldCurve,
      aus_10yr:        aus10yr,
      aud_usd:         aud,
      aud_change:      market.audChange,
      real_yield:      realYield,
      credit_spread:   igSpread,
      breakeven_infl:  breakeven,
      composite_score: scored.score,
      signal:          scored.signal,
      summary:         scored.reasons.join('; '),
      longs:           trades.map(t => t.ticker)
    }, { onConflict: 'signal_date' });

    if (trades.length > 0) {
      await db.from('play_trades').insert(trades.map(t => ({
        ticker:       t.ticker,
        company_name: t.name,
        trade_date:   today,
        direction:    'LONG',
        entry_price:  t.price,
        stop_price:   t.stopPrice,
        target_price: t.targetPrice,
        units:        t.units,
        amount:       t.amount,
        signal_score: t.score,
        is_paper:     true,
        status:       'OPEN',
        notes:        t.reasons.join(', ')
      })));
    }

    if (fired.length > 0) {
      await db.from('alerts').insert(fired.map(r => ({
        alert_type: 'yield_trigger',
        ticker:     r.ticker,
        message:    `${r.ticker} FIRED — $${r.price.toFixed(3)} — ${(r.yield_*100).toFixed(1)}% yield`,
        data:       { price: r.price, yield_: r.yield_, target: r.target },
        sent:       false
      })));
    }

    const { subject, html } = buildEmail(market, scored, trades, reits);
    await sendEmail(subject, html);
    console.log('Morning briefing sent');

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: today, signal: scored.signal,
        score: scored.score, trades: trades.length, triggered: fired.length
      })
    };

  } catch (err) {
    console.error('Morning scan failed:', err);
    try {
      await sendEmail(
        '⚠️ AREIT Portfolio — Morning scan error',
        `<p style="font-family:sans-serif">Error on ${new Date().toISOString()}<br><br>${err.message}</p>`
      );
    } catch(e) { /* silent */ }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
