// netlify/functions/get-model-url.js
// Task A — return a short-lived signed download URL for a stored model workbook.
// The `reit-models` bucket is PRIVATE; the SPA never holds the service key, so it
// asks this function for a signed URL (60-min expiry) when the user taps Download.
//
// Trigger:  GET /.netlify/functions/get-model-url?path=DXI/v1.xlsx
//      or:  GET /.netlify/functions/get-model-url?ticker=DXI&version=1

const { createClient } = require('@supabase/supabase-js');

function getDB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE
  );
}

const BUCKET = 'reit-models';
const EXPIRY = 60 * 60; // 60 minutes

exports.handler = async (event) => {
  try {
    const q = (event && event.queryStringParameters) || {};
    let path = q.path;
    if (!path && q.ticker && q.version) {
      path = `${q.ticker.toUpperCase()}/v${q.version}.xlsx`;
    }
    if (!path) {
      return { statusCode: 400, body: JSON.stringify({ error: 'provide ?path= or ?ticker=&version=' }) };
    }

    const db = getDB();
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, EXPIRY);
    if (error) throw new Error(error.message);

    return { statusCode: 200, body: JSON.stringify({ url: data.signedUrl, path, expires_in: EXPIRY }) };
  } catch (err) {
    console.error('get-model-url failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
