const { schedule } = require('@netlify/functions');
// netlify/functions/orb-scan.js
// Opening Range Breakout scan — runs at 10:15am AEST (12:15am UTC)
// Scheduled: 0 0 * * 1-5 (12:15am UTC = 10:15am AEST)
//
// Strategy:
// 1. Get overnight 6-layer scores from morning scan
// 2. Fetch 1-min or 5-min intraday data for top candidates
// 3. Calculate opening range (10:00-10:15am high/low)
// 4. Identify breakouts above OR or breakdowns below OR
// 5. Send actionable email with entry levels

const { getSupabase, sendEmail, BOND_YIELD } = require('./_shared.js');

const BASE = 'https://eodhd.com/api';
const KEY  = () => process.env.EODHD_API_KEY;

// ── FETCH 5-MIN INTRADAY ──────────────────────────────────────────────────────
async function getIntraday(ticker) {
  try {
    const epic = `${ticker}.AU`;
    // Get today's intraday data from midnight
    const from = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    const url  = `${BASE}/intraday/${epic}?interval=5m&from=${from}&api_token=${KEY()}&fmt=json`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data.map(d => ({
      timestamp: d.datetime || d.timestamp,
      open:   parseFloat(d.open),
      high:   parseFloat(d.high),
      low:    parseFloat(d.low),
      close:  parseFloat(d.close),
      volume: parseInt(d.volume || 0)
    }));
  } catch(e) {
    console.error(`Intraday error ${ticker}:`, e.message);
    return null;
  }
}

// ── CALCULATE OPENING RANGE ───────────────────────────────────────────────────
// ASX opens 10:00am AEST — get high/low of 10:00-10:15am (3 x 5-min bars)
function calcOpeningRange(bars) {
  if (!bars || bars.length === 0) return null;

  // Filter to 10:00am - 10:15am AEST (bars during opening 15 min)
  const openingBars = bars.filter(b => {
    const t = new Date(b.timestamp);
    const h = t.getHours();
    const m = t.getMinutes();
    // 10:00am - 10:14am AEST
    return (h === 10 && m < 15) || (h === 10 && m === 0);
  });

  if (openingBars.length === 0) {
    // Fallback: use first 3 bars of the day
    const firstBars = bars.slice(0, 3);
    if (firstBars.length === 0) return null;
    return {
      high:   Math.max(...firstBars.map(b => b.high)),
      low:    Math.min(...firstBars.map(b => b.low)),
      open:   firstBars[0].open,
      volume: firstBars.reduce((s, b) => s + b.volume, 0),
      bars:   firstBars.length
    };
  }

  return {
    high:   Math.max(...openingBars.map(b => b.high)),
    low:    Math.min(...openingBars.map(b => b.low)),
    open:   openingBars[0].open,
    volume: openingBars.reduce((s, b) => s + b.volume, 0),
    bars:   openingBars.length
  };
}

// ── GET CURRENT PRICE ─────────────────────────────────────────────────────────
function getCurrentPrice(bars) {
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1].close;
}

// ── GET CURRENT VOLUME ────────────────────────────────────────────────────────
function getTotalVolume(bars) {
  if (!bars) return 0;
  return bars.reduce((s, b) => s + b.volume, 0);
}

// ── CLASSIFY BREAKOUT ─────────────────────────────────────────────────────────
function classifyBreakout(currentPrice, or, avgVolume) {
  if (!or || !currentPrice) return null;

  const rangeSize   = or.high - or.low;
  const rangePct    = rangeSize / or.open;
  const aboveHigh   = currentPrice > or.high;
  const belowLow    = currentPrice < or.low;
  const insideRange = !aboveHigh && !belowLow;

  if (insideRange) return { type: 'INSIDE', direction: null };

  const breakoutPct = aboveHigh
    ? (currentPrice - or.high) / or.high
    : (or.low - currentPrice) / or.low;

  // Volume confirmation — breakout should be on above average volume
  const volumeConfirmed = or.volume > (avgVolume * 0.3); // 30% of daily avg in first 15 min

  return {
    type:             aboveHigh ? 'BREAKOUT' : 'BREAKDOWN',
    direction:        aboveHigh ? 'LONG' : 'SHORT',
    currentPrice,
    orHigh:           parseFloat(or.high.toFixed(4)),
    orLow:            parseFloat(or.low.toFixed(4)),
    rangeSize:        parseFloat(rangeSize.toFixed(4)),
    rangePct:         parseFloat((rangePct * 100).toFixed(2)),
    breakoutPct:      parseFloat((breakoutPct * 100).toFixed(2)),
    volumeConfirmed,
    // Trade levels
    entry:            currentPrice,
    stop:             aboveHigh ? or.low  : or.high, // stop is other side of range
    target1:          aboveHigh ? or.high + rangeSize : or.low - rangeSize, // 1R target
    target2:          aboveHigh ? or.high + rangeSize * 2 : or.low - rangeSize * 2, // 2R target
    riskPct:          parseFloat(((Math.abs(currentPrice - (aboveHigh ? or.low : or.high)) / currentPrice) * 100).toFixed(2))
  };
}

