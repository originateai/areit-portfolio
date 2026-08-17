// netlify/functions/sync-holdings.js
// Agent A — derives `holdings` from the `real_trades` ledger (SPEC.md §2.1).
//
// `real_trades` is the immutable trade log. `holdings` is the register, and for
// any ticker that has trades it is DERIVED, never hand-maintained. Positions
// with no trade record are entered manually and carry source='manual'; this
// function never writes to those rows.
//
// Aggregation, per ticker, trades applied in trade_date order:
//   BUY   units += u;  cost_base += u * price;  brokerage += b
//   SELL  cost_base -= cost_base * (u / units_before)   (average-cost method)
//         units     -= u
//   entry_date = earliest BUY trade_date
//   is_open    = units > 0
//   source     = 'trades'
//
// UNITS (SPEC §1.2): every money figure written here is DOLLARS.
//   `cost_base` is the TOTAL dollar cost of the position, not a per-unit cost.
//   SPEC §3.1 defines equity invested = cost_base + brokerage, which only works
//   if cost_base is a total.
//
// BROKERAGE: only BUY-side brokerage is accumulated. Sell brokerage is a
//   disposal cost that reduces proceeds; it is not part of "equity invested".
//   With no SELL rows in the ledger today the two definitions coincide.
//
// IDEMPOTENT: the target row is recomputed from the ledger each run and only
//   written when a field actually differs. Running twice changes nothing.
//
// Usage:
//   GET/POST /.netlify/functions/sync-holdings          -> apply
//   GET      /.netlify/functions/sync-holdings?dry=1    -> compute, write nothing

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

// SPEC §2.2 — the canonical asset_class enum. Classification is DATA, never a
// hardcoded ticker list in JS.
const ASSET_CLASSES = ['equity', 'reit', 'lic', 'lit', 'credit', 'bond_hybrid', 'property'];

// 'lic' and 'lit' are BOTH first-class values, not spellings of one thing.
// A LIC is a company: it pays franked dividends out of taxed profits. A LIT is a
// trust: flow-through, typically unfranked. That is the opposite franking
// treatment, so collapsing one into the other would hand the tax engine the
// wrong default profile (SPEC §4.3) the first time a LIC is held. An earlier
// revision aliased lic -> lit; the enum was widened instead. SPEC §2.2 updated
// to match.
const CLASS_ALIASES = {};

const EPS = 1e-9;

/**
 * Classify a holding from the `stocks` row alone. Returns null rather than a
 * guess — SPEC §9: placeholder is not a value, and asset_class drives both the
 * default tax profile (§4.3) and the valuation method (§5.2).
 *
 * Worked examples:
 *   classify({asset_class:'reit'})                    -> 'reit'
 *   classify({asset_class:'lic'})                     -> 'lic'  (NOT 'lit')
 *   classify({asset_class:null, is_reit:true})        -> 'reit'
 *   classify({asset_class:null, universe:'REIT'})     -> 'reit'
 *   classify({asset_class:null, universe:'ASX500'})   -> null   (no guess)
 *   classify(undefined)                               -> null   (no stocks row)
 */
function classify(stock) {
  if (!stock) return null;
  const raw = (stock.asset_class || '').toLowerCase().trim();
  const mapped = CLASS_ALIASES[raw] || raw;
  if (ASSET_CLASSES.includes(mapped)) return mapped;
  // Only one inference is safe from the columns available: anything the DB
  // already flags as a REIT is a REIT. Everything else stays null.
  if (stock.is_reit === true) return 'reit';
  if (stock.reit_subclass) return 'reit';
  if ((stock.universe || '').toUpperCase() === 'REIT') return 'reit';
  return null;
}

