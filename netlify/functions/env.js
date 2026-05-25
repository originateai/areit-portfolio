// netlify/functions/env.js
// Serves public Supabase credentials to the dashboard frontend
// Only exposes the anon key (safe to be public)
// Service key stays server-side only

exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify({
    SUPABASE_URL:  process.env.SUPABASE_URL       || '',
    SUPABASE_ANON: process.env.SUPABASE_ANON_KEY  || ''
  })
});
