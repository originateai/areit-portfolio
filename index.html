// netlify/functions/fetch-prices.js
// Scheduled: 4:00pm AEST (6:00am UTC) Mon–Fri
// 1. Fetches ASX closing prices for all watchlist + REIT stocks
// 2. Saves to prices table in Supabase
// 3. Marks all open paper trades to market
// 4. Closes trades that hit stop or target

import { getSupabase, fetchYahoo } from './_shared.js';

export const handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  console.log(`Fetch prices starting: ${today}`);

  try {
    // Get all tickers to fetch
    const [{ data: watchlist }, { data: holdings }] = await Promise.all([
      db.from('watchlist').select('ticker').eq('active', true),
      db.from('reit_holdings').select('ticker')
    ]);

    const tickers = [...new Set([
      ...(watchlist || []).map(w => w.ticker),
      ...(holdings  || []).map(h => h.ticker).filter(t => t !== 'GSBG37')
    ])];

    console.log(`Fetching ${tickers.length} tickers`);

    // Fetch all prices (with small delay to avoid rate limiting)
    const rows = [];
    for (const ticker of tickers) {
      const data = await fetchYahoo(ticker + '.AX', '2d');
      if (data?.price) {
        rows.push({
          ticker,
          price:       data.price,
          volume:      data.volume,
          change_pct:  data.changePct,
          market_date: today,
          fetched_at:  new Date().toISOString()
        });
      }
      // Small delay between requests
      await new Promise(r => setTimeout(r, 200));
    }

    // Save prices to Supabase
    if (rows.length > 0) {
      const { error } = await db.from('prices').insert(rows);
      if (error) console.error('Price insert error:', error.message);
    }
    console.log(`Saved ${rows.length} prices`);

    // Build price lookup map
    const priceMap = {};
    rows.forEach(r => { priceMap[r.ticker] = r.price; });

    // Mark open paper trades to market
    const { data: openTrades } = await db
      .from('play_trades')
      .select('*')
      .eq('status', 'OPEN')
      .eq('is_paper', true);

    let closed = 0, stopped = 0, targeted = 0;

    if (openTrades?.length) {
      for (const trade of openTrades) {
        const currentPrice = priceMap[trade.ticker];
        if (!currentPrice) continue;

        const pnl    = (currentPrice - trade.entry_price) * trade.units;
        const pnlPct = (currentPrice - trade.entry_price) / trade.entry_price;

        let status = 'CLOSED', exitPrice = currentPrice;

        if (currentPrice <= trade.stop_price) {
          status = 'STOPPED'; exitPrice = trade.stop_price; stopped++;
        } else if (currentPrice >= trade.target_price) {
          status = 'TARGETED'; exitPrice = trade.target_price; targeted++;
        } else {
          closed++;
        }

        await db.from('play_trades').update({
          status,
          exit_price: exitPrice,
          exit_date:  today,
          pnl:        parseFloat(pnl.toFixed(2)),
          pnl_pct:    parseFloat(pnlPct.toFixed(6))
        }).eq('id', trade.id);
      }
    }

    console.log(`Trades — closed: ${closed}, stopped: ${stopped}, targeted: ${targeted}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        prices_saved: rows.length,
        trades_closed: closed,
        trades_stopped: stopped,
        trades_targeted: targeted
      })
    };

  } catch (err) {
    console.error('fetch-prices failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
