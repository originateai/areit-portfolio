// netlify/functions/save-assumptions.js
// Editable assumptions write-back for the value layer. The workbook remains the
// source of truth (re-running export-model.js overwrites these), so this is for
// quick what-if / between-results tweaks. Writes via service role; whitelists the
// headline assumption columns so nothing unexpected lands in the table.
//
// POST JSON: { ticker, model_version, fields: { cap_rate: 0.06, escalation: 0.03, ... } }

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

const NUM = ['base_noi_m','cap_rate','wacr_disclosed','escalation','reversion','occupancy',
  'wale_years','gearing_current','cost_of_debt','hedge_ratio','wadm_years','payout_ratio',
  'fee_rate_gav','req_return','erp','beta','base_pe','industrial_premium','exit_cap',
  'dcf_unlevered_rate','synergy_multiple','control_premium'];
const TEXT = ['first_maturity','rf_source'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  try {
    const body = JSON.parse(event.body || '{}');
    const ticker = (body.ticker || '').toUpperCase().trim();
    const model_version = parseInt(body.model_version, 10);
    const fields = body.fields || {};
    if (!ticker || !model_version) return { statusCode: 400, body: JSON.stringify({ error: 'ticker and model_version required' }) };

    const row = { ticker, model_version };
    NUM.forEach(k => { if (k in fields && String(fields[k]).trim() !== '') { const n = parseFloat(fields[k]); if (!isNaN(n)) row[k] = n; } });
    TEXT.forEach(k => { if (k in fields && String(fields[k]).trim() !== '') row[k] = String(fields[k]).trim(); });
    if (Object.keys(row).length <= 2) return { statusCode: 400, body: JSON.stringify({ error: 'no editable fields supplied' }) };

    const db = getDB();
    const { error } = await db.from('reit_model_assumptions').upsert(row, { onConflict: 'ticker,model_version' });
    if (error) throw new Error(error.message);

    return { statusCode: 200, body: JSON.stringify({ ok: true, ticker, model_version, saved: Object.keys(row).length - 2 }) };
  } catch (err) {
    console.error('save-assumptions failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
