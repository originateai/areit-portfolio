// netlify/functions/fetch-fundamentals-background.js
// Pulls EODHD fundamentals (P/E, EPS, DPS, book value, shares, net debt) for the
// whole universe into the `fundamentals` table.
//
// Trigger once to populate:  /.netlify/functions/fetch-fundamentals-background
// (Background functions return 202 immediately and run up to ~15 min.)
// Fundamentals change slowly — a weekly refresh is plenty. Claude Code can add a
// schedule wrapper later, or invoke this URL on a cron.

const { getSupabase } = require('./_shared.js');
const { getFundamentals } = require('./eodhd-client.js');

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Net debt: prefer the balance-sheet field, else compute (total debt − cash).
function deriveNetDebt(data) {
  const bs = data?.Financials?.Balance_Sheet?.quarterly;
  if (!bs) return null;
  const latest = bs[Object.keys(bs)[0]];
  if (!latest) return null;
  if (latest.netDebt != null) return num(latest.netDebt);
  const debt = num(latest.shortLongTermDebtTotal) ?? num(latest.totalDebt) ?? 0;
  const cash = num(latest.cashAndShortTermInvestments) ?? num(latest.cash) ?? 0;
  return (debt || cash) ? debt - cash : null;
}

function extract(ticker, data) {
  const H = data?.Highlights || {};
  const V = data?.Valuation || {};
  const G = data?.General || {};
  const S = data?.SharesStats || {};
  return {
    ticker,
    name:               G.Name || null,
    sector:             G.Sector || null,
    industry:           G.Industry || null,
    market_cap:         num(H.MarketCapitalization),
    pe:                 num(H.PERatio),
    forward_pe:         num(V.ForwardPE),
    eps:                num(H.EarningsShare),
    dps:                num(H.DividendShare),
    dividend_yield:     num(H.DividendYield),
    book_value:         num(H.BookValue),
    price_book:         num(V.PriceBookMRQ),
    profit_margin:      num(H.ProfitMargin),
    roe:                num(H.ReturnOnEquityTTM),
    shares_outstanding: num(S.SharesOutstanding),
    net_debt:          deriveNetDebt(data),
    raw:               data,
    updated_at:        new Date().toISOString(),
  };
}

async function run() {
  const db = getSupabase();
  const { data: stocks, error } = await db.from('stocks').select('ticker').order('ticker');
  if (error) { console.error('load stocks failed:', error.message); return; }
  const tickers = (stocks || []).map(s => s.ticker);
  console.log(`Fundamentals: ${tickers.length} tickers to fetch`);

  const CONCURRENCY = 4;
  let ok = 0, fail = 0;
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map(async t => {
      const data = await getFundamentals(t);
      if (!data || !data.Highlights) { fail++; return null; }
      return extract(t, data);
    }));
    const valid = rows.filter(Boolean);
    if (valid.length) {
      const { error: upErr } = await db.from('fundamentals').upsert(valid, { onConflict: 'ticker' });
      if (upErr) { console.error('upsert error:', upErr.message); fail += valid.length; }
      else ok += valid.length;
    }
    if (i % 40 === 0) console.log(`…${i + batch.length}/${tickers.length} (ok ${ok}, fail ${fail})`);
  }
  console.log(`Fundamentals done: ${ok} stored, ${fail} skipped/failed`);
}

exports.handler = async () => {
  try { await run(); return { statusCode: 200, body: 'fundamentals ingestion complete' }; }
  catch (e) { console.error('fundamentals run error:', e.message); return { statusCode: 500, body: e.message }; }
};
