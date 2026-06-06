// netlify/functions/price-snapshot.js
// Task C — daily live-price snapshot for the value layer.
// For every ticker with a current model (reit_models.is_current), fetch the latest
// close from EODHD (reusing the existing client) and upsert into reit_prices. The
// v_discount_to_fair_value view joins these prices to each model's blended value.
//
// Schedule: 17:30 AEST (07:30 UTC), Mon–Fri.
// Manual run: trigger from Netlify → Functions → price-snapshot ("Run"), or hit the
//   URL if you temporarily unwrap schedule() while testing.

const { schedule } = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');
const { getBulkPrices } = require('./eodhd-client.js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

const run = async () => {
  const db = getDB();
  // AEST trading day (Netlify runs UTC)
  const priceDate = new Date(Date.now() + 10 * 3600 * 1000).toISOString().split('T')[0];

  try {
    const { data: models, error: mErr } = await db.from('reit_models')
      .select('ticker').eq('is_current', true);
    if (mErr) throw new Error(`reit_models read: ${mErr.message}`);

    const tickers = [...new Set((models || []).map(m => m.ticker).filter(Boolean))];
    if (!tickers.length) {
      console.log('price-snapshot: no current models to price.');
      return { statusCode: 200, body: JSON.stringify({ priced: 0, message: 'no current models' }) };
    }

    const priceMap = await getBulkPrices(tickers); // { TICKER: { close, ... } }

    const rows = tickers.map(t => {
      const p = priceMap[t];
      const last = p ? (p.close || p.price) : null;
      return last ? { ticker: t, last_price: parseFloat(last), price_date: priceDate } : null;
    }).filter(Boolean);

    const missing = tickers.filter(t => !rows.find(r => r.ticker === t));
    if (missing.length) console.warn('price-snapshot: no price for', missing.join(', '));

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('reit_prices')
        .upsert(rows.slice(i, i + 100), { onConflict: 'ticker' });
      if (error) console.error('reit_prices upsert:', error.message);
    }

    const message = `price-snapshot: ${rows.length}/${tickers.length} priced for ${priceDate}`;
    console.log(message);
    return { statusCode: 200, body: JSON.stringify({ priced: rows.length, of: tickers.length, missing, priceDate }) };
  } catch (err) {
    console.error('price-snapshot failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports.handler = schedule('30 7 * * 1-5', run);
