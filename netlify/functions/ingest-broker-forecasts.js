// netlify/functions/ingest-broker-forecasts.js
// Writes approved broker forecasts into reit_broker_forecasts. Uses the service role so it
// works without the user being signed in (the table is anon-readable but auth-write only).
// Upserts on (ticker, broker_name, note_date) — matching the table's unique constraint and
// the inline "Save to platform" path — so re-importing the same note updates in place.
//
// POST JSON: { rows: [ { ticker, broker_name, eps_fy26..30, valuation, target_return, note_date }, ... ] }
// Rows are filtered to known columns and coerced; stray fields are dropped. Each row is
// upserted individually so one bad ticker (e.g. not in stocks → FK error) can't sink the batch.

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

/* The whitelist IS the contract. Any column missing from these lists is dropped
 * without a word, which is how dpu_fy26..28, rating and price_at_note used to
 * disappear between the reader and the table — the import reported success and
 * the distribution forecasts, the reason for reading the note at all, were never
 * written. Add the column here whenever the table gains one. */
const TEXT = ['ticker', 'broker_name', 'rating'];
const NUM  = ['eps_fy26', 'eps_fy27', 'eps_fy28', 'eps_fy29', 'eps_fy30',
              'dpu_fy26', 'dpu_fy27', 'dpu_fy28',
              'price_at_note', 'valuation', 'target_return'];

function cleanRow(raw) {
  const out = {};
  TEXT.forEach(k => { if (raw[k] != null && String(raw[k]).trim() !== '') out[k] = String(raw[k]).trim(); });
  NUM.forEach(k => {
    if (raw[k] != null && String(raw[k]).trim() !== '') {
      const n = parseFloat(String(raw[k]).replace(/[$,%\s]/g, ''));
      if (!isNaN(n)) out[k] = n;
    }
  });
  if (out.ticker) out.ticker = out.ticker.toUpperCase().replace(/\.(AX|AU)$/i, '');
  if (out.rating) out.rating = out.rating.toUpperCase();
  // Link back to the filed PDF so a forecast on screen can be traced to the note.
  const docId = parseInt(raw.document_id, 10);
  if (!isNaN(docId)) out.document_id = docId;
  // note_date: use supplied (YYYY-MM-DD) or let the column default to current_date.
  if (raw.note_date != null && String(raw.note_date).trim() !== '') out.note_date = String(raw.note_date).trim();
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  try {
    const body = JSON.parse(event.body || '{}');
    const incoming = Array.isArray(body.rows) ? body.rows : [];
    const rows = incoming
      .map(cleanRow)
      .filter(r => r.ticker && r.broker_name); // ticker + broker are required (NOT NULL + conflict key)
    if (!rows.length) return { statusCode: 400, body: JSON.stringify({ error: 'no valid rows (each needs a ticker and broker_name)' }) };

    const db = getDB();
    let upserted = 0;
    const errors = [];
    for (const row of rows) {
      const { error } = await db
        .from('reit_broker_forecasts')
        .upsert(row, { onConflict: 'ticker,broker_name,note_date' });
      if (error) errors.push(`${row.broker_name}/${row.ticker}: ${error.message}`);
      else upserted++;
    }
    return { statusCode: 200, body: JSON.stringify({
      ok: true,
      upserted,
      dropped: incoming.length - rows.length,
      errors,
    })};
  } catch (err) {
    console.error('ingest-broker-forecasts failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
