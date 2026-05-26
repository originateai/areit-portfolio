// netlify/functions/bulk-live-prices.js
// Returns live Yahoo Finance prices for all active tickers
// Yahoo v7/finance/quote supports batches of ~100 symbols
// ASX tickers formatted as BHP.AX, SBM.AX etc.

const { getSupabase } = require('./_shared.js');

const YH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
  'Accept': 'application/json'
};

async function fetchYahooBatch(tickers) {
  if (!tickers.length) return {};
  try {
    const symbols = tickers.map(t => `${t}.AX`).join(',');
    const url     = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap`;
    const res     = await fetch(url, { headers: YH_HEADERS });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const json    = await res.json();
    const quotes  = json?.quoteResponse?.result || [];
    const map     = {};
    quotes.forEach(q => {
      const ticker = q.symbol?.replace('.AX', '');
      if (!ticker) return;
      const price     = q.regularMarketPrice     || 0;
      const prev      = q.regularMarketPreviousClose || price;
      const change    = q.regularMarketChange    || (price - prev);
      const changePct = q.regularMarketChangePercent
        ? q.regularMarketChangePercent / 100
        : (prev > 0 ? change / prev : 0);
      map[ticker] = {
        price,
        open:       q.regularMarketOpen      || price,
        high:       q.regularMarketDayHigh   || price,
        low:        q.regularMarketDayLow    || price,
        close:      price,
        volume:     q.regularMarketVolume    || 0,
        change,
        changePct,
        high_52w:   q.fiftyTwoWeekHigh       || null,
        low_52w:    q.fiftyTwoWeekLow        || null,
        market_cap: q.marketCap              || null,
        timestamp:  q.regularMarketTime      || null,
      };
    });
    return map;
  } catch(e) {
    console.error('Yahoo batch error:', e.message);
    return {};
  }
}

exports.handler = async (event) => {
  const params   = event.queryStringParameters || {};
  const universe = params.universe || null;
  const manual   = params.tickers  ? params.tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean) : null;

  let tickers = manual;

  if (!tickers) {
    const db = getSupabase();
    let query = db.from('stocks').select('ticker').eq('active', true).neq('ticker','GSBG37');
    if (universe && universe !== 'ALL') query = query.eq('universe', universe);
    const { data } = await query;
    tickers = (data || []).map(s => s.ticker);
  }

  if (!tickers.length) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) };
  }

  // Fetch in batches of 100
  const result = {};
  for (let i = 0; i < tickers.length; i += 100) {
    const batch = tickers.slice(i, i + 100);
    const map   = await fetchYahooBatch(batch);
    Object.assign(result, map);
    if (i + 100 < tickers.length) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`Yahoo live prices: ${Object.keys(result).length}/${tickers.length} tickers`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60'
    },
    body: JSON.stringify(result)
  };
};
