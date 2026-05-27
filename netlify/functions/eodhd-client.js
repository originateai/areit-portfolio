// netlify/functions/eodhd-client.js
// EODHD API client — replaces Yahoo Finance
// Docs: https://eodhd.com/financial-apis/

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

// ── HELPERS ───────────────────────────────────────────────────────────────────

// ASX tickers need .AU suffix for EODHD
function asxTicker(ticker) {
  if (ticker.includes('.')) return ticker;
  return `${ticker}.AU`;
}

async function eodFetch(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set('api_token', KEY());
  url.searchParams.set('fmt', 'json');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  const res  = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`EODHD ${res.status}: ${err}`);
  }
  return res.json();
}

// ── END OF DAY PRICE ──────────────────────────────────────────────────────────
// Returns latest EOD price for a single stock
async function getEODPrice(ticker) {
  try {
    const data = await eodFetch(`real-time/${asxTicker(ticker)}`, {
      s: asxTicker(ticker)
    });
    if (!data || data.code === 'NA') return null;
    return {
      ticker,
      price:     parseFloat(data.close || data.previousClose || 0),
      open:      parseFloat(data.open  || 0),
      high:      parseFloat(data.high  || 0),
      low:       parseFloat(data.low   || 0),
      close:     parseFloat(data.close || data.previousClose || 0),
      volume:    parseInt(data.volume  || 0),
      change:    parseFloat(data.change || 0),
      changePct: parseFloat(data.change_p || 0) / 100,
      timestamp: data.timestamp
    };
  } catch(e) {
    console.error(`EODHD price error ${ticker}:`, e.message);
    return null;
  }
}

// ── BULK EOD PRICES ───────────────────────────────────────────────────────────
// Fetch multiple tickers at once — much more efficient
async function getBulkPrices(tickers) {
  const map = {};
  // Chunk into 50 tickers per request to avoid URL length limits
  const CHUNK = 50;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    try {
      const symbols = chunk.map(asxTicker).join(',');
      const data    = await eodFetch(`real-time/${asxTicker(chunk[0])}`, { s: symbols });
      const arr     = Array.isArray(data) ? data : [data];
      arr.forEach(d => {
        const ticker = d.code?.replace('.AU','');
        if (ticker) {
          map[ticker] = {
            ticker,
            price:     parseFloat(d.close || d.previousClose || 0),
            open:      parseFloat(d.open  || 0),
            high:      parseFloat(d.high  || 0),
            low:       parseFloat(d.low   || 0),
            close:     parseFloat(d.close || d.previousClose || 0),
            volume:    parseInt(d.volume  || 0),
            change:    parseFloat(d.change   || 0),
            changePct: parseFloat(d.change_p || 0) / 100,
            timestamp: d.timestamp
          };
        }
      });
    } catch(e) {
      console.error('EODHD bulk price error:', e.message);
    }
  }
  return map;
}

// ── HISTORICAL OHLCV ──────────────────────────────────────────────────────────
// Returns array of daily OHLCV for a stock
// from/to format: YYYY-MM-DD
async function getHistorical(ticker, from, to) {
  try {
    const data = await eodFetch(`eod/${asxTicker(ticker)}`, {
      from: from || '2023-01-01',
      to:   to   || new Date().toISOString().split('T')[0],
      period: 'd'
    });
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      date:      d.date,
      open:      parseFloat(d.open),
      high:      parseFloat(d.high),
      low:       parseFloat(d.low),
      close:     parseFloat(d.adjusted_close || d.close),
      volume:    parseInt(d.volume || 0),
      change:    0 // calculated below
    })).filter(d => d.close > 0);
  } catch(e) {
    console.error(`EODHD history error ${ticker}:`, e.message);
    return [];
  }
}

// ── INTRADAY PRICES ───────────────────────────────────────────────────────────
// interval: 1m, 5m, 1h
async function getIntraday(ticker, interval = '5m', from = null) {
  try {
    const params = { interval };
    if (from) params.from = from;
    const data = await eodFetch(`intraday/${asxTicker(ticker)}`, params);
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      timestamp: d.datetime || d.timestamp,
      open:   parseFloat(d.open),
      high:   parseFloat(d.high),
      low:    parseFloat(d.low),
      close:  parseFloat(d.close),
      volume: parseInt(d.volume || 0)
    }));
  } catch(e) {
    console.error(`EODHD intraday error ${ticker}:`, e.message);
    return [];
  }
}

// ── TECHNICAL INDICATORS ──────────────────────────────────────────────────────
// EODHD calculates indicators server-side — no need to compute ourselves
// indicator: rsi, macd, slope, ema, sma, wma, bbands, atr, cci, roc, stoch

async function getTechnicals(ticker, indicator, params = {}) {
  try {
    const data = await eodFetch(`technical/${asxTicker(ticker)}`, {
      function: indicator,
      period:   params.period || 14,
      ...params
    });
    if (!Array.isArray(data)) return [];
    return data;
  } catch(e) {
    console.error(`EODHD technical error ${ticker}/${indicator}:`, e.message);
    return [];
  }
}

// ── SCREENER ──────────────────────────────────────────────────────────────────
// Pre-screens stocks server-side — returns candidates matching criteria
// Saves us from fetching all 500 stocks individually
async function screenStocks(params = {}) {
  try {
    const defaultParams = {
      exchange:        'AU',
      country:         'AU',
      volume_more_than: 500000,  // minimum daily volume
      ...params
    };
    const data = await eodFetch('screener', defaultParams);
    return data?.data || [];
  } catch(e) {
    console.error('EODHD screener error:', e.message);
    return [];
  }
}

// ── FUNDAMENTALS ──────────────────────────────────────────────────────────────
// Returns company fundamentals — EPS, DPS, book value etc
async function getFundamentals(ticker) {
  try {
    const data = await eodFetch(`fundamentals/${asxTicker(ticker)}`);
    return data;
  } catch(e) {
    console.error(`EODHD fundamentals error ${ticker}:`, e.message);
    return null;
  }
}

// ── DIVIDENDS ─────────────────────────────────────────────────────────────────
// Returns dividend history for a stock
async function getDividends(ticker, from = null) {
  try {
    const params = {};
    if (from) params.from = from;
    const data = await eodFetch(`div/${asxTicker(ticker)}`, params);
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      date:           d.date,
      declarationDate: d.declarationDate,
      recordDate:     d.recordDate,
      paymentDate:    d.paymentDate,
      amount:         parseFloat(d.value || 0),
      unadjustedValue: parseFloat(d.unadjustedValue || d.value || 0),
      currency:       d.currency || 'AUD'
    }));
  } catch(e) {
    console.error(`EODHD dividends error ${ticker}:`, e.message);
    return [];
  }
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
async function searchTicker(query) {
  try {
    const data = await eodFetch('search', { q: query, exchange: 'AU' });
    return Array.isArray(data) ? data : [];
  } catch(e) {
    return [];
  }
}

// ── MARKET STATUS ─────────────────────────────────────────────────────────────
function isASXOpen() {
  const now   = new Date();
  const aest  = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }));
  const day   = aest.getDay(); // 0=Sun, 6=Sat
  const hour  = aest.getHours();
  const min   = aest.getMinutes();
  const time  = hour * 100 + min;
  if (day === 0 || day === 6) return false;
  return time >= 1000 && time < 1600;
}

module.exports = {
  getEODPrice,
  getBulkPrices,
  getHistorical,
  getIntraday,
  getTechnicals,
  screenStocks,
  getFundamentals,
  getDividends,
  searchTicker,
  isASXOpen,
  asxTicker
};
