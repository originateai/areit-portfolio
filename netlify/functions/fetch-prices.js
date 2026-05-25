// netlify/functions/fetch-prices.js
// Scheduled: 4:00pm AEST (6:00am UTC) Mon-Fri
// Fetches EOD prices for ALL active stocks via EODHD bulk API
// Processes in batches of 50 — no rate limiting issues
// Marks model trades to market, updates REIT holdings

const { getSupabase, sendEmail }  = require('./_shared.js');
const { getBulkPrices }           = require('./eodhd-client.js');

exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetch prices (EODHD) starting: ${today}`);

  try {
    // Get all active stocks
    const { data: stocks } = await db
      .from('stocks')
      .select('ticker, universe, is_reit')
      .eq('active', true)
      .neq('ticker', 'GSBG37');

    if (!stocks?.length) return { statusCode: 200, body: 'No stocks' };

    const tickers = stocks.map(s => s.ticker);
    console.log(`Fetching prices for ${tickers.length} stocks via EODHD`);

    // Process in batches of 50
    const batchSize = 50;
    const rows      = [];
    let fetched = 0, failed = 0;

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch     = tickers.slice(i, i + batchSize);
      const priceMap  = await getBulkPrices(batch);

      batch.forEach(ticker => {
        const p = priceMap[ticker];
        if (p && p.close > 0) {
          rows.push({
            ticker,
            market_date: today,
            open:        p.open  || p.close,
            high:        p.high  || p.close,
            low:         p.low   || p.close,
            close:       p.close,
            volume:      p.volume || 0,
            change_pct:  p.changePct || 0,
            fetched_at:  new Date().toISOString()
          });
          fetched++;
        } else {
          failed++;
        }
      });

      // Small delay between batches
      if (i + batchSize < tickers.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Upsert all prices
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('prices')
        .upsert(rows.slice(i, i + 100), { onConflict: 'ticker,market_date' });
      if (error) console.error('Price upsert error:', error.message);
    }

    console.log(`Prices saved: ${fetched}, failed: ${failed}`);

    // Build lookup map
    const priceMap = {};
    rows.forEach(r => { priceMap[r.ticker] = r; });

    // Mark open model trades to market
    const { data: openTrades } = await db
      .from('model_trades')
      .select('*')
      .eq('status', 'OPEN');

    let closed = 0, stopped = 0, targeted = 0;
    const tradeAlerts = [];

    if (openTrades?.length) {
      for (const trade of openTrades) {
        const pd = priceMap[trade.ticker];
        if (!pd) continue;

        const cur      = pd.close;
        const pnl      = (cur - trade.entry_price) * trade.units;
        const pnlPct   = (cur - trade.entry_price) / trade.entry_price;
        const holdDays = Math.floor((new Date() - new Date(trade.created_at)) / 86400000);

        let status = 'CLOSED', exitPrice = cur;

        if (cur <= trade.stop_price) {
          status = 'STOPPED'; exitPrice = trade.stop_price; stopped++;
          tradeAlerts.push({
            alert_type: 'stop_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} STOP HIT — $${exitPrice.toFixed(3)} — P&L: ${pnl>=0?'+':''}$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct }, sent: false
          });
        } else if (cur >= trade.target_price) {
          status = 'TARGETED'; exitPrice = trade.target_price; targeted++;
          tradeAlerts.push({
            alert_type: 'target_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} TARGET HIT 🎯 — $${exitPrice.toFixed(3)} — P&L: +$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct }, sent: false
          });
        } else {
          closed++;
        }

        await db.from('model_trades').update({
          status, exit_price: exitPrice, exit_date: today,
          pnl: parseFloat(pnl.toFixed(2)),
          pnl_pct: parseFloat(pnlPct.toFixed(6)),
          hold_days: holdDays
        }).eq('id', trade.id);
      }
    }

    // Update REIT income holdings
    const { data: reitHoldings } = await db
      .from('reit_income_holdings')
      .select('*')
      .gt('units_held', 0);

    if (reitHoldings?.length) {
      for (const h of reitHoldings) {
        const pd = priceMap[h.ticker];
        if (!pd) continue;
        const price = pd.close;
        const value = h.units_held * price;
        const upnl  = value - (h.total_cost || 0);
        await db.from('reit_income_holdings').update({
          current_price:   price,
          current_value:   parseFloat(value.toFixed(2)),
          unrealised_pnl:  parseFloat(upnl.toFixed(2)),
          yield_on_market: h.dps_fy26 ? parseFloat((h.dps_fy26/price).toFixed(6)) : null,
          annual_income:   h.dps_fy26 ? parseFloat((h.units_held*h.dps_fy26).toFixed(2)) : null,
          updated_at:      new Date().toISOString()
        }).eq('ticker', h.ticker);
      }
    }

    // Send stop/target alerts
    if (tradeAlerts.length > 0) {
      await db.from('alerts').insert(tradeAlerts);
      const html = `
        <div style="font-family:sans-serif;max-width:600px;padding:20px">
          <h2>⚡ Trade Alerts — ${today}</h2>
          ${tradeAlerts.map(a=>`
            <div style="padding:12px;margin:8px 0;background:${a.alert_type==='target_hit'?'#eef6ee':'#fdf8ee'};border-left:3px solid ${a.alert_type==='target_hit'?'#2d5a2d':'#7a5500'}">
              <strong>${a.ticker}</strong> — ${a.message}
            </div>`).join('')}
          <p style="font-size:11px;color:#6b6660">Log into CommSec to action any real positions.</p>
        </div>`;
      await sendEmail(`⚡ Trade Alerts — ${tradeAlerts.map(a=>a.ticker).join(', ')}`, html);
    }

    // Save performance snapshot
    const { data: allTrades } = await db.from('model_trades').select('pnl,status,amount');
    const totPnl   = (allTrades||[]).filter(t=>t.pnl!=null).reduce((s,t)=>s+parseFloat(t.pnl),0);
    const invested = (allTrades||[]).filter(t=>t.status==='OPEN').reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const closed2  = (allTrades||[]).filter(t=>t.status!=='OPEN'&&t.pnl!=null);
    const wins     = closed2.filter(t=>parseFloat(t.pnl)>0);

    await db.from('performance').upsert({
      snap_date:         today,
      model_capital:     50000,
      model_invested:    invested,
      model_cash:        50000 - invested,
      model_value:       50000 + totPnl,
      model_pnl:         parseFloat(totPnl.toFixed(2)),
      model_pnl_pct:     parseFloat((totPnl/50000).toFixed(6)),
      model_trades_open: (allTrades||[]).filter(t=>t.status==='OPEN').length,
      model_win_rate:    closed2.length ? parseFloat((wins.length/closed2.length).toFixed(4)) : null
    }, { onConflict: 'snap_date' });

    return {
      statusCode: 200,
      body: JSON.stringify({
        prices_saved:    fetched,
        prices_failed:   failed,
        trades_stopped:  stopped,
        trades_targeted: targeted,
        trades_closed:   closed
      })
    };

  } catch(err) {
    console.error('fetch-prices failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
