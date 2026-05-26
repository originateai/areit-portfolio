// netlify/functions/bulk-live-prices.js
// Returns live EODHD delayed prices for all active tickers
// EODHD real-time endpoint returns last traded price in 'close' field during market hours

const { getSupabase } = require('./_shared.js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

async function fetchBatch(tickers) {
  if (!tickers.length) return {};
  try {
    const epic = tickers.map(t => `${t}.AU`);
    const url  = `${BASE}/real-time/${epic[0]}?s=${epic.join(',')}&api_token=${KEY()}&fmt=json`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`EODHD ${res.status}`);
    const json = await res.json();
    const data = Array.isArray(json) ? json : [json];
    const map  = {};
    data.forEach(d => {
      const ticker = d.code?.replace('.AU', '');
      if (!ticker) return;
      const close     = parseFloat(d.close     || 0);
      const prev      = parseFloat(d.previousClose || close);
      const change    = parseFloat(d.change    || (close - prev));
      const changePct = parseFloat(d.change_p  || 0) / 100;
      if (close === 0) return;
      map[ticker] = {
        price:      close,
        open:       parseFloat(d.open   || close),
        high:       parseFloat(d.high   || close),
        low:        parseFloat(d.low    || close),
        close,
        volume:     parseInt(d.volume   || 0),
        change,
        changePct,
        high_52w:   parseFloat(d.high_52w || 0) || null,
        low_52w:    parseFloat(d.low_52w  || 0) || null,
        market_cap: parseFloat(d.marketCapitalization || 0) || null,
        timestamp:  d.timestamp || null,
      };
    });
    return map;
  } catch(e) {
    console.error('Batch fetch error:', e.message);
    return {};
  }
}

exports.handler = async (event) => {
  const params   = event.queryStringParameters || {};
  const universe = params.universe || null;
  const manual   = params.tickers ? params.tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean) : null;

  let tickers = manual;

  if (!tickers) {
    const db = getSupabase();
    let query = db.from('stocks').select('ticker').eq('active', true).neq('ticker', 'GSBG37');
    if (universe && universe !== 'ALL') query = query.eq('universe', universe);
    const { data } = await query;
    tickers = (data || []).map(s => s.ticker);
  }

  if (!tickers.length) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) };
  }

  const result = {};
  for (let i = 0; i < tickers.length; i += 100) {
    const batch = tickers.slice(i, i + 100);
    const map   = await fetchBatch(batch);
    Object.assign(result, map);
    if (i + 100 < tickers.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`EODHD live prices: ${Object.keys(result).length}/${tickers.length} tickers`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60'
    },
    body: JSON.stringify(result)
  };
};
