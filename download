// netlify/functions/yield-triggers.js
// Scheduled: 4:05pm AEST (6:05am UTC) Mon–Fri
// 1. Gets latest prices from Supabase (just saved by fetch-prices)
// 2. Calculates yield for each REIT holding
// 3. Checks 20DMA from price history
// 4. Sends alert email if any holding hits 8% yield

import {
  getSupabase, sendEmail,
  BOND_YIELD, YIELD_TARGET, REIT_HOLDINGS,
  emailStyles, pct, pctRaw, dollar, bps
} from './_shared.js';

async function getLatestPrice(db, ticker) {
  const { data } = await db
    .from('prices')
    .select('price, change_pct, market_date')
    .eq('ticker', ticker)
    .order('market_date', { ascending: false })
    .limit(1)
    .single();
  return data;
}

async function get20DMA(db, ticker) {
  const { data } = await db
    .from('prices')
    .select('price')
    .eq('ticker', ticker)
    .order('market_date', { ascending: false })
    .limit(20);
  if (!data || data.length < 20) return null;
  return data.reduce((sum, r) => sum + parseFloat(r.price), 0) / data.length;
}

export const handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Yield triggers checking: ${today}`);

  try {
    const results = [];
    let anyFired  = false;

    for (const h of REIT_HOLDINGS.filter(r => r.ticker !== 'GSBG37')) {
      const [priceData, dma20] = await Promise.all([
        getLatestPrice(db, h.ticker),
        get20DMA(db, h.ticker)
      ]);

      if (!priceData) { console.log(`No price data for ${h.ticker}`); continue; }

      const price  = parseFloat(priceData.price);
      const yield_ = h.dps / price;
      const target = h.dps / YIELD_TARGET;
      const gap    = (target - price) / price;
      const spread = yield_ - BOND_YIELD;
      const fired  = yield_ >= YIELD_TARGET;
      const close  = !fired && gap > -0.13;
      const belowDMA = dma20 ? price < dma20 : null;

      if (fired) anyFired = true;

      results.push({
        ticker:    h.ticker,
        name:      h.name,
        nta:       h.nta,
        price,
        yield_,
        target,
        gap,
        spread,
        dma20,
        belowDMA,
        fired,
        close,
        change: parseFloat(priceData.change_pct || 0)
      });

      // Log fired triggers to Supabase
      if (fired) {
        await db.from('alerts').insert({
          alert_type: 'yield_trigger',
          ticker:     h.ticker,
          message:    `${h.ticker} FIRED — $${price.toFixed(3)} — ${(yield_*100).toFixed(1)}% yield`,
          data:       { price, yield_, target, spread, dma20, belowDMA },
          sent:       false
        });
      }
    }

    // Send email if any trigger fired OR any holding is close
    const closeTickers = results.filter(r => r.fired || r.close);
    if (anyFired || closeTickers.length > 0) {

      const subject = anyFired
        ? `🟢 REIT TRIGGER — ${results.filter(r=>r.fired).map(r=>r.ticker).join(', ')} at 8%+ yield — BUY`
        : `⚠️ REIT Watch — ${closeTickers.length} holding(s) approaching 8% trigger`;

      const rowsHtml = results.map(r => `
        <tr style="background:${r.fired ? '#f0f8f0' : r.close ? '#fffbf0' : 'white'}">
          <td class="mono" style="font-weight:600">${r.ticker}</td>
          <td>${r.name}</td>
          <td class="mono">
            ${dollar(r.price, 3)}
            <span style="font-size:10px;color:${r.change>=0?'#2d5a2d':'#8b2e2e'}">${pct(r.change)}</span>
          </td>
          <td class="mono" style="color:${r.yield_>=0.08?'#2d5a2d':r.yield_>=0.07?'#1a5f6e':'#333'};font-weight:${r.yield_>=0.07?600:400}">
            ${pctRaw(r.yield_, 1)}
          </td>
          <td class="mono">${dollar(r.target, 3)}</td>
          <td class="mono" style="font-size:10px;color:#6b6660">
            ${r.belowDMA === null ? 'Need 20 days data' : r.belowDMA ? '✓ Below 20DMA' : '✗ Above 20DMA'}
          </td>
          <td>
            <span class="badge ${r.fired ? 'badge-buy' : r.close ? 'badge-watch' : 'badge-hold'}">
              ${r.fired ? '🟢 BUY NOW' : `${(Math.abs(r.gap)*100).toFixed(0)}% away`}
            </span>
          </td>
        </tr>
      `).join('');

      const actionHtml = anyFired ? `
        <div style="background:#eef6ee;border:1px solid #c8c2b4;border-left:4px solid #2d5a2d;padding:14px 18px;margin-bottom:12px;font-size:13px;color:#2d5a2d">
          <strong>Action required:</strong> ${results.filter(r=>r.fired).map(r=>r.ticker).join(', ')} ${results.filter(r=>r.fired).length > 1 ? 'have' : 'has'} hit the 8% yield trigger.
          Log into <strong>IG Markets share trading</strong> (not CFD) and place buy order.
          This is a real ASX share purchase for the income portfolio in wife's account.
        </div>` : '';

      const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${emailStyles}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>${anyFired ? '🟢 REIT Yield Trigger Fired' : '⚠️ REIT Yield Watch'}</h1>
    <p>${new Date().toLocaleString('en-AU', { weekday:'long', day:'numeric', month:'long' })} · 4:00pm AEST close</p>
  </div>
  <div class="section">
    ${actionHtml}
    <div class="section-title">REIT Yield Status — End of Day</div>
    <table>
      <thead><tr>
        <th>Ticker</th><th>Name</th><th>Close Price</th>
        <th>Yield</th><th>8% Target</th><th>20DMA Filter</th><th>Status</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="font-size:11px;color:#6b6660;margin-top:12px">
      Bond yield today: ${pctRaw(BOND_YIELD)} · 
      Portfolio spread: ${bps(results.reduce((s,r) => s + r.spread * (1/results.length), 0))} avg ·
      20DMA filter needs 20 trading days of price history to activate
    </p>
  </div>
  <div class="footer">
    Not financial advice · Real shares only — no CFDs · Verify prices in IG before trading
  </div>
</div></body></html>`;

      await sendEmail(subject, html);

      // Mark alerts as sent
      await db.from('alerts')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('sent', false)
        .eq('alert_type', 'yield_trigger');

      console.log(`Alert sent — fired: ${results.filter(r=>r.fired).length}, close: ${closeTickers.length}`);
    } else {
      console.log('No triggers fired, no email sent');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        checked:  results.length,
        fired:    results.filter(r => r.fired).length,
        close:    results.filter(r => r.close).length,
        emailed:  anyFired || closeTickers.length > 0
      })
    };

  } catch (err) {
    console.error('yield-triggers failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
