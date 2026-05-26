// netlify/functions/live-price.js
// Returns live (15-min delayed) price for a single ASX stock
// Called from the stock detail page "↻ Live price" button

exports.handler = async (event) => {
  const ticker = event.queryStringParameters?.ticker?.toUpperCase()?.trim();
  if (!ticker) return { statusCode: 400, body: JSON.stringify({ error: 'ticker required' }) };

  try {
    const epic = `${ticker}.AU`;
    const url  = `https://eodhd.com/api/real-time/${epic}?api_token=${process.env.EODHD_API_KEY}&fmt=json`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data || data.code === 'NA') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
    }

    const price     = parseFloat(data.close || data.previousClose || 0);
    const prevClose = parseFloat(data.previousClose || price);
    const change    = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker,
        price:      parseFloat(price.toFixed(4)),
        open:       parseFloat(data.open    || price),
        high:       parseFloat(data.high    || price),
        low:        parseFloat(data.low     || price),
        volume:     parseInt(data.volume    || 0),
        change:     parseFloat(change.toFixed(4)),
        changePct:  parseFloat(changePct.toFixed(4)),
        high_52w:   parseFloat(data.high_52w || 0) || null,
        low_52w:    parseFloat(data.low_52w  || 0) || null,
        market_cap: parseFloat(data.marketCapitalization || 0) || null,
        timestamp:  data.timestamp
      })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
