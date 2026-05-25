// netlify/functions/bootstrap-history.js
// ONE-TIME function — run manually to load 12 months of price history
// Trigger via: https://areit.netlify.app/.netlify/functions/bootstrap-history
//
// Uses IG Markets API for reliable historical OHLCV data
// Falls back to Yahoo Finance if IG fails for a stock
// Loads ~250 trading days for all active stocks
// Takes 30-45 minutes to complete — runs in background

const { getSupabase, fetchYahoo }    = require('./_shared.js');
const { getHistoricalPrices }        = require('./ig-client.js');

exports.handler = async (event) => {
  const db = getSupabase();

  // Allow filtering by universe via query param
  // e.g. ?universe=REIT or ?universe=ASX500 or ?ticker=BHP
  const params    = event.queryStringParameters || {};
  const filterUni = params.universe || null;
  const filterTkr = params.ticker   || null;

  console.log(`Bootstrap history starting — universe: ${filterUni || 'ALL'}, ticker: ${filterTkr || 'ALL'}`);

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
        // Try IG first
        let prices = null;

        if (process.env.IG_API_KEY && process.env.IG_USERNAME) {
          try {
            prices = await getHistoricalPrices(stock.ticker, 'DAY', 250);
          } catch (igErr) {
            console.log(`IG failed for ${stock.ticker}, falling back to Yahoo: ${igErr.message}`);
          }
        }

        // Fall back to Yahoo if IG failed or not configured
        if (!prices || prices.length === 0) {
          const yahooData = await fetchYahoo(stock.ticker + '.AX', '1y');
          if (yahooData?.closes?.length > 10) {
            const closes  = yahooData.closes;
            const opens   = yahooData.opens   || closes;
            const highs   = yahooData.highs   || closes;
            const lows    = yahooData.lows    || closes;
            const volumes = yahooData.volumes || closes.map(() => 0);

            prices = closes.map((c, i) => ({
              date:   new Date(Date.now() - (closes.length - i) * 86400000).toISOString().split('T')[0],
              open:   parseFloat((opens[i]   || c).toFixed(4)),
              high:   parseFloat((highs[i]   || c).toFixed(4)),
              low:    parseFloat((lows[i]    || c).toFixed(4)),
              close:  parseFloat(c.toFixed(4)),
              volume: parseInt(volumes[i] || 0)
            })).filter(p => p.close > 0);
          }
        }

        if (!prices || prices.length === 0) {
          console.log(`No data for ${stock.ticker}`);
          failed++;
          continue;
        }

        // Build rows for prices table
        const rows = prices.map(p => ({
          ticker:      stock.ticker,
          market_date: typeof p.date === 'string' ? p.date.split('T')[0] : p.date,
          open:        p.open,
          high:        p.high,
          low:         p.low,
          close:       p.close,
          volume:      p.volume,
          change_pct:  0, // calculate below
          fetched_at:  new Date().toISOString()
        }));

        // Calculate change_pct
        for (let i = 1; i < rows.length; i++) {
          const prev = rows[i-1].close;
          if (prev > 0) {
            rows[i].change_pct = parseFloat(((rows[i].close - prev) / prev).toFixed(6));
          }
        }

        // Upsert in batches of 50
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          await db.from('prices').upsert(batch, { onConflict: 'ticker,market_date' });
        }

        loaded++;
        if (loaded % 10 === 0) console.log(`Progress: ${loaded}/${stocks.length} loaded`);

      } catch (e) {
        console.error(`Error loading ${stock.ticker}:`, e.message);
        failed++;
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    const result = {
      total:   stocks.length,
      loaded,
      failed,
      skipped,
      message: `Bootstrap complete. ${loaded} stocks loaded with historical price data.`
    };

    console.log(result.message);

    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };

  } catch (err) {
    console.error('Bootstrap failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
