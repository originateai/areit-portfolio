// netlify/functions/_shared.js
// Shared utilities — updated with full OHLCV fetch and settings loader

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

const ALERT_EMAIL  = process.env.ALERT_EMAIL  || 'James.storey@outlook.com.au';
const FROM_EMAIL   = process.env.FROM_EMAIL   || 'alerts@getkredit.ai';
const BOND_YIELD   = 0.0507;
const VIX_TRIGGER  = parseFloat(process.env.VIX_TRIGGER   || '25');
const YIELD_TARGET = parseFloat(process.env.YIELD_TRIGGER  || '0.08');

async function loadSettings(db) {
  const { data } = await db.from('settings').select('key,value');
  const settings = {};
  (data || []).forEach(s => { settings[s.key] = s.value; });
  return settings;
}

async function fetchYahoo(ticker, range = '5d') {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)' }
    });
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const q       = result.indicators.quote[0];
    const closes  = (q.close  || []).filter(v => v != null);
    const opens   = (q.open   || []).filter(v => v != null);
    const highs   = (q.high   || []).filter(v => v != null);
    const lows    = (q.low    || []).filter(v => v != null);
    const volumes = (q.volume || []).filter(v => v != null);
    if (closes.length < 2) return null;
    const price = closes[closes.length - 1];
    const prev  = closes[closes.length - 2];
    return {
      ticker, price: parseFloat(price.toFixed(4)), prev: parseFloat(prev.toFixed(4)),
      open: opens[opens.length-1] || price, high: highs[highs.length-1] || price,
      low: lows[lows.length-1] || price, volume: volumes[volumes.length-1] || 0,
      change: (price-prev)/prev, changePct: parseFloat(((price-prev)/prev).toFixed(6)),
      closes, opens, highs, lows, volumes
    };
  } catch (err) {
    console.error(`Yahoo fetch error for ${ticker}:`, err.message);
    return null;
  }
}

