// netlify/functions/fetch-prices.js
// Scheduled: 4:00pm AEST (6:00am UTC) Mon-Fri
// Fetches closing price + volume for ALL active stocks
// Saves to prices table — used by morning scan for pre-screening
// Also marks open model trades to market

const { getSupabase, fetchYahoo, sendEmail } = require('./_shared.js');

exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetch prices starting: ${today}`);

  try {
    // Get all active stocks
    const { data: stocks } = await db
      .from('stocks')
      .select('ticker, universe, is_reit')
      .eq('active', true)
      .neq('ticker', 'GSBG37');

    if (!stocks?.length) return { statusCode: 200, body: 'No stocks' };

    console.log(`Fetching prices for ${stocks.length} stocks`);

    const rows = [];
    let fetched = 0, failed = 0;

    for (const stock of stocks) {
      try {
        const data = await fetchYahoo(stock.ticker + '.AX', '2d');
        if (data?.price) {
          rows.push({
            ticker:      stock.ticker,
            market_date: today,
            open:        data.open   || data.price,
            high:        data.high   || data.price,
            low:         data.low    || data.price,
            close:       data.price,
            volume:      data.volume || 0,
            change_pct:  data.changePct || 0,
            fetched_at:  new Date().toISOString()
          });
          fetched++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      // Rate limiting — 200ms between requests
      await new Promise(r => setTimeout(r, 200));
    }

    // Upsert prices in batches of 100
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await db.from('prices')
        .upsert(batch, { onConflict: 'ticker,market_date' });
      if (error) console.error('Price upsert error:', error.message);
    }

    console.log(`Prices saved: ${fetched}, failed: ${failed}`);

    // Build price lookup map
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

        const currentPrice = pd.close;
        const pnl     = (currentPrice - trade.entry_price) * trade.units;
        const pnlPct  = (currentPrice - trade.entry_price) / trade.entry_price;
        const entry   = new Date(trade.created_at);
        const holdDays = Math.floor((new Date() - entry) / 86400000);

        let status = 'CLOSED', exitPrice = currentPrice;

        if (currentPrice <= trade.stop_price) {
          status = 'STOPPED'; exitPrice = trade.stop_price; stopped++;
          tradeAlerts.push({
            alert_type: 'stop_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} STOP HIT — $${exitPrice.toFixed(3)} — P&L: ${pnl>=0?'+':''}$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct }
          });
        } else if (currentPrice >= trade.target_price) {
          status = 'TARGETED'; exitPrice = trade.target_price; targeted++;
          tradeAlerts.push({
            alert_type: 'target_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} TARGET HIT 🎯 — $${exitPrice.toFixed(3)} — P&L: +$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct }
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

    // Update REIT income holdings current prices
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
          current_price:  price,
          current_value:  parseFloat(value.toFixed(2)),
          unrealised_pnl: parseFloat(upnl.toFixed(2)),
          yield_on_market: h.dps_fy26 ? parseFloat((h.dps_fy26 / price).toFixed(6)) : null,
          annual_income:   h.dps_fy26 ? parseFloat((h.units_held * h.dps_fy26).toFixed(2)) : null,
          updated_at:     new Date().toISOString()
        }).eq('ticker', h.ticker);
      }
    }

    // Send stop/target alerts
    if (tradeAlerts.length > 0) {
      await db.from('alerts').insert(tradeAlerts.map(a => ({ ...a, sent: false })));
      const alertHtml = `
        <div style="font-family:sans-serif;max-width:600px;padding:20px">
          <h2 style="color:#0e1117">⚡ Trade Alerts — ${today}</h2>
          ${tradeAlerts.map(a => `
            <div style="padding:12px;margin:8px 0;background:${a.alert_type==='target_hit'?'#eef6ee':'#fdf8ee'};border-left:3px solid ${a.alert_type==='target_hit'?'#2d5a2d':'#7a5500'}">
              <strong>${a.ticker}</strong> — ${a.message}
            </div>`).join('')}
          <p style="font-size:11px;color:#6b6660;margin-top:16px">Log into CommSec if you have real positions to action.</p>
        </div>`;
      await sendEmail(`⚡ Trade Alerts — ${tradeAlerts.map(a=>a.ticker).join(', ')}`, alertHtml);
    }

    // Save daily performance snapshot
    const { data: allTrades } = await db.from('model_trades').select('pnl,status,amount');
    const totalPnl    = (allTrades||[]).filter(t=>t.pnl!=null).reduce((s,t)=>s+parseFloat(t.pnl),0);
    const invested    = (allTrades||[]).filter(t=>t.status==='OPEN').reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const closedTrades = (allTrades||[]).filter(t=>t.status!=='OPEN' && t.pnl!=null);
    const wins        = closedTrades.filter(t=>parseFloat(t.pnl)>0);

    await db.from('performance').upsert({
      snap_date:         today,
      model_capital:     50000,
      model_invested:    invested,
      model_cash:        50000 - invested,
      model_value:       50000 + totalPnl,
      model_pnl:         parseFloat(totalPnl.toFixed(2)),
      model_pnl_pct:     parseFloat((totalPnl/50000).toFixed(6)),
      model_trades_open: (allTrades||[]).filter(t=>t.status==='OPEN').length,
      model_win_rate:    closedTrades.length ? parseFloat((wins.length/closedTrades.length).toFixed(4)) : null
    }, { onConflict: 'snap_date' });

    return {
      statusCode: 200,
      body: JSON.stringify({
        prices_saved: fetched,
        prices_failed: failed,
        trades_stopped: stopped,
        trades_targeted: targeted,
        trades_closed: closed
      })
    };

  } catch (err) {
    console.error('fetch-prices failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
