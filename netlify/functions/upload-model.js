// netlify/functions/upload-model.js
// Task A — store a REIT model workbook so it downloads anywhere.
// POST JSON: { ticker, model_version, file_name, file_base64 }
//   (base64 chosen over multipart — no extra parser dependency in the bundle.)
// Uploads the .xlsx to the private Storage bucket `reit-models` at
//   {ticker}/v{version}.xlsx  (overwrites), then upserts a reit_model_files row.
// Server-side only — uses the service-role key, never shipped to the browser.
//
// Trigger:  POST /.netlify/functions/upload-model

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Reuse the env var the rest of the platform already uses
// (SUPABASE_SERVICE_KEY); fall back to SUPABASE_SERVICE_ROLE if that's what's set.
function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

const BUCKET = 'reit-models';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const ticker  = (body.ticker || '').toUpperCase().trim();
    const version = String(body.model_version || '').trim();
    const fileName = (body.file_name || `${ticker}_v${version}.xlsx`).trim();
    const b64 = body.file_base64 || '';
    if (!ticker || !version || !b64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'ticker, model_version and file_base64 are required' }) };
    }

    // base64 may arrive as a data URL ("data:...;base64,XXXX") — strip the prefix.
    const raw = b64.includes(',') ? b64.split(',').pop() : b64;
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'file_base64 decoded to 0 bytes' }) };
    }
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const storagePath = `${ticker}/v${version}.xlsx`;

    const db = getDB();
    const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: XLSX_MIME, upsert: true,
    });
    if (upErr) throw new Error(`storage upload: ${upErr.message}`);

    const { error: rowErr } = await db.from('reit_model_files').upsert({
      ticker, model_version: version, storage_path: storagePath,
      file_name: fileName, bytes: buffer.length, checksum,
    }, { onConflict: 'ticker,model_version' });
    if (rowErr) throw new Error(`reit_model_files upsert: ${rowErr.message}`);

    return { statusCode: 200, body: JSON.stringify({
      ok: true, ticker, model_version: version, storage_path: storagePath,
      bytes: buffer.length, checksum,
    })};
  } catch (err) {
    console.error('upload-model failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
