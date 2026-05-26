// netlify/functions/fetch-prices.js
// Scheduled: 4:00pm AEST (6:00am UTC) Mon-Fri
// Fetches EOD prices + 52W high/low + market cap for ALL active stocks
// Uses EODHD bulk real-time endpoint — all 500 stocks in one call

const { getSupabase, sendEmail } = require('./_shared.js');
const { schedule } = require('@netlify/functions');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

async function getBulkPrices(tickers) {
  try {
    const epic    = tickers.map(t => `${t}.AU`);
    const symbols = epic.join(',');
    const url     = `${BASE}/real-time/${epic[0]}?s=${symbols}&api_token=${KEY()}&fmt=json`;
    const res     = await fetch(url);
    if (!res.ok) throw new Error(`EODHD ${res.status}`);
    const json    = await res.json();
    const data    = Array.isArray(json) ? json : [json];

    const map = {};
    data.forEach(d => {
      const ticker = d.code?.replace('.AU', '');
      if (!ticker) return;
      const close    = parseFloat(d.close || d.previousClose || 0);
      const high52   = parseFloat(d.high_52w || 0);
      const low52    = parseFloat(d.low_52w  || 0);
      map[ticker] = {
        price:         close,
        open:          parseFloat(d.open   || close),
        high:          parseFloat(d.high   || close),
        low:           parseFloat(d.low    || close),
        close,
        volume:        parseInt(d.volume   || 0),
        change:        parseFloat(d.change || 0),
        changePct:     parseFloat(d.change_p || 0) / 100,
        high_52w:      high52 || null,
        low_52w:       low52  || null,
        market_cap:    parseFloat(d.marketCapitalization || 0) || null,
        pct_from_52w_low:  low52  > 0 ? parseFloat(((close - low52)  / low52  * 100).toFixed(2)) : null,
        pct_from_52w_high: high52 > 0 ? parseFloat(((close - high52) / high52 * 100).toFixed(2)) : null,
      };
    });
    return map;
  } catch(e) {
    console.error('Bulk price error:', e.message);
    return {};
  }
}

