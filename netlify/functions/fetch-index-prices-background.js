// netlify/functions/fetch-index-prices-background.js
// Pulls All Ords (XAO) and ASX 300 (XKO) EOD history from EODHD into index_prices,
// so the dashboard charts render. Trigger once to backfill, then refresh daily.
//   /.netlify/functions/fetch-index-prices-background
// Claude Code can add a daily schedule wrapper (after the 4pm price job).

const { getSupabase } = require('./_shared.js');

const KEY = () => process.env.EODHD_API_KEY;
const MAP = { XAO: 'XAO.INDX', XKO: 'XKO.INDX' };  // All Ords, ASX 300

async function fetchEOD(symbol, from) {
  const url = `https://eodhd.com/api/eod/${symbol}?api_token=${KEY()}&fmt=json&from=${from}&period=d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  return r.json();
}

async function run() {
  const db = getSupabase();
  const from = new Date(Date.now() - 365 * 864e5).toISOString().split('T')[0]; // ~1yr
  let total = 0;
  for (const [code, symbol] of Object.entries(MAP)) {
    try {
      const data = await fetchEOD(symbol, from);
      if (!Array.isArray(data) || !data.length) { console.error(`${code}: no data (${symbol})`); continue; }
      const rows = data.map(d => ({
        index_code: code,
        market_date: d.date,
        open:  parseFloat(d.open),
        high:  parseFloat(d.high),
        low:   parseFloat(d.low),
        close: parseFloat(d.adjusted_close ?? d.close),
      })).filter(r => !isNaN(r.close));
      // upsert in chunks
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('index_prices').upsert(rows.slice(i, i + 500), { onConflict: 'index_code,market_date' });
        if (error) console.error(`${code} upsert error:`, error.message);
      }
      total += rows.length;
      console.log(`${code} (${symbol}): ${rows.length} rows`);
    } catch (e) {
      console.error(`${code} error:`, e.message);
    }
  }
  console.log(`Index prices done: ${total} rows`);
}

exports.handler = async () => {
  try { await run(); return { statusCode: 200, body: 'index prices ingestion complete' }; }
  catch (e) { console.error('index run error:', e.message); return { statusCode: 500, body: e.message }; }
};