/**
 * Fold an array of trades for ONE ticker into a holding. Pure and deterministic.
 *
 * Worked example (CIP, the real ledger row):
 *   trades = [{direction:'BUY', units:2000, price:2.84, brokerage:19.95,
 *              trade_date:'2025-04-09'}]
 *   -> { units: 2000, cost_base: 5680, brokerage: 19.95,
 *        entry_date: '2025-04-09', is_open: true }
 *   equity invested (SPEC §3.1) = 5680 + 19.95 = 5699.95
 *
 * Worked example with a partial sale (average-cost method):
 *   BUY  1000 @ 2.00 (brokerage 20)  -> units 1000, cost 2000, brokerage 20
 *   BUY  1000 @ 3.00 (brokerage 20)  -> units 2000, cost 5000, brokerage 40
 *   SELL  500 @ 4.00 (brokerage 20)  -> cost 5000 - 5000*(500/2000) = 3750
 *                                       units 1500, brokerage stays 40
 *   -> { units: 1500, cost_base: 3750, brokerage: 40, is_open: true }
 */
function foldTrades(trades) {
  const ordered = trades.slice().sort((a, b) => {
    const d = String(a.trade_date).localeCompare(String(b.trade_date));
    return d !== 0 ? d : (a.id || 0) - (b.id || 0);
  });

  let units = 0;
  let costBase = 0;
  let brokerage = 0;
  let entryDate = null;
  let account = null;

  for (const t of ordered) {
    const u = Math.abs(parseFloat(t.units) || 0);
    const p = parseFloat(t.price) || 0;
    const b = parseFloat(t.brokerage) || 0;
    const dir = String(t.direction || '').toUpperCase();

    if (dir === 'SELL' || dir === 'S') {
      if (units > EPS) {
        const sold = Math.min(u, units);
        costBase -= costBase * (sold / units);
        units -= sold;
      }
      // sell brokerage is a disposal cost, not equity invested — not accumulated
    } else {
      units += u;
      costBase += u * p;
      brokerage += b;
      if (!entryDate) entryDate = t.trade_date;
    }
    if (!account && t.broker) account = t.broker;
  }

  if (units <= EPS) { units = 0; costBase = 0; }

  return {
    units: round(units, 6),
    cost_base: round(costBase, 2),
    brokerage: round(brokerage, 2),
    entry_date: entryDate || (ordered[0] ? ordered[0].trade_date : null),
    account,
    is_open: units > EPS,
  };
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function numEq(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(parseFloat(a) - parseFloat(b)) < 1e-6;
}

const run = async (event) => {
  const dry = /(^|[?&])dry=1/.test(event?.rawQuery || event?.rawUrl || '') ||
              (event?.queryStringParameters || {}).dry === '1';
  const db = getDB();

  try {
    const { data: trades, error: tErr } = await db
      .from('real_trades')
      .select('id,ticker,direction,units,price,brokerage,trade_date,broker')
      .limit(10000);
    if (tErr) throw new Error(`real_trades read: ${tErr.message}`);

    const byTicker = {};
    (trades || []).forEach(t => {
      const tk = String(t.ticker || '').toUpperCase().trim();
      if (!tk) return;
      (byTicker[tk] = byTicker[tk] || []).push(t);
    });
    const tickers = Object.keys(byTicker).sort();

    if (!tickers.length) {
      return json(200, { synced: 0, message: 'real_trades is empty — nothing to derive' });
    }

    // classification source (SPEC §2.2 — from data, not a ticker list)
    const { data: stocks, error: sErr } = await db
      .from('stocks')
      .select('ticker,asset_class,reit_subclass,is_reit,universe')
      .in('ticker', tickers);
    if (sErr) throw new Error(`stocks read: ${sErr.message}`);
    const stockMap = {};
    (stocks || []).forEach(s => { stockMap[String(s.ticker).toUpperCase()] = s; });

    const { data: existing, error: hErr } = await db
      .from('holdings')
      .select('id,ticker,asset_class,units,cost_base,adjusted_cost_base,brokerage,entry_date,account,source,is_open')
      .limit(10000);
    if (hErr) throw new Error(`holdings read: ${hErr.message}`);

    const derivedRows = {};
    const manualRows = {};
    (existing || []).forEach(h => {
      const tk = String(h.ticker || '').toUpperCase().trim();
      if (h.source === 'trades') derivedRows[tk] = h;
      else (manualRows[tk] = manualRows[tk] || []).push(h);
    });

    const inserted = [], updated = [], unchanged = [];
    const skippedManual = [], unclassified = [];

    for (const ticker of tickers) {
      // A manual row for the same ticker would double-count in the income
      // rollup. Skip the ticker entirely and report it — SPEC §1.5/§9: never
      // silently overwrite a hand-entered real-money record.
      if (manualRows[ticker]) { skippedManual.push(ticker); continue; }

      const agg = foldTrades(byTicker[ticker]);
      const prev = derivedRows[ticker];
      const inferred = classify(stockMap[ticker]);

      // Never downgrade a known classification to null: if a class was set by
      // hand (or by an earlier run when `stocks` was better populated), keep it.
      const assetClass = inferred || (prev ? prev.asset_class : null) || null;
      if (!assetClass) unclassified.push(ticker);

      const row = {
        ticker,
        asset_class: assetClass,
        units: agg.units,
        cost_base: agg.cost_base,
        brokerage: agg.brokerage,
        entry_date: agg.entry_date,
        account: agg.account,
        source: 'trades',
        is_open: agg.is_open,
      };

      if (!prev) {
        // Seed adjusted_cost_base on first write only. Agent B's tax engine
        // owns it thereafter (SPEC §4.2 — tax-deferred distributions reduce it).
        row.adjusted_cost_base = agg.cost_base;
        if (!dry) {
          const { error } = await db.from('holdings').insert(row);
          if (error) throw new Error(`holdings insert ${ticker}: ${error.message}`);
        }
        inserted.push({ ticker, ...row });
        continue;
      }

      const changed =
        !numEq(prev.units, row.units) ||
        !numEq(prev.cost_base, row.cost_base) ||
        !numEq(prev.brokerage, row.brokerage) ||
        String(prev.entry_date || '') !== String(row.entry_date || '') ||
        (prev.asset_class || null) !== (row.asset_class || null) ||
        (prev.account || null) !== (row.account || null) ||
        Boolean(prev.is_open) !== Boolean(row.is_open);

      if (!changed && prev.adjusted_cost_base != null) { unchanged.push(ticker); continue; }

      // adjusted_cost_base is only ever seeded, never recomputed here.
      const patch = { ...row };
      if (prev.adjusted_cost_base == null) patch.adjusted_cost_base = agg.cost_base;

      if (!dry) {
        const { error } = await db.from('holdings').update(patch).eq('id', prev.id);
        if (error) throw new Error(`holdings update ${ticker}: ${error.message}`);
      }
      updated.push({ ticker, ...patch });
    }

    const warnings = [];
    if (skippedManual.length) {
      warnings.push(`skipped (a source='manual' holding already exists for these tickers; ` +
        `delete the manual row or the ledger row to resolve): ${skippedManual.join(', ')}`);
    }
    if (unclassified.length) {
      warnings.push(`asset_class left NULL (no usable stocks row — set stocks.asset_class, ` +
        `or set holdings.asset_class by hand and this function will preserve it): ${unclassified.join(', ')}`);
    }

    const result = {
      ok: true,
      dry_run: dry,
      tickers_in_ledger: tickers.length,
      inserted: inserted.map(r => r.ticker),
      updated: updated.map(r => r.ticker),
      unchanged,
      skipped_manual: skippedManual,
      unclassified,
      warnings,
      rows: [...inserted, ...updated],
    };
    console.log('sync-holdings:', JSON.stringify({ ...result, rows: undefined }));
    return json(200, result);

  } catch (err) {
    console.error('sync-holdings failed:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = run;
exports.foldTrades = foldTrades;
exports.classify = classify;
exports.ASSET_CLASSES = ASSET_CLASSES;