exports.handler = schedule('0 6 * * 1-5', async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetch prices starting: ${today}`);

  try {
    const { data: stocks } = await db.from('stocks')
      .select('ticker').eq('active', true).neq('ticker', 'GSBG37');

    if (!stocks?.length) return { statusCode: 200, body: 'No stocks' };

    const tickers = stocks.map(s => s.ticker);
    console.log(`Fetching prices for ${tickers.length} stocks`);

    // Process in batches of 100
    const priceRows = [];
    let fetched = 0, failed = 0;

    for (let i = 0; i < tickers.length; i += 100) {
      const batch    = tickers.slice(i, i + 100);
      const priceMap = await getBulkPrices(batch);

      for (const ticker of batch) {
        const p = priceMap[ticker];
        if (p && p.close > 0) {
          priceRows.push({
            ticker,
            market_date: today,
            open:        p.open,
            high:        p.high,
            low:         p.low,
            close:       p.close,
            volume:      p.volume,
            change_pct:  p.changePct,
            fetched_at:  new Date().toISOString()
          });

          // Update 52W data in stocks table
          const stockUpdate = {};
          if (p.high_52w)      stockUpdate.high_52w          = p.high_52w;
          if (p.low_52w)       stockUpdate.low_52w           = p.low_52w;
          if (p.market_cap)    stockUpdate.market_cap        = p.market_cap;
          if (p.pct_from_52w_low  != null) stockUpdate.pct_from_52w_low  = p.pct_from_52w_low;
          if (p.pct_from_52w_high != null) stockUpdate.pct_from_52w_high = p.pct_from_52w_high;

          if (Object.keys(stockUpdate).length > 0) {
            await db.from('stocks').update(stockUpdate).eq('ticker', ticker);
          }

          fetched++;
        } else {
          failed++;
        }
      }

      await new Promise(r => setTimeout(r, 300));
    }

    // Upsert prices
    for (let i = 0; i < priceRows.length; i += 100) {
      await db.from('prices').upsert(
        priceRows.slice(i, i + 100),
        { onConflict: 'ticker,market_date' }
      );
    }

    // Check open model trades for stop/target hits
    const { data: openTrades } = await db.from('model_trades')
      .select('*').eq('status', 'OPEN');

    let stopped = 0, targeted = 0;
    const alerts = [];

    if (openTrades?.length) {
      const livePrices = {};
      priceRows.forEach(r => { livePrices[r.ticker] = r.close; });

      for (const trade of openTrades) {
        const cur = livePrices[trade.ticker];
        if (!cur) continue;

        const pnl    = (cur - trade.entry_price) * (trade.units || 0);
        const pnlPct = (cur - trade.entry_price) / trade.entry_price;

        if (cur <= trade.stop_price) {
          await db.from('model_trades').update({
            status: 'STOPPED', exit_price: trade.stop_price,
            exit_date: today, pnl: parseFloat(pnl.toFixed(2)),
            pnl_pct: parseFloat(pnlPct.toFixed(6))
          }).eq('id', trade.id);
          alerts.push({ type: 'stop_hit', ticker: trade.ticker, msg: `${trade.ticker} STOP HIT — $${trade.stop_price} — P&L: ${pnl>=0?'+':''}$${pnl.toFixed(0)}` });
          stopped++;
        } else if (cur >= trade.target_price) {
          await db.from('model_trades').update({
            status: 'TARGETED', exit_price: trade.target_price,
            exit_date: today, pnl: parseFloat(pnl.toFixed(2)),
            pnl_pct: parseFloat(pnlPct.toFixed(6))
          }).eq('id', trade.id);
          alerts.push({ type: 'target_hit', ticker: trade.ticker, msg: `${trade.ticker} TARGET HIT 🎯 — $${trade.target_price} — P&L: +$${pnl.toFixed(0)}` });
          targeted++;
        }
      }
    }

    // Send alert email if any stops/targets hit
    if (alerts.length > 0) {
      await db.from('alerts').insert(alerts.map(a => ({
        alert_type: a.type, ticker: a.ticker, universe: 'ASX500',
        message: a.msg, sent: false
      })));
      const html = `<div style="font-family:sans-serif;max-width:600px;padding:20px">
        <h2>⚡ Trade Alerts — ${today}</h2>
        ${alerts.map(a => `<div style="padding:10px;margin:6px 0;background:${a.type==='target_hit'?'#eef6ee':'#fdf8ee'};border-left:3px solid ${a.type==='target_hit'?'#2d5a2d':'#b8943f'}">
          ${a.msg}</div>`).join('')}
      </div>`;
      await sendEmail(`⚡ Trade Alerts — ${alerts.map(a=>a.ticker).join(', ')}`, html);
    }

    // Save performance snapshot
    const { data: allTrades } = await db.from('model_trades').select('pnl,status,amount');
    const totPnl   = (allTrades||[]).filter(t=>t.pnl!=null).reduce((s,t)=>s+parseFloat(t.pnl),0);
    const invested = (allTrades||[]).filter(t=>t.status==='OPEN').reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const closed   = (allTrades||[]).filter(t=>t.status!=='OPEN'&&t.pnl!=null);
    const wins     = closed.filter(t=>parseFloat(t.pnl)>0);

    await db.from('performance').upsert({
      snap_date:         today,
      model_capital:     50000,
      model_invested:    invested,
      model_cash:        50000 - invested,
      model_value:       50000 + totPnl,
      model_pnl:         parseFloat(totPnl.toFixed(2)),
      model_pnl_pct:     parseFloat((totPnl/50000).toFixed(6)),
      model_trades_open: (allTrades||[]).filter(t=>t.status==='OPEN').length,
      model_win_rate:    closed.length ? parseFloat((wins.length/closed.length).toFixed(4)) : null
    }, { onConflict: 'snap_date' });

    console.log(`Prices saved: ${fetched}, failed: ${failed}, stops: ${stopped}, targets: ${targeted}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ prices_saved: fetched, prices_failed: failed, stops: stopped, targets: targeted })
    };

  } catch(err) {
    console.error('fetch-prices failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
