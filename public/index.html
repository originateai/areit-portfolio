<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AREIT Portfolio</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --ink: #0e1117; --paper: #f5f2ec; --cream: #ede9e0;
  --rule: #c8c2b4; --gold: #b8943f; --gold-lt: #d4b06a;
  --teal: #1a5f6e; --red: #8b2e2e; --green: #2d5a2d;
  --amber: #7a5500; --muted: #6b6660; --purple: #5c3d8f;
}
body { font-family: 'DM Sans', sans-serif; background: var(--paper); color: var(--ink); margin: 0; }
.sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 190px; background: var(--ink); padding: 20px 14px; z-index: 100; overflow-y: auto; display: flex; flex-direction: column; }
.logo { font-family: 'Playfair Display', serif; font-size: 15px; color: var(--gold-lt); margin-bottom: 28px; line-height: 1.3; }
.logo span { font-size: 9px; color: rgba(255,255,255,0.3); display: block; font-family: 'DM Mono', monospace; letter-spacing: 0.1em; margin-top: 3px; text-transform: uppercase; }
.nav-sec { font-family: 'DM Mono', monospace; font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.2); margin: 14px 0 4px 8px; }
.nav a { display: block; padding: 7px 10px; color: rgba(255,255,255,0.45); text-decoration: none; font-size: 12px; border-radius: 3px; margin-bottom: 1px; transition: all 0.12s; cursor: pointer; }
.nav a:hover, .nav a.active { background: rgba(255,255,255,0.1); color: #fff; }
.nav a.active { color: var(--gold-lt); }
.sidebar-footer { margin-top: auto; padding-top: 16px; font-size: 10px; color: rgba(255,255,255,0.2); line-height: 1.8; font-family: 'DM Mono', monospace; }
.live { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2d5a2d; margin-right: 5px; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.main { margin-left: 190px; padding: 24px 28px 60px; }
.page { display: none; }
.page.active { display: block; }
.page-hdr { margin-bottom: 20px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
.page-hdr h1 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; }
.page-hdr p { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
.sl { font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin: 20px 0 10px; display: flex; align-items: center; gap: 10px; }
.sl::after { content: ''; flex: 1; height: 1px; background: var(--rule); }
.kband { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin-bottom: 20px; }
.kc { background: var(--paper); padding: 14px 15px; }
.kc.dk { background: var(--ink); }
.kl { font-family: 'DM Mono', monospace; font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.kc.dk .kl { color: rgba(255,255,255,0.35); }
.kv { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 600; line-height: 1; }
.kc.dk .kv { color: var(--gold-lt); }
.kv.teal  { color: var(--teal); }
.kv.gold  { color: var(--gold); }
.kv.red   { color: var(--red); }
.kv.green { color: var(--green); }
.kn { font-size: 10px; color: var(--muted); margin-top: 2px; }
.kc.dk .kn { color: rgba(255,255,255,0.28); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
thead tr { border-bottom: 2px solid var(--ink); }
th { font-family: 'DM Mono', monospace; font-size: 8.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); padding: 6px 8px; text-align: left; font-weight: 400; white-space: nowrap; }
th.r { text-align: right; }
tbody tr { border-bottom: 1px solid var(--rule); transition: background 0.1s; }
tbody tr:hover { background: var(--cream); }
td { padding: 10px 8px; vertical-align: middle; font-size: 12px; }
td.r { text-align: right; font-family: 'DM Mono', monospace; font-size: 11px; }
tfoot tr { border-top: 2px solid var(--ink); background: var(--cream); }
tfoot td { padding: 8px; font-family: 'DM Mono', monospace; font-size: 11px; font-weight: 600; }
tfoot td.r { text-align: right; }
.tkr { font-family: 'DM Mono', monospace; font-size: 11px; font-weight: 500; background: var(--cream); padding: 2px 6px; border-radius: 2px; }
.badge { font-family: 'DM Mono', monospace; font-size: 9px; padding: 2px 7px; border-radius: 2px; font-weight: 500; display: inline-block; white-space: nowrap; }
.b-buy   { background: #eef6ee; color: #2d5a2d; }
.b-watch { background: #fdf8ee; color: #7a5500; }
.b-hold  { background: var(--cream); color: var(--muted); }
.b-long  { background: #e6f1fb; color: #185fa5; }
.b-stop  { background: #fcebeb; color: #8b2e2e; }
.b-paper { background: #f5eafa; color: #5c3d8f; }
.empty { padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
.macro-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin-bottom: 14px; }
.mg { background: var(--paper); padding: 10px 12px; }
.mg-l { font-family: 'DM Mono', monospace; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin-bottom: 3px; }
.mg-v { font-family: 'Playfair Display', serif; font-size: 17px; font-weight: 600; }
.signal-box { border: 1px solid var(--rule); border-left: 4px solid var(--teal); padding: 14px 18px; margin-bottom: 14px; border-radius: 0 4px 4px 0; }
.signal-box.bearish { border-left-color: var(--red); }
.signal-box.neutral { border-left-color: var(--gold); }
.signal-title { font-family: 'Playfair Display', serif; font-size: 19px; font-weight: 600; }
.signal-sub { font-size: 11px; color: var(--muted); margin-top: 3px; }
.chart-wrap { height: 200px; margin-top: 12px; }
.info-box { padding: 12px 16px; background: var(--cream); border: 1px solid var(--rule); border-left: 3px solid var(--teal); font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.5; }
</style>
</head>
<body>

<div class="sidebar">
  <div class="logo">AREIT Portfolio<span>James Storey · ASX · Live</span></div>
  <nav class="nav">
    <div class="nav-sec">Portfolio</div>
    <a class="active" onclick="go('reit',this)">⬡ REIT Holdings</a>
    <a onclick="go('play',this)">◈ Play Portfolio</a>
    <a onclick="go('deploy',this)">⟳ Deployment</a>
    <div class="nav-sec">Signals</div>
    <a onclick="go('morning',this)">☀ Morning Scan</a>
    <a onclick="go('bond',this)">~ Bond Market</a>
    <a onclick="go('triggers',this)">⚡ Yield Triggers</a>
    <div class="nav-sec">Performance</div>
    <a onclick="go('pnl',this)">$ P&amp;L</a>
    <a onclick="go('alerts',this)">◎ Alert Log</a>
  </nav>
  <div class="sidebar-footer">
    <span class="live"></span>Live<br>
    Yahoo Finance · FRED<br>
    Supabase · Netlify Pro<br>
    Briefing: 8:00am AEST<br>
    Prices: 4:00pm AEST
  </div>
</div>

<div class="main">

  <!-- REIT HOLDINGS -->
  <div id="pg-reit" class="page active">
    <div class="page-hdr"><h1>REIT Income Portfolio</h1><p>Wife's account · Real shares · $12k/month · Target 8% yield · Zero tax under $18,200</p></div>
    <div class="kband">
      <div class="kc dk"><div class="kl">Blended Yield</div><div class="kv" id="r-yield">--</div><div class="kn">Weighted avg</div></div>
      <div class="kc"><div class="kl">$100k Income</div><div class="kv teal" id="r-income">--</div><div class="kn">Annual gross</div></div>
      <div class="kc"><div class="kl">Spread vs Bond</div><div class="kv teal" id="r-spread">--</div><div class="kn">Above 5.07% risk-free</div></div>
      <div class="kc"><div class="kl">Avg Disc NTA</div><div class="kv teal" id="r-disc">--</div><div class="kn">Buying below book</div></div>
      <div class="kc"><div class="kl">Signals Firing</div><div class="kv" id="r-sigs">--</div><div class="kn">At 8% threshold</div></div>
      <div class="kc"><div class="kl">Total Return Est.</div><div class="kv gold" id="r-ret">--</div><div class="kn">Income + 4% capital</div></div>
    </div>
    <div class="sl">Holdings</div>
    <table>
      <thead><tr>
        <th>Security</th><th class="r">Price</th><th class="r">NTA</th>
        <th class="r">Disc NTA</th><th class="r">DPS FY26</th><th class="r">Yield</th>
        <th class="r">vs Bond</th><th class="r">8% Target</th><th class="r">Gap</th>
        <th class="r">Status</th><th class="r">Weight</th>
      </tr></thead>
      <tbody id="reit-tbody"><tr><td colspan="11" class="empty">Loading prices...</td></tr></tbody>
      <tfoot><tr>
        <td colspan="5">Weighted Average</td>
        <td class="r" id="r-tot-y">--</td><td class="r" id="r-tot-s">--</td>
        <td class="r" colspan="3">--</td><td class="r">100%</td>
      </tr></tfoot>
    </table>
  </div>

  <!-- PLAY PORTFOLIO -->
  <div id="pg-play" class="page">
    <div class="page-hdr"><h1>Play Portfolio</h1><p>$10,000 · ASX200 · Long only · Real shares · Paper mode until validated</p></div>
    <div class="kband">
      <div class="kc dk"><div class="kl">Capital</div><div class="kv">$10,000</div></div>
      <div class="kc"><div class="kl">Open Trades</div><div class="kv teal" id="p-open">--</div></div>
      <div class="kc"><div class="kl">Today P&L</div><div class="kv" id="p-today">--</div></div>
      <div class="kc"><div class="kl">Total P&L</div><div class="kv" id="p-total">--</div></div>
      <div class="kc"><div class="kl">Win Rate</div><div class="kv gold" id="p-win">--</div></div>
      <div class="kc"><div class="kl">Mode</div><div class="kv" style="font-size:13px;color:var(--purple)">PAPER</div></div>
    </div>
    <div class="sl">Trade log</div>
    <table>
      <thead><tr>
        <th>Date</th><th>Ticker</th><th>Company</th><th class="r">Entry</th>
        <th class="r">Stop</th><th class="r">Target</th><th class="r">Exit</th>
        <th class="r">Size</th><th class="r">P&L</th><th class="r">%</th>
        <th>Status</th><th>Notes</th>
      </tr></thead>
      <tbody id="play-tbody"><tr><td colspan="12" class="empty">Morning scan runs at 8:00am AEST. First trades will appear here tomorrow.</td></tr></tbody>
    </table>
  </div>

  <!-- MORNING SCAN -->
  <div id="pg-morning" class="page">
    <div class="page-hdr"><h1>Morning Scan</h1><p>8:00am AEST Mon–Fri · US overnight + bonds + VIX + stock selection · Email to James.storey@outlook.com.au</p></div>
    <div id="morning-content"><div class="empty">Loading latest morning scan...</div></div>
  </div>

  <!-- BOND MARKET -->
  <div id="pg-bond" class="page">
    <div class="page-hdr"><h1>Bond Market</h1><p>US + AUS yield curves · FRED API · Real yields · Credit spreads</p></div>
    <div id="bond-content"><div class="empty">Loading bond data...</div></div>
  </div>

  <!-- TRIGGERS -->
  <div id="pg-triggers" class="page">
    <div class="page-hdr"><h1>Yield Triggers</h1><p>8% threshold · 20DMA filter · VIX deployment rule</p></div>
    <div id="triggers-content"><div class="empty">Loading...</div></div>
  </div>

  <!-- DEPLOYMENT -->
  <div id="pg-deploy" class="page">
    <div class="page-hdr"><h1>Monthly Deployment</h1><p>$12,000/month · Wife's account · School fees $60k target</p></div>
    <div id="deploy-content"><div class="empty">Loading...</div></div>
  </div>

  <!-- P&L -->
  <div id="pg-pnl" class="page">
    <div class="page-hdr"><h1>Performance</h1><p>Paper P&L · Win rate · Strategy validation before going live</p></div>
    <div id="pnl-content"><div class="empty">Loading...</div></div>
  </div>

  <!-- ALERTS -->
  <div id="pg-alerts" class="page">
    <div class="page-hdr"><h1>Alert Log</h1><p>All trigger alerts · Emails sent to James.storey@outlook.com.au</p></div>
    <div id="alerts-content"><div class="empty">Loading...</div></div>
  </div>

</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
// ── CONFIG ────────────────────────────────────────────────────────────────────
// These get replaced by Netlify with real values at deploy time
// via the _env.js function below
const BOND = 0.0507;
const FEES = 60000;
const MONTHLY = 12000;
let db = null;

const HOLDINGS = [
  { ticker:'HDN',    name:'HomeCo Daily Needs',  nta:1.42,  dps:0.086, weight:0.25 },
  { ticker:'DXC',    name:'Dexus Convenience',   nta:3.79,  dps:0.209, weight:0.20 },
  { ticker:'WPR',    name:'Waypoint REIT',        nta:2.92,  dps:0.172, weight:0.20 },
  { ticker:'CQR',    name:'Charter Hall Retail',  nta:4.90,  dps:0.255, weight:0.15 },
  { ticker:'RGN',    name:'Region Group',         nta:2.56,  dps:0.141, weight:0.10 },
  { ticker:'GSBG37', name:'Govt Bond 2037',       nta:100.0, dps:4.75,  weight:0.10 },
];

const FALLBACK = { HDN:1.26, DXC:2.87, WPR:2.41, CQR:3.79, RGN:2.24, GSBG37:92.0 };

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res  = await fetch('/.netlify/functions/env');
    const env  = await res.json();
    db = supabase.createClient(env.SUPABASE_URL, env.SUPABASE_ANON);
    loadREIT();
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('reit-tbody').innerHTML =
      '<tr><td colspan="11" class="empty">Could not connect to database. Check environment variables in Netlify.</td></tr>';
  }
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function go(page, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('pg-' + page).classList.add('active');
  el.classList.add('active');
  const fns = { reit:loadREIT, play:loadPlay, morning:loadMorning, bond:loadBond, triggers:loadTriggers, deploy:loadDeploy, pnl:loadPnL, alerts:loadAlerts };
  fns[page]?.();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const f = {
  pct:  (v, d=2) => v == null ? '--' : (v>0?'+':'') + (v*100).toFixed(d) + '%',
  pct0: (v, d=2) => v == null ? '--' : (v*100).toFixed(d) + '%',
  bps:  (v)      => v == null ? '--' : (v>0?'+':'') + Math.round(v*10000) + 'bps',
  $3:   (v)      => v == null ? '--' : '$' + parseFloat(v).toFixed(3),
  $0:   (v)      => v == null ? '--' : '$' + Math.round(v).toLocaleString(),
  raw2: (v)      => v == null ? '--' : parseFloat(v).toFixed(2),
  raw4: (v)      => v == null ? '--' : parseFloat(v).toFixed(4),
  clr:  (v, rev) => rev ? (v>0?'var(--red)':'var(--green)') : (v>0?'var(--green)':'var(--red)')
};

async function getPrices() {
  if (!db) return {};
  const tickers = HOLDINGS.filter(h=>h.ticker!=='GSBG37').map(h=>h.ticker);
  const { data } = await db.from('prices').select('ticker,price,change_pct,market_date')
    .in('ticker', tickers).order('market_date', { ascending:false });
  const map = {};
  (data||[]).forEach(r => { if (!map[r.ticker]) map[r.ticker] = r; });
  return map;
}

// ── REIT PAGE ─────────────────────────────────────────────────────────────────
async function loadREIT() {
  if (!db) return;
  const prices = await getPrices();
  const tbody  = document.getElementById('reit-tbody');
  tbody.innerHTML = '';
  let blendY = 0, blendD = 0, sigs = 0;

  HOLDINGS.forEach(h => {
    const row   = prices[h.ticker];
    const p     = row ? parseFloat(row.price) : FALLBACK[h.ticker];
    const chg   = row ? parseFloat(row.change_pct||0) : 0;
    const isGov = h.ticker === 'GSBG37';
    const y     = h.dps / p;
    const disc  = (p - h.nta) / h.nta;
    const spr   = y - BOND;
    const t8    = h.dps / 0.08;
    const gap   = (t8 - p) / p;
    const fired = y >= 0.08 && !isGov;
    const close = !fired && gap > -0.13 && !isGov;
    if (fired) sigs++;
    blendY += y * h.weight;
    blendD += disc * h.weight;

    const tr = document.createElement('tr');
    if (fired) tr.style.background = '#f0f8f0';
    tr.innerHTML = `
      <td><span class="tkr">${h.ticker}</span> <span style="font-size:11px;color:var(--muted)">${h.name}</span></td>
      <td class="r">$${p.toFixed(3)} <span style="font-size:9px;color:${chg>=0?'var(--green)':'var(--red)'}">${f.pct(chg)}</span></td>
      <td class="r">$${h.nta.toFixed(2)}</td>
      <td class="r" style="color:var(--teal)">${(disc*100).toFixed(1)}%</td>
      <td class="r">$${h.dps.toFixed(3)}</td>
      <td class="r" style="color:${y>=0.08?'var(--green)':y>=0.07?'var(--teal)':'var(--muted)'};font-weight:${y>=0.07?600:400}">${(y*100).toFixed(1)}%</td>
      <td class="r" style="color:${spr>0.015?'var(--green)':spr>0.008?'var(--amber)':'var(--red)'}">${f.bps(spr)}</td>
      <td class="r">${isGov?'--':f.$3(t8)}</td>
      <td class="r" style="color:${fired?'var(--green)':close?'var(--amber)':'var(--muted)'}">${isGov?'--':fired?'✓':(gap*100).toFixed(1)+'%'}</td>
      <td class="r"><span class="badge ${fired?'b-buy':close?'b-watch':'b-hold'}">${fired?'BUY':close?'CLOSE':'Watch'}</span></td>
      <td class="r">${(h.weight*100).toFixed(0)}%</td>
    `;
    tbody.appendChild(tr);
  });

  const spr = blendY - BOND;
  document.getElementById('r-yield').textContent  = (blendY*100).toFixed(1)+'%';
  document.getElementById('r-income').textContent = f.$0(blendY*100000);
  document.getElementById('r-spread').textContent = f.bps(spr);
  document.getElementById('r-disc').textContent   = (blendD*100).toFixed(1)+'%';
  document.getElementById('r-sigs').textContent   = sigs > 0 ? sigs+' FIRING' : '0';
  document.getElementById('r-sigs').style.color   = sigs > 0 ? 'var(--teal)' : 'inherit';
  document.getElementById('r-ret').textContent    = ((blendY+0.04)*100).toFixed(1)+'%';
  document.getElementById('r-tot-y').textContent  = (blendY*100).toFixed(1)+'%';
  document.getElementById('r-tot-s').textContent  = f.bps(spr);
}

// ── PLAY PORTFOLIO ────────────────────────────────────────────────────────────
async function loadPlay() {
  if (!db) return;
  const { data } = await db.from('play_trades').select('*').order('created_at',{ascending:false}).limit(50);
  const tbody = document.getElementById('play-tbody');
  tbody.innerHTML = '';
  if (!data?.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">No trades yet. Morning scan runs at 8:00am AEST.</td></tr>';
    return;
  }
  const closed  = data.filter(t=>t.pnl!==null);
  const wins    = closed.filter(t=>parseFloat(t.pnl)>0);
  const totPnl  = closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
  const today   = new Date().toISOString().split('T')[0];
  const todayPnl = data.filter(t=>t.trade_date===today&&t.pnl!==null).reduce((s,t)=>s+parseFloat(t.pnl||0),0);

  data.forEach(t => {
    const pnl    = t.pnl!==null ? parseFloat(t.pnl) : null;
    const pnlPct = t.pnl_pct!==null ? parseFloat(t.pnl_pct) : null;
    const sc     = {OPEN:'b-long',CLOSED:'b-hold',TARGETED:'b-buy',STOPPED:'b-stop',VETOED:'b-hold'}[t.status]||'b-hold';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:10px;color:var(--muted)">${t.trade_date}</td>
      <td><span class="tkr">${t.ticker}</span></td>
      <td style="font-size:11px;color:var(--muted)">${t.company_name||''}</td>
      <td class="r">$${parseFloat(t.entry_price||0).toFixed(3)}</td>
      <td class="r" style="color:var(--red)">$${parseFloat(t.stop_price||0).toFixed(3)}</td>
      <td class="r" style="color:var(--teal)">$${parseFloat(t.target_price||0).toFixed(3)}</td>
      <td class="r">${t.exit_price?'$'+parseFloat(t.exit_price).toFixed(3):'--'}</td>
      <td class="r">$${parseFloat(t.amount||0).toLocaleString()}</td>
      <td class="r" style="color:${pnl===null?'var(--muted)':pnl>=0?'var(--green)':'var(--red)'}">${pnl===null?'--':(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(0)}</td>
      <td class="r" style="color:${pnlPct===null?'var(--muted)':pnlPct>=0?'var(--green)':'var(--red)'}">${pnlPct===null?'--':(pnlPct>=0?'+':'')+(pnlPct*100).toFixed(1)+'%'}</td>
      <td><span class="badge ${sc}">${t.status}</span></td>
      <td style="font-size:10px;color:var(--muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.notes||''}</td>
    `;
    tbody.appendChild(tr);
  });

  const p = (id,val,isPos) => {
    const el = document.getElementById(id);
    el.textContent = val;
    if (isPos !== undefined) el.style.color = isPos ? 'var(--green)' : 'var(--red)';
  };
  p('p-open',    data.filter(t=>t.status==='OPEN').length);
  p('p-today',   (todayPnl>=0?'+':'')+'$'+Math.abs(todayPnl).toFixed(0), todayPnl>=0);
  p('p-total',   (totPnl>=0?'+':'')+'$'+Math.abs(totPnl).toFixed(0), totPnl>=0);
  p('p-win',     closed.length?Math.round(wins.length/closed.length*100)+'%':'--');
}

// ── MORNING SCAN ──────────────────────────────────────────────────────────────
async function loadMorning() {
  if (!db) return;
  const { data } = await db.from('morning_signals').select('*').order('signal_date',{ascending:false}).limit(1).single();
  const el = document.getElementById('morning-content');
  if (!data) { el.innerHTML = '<div class="empty">No morning scan data yet. First email arrives at 8:00am AEST tomorrow.</div>'; return; }

  const colors = { STRONG_LONG:'var(--green)', LONG:'var(--green)', MILD_LONG:'var(--teal)', NEUTRAL:'var(--amber)', MILD_SHORT:'var(--amber)', SHORT:'var(--red)', STRONG_SHORT:'var(--red)' };
  const isPos  = ['STRONG_LONG','LONG','MILD_LONG'].includes(data.signal);
  const col    = colors[data.signal] || 'var(--ink)';

  el.innerHTML = `
    <div class="signal-box ${isPos?'':data.signal==='NEUTRAL'?'neutral':'bearish'}">
      <div class="signal-title" style="color:${col}">${data.signal?.replace('_',' ')} &nbsp;<span style="font-size:14px;font-weight:400;color:var(--muted)">Score ${data.composite_score}/10</span></div>
      <div class="signal-sub">${data.signal_date} · ${data.summary||''}</div>
    </div>
    <div class="sl">US Overnight</div>
    <div class="macro-grid">
      ${mg('S&P 500',  data.sp500_change,  'pct')}
      ${mg('Nasdaq',   data.nasdaq_change, 'pct')}
      ${mg('VIX',      data.vix,           'raw2', data.vix<20?'var(--green)':data.vix<25?'var(--amber)':'var(--red)')}
      ${mg('AUD/USD',  data.aud_usd,       'raw4')}
      ${mg('AUD chg',  data.aud_change,    'pct')}
    </div>
    <div class="sl">Bond Market</div>
    <div class="macro-grid">
      ${mg('US 10yr',   data.us_10yr,      'pct0', 'var(--teal)')}
      ${mg('US 2yr',    data.us_2yr,       'pct0', 'var(--teal)')}
      ${mg('AUS 10yr',  data.aus_10yr,     'pct0', 'var(--teal)')}
      ${mg('Yield crv', data.yield_curve,  'bps')}
      ${mg('Real yld',  data.real_yield,   'pct0')}
      ${mg('Credit',    data.credit_spread,'bps')}
    </div>
    <div class="sl">Today's Trades</div>
    <div class="info-box">
      ${data.longs?.length ? '<strong>Longs:</strong> ' + data.longs.map(t=>`<span class="tkr">${t}</span>`).join(' ') : 'No trades today — signal too weak or no setups passing all filters.'}
    </div>
  `;
}

function mg(label, val, type, color) {
  let v = '--', col = color;
  if (val !== null && val !== undefined) {
    if (type==='pct')  { v=(val>0?'+':'')+(val*100).toFixed(2)+'%'; col=col||(val>=0?'var(--green)':'var(--red)'); }
    if (type==='pct0') { v=(val*100).toFixed(2)+'%'; col=col||'var(--ink)'; }
    if (type==='raw2') { v=parseFloat(val).toFixed(2); }
    if (type==='raw4') { v=parseFloat(val).toFixed(4); }
    if (type==='bps')  { v=(val>0?'+':'')+Math.round(val*10000)+'bps'; col=col||(val>0?'var(--green)':'var(--red)'); }
  }
  return `<div class="mg"><div class="mg-l">${label}</div><div class="mg-v" style="color:${col||'var(--ink)'}">${v}</div></div>`;
}

// ── BOND MARKET ───────────────────────────────────────────────────────────────
async function loadBond() {
  if (!db) return;
  const { data } = await db.from('bond_data').select('*').order('data_date',{ascending:false}).limit(1).single();
  const el = document.getElementById('bond-content');
  if (!data) { el.innerHTML = '<div class="info-box">Bond data loads from FRED API at 8:00am AEST daily. Will appear after first run.<br><br>Get your free FRED key at <strong>fred.stlouisfed.org/docs/api/api_key.html</strong></div>'; return; }
  const curve = data.yield_curve_us;
  el.innerHTML = `
    <div class="sl">US Treasury Yields</div>
    <div class="macro-grid">
      ${mg('2yr',   data.us_2yr,  'pct0','var(--teal)')} ${mg('5yr',data.us_5yr,'pct0','var(--teal)')}
      ${mg('10yr',  data.us_10yr, 'pct0','var(--teal)')} ${mg('30yr',data.us_30yr,'pct0','var(--teal)')}
      ${mg('Curve', data.yield_curve_us, 'bps')} ${mg('Real yield',data.real_yield,'pct0')}
      ${mg('Breakeven',data.breakeven_infl,'pct0')}
    </div>
    <div class="info-box">${curve>0.005?'📈 Curve steepening — growth signal. Bullish banks and resources.':curve<-0.002?'⚠️ Curve inverted — recession risk. Favour defensives.':'→ Flat — neutral. Trade on equity signal.'}</div>
    <div class="sl">Australian Yields</div>
    <div class="macro-grid">
      ${mg('AUS 2yr',data.aus_2yr,'pct0','var(--purple)')} ${mg('AUS 10yr',data.aus_10yr,'pct0','var(--purple)')}
      ${mg('AUS crv',data.yield_curve_aus,'bps')} ${mg('AUS/US',data.aus_10yr&&data.us_10yr?(data.aus_10yr-data.us_10yr):null,'bps')}
    </div>
    <div class="sl">Risk Indicators</div>
    <div class="macro-grid">
      ${mg('VIX',data.vix,'raw2',data.vix<20?'var(--green)':data.vix<25?'var(--amber)':'var(--red)')}
      ${mg('IG spread',data.ig_spread,'bps')} ${mg('HY spread',data.hy_spread,'bps')}
      ${mg('AUD/USD',data.aud_usd,'raw4')} ${mg('Gold',data.gold_price?'$'+parseFloat(data.gold_price).toFixed(0):null,'raw2')}
      ${mg('Iron ore',data.iron_ore_price?'$'+parseFloat(data.iron_ore_price).toFixed(0):null,'raw2')}
    </div>
    <p style="font-size:10px;color:var(--muted)">Source: FRED API (Federal Reserve) · Updated 8:00am AEST · ${data.data_date}</p>
  `;
}

// ── YIELD TRIGGERS ────────────────────────────────────────────────────────────
async function loadTriggers() {
  if (!db) return;
  const prices = await getPrices();
  const el     = document.getElementById('triggers-content');

  const rows = HOLDINGS.filter(h=>h.ticker!=='GSBG37').map(h => {
    const p = prices[h.ticker] ? parseFloat(prices[h.ticker].price) : FALLBACK[h.ticker];
    const y = h.dps / p;
    const t = h.dps / 0.08;
    const g = (t - p) / p;
    return { ...h, p, y, t, g, fired:y>=0.08, close:y<0.08&&g>-0.13 };
  }).sort((a,b)=>b.y-a.y);

  el.innerHTML = `
    <div class="sl">Rule 1 — 8% yield trigger</div>
    <table>
      <thead><tr>
        <th>Ticker</th><th class="r">Today's Price</th><th class="r">DPS FY26</th>
        <th class="r">Live Yield</th><th class="r">Buy at 8%</th>
        <th class="r">Gap</th><th class="r">Status</th>
      </tr></thead>
      <tbody>${rows.map(r=>`
        <tr style="background:${r.fired?'#f0f8f0':r.close?'#fffbf0':''}">
          <td><span class="tkr">${r.ticker}</span> <span style="font-size:11px;color:var(--muted)">${r.name}</span></td>
          <td class="r">$${r.p.toFixed(3)}</td>
          <td class="r">$${r.dps.toFixed(3)}</td>
          <td class="r" style="color:${r.y>=0.08?'var(--green)':r.y>=0.07?'var(--teal)':'var(--muted)'};font-weight:${r.y>=0.07?600:400}">${(r.y*100).toFixed(1)}%</td>
          <td class="r">$${r.t.toFixed(3)}</td>
          <td class="r" style="color:${r.fired?'var(--green)':r.close?'var(--amber)':'var(--muted)'}">${r.fired?'✓ FIRED':(r.g*100).toFixed(1)+'%'}</td>
          <td class="r"><span class="badge ${r.fired?'b-buy':r.close?'b-watch':'b-hold'}">${r.fired?'BUY NOW':r.close?`${(Math.abs(r.g)*100).toFixed(0)}% away`:'Watching'}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="sl" style="margin-top:20px">Rule 2 — 20DMA filter</div>
    <div class="info-box">Only buy when price is below the 20-day moving average. Avoids chasing bounces. Needs 20 trading days of price history to activate — approximately 4 weeks after go-live.</div>
    <div class="sl">Rule 3 — VIX deployment</div>
    <div class="info-box">When VIX exceeds 25 (fear elevated), double the monthly deployment from $12,000 to $24,000. Captures panic selloffs. Current VIX from morning scan data.</div>
  `;
}

// ── DEPLOYMENT ────────────────────────────────────────────────────────────────
async function loadDeploy() {
  if (!db) return;
  const prices = await getPrices();
  let blendY = 0;
  HOLDINGS.forEach(h => {
    const p = prices[h.ticker] ? parseFloat(prices[h.ticker].price) : FALLBACK[h.ticker];
    blendY += (h.dps / p) * h.weight;
  });

  const el = document.getElementById('deploy-content');
  const ms = [3,6,12,24,36,48,60,72];
  const rows = ms.map(m => ({
    m, cum: MONTHLY*m,
    incCur: MONTHLY*m*blendY,
    inc8:   MONTHLY*m*0.08
  }));

  el.innerHTML = `
    <div class="kband">
      <div class="kc dk"><div class="kl">Monthly Deploy</div><div class="kv">$12,000</div></div>
      <div class="kc"><div class="kl">Current Yield</div><div class="kv teal">${(blendY*100).toFixed(1)}%</div></div>
      <div class="kc"><div class="kl">School Fees</div><div class="kv gold">$60,000</div></div>
      <div class="kc"><div class="kl">Cover at current</div><div class="kv">${rows.find(r=>r.incCur>=FEES)?.m||'>72'}m</div></div>
      <div class="kc"><div class="kl">Cover at 8%</div><div class="kv teal">${rows.find(r=>r.inc8>=FEES)?.m||'>72'}m</div></div>
    </div>
    <div class="sl">Coverage schedule</div>
    <table>
      <thead><tr>
        <th>Month</th><th class="r">Cumulative</th>
        <th class="r">Income @ ${(blendY*100).toFixed(1)}%</th>
        <th class="r">Income @ 8%</th>
        <th class="r">Fees $60k</th>
        <th class="r">At current</th>
        <th class="r">At 8%</th>
      </tr></thead>
      <tbody>${rows.map(r=>{
        const covC = r.incCur >= FEES, cov8 = r.inc8 >= FEES;
        return `<tr style="background:${covC?'#f0f8f0':cov8?'#fffbf0':''}">
          <td>Month ${r.m}</td>
          <td class="r">$${r.cum.toLocaleString()}</td>
          <td class="r">$${Math.round(r.incCur).toLocaleString()}</td>
          <td class="r">$${Math.round(r.inc8).toLocaleString()}</td>
          <td class="r">$60,000</td>
          <td class="r" style="color:${covC?'var(--green)':r.incCur/FEES>0.5?'var(--amber)':'var(--muted)'}">${covC?'✓ Covered':Math.round(r.incCur/FEES*100)+'%'}</td>
          <td class="r" style="color:${cov8?'var(--green)':r.inc8/FEES>0.5?'var(--amber)':'var(--muted)'}">${cov8?'✓ Covered':Math.round(r.inc8/FEES*100)+'%'}</td>
        </tr>`;}).join('')}
      </tbody>
    </table>
    <div style="height:200px;margin-top:16px"><canvas id="dc" role="img" aria-label="Income growth vs school fees target"></canvas></div>
  `;

  new Chart(document.getElementById('dc').getContext('2d'), {
    type:'line',
    data:{ labels:rows.map(r=>'M'+r.m), datasets:[
      {label:'Current yield', data:rows.map(r=>Math.round(r.incCur)), borderColor:'#1a5f6e', backgroundColor:'rgba(26,95,110,0.08)', borderWidth:2, fill:true, tension:0.3, pointRadius:3},
      {label:'At 8%',         data:rows.map(r=>Math.round(r.inc8)),   borderColor:'#2d5a2d', borderWidth:1.5, borderDash:[4,4], fill:false, tension:0.3, pointRadius:0},
      {label:'School fees',   data:rows.map(()=>FEES),                 borderColor:'#b8943f', borderWidth:1.5, borderDash:[2,4], fill:false, pointRadius:0}
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        y:{ticks:{callback:v=>'$'+(v/1000).toFixed(0)+'k',font:{size:10}},grid:{color:'rgba(0,0,0,0.04)'}},
        x:{ticks:{font:{size:10}},grid:{display:false}}
      }
    }
  });
}

// ── P&L ───────────────────────────────────────────────────────────────────────
async function loadPnL() {
  if (!db) return;
  const { data } = await db.from('play_trades').select('*').eq('is_paper',true);
  const el = document.getElementById('pnl-content');
  if (!data?.length) { el.innerHTML = '<div class="empty">No trade history yet. P&L appears after first morning scan.</div>'; return; }
  const closed  = data.filter(t=>t.pnl!==null);
  const wins    = closed.filter(t=>parseFloat(t.pnl)>0);
  const totPnl  = closed.reduce((s,t)=>s+parseFloat(t.pnl||0),0);
  const avgWin  = wins.length ? wins.reduce((s,t)=>s+parseFloat(t.pnl),0)/wins.length : 0;
  const avgLoss = closed.filter(t=>parseFloat(t.pnl)<=0).length ? closed.filter(t=>parseFloat(t.pnl)<=0).reduce((s,t)=>s+parseFloat(t.pnl),0)/closed.filter(t=>parseFloat(t.pnl)<=0).length : 0;

  el.innerHTML = `
    <div class="kband">
      <div class="kc dk"><div class="kl">Total P&L</div><div class="kv" style="color:${totPnl>=0?'var(--gold-lt)':'var(--red)'}">${totPnl>=0?'+':''}$${Math.abs(totPnl).toFixed(0)}</div></div>
      <div class="kc"><div class="kl">Win Rate</div><div class="kv teal">${closed.length?Math.round(wins.length/closed.length*100)+'%':'--'}</div></div>
      <div class="kc"><div class="kl">Trades Closed</div><div class="kv">${closed.length}</div></div>
      <div class="kc"><div class="kl">Avg Win</div><div class="kv green">+$${avgWin.toFixed(0)}</div></div>
      <div class="kc"><div class="kl">Avg Loss</div><div class="kv red">$${Math.abs(avgLoss).toFixed(0)}</div></div>
      <div class="kc"><div class="kl">Risk/Reward</div><div class="kv gold">${avgLoss!==0?Math.abs(avgWin/avgLoss).toFixed(2)+'x':'--'}</div></div>
    </div>
    <div class="info-box">${totPnl>=0?`Paper trading profitable. ${closed.length} trades closed, ${Math.round(wins.length/closed.length*100)}% win rate. Keep paper trading until 20+ trades completed before going live.`:`${closed.length} trades closed so far. Need 20+ closed trades to validate strategy. Keep paper trading.`}</div>
  `;
}

// ── ALERTS ────────────────────────────────────────────────────────────────────
async function loadAlerts() {
  if (!db) return;
  const { data } = await db.from('alerts').select('*').order('created_at',{ascending:false}).limit(50);
  const el = document.getElementById('alerts-content');
  if (!data?.length) { el.innerHTML = '<div class="empty">No alerts yet. Alerts fire when yield triggers hit, VIX spikes, or morning scan errors occur.</div>'; return; }
  const cols = { yield_trigger:'#2d5a2d', vix_spike:'#7a5500', morning_signal:'#185fa5', stop_hit:'#7a5500', target_hit:'#2d5a2d' };
  el.innerHTML = data.map(a=>`
    <div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--rule);font-size:12px">
      <div style="width:8px;height:8px;border-radius:50%;background:${cols[a.alert_type]||'#6b6660'};flex-shrink:0;margin-top:4px"></div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);min-width:100px">${new Date(a.created_at).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
      <div style="flex:1">${a.ticker?`<strong>${a.ticker}</strong> — `:''}${a.message}${a.sent?'<span style="font-size:10px;color:var(--muted)"> · Email sent ✓</span>':''}</div>
    </div>
  `).join('');
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
</script>
</body>
</html>
