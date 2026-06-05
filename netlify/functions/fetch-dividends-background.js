// netlify/functions/fetch-dividends-background.js
// Background function (runs up to 15 min). Pulls dividend/distribution history
// from EODHD for every held ticker and upserts it into `distributions`, with
// units-held reconstructed from real_trades as at each ex-date so total_received
// is accurate. Manual rows (source='manual') are never overwritten.
//
// Trigger:  POST /.netlify/functions/fetch-dividends-background
// Optional: ?ticker=HDN  to refresh a single name.
//
// Requires migration 20260605_03 (source column + unique(ticker,ex_date)).

const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// EODHD: /api/div/{TICKER}.AU → [{date, value, unadjustedValue, currency, paymentDate, ...}]
async function getDividends(ticker, from) {
  try {
    const url = new URL(`${BASE}/div/${ticker}.AU`);
    url.searchParams.set('api_token', KEY());
    url.searchParams.set('fmt', 'json');
    if (from) url.searchParams.set('from', from);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error(`EODHD div error ${ticker}:`, e.message);
    return [];
  }
}

// Units held as at a given date, reconstructed from real_trades.
// Falls back to a flat reit_income_holdings position (held since first_bought).
function unitsAsAt(ticker, dateStr, tradesByTicker, reitByTicker) {
  const trades = tradesByTicker[ticker];
  if (trades && trades.length) {
    let u = 0;
    for (const t of trades) {
      if ((t.trade_date || '') > dateStr) continue;           // not yet bought/sold by ex-date
      const dir = String(t.direction || '').toUpperCase();
      u += (dir === 'SELL' ? -1 : 1) * (parseInt(t.units) || 0);
    }
    return Math.max(0, u);
  }
  const h = reitByTicker[ticker];
  if (h && h.units_held > 0) {
    if (h.first_bought && dateStr < h.first_bought) return 0;  // held only from first_bought
    return parseFloat(h.units_held);
  }
  return 0;
}

exports.handler = async (event) => {
  const db        = getDB();
  const params    = (event && event.queryStringParameters) || {};
  const onlyTicker = params.ticker || null;

  try {
    // 1. Build the held-ticker set + acquisition dates.
    const { data: trades } = await db.from('real_trades')
      .select('ticker,direction,units,trade_date');
    const { data: reits }  = await db.from('reit_income_holdings')
      .select('ticker,units_held,first_bought').gt('units_held', 0);

    const tradesByTicker = {};
    (trades || []).forEach(t => { (tradesByTicker[t.ticker] = tradesByTicker[t.ticker] || []).push(t); });
    const reitByTicker = {};
    (reits || []).forEach(h => { reitByTicker[h.ticker] = h; });

    let tickers = [...new Set([...Object.keys(tradesByTicker), ...Object.keys(reitByTicker)])];
    if (onlyTicker) tickers = tickers.filter(t => t === onlyTicker);
    if (!tickers.length) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No held tickers to pull dividends for.', upserted: 0 }) };
    }

    // earliest acquisition per ticker → only count distributions from when we held it
    const firstHeld = {};
    tickers.forEach(t => {
      const dates = [];
      (tradesByTicker[t] || []).filter(x => String(x.direction||'').toUpperCase() !== 'SELL')
        .forEach(x => x.trade_date && dates.push(x.trade_date));
      if (reitByTicker[t]?.first_bought) dates.push(reitByTicker[t].first_bought);
      firstHeld[t] = dates.sort()[0] || '2000-01-01';
    });

    let upserted = 0, skippedManual = 0;

    for (const ticker of tickers) {
      const divs = await getDividends(ticker, firstHeld[ticker]);
      if (!divs.length) { await sleep(200); continue; }

      // protect any manually-entered rows for this ticker
      const { data: existing } = await db.from('distributions')
        .select('ex_date,source').eq('ticker', ticker);
      const manualExDates = new Set((existing || [])
        .filter(r => (r.source || 'manual') === 'manual').map(r => r.ex_date));

      const rows = [];
      for (const d of divs) {
        const exDate = d.date;
        if (!exDate || exDate < firstHeld[ticker]) continue;   // not held yet
        if (manualExDates.has(exDate)) { skippedManual++; continue; }
        const perUnit = parseFloat(d.unadjustedValue != null ? d.unadjustedValue : d.value);
        if (!(perUnit > 0)) continue;
        const units = unitsAsAt(ticker, exDate, tradesByTicker, reitByTicker);
        rows.push({
          ticker,
          ex_date:         exDate,
          pay_date:        d.paymentDate || null,
          amount_per_unit: parseFloat(perUnit.toFixed(4)),
          units_held:      units || null,
          total_received:  units ? parseFloat((perUnit * units).toFixed(2)) : null,
          currency:        d.currency || 'AUD',
          source:          'eodhd'
        });
      }

      for (let i = 0; i < rows.length; i += 100) {
        const { error } = await db.from('distributions')
          .upsert(rows.slice(i, i + 100), { onConflict: 'ticker,ex_date' });
        if (error) console.error(`Upsert div ${ticker}:`, error.message);
        else upserted += rows.slice(i, i + 100).length;
      }
      await sleep(250); // EODHD rate limit
    }

    const message = `Dividends pulled — ${upserted} distributions upserted across ${tickers.length} holdings (${skippedManual} manual rows preserved).`;
    console.log(message);
    return { statusCode: 200, body: JSON.stringify({ message, upserted, tickers: tickers.length, skippedManual }) };

  } catch (err) {
    console.error('fetch-dividends failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
