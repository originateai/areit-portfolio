import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

export function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

export const ALERT_EMAIL  = process.env.ALERT_EMAIL  || 'James.storey@outlook.com.au';
export const FROM_EMAIL   = process.env.FROM_EMAIL   || 'onboarding@resend.dev';
export const BOND_YIELD   = 0.0507;
export const VIX_TRIGGER  = parseFloat(process.env.VIX_TRIGGER  || '25');
export const YIELD_TARGET = parseFloat(process.env.YIELD_TRIGGER || '0.08');

export const REIT_HOLDINGS = [
  { ticker: 'HDN',    name: 'HomeCo Daily Needs',   nta: 1.42,  dps: 0.086, weight: 0.25 },
  { ticker: 'DXC',    name: 'Dexus Convenience',    nta: 3.79,  dps: 0.209, weight: 0.20 },
  { ticker: 'WPR',    name: 'Waypoint REIT',         nta: 2.92,  dps: 0.172, weight: 0.20 },
  { ticker: 'CQR',    name: 'Charter Hall Retail',   nta: 4.90,  dps: 0.255, weight: 0.15 },
  { ticker: 'RGN',    name: 'Region Group',          nta: 2.56,  dps: 0.141, weight: 0.10 },
  { ticker: 'GSBG37', name: 'Govt Bond 2037',        nta: 100.0, dps: 4.75,  weight: 0.10 },
];

export async function fetchYahoo(ticker, range = '5d') {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }
    });
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const closes  = result.indicators.quote[0].close.filter(Boolean);
    const volumes = result.indicators.quote[0].volume || [];
    if (closes.length < 2) return null;
    const price  = closes[closes.length - 1];
    const prev   = closes[closes.length - 2];
    const volume = volumes[volumes.length - 1] || 0;
    return {
      ticker,
      price:     parseFloat(price.toFixed(4)),
      prev:      parseFloat(prev.toFixed(4)),
      change:    (price - prev) / prev,
      changePct: parseFloat(((price - prev) / prev).toFixed(6)),
      volume,
      closes
    };
  } catch (err) {
    console.error(`Yahoo fetch error for ${ticker}:`, err.message);
    return null;
  }
}

export async function fetchFRED(seriesId) {
  try {
    const key = process.env.FRED_API_KEY;
    if (!key) return null;
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

export async function sendEmail(subject, html) {
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from:    `AREIT Portfolio <${FROM_EMAIL}>`,
    to:      [ALERT_EMAIL],
    subject,
    html
  });
  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message);
  }
  console.log('Email sent:', data?.id);
  return data;
}

export const emailStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f2ec; margin: 0; padding: 20px; }
  .wrap { max-width: 680px; margin: 0 auto; }
  .header { background: #0e1117; padding: 20px 24px; border-radius: 8px 8px 0 0; }
  .header h1 { color: #d4b06a; font-size: 20px; margin: 0 0 4px; }
  .header p { color: rgba(255,255,255,0.4); font-size: 11px; margin: 0; font-family: monospace; }
  .section { background: #fff; border: 1px solid #c8c2b4; border-top: none; padding: 16px 20px; }
  .section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #6b6660; margin: 0 0 10px; font-family: monospace; }
  .metric-row { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 4px; }
  .metric { min-width: 80px; }
  .metric .ml { font-size: 10px; color: #6b6660; margin-bottom: 2px; }
  .metric .mv { font-size: 18px; font-weight: 600; }
  .positive { color: #2d5a2d; }
  .negative { color: #8b2e2e; }
  .neutral  { color: #7a5500; }
  .teal     { color: #1a5f6e; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th { text-align: left; padding: 6px 8px; font-size: 10px; color: #6b6660; border-bottom: 1px solid #c8c2b4; font-weight: 400; font-family: monospace; text-transform: uppercase; }
  td { padding: 8px; border-bottom: 1px solid #ede9e0; }
  .mono { font-family: monospace; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 600; font-family: monospace; }
  .badge-buy   { background: #eef6ee; color: #2d5a2d; }
  .badge-watch { background: #fdf8ee; color: #7a5500; }
  .badge-hold  { background: #f0f0f0; color: #6b6660; }
  .footer { background: #ede9e0; border: 1px solid #c8c2b4; border-top: none; padding: 12px 20px; border-radius: 0 0 8px 8px; font-size: 10px; color: #6b6660; }
  .signal-bar { padding: 12px 16px; border-left: 4px solid #1a5f6e; background: #f5f2ec; margin-bottom: 12px; border-radius: 0 4px 4px 0; }
  .signal-bar.bearish { border-left-color: #8b2e2e; }
  .signal-bar.neutral { border-left-color: #b8943f; }
  .signal-title { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  .signal-sub { font-size: 11px; color: #6b6660; margin: 0; }
`;

export function pct(val, decimals = 2) {
  if (val === null || val === undefined) return '--';
  return (val > 0 ? '+' : '') + (val * 100).toFixed(decimals) + '%';
}

export function pctRaw(val, decimals = 2) {
  if (val === null || val === undefined) return '--';
  return (val * 100).toFixed(decimals) + '%';
}

export function bps(val) {
  if (val === null || val === undefined) return '--';
  return (val > 0 ? '+' : '') + Math.round(val * 10000) + 'bps';
}

export function dollar(val, decimals = 2) {
  if (val === null || val === undefined) return '--';
  return '$' + parseFloat(val).toFixed(decimals);
}

export function colorClass(val) {
  return val > 0 ? 'positive' : val < 0 ? 'negative' : 'neutral';
}