// ── BUILD ORB EMAIL ───────────────────────────────────────────────────────────
function buildORBEmail(breakouts, watching, date) {
  const hasSignals = breakouts.length > 0;

  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#f0ede6;color:#1a1a1a}
    .wrap{max-width:600px;margin:0 auto;background:#f0ede6}
    .hdr{background:#0e1117;padding:16px 20px}
    .hdr h1{color:#d4b06a;font-size:18px;font-weight:600;margin-bottom:2px}
    .hdr p{color:rgba(255,255,255,0.35);font-size:11px;font-family:monospace}
    .sec{background:#fff;border-bottom:1px solid #e5e0d8;padding:14px 18px}
    .sec-title{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:10px;font-family:monospace}
    .signal{border:1px solid #e8e4dc;border-radius:6px;padding:14px;margin-bottom:10px}
    .signal.bull{border-left:4px solid #2d5a2d;background:#f8fff8}
    .signal.bear{border-left:4px solid #8b2e2e;background:#fff8f8}
    .tkr{font-family:monospace;font-weight:700;font-size:18px}
    .bull .tkr{color:#1a5f6e}
    .name{font-size:12px;color:#888;margin:2px 0 8px}
    .levels{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}
    .lvl{background:#f5f2ec;border-radius:4px;padding:7px;text-align:center}
    .lvl-l{font-size:9px;color:#888;font-family:monospace;text-transform:uppercase;margin-bottom:2px}
    .lvl-v{font-family:monospace;font-weight:700;font-size:13px}
    .score-row{display:flex;gap:3px;margin-top:8px}
    .sd{width:16px;height:16px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:white}
    .sd-on{background:#1a5f6e}.sd-off{background:#c8c2b4}
    .watch-row{display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #f0ede6;font-size:13px}
    .watch-row:last-child{border:none}
    .ftr{padding:12px 18px;font-size:11px;color:#aaa;text-align:center}
  `;

  const breakoutCard = b => `
    <div class="signal ${b.direction==='LONG'?'bull':'bear'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <span class="tkr">${b.ticker}</span>
          <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;background:${b.direction==='LONG'?'#eef6ee':'#fcebeb'};color:${b.direction==='LONG'?'#2d5a2d':'#8b2e2e'}">
            ${b.direction==='LONG'?'⬆ BREAKOUT':'⬇ BREAKDOWN'}
          </span>
        </div>
        <div style="text-align:right">
          <div style="font-family:monospace;font-weight:700;font-size:16px">$${b.currentPrice?.toFixed(3)}</div>
          <div style="font-size:11px;color:#888">+${b.breakoutPct?.toFixed(1)}% from range</div>
        </div>
      </div>
      <div class="name">${b.name} · Overnight score ${b.overnightScore}/6 · Range ${b.rangePct?.toFixed(1)}% wide ${b.volumeConfirmed?'· ✓ Volume confirmed':''}</div>
      <div class="levels">
        <div class="lvl">
          <div class="lvl-l">Entry</div>
          <div class="lvl-v">$${b.entry?.toFixed(3)}</div>
        </div>
        <div class="lvl" style="background:#fcebeb">
          <div class="lvl-l">Stop</div>
          <div class="lvl-v" style="color:#8b2e2e">$${b.stop?.toFixed(3)}</div>
        </div>
        <div class="lvl" style="background:#f0f8f0">
          <div class="lvl-l">Target 1R</div>
          <div class="lvl-v" style="color:#2d5a2d">$${b.target1?.toFixed(3)}</div>
        </div>
        <div class="lvl" style="background:#e8f5e8">
          <div class="lvl-l">Target 2R</div>
          <div class="lvl-v" style="color:#2d5a2d">$${b.target2?.toFixed(3)}</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#888">
        OR High: $${b.orHigh} · OR Low: $${b.orLow} · Risk: ${b.riskPct}% · ${b.volumeConfirmed?'Volume ✓':'Low volume — caution'}
      </div>
      <div class="score-row">
        ${[1,2,3,4,5,6].map((_,i) => `<div class="sd ${i<(b.overnightScore||0)?'sd-on':'sd-off'}">${i<(b.overnightScore||0)?'✓':''}</div>`).join('')}
        <span style="font-size:10px;color:#888;margin-left:6px">overnight signal</span>
      </div>
    </div>`;

  const subject = hasSignals
    ? `⚡ ORB 10:15am — ${breakouts.filter(b=>b.direction==='LONG').length} breakout${breakouts.filter(b=>b.direction==='LONG').length!==1?'s':''}, ${breakouts.filter(b=>b.direction==='BREAKDOWN').length} breakdown${breakouts.filter(b=>b.direction==='BREAKDOWN').length!==1?'s':''} · ${date}`
    : `○ ORB 10:15am — No clean breakouts · ${date}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head>
<body><div class="wrap">

<div class="hdr">
  <h1>⚡ Opening Range Breakout — 10:15am AEST</h1>
  <p>${date} · ASX open 15-minute range analysis · Top ${breakouts.length + watching.length} overnight signals</p>
</div>

${hasSignals ? `
<div class="sec">
  <div class="sec-title">Active breakouts — act now at market</div>
  ${breakouts.map(breakoutCard).join('')}
  <p style="font-size:11px;color:#aaa;margin-top:8px">Enter at market · Stop below OR low (long) or above OR high (short) · Target 1-2× range width</p>
</div>` : `
<div class="sec">
  <p style="color:#888;font-size:14px;padding:8px 0">No clean breakouts from the opening range yet. Top overnight signals are consolidating inside the range — wait for a clean break.</p>
</div>`}

${watching.length > 0 ? `
<div class="sec">
  <div class="sec-title">Watching — inside opening range (${watching.length} stocks)</div>
  ${watching.map(w => `
    <div class="watch-row">
      <span style="font-family:monospace;font-weight:700;color:#1a5f6e;min-width:50px">${w.ticker}</span>
      <span style="flex:1;font-size:12px;color:#888">${w.name}</span>
      <span style="font-family:monospace;font-size:12px">$${w.currentPrice?.toFixed(3)}</span>
      <span style="font-family:monospace;font-size:11px;color:#888;margin-left:8px">OR ${w.orLow?.toFixed(3)}–${w.orHigh?.toFixed(3)}</span>
      <span style="font-family:monospace;font-size:11px;color:#1a5f6e;margin-left:8px">${w.overnightScore}/6</span>
    </div>`).join('')}
  <p style="font-size:11px;color:#aaa;margin-top:8px">These stocks have strong overnight signals but haven't broken out yet. Watch for a break above/below the range.</p>
</div>` : ''}

<div class="ftr">
  Not financial advice · Intraday data: EODHD · Place trades via Stake · Log in dashboard
</div>
</div></body></html>`;

  return { subject, html };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
const handler = async () => {
  const db   = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  const dateStr = new Date().toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short'
  });

  console.log(`ORB scan starting: ${today}`);

  try {
    // 1. Get today's top overnight signals from morning scan
    const { data: morningSignal } = await db
      .from('morning_signals')
      .select('*')
      .eq('signal_date', today)
      .single();

    // Get all stocks that scored 4+ overnight
    const { data: analysis } = await db
      .from('daily_analysis')
      .select('ticker, total_score, conviction, signal_reasons')
      .eq('analysis_date', today)
      .gte('total_score', 4)
      .order('total_score', { ascending: false })
      .limit(30);

    if (!analysis?.length) {
      console.log('No overnight signals — skipping ORB scan');
      return { statusCode: 200, body: JSON.stringify({ message: 'No overnight signals' }) };
    }

    const tickers = analysis.map(a => a.ticker);
    console.log(`Checking ORB for ${tickers.length} stocks: ${tickers.join(', ')}`);

    // 2. Get stock names
    const { data: stocks } = await db
      .from('stocks')
      .select('ticker, name')
      .in('ticker', tickers);
    const nameMap = {};
    (stocks || []).forEach(s => { nameMap[s.ticker] = s.name; });

    // 3. Get average daily volume for each stock (for volume confirmation)
    const { data: priceHistory } = await db
      .from('prices')
      .select('ticker, volume')
      .in('ticker', tickers)
      .order('market_date', { ascending: false });

    const avgVolMap = {};
    const volGroups = {};
    (priceHistory || []).forEach(p => {
      if (!volGroups[p.ticker]) volGroups[p.ticker] = [];
      if (volGroups[p.ticker].length < 20) volGroups[p.ticker].push(parseInt(p.volume || 0));
    });
    Object.entries(volGroups).forEach(([t, vols]) => {
      avgVolMap[t] = vols.length > 0 ? vols.reduce((a,b) => a+b, 0) / vols.length : 0;
    });

    // 4. Fetch intraday data and calculate ORB for each stock
    const breakouts = [];
    const watching  = [];

    for (const a of analysis) {
      try {
        const bars = await getIntraday(a.ticker);
        await new Promise(r => setTimeout(r, 300)); // rate limit

        if (!bars || bars.length < 3) {
          console.log(`No intraday data for ${a.ticker}`);
          continue;
        }

        const or           = calcOpeningRange(bars);
        const currentPrice = getCurrentPrice(bars);
        const totalVolume  = getTotalVolume(bars);

        if (!or || !currentPrice) continue;

        const result = classifyBreakout(currentPrice, or, avgVolMap[a.ticker] || 0);
        if (!result) continue;

        const enriched = {
          ticker:         a.ticker,
          name:           nameMap[a.ticker] || a.ticker,
          overnightScore: a.total_score,
          conviction:     a.conviction,
          currentPrice,
          totalVolume,
          ...result
        };

        if (result.type === 'BREAKOUT' || result.type === 'BREAKDOWN') {
          breakouts.push(enriched);
          console.log(`${a.ticker}: ${result.type} +${result.breakoutPct?.toFixed(1)}%`);
        } else {
          watching.push(enriched);
        }

      } catch(e) {
        console.error(`ORB error for ${a.ticker}:`, e.message);
      }
    }

    // Sort by breakout strength
    breakouts.sort((a, b) => {
      // Prioritise: volume confirmed, higher overnight score, bigger breakout
      if (a.volumeConfirmed !== b.volumeConfirmed) return a.volumeConfirmed ? -1 : 1;
      if (b.overnightScore !== a.overnightScore) return b.overnightScore - a.overnightScore;
      return (b.breakoutPct || 0) - (a.breakoutPct || 0);
    });

    // 5. Save to alerts
    if (breakouts.length > 0) {
      await db.from('alerts').insert(breakouts.map(b => ({
        alert_type: 'orb_breakout',
        ticker:     b.ticker,
        universe:   'ASX500',
        message:    `${b.ticker} ORB ${b.type} — $${b.currentPrice?.toFixed(3)} · ${b.breakoutPct?.toFixed(1)}% from range · Stop $${b.stop?.toFixed(3)} · Target $${b.target1?.toFixed(3)}`,
        data:       { currentPrice: b.currentPrice, orHigh: b.orHigh, orLow: b.orLow, direction: b.direction },
        sent:       false
      })));
    }

    // 6. Build and send email
    const { subject, html } = buildORBEmail(breakouts, watching, dateStr);
    await sendEmail(subject, html);

    console.log(`ORB scan complete: ${breakouts.length} breakouts, ${watching.length} watching`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        date:      today,
        breakouts: breakouts.length,
        watching:  watching.length,
        tickers:   breakouts.map(b => b.ticker)
      })
    };

  } catch(err) {
    console.error('ORB scan failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports.handler = schedule('15 0 * * 1-5', handler);
