// netlify/functions/reconstruct-performance-background.js
// Background function. Rebuilds the `performance` table backwards from the first
// trade date using stored price history, so the cumulative-return chart has
// history before daily snapshotting was switched on.
//
//   REAL  series: net positions from real_trades valued at each day's close.
//   MODEL series: $50k base + realised P&L (trades exited by date)
//                 + open-position mark-to-market at each day's close.
//
// Trigger: POST /.netlify/functions/reconstruct-performance-background
// Optional: ?from=YYYY-MM-DD to bound the start.

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const MODEL_CAPITAL = 50000;

exports.handler = async (event) => {
  const db     = getDB();
  const params = (event && event.queryStringParameters) || {};

  try {
    const [{ data: realTrades }, { data: modelTrades }] = await Promise.all([
      db.from('real_trades').select('ticker,direction,units,total_cost,trade_date'),
      db.from('model_trades').select('ticker,units,entry_price,amount,exit_price,exit_date,pnl,trade_date,status')
    ]);

    const tickers = [...new Set([
      ...(realTrades||[]).map(t=>t.ticker),
      ...(modelTrades||[]).map(t=>t.ticker)
    ])];
    if (!tickers.length) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No trades to reconstruct from.', snapshots: 0 }) };
    }

    // Load price history for just the traded tickers.
    const priceByTicker = {};           // ticker -> { date -> close }
    const dateSet = new Set();
    for (let i=0; i<tickers.length; i+=50) {
      const batch = tickers.slice(i, i+50);
      const { data: rows } = await db.from('prices')
        .select('ticker,market_date,close').in('ticker', batch);
      (rows||[]).forEach(r => {
        (priceByTicker[r.ticker] = priceByTicker[r.ticker] || {})[r.market_date] = parseFloat(r.close);
        dateSet.add(r.market_date);
      });
    }

    const allDates = [...dateSet].sort();
    const firstTrade = [...(realTrades||[]), ...(modelTrades||[])]
      .map(t=>t.trade_date).filter(Boolean).sort()[0];
    const fromDate = params.from || firstTrade || allDates[0];
    const dates = allDates.filter(d => d >= fromDate);
    if (!dates.length) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No price history covering the trade dates.', snapshots: 0 }) };
    }

    // carry-forward last known close per ticker
    const lastClose = {};
    const snapshots = [];

    for (const date of dates) {
      tickers.forEach(tk => {
        const c = priceByTicker[tk]?.[date];
        if (c != null) lastClose[tk] = c;
      });

      // ── REAL ──
      const pos = {};
      (realTrades||[]).forEach(t => {
        if ((t.trade_date||'') > date) return;
        const p = pos[t.ticker] = pos[t.ticker] || { units:0, cost:0 };
        const sign = String(t.direction||'').toUpperCase()==='SELL' ? -1 : 1;
        p.units += sign*(parseInt(t.units)||0);
        p.cost  += sign*(parseFloat(t.total_cost)||0);
      });
      let realValue=0, realCost=0;
      Object.entries(pos).forEach(([tk,p]) => {
        if (p.units <= 0) return;
        const px = lastClose[tk];
        if (px) realValue += p.units*px;
        realCost += p.cost;
      });
      const realPnl    = realCost>0 ? realValue-realCost : 0;
      const realPnlPct = realCost>0 ? realPnl/realCost  : 0;

      // ── MODEL ──
      let realised=0, openMTM=0, openCount=0;
      (modelTrades||[]).forEach(t => {
        if ((t.trade_date||'') > date) return;
        const exited = t.exit_date && t.exit_date <= date;
        if (exited) {
          realised += parseFloat(t.pnl||0);
        } else {
          const px = lastClose[t.ticker];
          if (px && t.entry_price && t.units) { openMTM += (px - parseFloat(t.entry_price))*parseInt(t.units); openCount++; }
        }
      });
      const modelValue = MODEL_CAPITAL + realised + openMTM;
      const modelPnl   = realised + openMTM;

      snapshots.push({
        snap_date:    date,
        model_capital: MODEL_CAPITAL,
        model_value:   parseFloat(modelValue.toFixed(2)),
        model_pnl:     parseFloat(modelPnl.toFixed(2)),
        model_pnl_pct: parseFloat((modelPnl/MODEL_CAPITAL).toFixed(6)),
        model_trades_open: openCount,
        real_value:    parseFloat(realValue.toFixed(2)),
        real_pnl:      parseFloat(realPnl.toFixed(2)),
        real_pnl_pct:  parseFloat(realPnlPct.toFixed(6))
      });
    }

    for (let i=0; i<snapshots.length; i+=200) {
      const { error } = await db.from('performance')
        .upsert(snapshots.slice(i, i+200), { onConflict: 'snap_date' });
      if (error) console.error('perf upsert:', error.message);
    }

    const message = `Reconstructed ${snapshots.length} daily snapshots from ${dates[0]} to ${dates[dates.length-1]}.`;
    console.log(message);
    return { statusCode: 200, body: JSON.stringify({ message, snapshots: snapshots.length, from: dates[0], to: dates[dates.length-1] }) };

  } catch (err) {
    console.error('reconstruct-performance failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
