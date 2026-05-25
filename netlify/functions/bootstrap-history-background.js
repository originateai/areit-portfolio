// netlify/functions/bootstrap-history-background.js
// Netlify Background Function — runs for up to 15 minutes
// Loads 2 years of EODHD historical price data for all active stocks
// Trigger via POST: https://areit.netlify.app/.netlify/functions/bootstrap-history-background

const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getHistorical(ticker, from, to) {
  try {
    const epic = `${ticker}.AU`;
    const url  = new URL(`${BASE}/eod/${epic}`);
    url.searchParams.set('api_token', KEY());
    url.searchParams.set('fmt',    'json');
    url.searchParams.set('from',   from);
    url.searchParams.set('to',     to);
    url.searchParams.set('period', 'd');

    const res  = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter(d => d.adjusted_close > 0 || d.close > 0)
      .map((d, i, arr) => {
        const close = parseFloat(d.adjusted_close || d.close);
        const prev  = i > 0 ? parseFloat(arr[i-1].adjusted_close || arr[i-1].close) : close;
        return {
          ticker,
          market_date: d.date,
          open:        parseFloat(d.open   || close),
          high:        parseFloat(d.high   || close),
          low:         parseFloat(d.low    || close),
          close,
          volume:      parseInt(d.volume   || 0),
          change_pct:  prev > 0 ? parseFloat(((close - prev) / prev).toFixed(6)) : 0,
          fetched_at:  new Date().toISOString()
        };
      });
  } catch(e) {
    console.error(`EODHD history error ${ticker}:`, e.message);
    return [];
  }
}

exports.handler = async (event) => {
  const db     = getDB();
  const params = event.queryStringParameters || {};
  const filterUni = params.universe || null;
  const filterTkr = params.ticker   || null;
  const fromDate  = params.from || new Date(Date.now() - 2*365*24*60*60*1000).toISOString().split('T')[0];
  const toDate    = params.to   || new Date().toISOString().split('T')[0];

  console.log(`Bootstrap starting — from:${fromDate} to:${toDate} universe:${filterUni||'ALL'} ticker:${filterTkr||'ALL'}`);

  try {
    // Load stock list
    let query = db.from('stocks').select('ticker,universe,name').eq('active', true);
    if (filterUni) query = query.eq('universe', filterUni);
    if (filterTkr) query = query.eq('ticker', filterTkr);
    const { data: stocks, error: stockErr } = await query;

    if (stockErr) throw new Error(`DB error: ${stockErr.message}`);
    if (!stocks?.length) return { statusCode: 200, body: JSON.stringify({ message: 'No stocks found' }) };

    const toProcess = stocks.filter(s => s.ticker !== 'GSBG37');
    console.log(`Processing ${toProcess.length} stocks`);

    let loaded = 0, failed = 0, skipped = 0;

    for (const stock of toProcess) {
      try {
        const rows = await getHistorical(stock.ticker, fromDate, toDate);

        if (!rows.length) {
          console.log(`No data: ${stock.ticker}`);
          failed++;
          continue;
        }

        // Upsert in batches of 100 rows
        for (let i = 0; i < rows.length; i += 100) {
          const { error } = await db
            .from('prices')
            .upsert(rows.slice(i, i + 100), { onConflict: 'ticker,market_date' });
          if (error) console.error(`Upsert error ${stock.ticker}:`, error.message);
        }

        loaded++;
        if (loaded % 10 === 0) {
          console.log(`Progress: ${loaded}/${toProcess.length} — last: ${stock.ticker} (${rows.length} days)`);
        }

      } catch(e) {
        console.error(`Failed ${stock.ticker}:`, e.message);
        failed++;
      }

      // 250ms between each stock — stays within EODHD rate limits
      await new Promise(r => setTimeout(r, 250));
    }

    const result = {
      total:    toProcess.length,
      loaded,
      failed,
      skipped,
      from:     fromDate,
      to:       toDate,
      message:  `Bootstrap complete — ${loaded}/${toProcess.length} stocks loaded with history from ${fromDate} to ${toDate}`
    };

    console.log(result.message);
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch(err) {
    console.error('Bootstrap failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
