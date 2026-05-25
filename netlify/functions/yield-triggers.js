const { schedule } = require('@netlify/functions');
// netlify/functions/yield-triggers.js
// Scheduled: 4:05pm AEST (6:05am UTC) Mon-Fri
// Checks REIT yields against triggers and sends alert

const { getSupabase, sendEmail, BOND_YIELD, YIELD_TARGET, emailStyles, pct, pctRaw, dollar, bps } = require('./_shared.js');

const handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: reits } = await db.from('stocks').select('*').eq('is_reit', true).eq('active', true).eq('is_manager', false);
    const { data: prices } = await db.from('prices').select('ticker,close,change_pct').eq('market_date', today);

    if (!reits?.length || !prices?.length) return { statusCode: 200, body: 'No data' };

    const priceMap = {};
    prices.forEach(p => { priceMap[p.ticker] = { price: parseFloat(p.close), change: parseFloat(p.change_pct||0) }; });

    const results = [];
    let anyFired  = false;

    for (const reit of reits.filter(r => r.ticker !== 'GSBG37')) {
      const pd = priceMap[reit.ticker];
      if (!pd) continue;
      const price   = pd.price;
      const yield_  = reit.dps_fy26 ? reit.dps_fy26 / price : null;
      const trigger = reit.yield_trigger || YIELD_TARGET;
      const target  = reit.dps_fy26 ? reit.dps_fy26 / trigger : null;
      const gap     = target ? (target - price) / price : null;
      const fired   = yield_ && yield_ >= trigger;
      const close   = !fired && gap && gap > -0.12;
      const spread  = yield_ ? yield_ - BOND_YIELD : null;
      if (fired) anyFired = true;

      results.push({ ticker: reit.ticker, name: reit.name, nta: reit.nta, price, yield_, trigger, target, gap, spread, fired, close, change: pd.change });

      if (fired) {
        await db.from('alerts').insert({
          alert_type: 'yield_trigger', ticker: reit.ticker, universe: 'REIT',
          message: `${reit.ticker} YIELD TRIGGER — $${price.toFixed(3)} — ${yield_?(yield_*100).toFixed(1)+'%':'--'}`,
          data: { price, yield_, target, spread }, sent: false
        });
      }
    }

    const closeTickers = results.filter(r => r.fired || r.close);
    if (anyFired || closeTickers.length > 0) {
      const subject = anyFired
        ? `🟢 REIT TRIGGER — ${results.filter(r=>r.fired).map(r=>r.ticker).join(', ')} — Log into CommSec`
        : `⚠️ REIT Watch — ${closeTickers.length} approaching 8% trigger`;

      const rowsHtml = results.sort((a,b)=>(b.yield_||0)-(a.yield_||0)).map(r => `
        <tr style="background:${r.fired?'#f0f8f0':r.close?'#fffbf0':'white'}">
          <td class="mono" style="font-weight:600">${r.ticker}</td>
          <td>${r.name}</td>
          <td class="mono">$${r.price.toFixed(3)} <span style="font-size:10px;color:${r.change>=0?'#2d5a2d':'#8b2e2e'}">${pct(r.change)}</span></td>
          <td class="mono" style="color:${r.yield_>=0.08?'#2d5a2d':r.yield_>=0.07?'#1a5f6e':'#333'};font-weight:${r.yield_>=0.07?600:400}">${r.yield_?pctRaw(r.yield_,1):'--'}</td>
          <td class="mono">${r.nta?'$'+r.nta.toFixed(2):'--'}</td>
          <td class="mono">${r.target?'$'+r.target.toFixed(3):'--'}</td>
          <td><span style="font-size:11px;${r.fired?'color:#2d5a2d;font-weight:600':'color:#6b6660'}">${r.fired?'🟢 BUY — CommSec':r.close&&r.gap?`${(Math.abs(r.gap)*100).toFixed(0)}% away`:'Watching'}</span></td>
        </tr>`).join('');

      const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${emailStyles}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>${anyFired?'🟢 REIT Yield Trigger Fired':'⚠️ REIT Yield Watch'}</h1>
    <p>${new Date().toLocaleString('en-AU',{weekday:'long',day:'numeric',month:'long'})} · 4:00pm AEST close</p>
  </div>
  <div class="section">
    ${anyFired?`<div style="background:#eef6ee;border-left:4px solid #2d5a2d;padding:12px 16px;margin-bottom:12px;font-size:13px;color:#2d5a2d"><strong>Action:</strong> Log into CommSec → place buy order for ${results.filter(r=>r.fired).map(r=>r.ticker).join(', ')} → record in dashboard.</div>`:''}
    <table>
      <thead><tr><th>Ticker</th><th>Name</th><th>Close</th><th>Yield</th><th>NTA</th><th>8% Target</th><th>Status</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="font-size:11px;color:#6b6660;margin-top:10px">Risk-free bond: ${pctRaw(BOND_YIELD)} · Buy REITs offering meaningful spread above this rate</p>
  </div>
  <div class="footer">Not financial advice · Real shares only via CommSec · Record trades in dashboard</div>
</div></body></html>`;

      await sendEmail(subject, html);
      await db.from('alerts').update({ sent: true, sent_at: new Date().toISOString() }).eq('sent', false).eq('alert_type', 'yield_trigger');
    }

    return { statusCode: 200, body: JSON.stringify({ checked: results.length, fired: results.filter(r=>r.fired).length, close: closeTickers.length }) };

  } catch (err) {
    console.error('yield-triggers failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports.handler = schedule('5 6 * * 1-5', handler);
