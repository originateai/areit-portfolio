export const handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify({
    SUPABASE_URL:  process.env.SUPABASE_URL      || '',
    SUPABASE_ANON: process.env.SUPABASE_ANON_KEY || ''
  })
});
