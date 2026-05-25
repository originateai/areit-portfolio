// netlify/functions/fetch-prices.js
// Scheduled: 4:00pm AEST (6:00am UTC) Mon-Fri
// Fetches closing prices for all stocks
// Marks model trades to market — stops and targets

const { getSupabase, fetchYahoo, sendEmail } = require('./_shared.js');

exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetch prices starting: ${today}`);

  try {
    const { data: stocks } = await db.from('stocks').select('ticker,universe,is_reit').eq('active', true);
    if (!stocks?.length) return { statusCode: 200, body: 'No stocks' };

    const tickers = stocks.filter(s => s.ticker !== 'GSBG37').map(s => s.ticker);
    console.log(`Fetching ${tickers.length} tickers`);

    const rows = [];
    for (const ticker of tickers) {
      const data = await fetchYahoo(ticker + '.AX', '2d');
      if (data?.price) {
        rows.push({
          ticker,
          market_date: today,
          open:        data.open,
          high:        data.high,
          low:         data.low,
          close:       data.price,
          volume:      data.volume,
          change_pct:  data.changePct,
          fetched_at:  new Date().toISOString()
        });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (rows.length > 0) {
      await db.from('prices').upsert(rows, { onConflict: 'ticker,market_date' });
    }
    console.log(`Saved ${rows.length} prices`);

    // Price lookup
    const priceMap = {};
    rows.forEach(r => { priceMap[r.ticker] = r.close; });

    // Mark open model trades to market
    const { data: openTrades } = await db.from('model_trades').select('*').eq('status', 'OPEN');
    let closed = 0, stopped = 0, targeted = 0;
    const alerts = [];

    if (openTrades?.length) {
      for (const trade of openTrades) {
        const currentPrice = priceMap[trade.ticker];
        if (!currentPrice) continue;

        const pnl     = (currentPrice - trade.entry_price) * trade.units;
        const pnlPct  = (currentPrice - trade.entry_price) / trade.entry_price;
        const entry   = new Date(trade.created_at);
        const holdDays = Math.floor((new Date() - entry) / 86400000);

        let status = 'CLOSED', exitPrice = currentPrice;

        if (currentPrice <= trade.stop_price) {
          status = 'STOPPED'; exitPrice = trade.stop_price; stopped++;
          alerts.push({ alert_type: 'stop_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} STOP HIT — $${exitPrice.toFixed(3)} — P&L: ${pnl>=0?'+':''}$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct } });
        } else if (currentPrice >= trade.target_price) {
          status = 'TARGETED'; exitPrice = trade.target_price; targeted++;
          alerts.push({ alert_type: 'target_hit', ticker: trade.ticker, universe: trade.universe,
            message: `${trade.ticker} TARGET HIT 🎯 — $${exitPrice.toFixed(3)} — P&L: +$${pnl.toFixed(0)}`,
            data: { price: exitPrice, pnl, pnlPct } });
        } else {
          closed++;
        }

        await db.from('model_trades').update({
          status, exit_price: exitPrice, exit_date: today,
          pnl: parseFloat(pnl.toFixed(2)), pnl_pct: parseFloat(pnlPct.toFixed(6)),
          hold_days: holdDays
        }).eq('id', trade.id);
      }
    }

    // Update real portfolio current prices
    const { data: realHoldings } = await db.from('reit_income_holdings').select('*');
    if (realHoldings?.length) {
      for (const h of realHoldings) {
        const price = priceMap[h.ticker];
        if (!price) continue;
        const value = h.units_held * price;
        const upnl  = value - h.total_cost;
        const annualIncome = h.units_held * (h.dps_fy26 || 0);
        await db.from('reit_income_holdings').update({
          current_price: price,
          current_value: parseFloat(value.toFixed(2)),
          unrealised_pnl: parseFloat(upnl.toFixed(2)),
          annual_income: parseFloat(annualIncome.toFixed(2)),
          yield_on_market: h.dps_fy26 ? parseFloat((h.dps_fy26 / price).toFixed(6)) : null,
          updated_at: new Date().toISOString()
        }).eq('ticker', h.ticker);
      }
    }

    // Save stop/target alerts
    if (alerts.length > 0) {
      await db.from('alerts').insert(alerts.map(a => ({ ...a, sent: false })));
      // Send immediate email for stops/targets
      const alertHtml = alerts.map(a =>
        `<p style="font-family:sans-serif;margin:8px 0"><strong>${a.ticker}</strong> — ${a.message}</p>`
      ).join('');
      await sendEmail(`⚡ Trade Alert — ${alerts.map(a=>a.ticker).join(', ')}`,
        `<div style="font-family:sans-serif;padding:20px"><h2>Trade Alerts</h2>${alertHtml}<p style="color:#6b6660;font-size:11px">Log into CommSec to action any real positions.</p></div>`
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ prices_saved: rows.length, stopped, targeted, closed })
    };

  } catch (err) {
    console.error('fetch-prices failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
