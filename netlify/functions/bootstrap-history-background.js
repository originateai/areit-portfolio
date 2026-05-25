// netlify/functions/bootstrap-history-background.js
// ONE-TIME function — loads 2 years of historical price data via EODHD
// Trigger: https://areit.netlify.app/.netlify/functions/bootstrap-history
// Optional params: ?universe=REIT or ?ticker=BHP
// Takes 5-10 minutes for full universe (much faster than Yahoo Finance)

const { getSupabase }    = require('./_shared.js');
const { getHistorical }  = require('./eodhd-client.js');

exports.handler = async (event) => {
  const db     = getSupabase();
  const params = event.queryStringParameters || {};
  const filterUni = params.universe || null;
  const filterTkr = params.ticker   || null;

  // Default: 2 years of history
  const fromDate = params.from || new Date(Date.now() - 2*365*24*60*60*1000).toISOString().split('T')[0];
  const toDate   = params.to   || new Date().toISOString().split('T')[0];

  console.log(`Bootstrap (EODHD) starting — from: ${fromDate}, universe: ${filterUni||'ALL'}, ticker: ${filterTkr||'ALL'}`);

  try {
    let query = db.from('stocks').select('ticker,universe,is_reit,name').eq('active', true);
    if (filterUni) query = query.eq('universe', filterUni);
    if (filterTkr) query = query.eq('ticker', filterTkr);

    const { data: stocks } = await query;
    if (!stocks?.length) return { statusCode: 200, body: 'No stocks found' };

    console.log(`Loading history for ${stocks.length} stocks`);

    let loaded = 0, failed = 0, skipped = 0;

    for (const stock of stocks) {
      if (stock.ticker === 'GSBG37') { skipped++; continue; }

      try {
        const prices = await getHistorical(stock.ticker, fromDate, toDate);

        if (!prices?.length) {
          console.log(`No history for ${stock.ticker}`);
          failed++;
          continue;
        }

        // Calculate change_pct
        const rows = prices.map((p, i) => ({
          ticker:      stock.ticker,
          market_date: p.date,
          open:        p.open,
          high:        p.high,
          low:         p.low,
          close:       p.close,
          volume:      p.volume,
          change_pct:  i > 0 && prices[i-1].close > 0
            ? parseFloat(((p.close - prices[i-1].close) / prices[i-1].close).toFixed(6))
            : 0,
          fetched_at: new Date().toISOString()
        }));

        // Upsert in batches of 100
        for (let i = 0; i < rows.length; i += 100) {
          await db.from('prices').upsert(
            rows.slice(i, i + 100),
            { onConflict: 'ticker,market_date' }
          );
        }

        loaded++;
        if (loaded % 20 === 0) console.log(`Progress: ${loaded}/${stocks.length}`);

      } catch(e) {
        console.error(`Error loading ${stock.ticker}:`, e.message);
        failed++;
      }

      // Small delay between stocks
      await new Promise(r => setTimeout(r, 250));
    }

    const result = {
      total:   stocks.length,
      loaded,
      failed,
      skipped,
      from:    fromDate,
      to:      toDate,
      message: `Bootstrap complete — ${loaded} stocks loaded with ${fromDate} to ${toDate} history.`
    };

    console.log(result.message);
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch(err) {
    console.error('Bootstrap failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
