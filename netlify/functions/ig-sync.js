// netlify/functions/ig-sync.js
// Syncs IG Markets account data to the platform
// - Fetches live prices for all active stocks
// - Syncs real positions to real_trades table
// - Updates REIT income holdings from IG share trading account
// Can be triggered manually or scheduled

const { getSupabase, sendEmail }   = require('./_shared.js');
const { getLivePrice, getPositions, getAccountInfo } = require('./ig-client.js');

exports.handler = async () => {
  const db    = getSupabase();
  const today = new Date().toISOString().split('T')[0];

  try {
    console.log('IG sync starting...');

    // 1. Test connection — get account info
    let accounts;
    try {
      accounts = await getAccountInfo();
      console.log(`IG connected. Accounts: ${accounts.length}`);
    } catch (e) {
      throw new Error(`IG authentication failed: ${e.message}. Check IG_API_KEY, IG_USERNAME, IG_PASSWORD in Netlify.`);
    }

    // 2. Get current open positions from IG
    let igPositions = [];
    try {
      igPositions = await getPositions();
      console.log(`Open positions in IG: ${igPositions.length}`);
    } catch (e) {
      console.error('Could not fetch IG positions:', e.message);
    }

    // 3. Fetch live prices for all active stocks from IG
    const { data: stocks } = await db
      .from('stocks')
      .select('ticker')
      .eq('active', true)
      .neq('ticker', 'GSBG37');

    const priceRows = [];
    let pricesFetched = 0;

    for (const stock of (stocks || [])) {
      const price = await getLivePrice(stock.ticker);
      if (price) {
        priceRows.push({
          ticker:      stock.ticker,
          market_date: today,
          open:        price.open  || price.price,
          high:        price.high  || price.price,
          low:         price.low   || price.price,
          close:       price.price,
          volume:      price.volume || 0,
          change_pct:  price.changePct || 0,
          fetched_at:  new Date().toISOString()
        });
        pricesFetched++;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // Upsert prices
    if (priceRows.length > 0) {
      for (let i = 0; i < priceRows.length; i += 100) {
        await db.from('prices').upsert(
          priceRows.slice(i, i + 100),
          { onConflict: 'ticker,market_date' }
        );
      }
    }
    console.log(`Live prices updated: ${pricesFetched}`);

    // 4. Sync IG positions to real_trades
    if (igPositions.length > 0) {
      for (const pos of igPositions) {
        const ticker = pos.market?.epic?.replace('.AU', '');
        if (!ticker) continue;

        const direction = pos.position?.direction;
        const size      = pos.position?.size;
        const level     = pos.position?.openLevel;
        const dealId    = pos.position?.dealId;

        // Check if we already have this deal recorded
        const { data: existing } = await db
          .from('real_trades')
          .select('id')
          .eq('ig_deal_id' in {} ? 'notes' : 'contract_note', dealId)
          .limit(1);

        if (!existing?.length) {
          // Record new position from IG
          await db.from('real_trades').insert({
            ticker,
            company_name: pos.market?.instrumentName,
            universe:     'ASX500',
            trade_date:   today,
            direction:    direction || 'BUY',
            units:        size,
            price:        level,
            total_cost:   size * level,
            contract_note: dealId,
            broker:       'IG Markets',
            notes:        `Synced from IG — Deal ID: ${dealId}`
          });
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        accounts:        accounts.length,
        prices_updated:  pricesFetched,
        ig_positions:    igPositions.length,
        message:         'IG sync complete'
      })
    };

  } catch (err) {
    console.error('IG sync failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