async function fetchFRED(seriesId) {
  try {
    const key = process.env.FRED_API_KEY;
    if (!key || key === 'pending') return null;
    const url  = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&limit=5&sort_order=desc&file_type=json`;
    const res  = await fetch(url);
    const json = await res.json();
    const val  = parseFloat(json?.observations?.[0]?.value);
    return isNaN(val) ? null : val / 100;
  } catch (err) {
    console.error(`FRED fetch error for ${seriesId}:`, err.message);
    return null;
  }
}

async function sendEmail(subject, html) {
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: `ASX Trading Platform <${FROM_EMAIL}>`,
    to:   [ALERT_EMAIL],
    subject, html
  });
  if (error) { console.error('Resend error:', error); throw new Error(error.message); }
  console.log('Email sent:', data?.id);
  return data;
}

const emailStyles = `
  body { margin:0; padding:0; background:#f0f0f0; font-family:Arial,Helvetica,sans-serif; }
  .wrap { max-width:660px; margin:0 auto; background:#ffffff; }
  /* Header */
  .header { background:#1a3a5c; padding:28px 32px; text-align:center; }
  .header-logo { color:#ffffff; font-size:24px; font-weight:700; letter-spacing:2px; text-transform:uppercase; }
  .header-logo span { color:#7fb3d3; }
  .header-sub { color:#7fb3d3; font-size:11px; letter-spacing:1px; margin-top:4px; text-transform:uppercase; }
  .header-date { color:#7fb3d3; font-size:11px; margin-top:8px; letter-spacing:1px; }
  /* Section labels */
  .sec-label { background:#1a3a5c; color:#ffffff; font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:8px 24px; }
  .sec-label-amber { background:#b8943f; color:#ffffff; font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:8px 24px; }
  .sec-label-green { background:#2d5a2d; color:#ffffff; font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:8px 24px; }
  /* Body */
  .pad { padding:20px 28px; }
  .pad-sm { padding:12px 28px; }
  /* Tables */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#1a3a5c; color:#fff; padding:8px 10px; text-align:left; font-weight:600; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  th.r { text-align:right; }
  td { padding:8px 10px; border-bottom:1px solid #e8ecf0; color:#333; font-size:13px; }
  td.r { text-align:right; font-family:monospace; }
  td.tkr { font-weight:700; color:#1a3a5c; font-family:monospace; }
  tr:last-child td { border-bottom:none; }
  tr:nth-child(even) td { background:#f8fafc; }
  /* Macro bar */
  .macro-bar { padding:14px 20px; border-left:4px solid #1a3a5c; background:#f0f4f8; margin:0 28px 16px; }
  .macro-bar.risk-off { border-left-color:#8b2e2e; background:#fdf8f8; }
  .macro-bar.neutral { border-left-color:#b8943f; background:#fdf8ee; }
  .macro-title { font-size:13px; font-weight:700; color:#1a3a5c; margin:0 0 4px; }
  .macro-detail { font-size:12px; color:#555; margin:0; line-height:1.6; }
  /* Trade cards */
  .trade-card { border:1px solid #e0e6ed; border-left:3px solid #1a3a5c; margin:0 28px 10px; padding:14px; background:#fff; }
  .trade-card.breakout { border-left-color:#b8943f; }
  .trade-header { display:table; width:100%; }
  .trade-left { display:table-cell; vertical-align:top; }
  .trade-right { display:table-cell; vertical-align:top; text-align:right; width:120px; }
  .trade-ticker { font-size:16px; font-weight:700; color:#1a3a5c; font-family:monospace; }
  .trade-name { font-size:11px; color:#888; margin-top:2px; }
  .trade-price { font-size:16px; font-weight:700; color:#333; }
  .trade-conviction { font-size:10px; color:#1a3a5c; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin-top:2px; }
  .trade-signals { font-size:11px; color:#555; margin:8px 0; line-height:1.6; }
  .trade-levels { display:table; width:100%; margin-top:10px; border-top:1px solid #e8ecf0; padding-top:10px; }
  .trade-level { display:table-cell; text-align:center; }
  .level-label { font-size:9px; color:#888; text-transform:uppercase; letter-spacing:1px; margin-bottom:3px; }
  .level-value { font-size:13px; font-weight:700; font-family:monospace; }
  .level-stop { color:#8b2e2e; }
  .level-target { color:#2d5a2d; }
  .level-size { color:#1a3a5c; }
  .commsecc-instructions { background:#f0f4f8; border-left:3px solid #1a3a5c; padding:10px 12px; margin-top:10px; font-size:11px; color:#444; line-height:1.9; }
  .commsecc-instructions strong { color:#1a3a5c; }
  /* REIT cards */
  .reit-card { padding:10px; border-bottom:1px solid #e8ecf0; }
  .reit-card:last-child { border-bottom:none; }
  /* Headlines */
  .hl { font-size:12px; color:#333; padding:5px 0; border-bottom:1px solid #f0f0f0; line-height:1.5; }
  .hl:last-child { border-bottom:none; }
  .hl a { color:#1a3a5c; text-decoration:none; }
  .hl a:hover { text-decoration:underline; }
  /* Source attribution */
  .source { font-size:10px; color:#888; margin-top:6px; font-style:italic; }
  .source a { color:#888; text-decoration:none; }
  /* Commentary boxes */
  .comm-row { display:table; width:100%; }
  .comm-cell { display:table-cell; width:50%; vertical-align:top; padding:8px; box-sizing:border-box; }
  .comm-inner { background:#f0f4f8; border-left:3px solid #1a3a5c; padding:12px; }
  .comm-title { font-size:10px; font-weight:700; color:#1a3a5c; letter-spacing:1px; text-transform:uppercase; margin-bottom:6px; }
  .comm-text { font-size:12px; color:#444; line-height:1.6; margin:0; }
  /* CTA */
  .cta-wrap { background:#1a3a5c; padding:20px 28px; text-align:center; }
  .cta-btn { display:inline-block; background:#ffffff; color:#1a3a5c; text-decoration:none; font-weight:700; font-size:12px; padding:10px 22px; border-radius:3px; margin:4px; letter-spacing:0.5px; }
  /* Footer */
  .footer { background:#1a3a5c; padding:20px 28px; }
  .footer-text { color:#7fb3d3; font-size:11px; line-height:1.8; }
  .footer-text a { color:#7fb3d3; text-decoration:none; }
  .footer-divider { border:none; border-top:1px solid #2e5f8a; margin:14px 0; }
  .footer-disclaimer { color:#5a7a9a; font-size:10px; line-height:1.6; }
  /* Misc */
  .positive { color:#2d5a2d; font-weight:600; }
  .negative { color:#8b2e2e; font-weight:600; }
  .neutral  { color:#b8943f; font-weight:600; }
  .mono { font-family:monospace; }
  .badge { display:inline-block; padding:2px 7px; border-radius:2px; font-size:10px; font-weight:700; font-family:monospace; letter-spacing:0.5px; }
  .b-exc { background:#1a3a5c; color:#fff; }
  .b-str { background:#eef6ee; color:#2d5a2d; }
  .b-mod { background:#fdf8ee; color:#7a5500; }
  .score-bar { display:inline-flex; gap:3px; }
  .score-dot { width:18px; height:18px; border-radius:2px; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:white; }
  .s-on { background:#1a3a5c; } .s-off { background:#d0d8e0; }
`;

function pct(val, d=2)    { if (val==null) return '--'; return (val>0?'+':'')+(val*100).toFixed(d)+'%'; }
function pctRaw(val, d=2) { if (val==null) return '--'; return (val*100).toFixed(d)+'%'; }
function bps(val)         { if (val==null) return '--'; return (val>0?'+':'')+Math.round(val*10000)+'bps'; }
function dollar(val, d=2) { if (val==null) return '--'; return '$'+parseFloat(val).toFixed(d); }
function colorClass(val)  { return val>0?'positive':val<0?'negative':'neutral'; }
function scoreDots(score, max=6) {
  const dots = [];
  for (let i=0; i<max; i++) dots.push(`<div class="score-dot ${i<score?'score-on':'score-off'}">${i<score?'✓':''}</div>`);
  return `<div class="score-bar">${dots.join('')}</div>`;
}


module.exports = { getSupabase, getResend, ALERT_EMAIL, FROM_EMAIL, BOND_YIELD, VIX_TRIGGER, YIELD_TARGET, loadSettings, fetchYahoo, fetchFRED, sendEmail, emailStyles, pct, pctRaw, bps, dollar, colorClass, scoreDots };
