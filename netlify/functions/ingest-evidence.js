// netlify/functions/ingest-evidence.js
// Task D — write market-evidence rows (CRE transactions / leasing / developments).
// Writes use the service role (the cre_* tables aren't anon-writable); the SPA reads
// the tables + benchmark views via anon. Accepts a single add-form row or a CSV batch.
//
// POST JSON: { table: 'cre_transactions'|'cre_leasing_deals'|'cre_developments', rows: [ {...}, ... ] }
// Rows are filtered to the known columns and coerced (numeric/date), so stray CSV
// headers can't break the insert.

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

// column -> type per table (text unless listed as num/date). Anything not here is dropped.
const SCHEMA = {
  cre_transactions: {
    text: ['asset_name','address','sector','sub_sector','state','metro','vendor','purchaser','reit_linked','source'],
    num:  ['sale_price_m','cap_rate','passing_income_m','wale_years','area_sqm','rate_psm'],
    date: ['sale_date'],
  },
  cre_leasing_deals: {
    text: ['property','reit_linked','tenant','sector','sub_sector','state','metro','review_type','source'],
    num:  ['area_sqm','face_rent_psm','effective_rent_psm','incentive_pct','term_years','review_pct'],
    date: ['deal_date'],
  },
  cre_developments: {
    text: ['project','reit_linked','location','state','sector','status','source'],
    num:  ['gla_sqm','cost_m','end_value_m','yield_on_cost','prelease_pct'],
    date: ['pc_date'],
  },
};

function cleanRow(spec, raw) {
  const out = {};
  const put = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = v; };
  spec.text.forEach(k => { if (raw[k] != null) put(k, String(raw[k]).trim()); });
  spec.num.forEach(k => { if (raw[k] != null && String(raw[k]).trim() !== '') { const n = parseFloat(String(raw[k]).replace(/[$,%\s]/g,'')); if (!isNaN(n)) out[k] = n; } });
  spec.date.forEach(k => { if (raw[k] != null && String(raw[k]).trim() !== '') out[k] = String(raw[k]).trim(); });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  try {
    const body = JSON.parse(event.body || '{}');
    const table = body.table;
    const spec = SCHEMA[table];
    if (!spec) return { statusCode: 400, body: JSON.stringify({ error: `unknown table '${table}'` }) };
    const incoming = Array.isArray(body.rows) ? body.rows : [];
    const rows = incoming.map(r => cleanRow(spec, r || {})).filter(r => Object.keys(r).length > 0);
    if (!rows.length) return { statusCode: 400, body: JSON.stringify({ error: 'no valid rows after cleaning' }) };

    const db = getDB();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from(table).insert(rows.slice(i, i + 200));
      if (error) throw new Error(`${table} insert: ${error.message}`);
      inserted += rows.slice(i, i + 200).length;
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, table, inserted, dropped: incoming.length - rows.length }) };
  } catch (err) {
    console.error('ingest-evidence failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
