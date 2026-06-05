// netlify/functions/fetch-index-prices-background.js
// Pulls Australian index EOD history from EODHD into index_prices for the dashboard.
//   /.netlify/functions/fetch-index-prices-background
// EODHD's index codes vary, so each index tries several candidate symbols and uses
// the first that returns data. ASX 200 included as a reliable fallback.

const { getSupabase } = require('./_shared.js');
const KEY = () => process.env.EODHD_API_KEY;

const INDICES = [
  { code: 'XAO', name: 'All Ordinaries', symbols: ['XAO.INDX', 'AORD.INDX', 'AS30.INDX'] },
  { code: 'XKO', name: 'ASX 300',        symbols: ['XKO.INDX', 'AXKO.INDX', 'AS52.INDX'] },
  { code: 'XJO', name: 'ASX 200',        symbols: ['XJO.INDX', 'AXJO.INDX', 'AS51.INDX'] },
];

async function fetchAny(symbols, from) {
  for (const s of symbols) {
    try {
      const url = `https://eodhd.com/api/eod/${s}?api_token=${KEY()}&fmt=json&from=${from}&period=d`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d.length) return { symbol: s, data: d };
        console.log(`  ${s}: ok but empty`);
      } else {
        console.log(`  ${s}: HTTP ${r.status}`);
      }
    } catch (e) { console.log(`  ${s}: ${e.message}`); }
  }
  return null;
}

async function run() {
  const db = getSupabase();
  const from = new Date(Date.now() - 365 * 864e5).toISOString().split('T')[0];
  let total = 0;
  for (const idx of INDICES) {
    const hit = await fetchAny(idx.symbols, from);
    if (!hit) { console.error(`${idx.code} (${idx.name}): no working symbol — tried ${idx.symbols.join(', ')}`); continue; }
    const rows = hit.data.map(d => ({
      index_code: idx.code,
      market_date: d.date,
      open: parseFloat(d.open), high: parseFloat(d.high),
      low: parseFloat(d.low), close: parseFloat(d.adjusted_close ?? d.close),
    })).filter(r => !isNaN(r.close));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('index_prices').upsert(rows.slice(i, i + 500), { onConflict: 'index_code,market_date' });
      if (error) console.error(`${idx.code} upsert error:`, error.message);
    }
    total += rows.length;
    console.log(`${idx.code} (${idx.name}) via ${hit.symbol}: ${rows.length} rows`);
  }
  console.log(`Index prices done: ${total} rows`);
}

exports.handler = async () => {
  try { await run(); return { statusCode: 200, body: 'index prices ingestion complete' }; }
  catch (e) { console.error('index run error:', e.message); return { statusCode: 500, body: e.message }; }
};
