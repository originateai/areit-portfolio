#!/usr/bin/env node
/* =====================================================================
 * ingest-results-packs.js — turn a folder of ASX result PDFs into
 * point-in-time fundamentals.
 *
 * Extracts text locally (pdf-parse), sends it to Claude for structured
 * extraction under a forced tool schema, and writes reit_fundamentals plus
 * forward guidance — with the release date taken from the ANNOUNCEMENT, never
 * the balance date.
 *
 *   node ingest-results-packs.js --dir ../samples/ASX_FY26_Results
 *   node ingest-results-packs.js --dir ... --ticker CIP        one REIT
 *   node ingest-results-packs.js --dir ... --dry-run           no writes
 *
 * Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE (or _KEY).
 *
 * ── WHY THE RELEASE DATE IS THE WHOLE POINT ───────────────────────────────────
 * A fundamental dated to the period end lets a backtest trade on numbers nobody
 * had yet. CIP's FY26 covers the year to 30 June 2026 but was released on
 * 11 August 2026 — six weeks of look-ahead if you get it wrong. The filenames
 * this script reads carry the ASX announcement date, which is the correct key,
 * and the DB constraint rejects release_date <= period_end regardless.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 * It never invents a figure. A field the pack does not state comes back null and
 * stays null. Extraction confidence is recorded, and anything below the bar is
 * written with is_estimate = true so the platform can flag it.
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const DIR = arg('--dir', '../samples/ASX_FY26_Results');
const ONLY = arg('--ticker');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;

if (!KEY) { console.error('ANTHROPIC_API_KEY is required.'); process.exit(1); }
if (!DRY && (!SB_URL || !SB_KEY)) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required (or pass --dry-run).'); process.exit(1); }
const db = DRY ? null : createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/* Filenames are TICKER_YYYY-MM-DD_Title.pdf — the date is the ASX announcement
 * date, which is exactly the point-in-time key. Parsing it here means we never
 * have to trust the model to find it in the body text. */
function parseName(file) {
  const m = path.basename(file).match(/^([A-Z]{2,4})_(\d{4}-\d{2}-\d{2})_(.+)\.pdf$/i);
  if (!m) return null;
  return { ticker: m[1].toUpperCase(), release_date: m[2], title: m[3].replace(/_/g, ' ') };
}

// Documents that carry the numbers. A "notice of results" or a governance
// statement has none, and sending them wastes tokens and invites noise.
const WORTH_READING = /results|appendix\s*4e|annual[_\s]report|financial[_\s]report|presentation|compendium/i;
const NOT_WORTH = /advance[_\s]notice|notice[_\s]of|webcast|teleconference|briefing|corporate[_\s]governance|4G|sustainability|annual[_\s]general/i;

const TOOL = {
  name: 'record_reit_fundamentals',
  description: 'Record the reported figures from an A-REIT results pack. Only fields the document explicitly states. Omit anything not stated — never infer, never carry a figure over from a prior period.',
  input_schema: {
    type: 'object',
    properties: {
      period_end:    { type: 'string', description: 'Balance date the results cover, YYYY-MM-DD.' },
      period_months: { type: 'number', description: '6 for a half year, 12 for a full year.' },
      nta:           { type: 'number', description: 'NTA per security in DOLLARS, e.g. 4.01.' },
      wacr:          { type: 'number', description: 'Weighted average cap rate as a DECIMAL, e.g. 0.058 for 5.8%.' },
      npi:           { type: 'number', description: 'Net property income / NOI for the period in DOLLARS (not millions). $114.1m -> 114100000.' },
      gearing:       { type: 'number', description: 'DECIMAL, e.g. 0.349 for 34.9%.' },
      icr:           { type: 'number', description: 'Interest cover, a MULTIPLE e.g. 3.2.' },
      hedge_pct:     { type: 'number', description: 'Share of debt hedged, DECIMAL e.g. 0.54.' },
      hedge_maturity:{ type: 'number', description: 'Weighted average hedge maturity in YEARS.' },
      wale:          { type: 'number', description: 'WALE in YEARS.' },
      occupancy:     { type: 'number', description: 'DECIMAL e.g. 0.952 for 95.2%.' },
      ffo:           { type: 'number', description: 'FFO for the period in DOLLARS.' },
      affo:          { type: 'number', description: 'AFFO for the period in DOLLARS.' },
      dps:           { type: 'number', description: 'Distribution per security for the period in DOLLARS, e.g. 0.168 for 16.8 cents.' },
      portfolio_value: { type: 'number', description: 'Total portfolio value in DOLLARS.' },
      asset_count:   { type: 'number' },
      wade_years:    { type: 'number', description: 'Weighted average debt expiry in YEARS.' },
      lfl_noi_growth:{ type: 'number', description: 'Like-for-like NOI growth, DECIMAL e.g. 0.052.' },
      guidance_ffo_low:  { type: 'number', description: 'Next-year FFO guidance low, DOLLARS per security e.g. 0.188.' },
      guidance_ffo_high: { type: 'number', description: 'Next-year FFO guidance high, DOLLARS per security.' },
      guidance_dps:      { type: 'number', description: 'Next-year distribution guidance, DOLLARS per security.' },
      guidance_fy:       { type: 'string', description: 'Which FY the guidance applies to, e.g. FY27.' },
      confidence:    { type: 'number', description: '0-1. Below 0.7 means a human should check it.' },
      notes:         { type: 'string', description: 'One line: anything ambiguous or worth flagging.' },
    },
    required: ['confidence'],
  },
};

const SYSTEM = `You extract reported figures from Australian REIT results packs.

RULES:
- Only what the document explicitly states. If a figure is not there, omit the field.
- Never carry a number over from a prior comparative period. If the pack shows FY25
  and FY26 side by side, take FY26 — the CURRENT period being reported.
- Convert units carefully:
    "18.2 cpu" -> 0.182 dollars
    "$114.1m"  -> 114100000 dollars
    "34.9%"    -> 0.349 decimal
    "5.8% WACR"-> 0.058 decimal
- Cap rates, gearing, occupancy, hedging are DECIMALS. Per-security figures are DOLLARS.
- WACR is the weighted average CAPITALISATION rate on the property portfolio. Do not
  confuse it with the discount rate or the distribution yield.
- FFO and AFFO are non-IFRS REIT measures; do not substitute statutory net profit,
  which includes revaluations.
- Set confidence honestly. A presentation with figures in charts rather than text,
  or a pack covering several entities, is lower confidence.`;

async function extract(text, meta) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000, system: SYSTEM,
      tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content:
        `${meta.ticker} — "${meta.title}", released ${meta.release_date}.\n\n${text.slice(0, 60000)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  const block = (out.content || []).find(c => c.type === 'tool_use');
  return block ? block.input : null;
}

(async () => {
  const root = path.resolve(__dirname, DIR);
  if (!fs.existsSync(root)) { console.error(`No such directory: ${root}`); process.exit(1); }

  // Walk ticker subfolders.
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of fs.readdirSync(path.join(root, entry.name))) {
        if (f.toLowerCase().endsWith('.pdf')) files.push(path.join(root, entry.name, f));
      }
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      files.push(path.join(root, entry.name));
    }
  }

  const candidates = files.map(f => ({ file: f, meta: parseName(f) }))
    .filter(x => x.meta)
    .filter(x => !ONLY || x.meta.ticker === ONLY.toUpperCase())
    .filter(x => WORTH_READING.test(path.basename(x.file)) && !NOT_WORTH.test(path.basename(x.file)));

  console.log(`${files.length} PDFs found, ${candidates.length} worth reading${ONLY ? ` for ${ONLY}` : ''}${DRY ? '  (DRY RUN)' : ''}\n`);

  // Best document per ticker: prefer the results announcement / 4E, which state
  // the headline figures in text, over a presentation where they sit in charts.
  const rank = f => /appendix\s*4e|results[_\s]announcement|asx[_\s]release/i.test(f) ? 0
                  : /financial[_\s]report|annual[_\s]report/i.test(f) ? 1
                  : /presentation/i.test(f) ? 2 : 3;
  const byTicker = {};
  candidates.forEach(c => { (byTicker[c.meta.ticker] = byTicker[c.meta.ticker] || []).push(c); });
  Object.values(byTicker).forEach(list => list.sort((a, b) => rank(path.basename(a.file)) - rank(path.basename(b.file))));

  const results = [];
  for (const [ticker, list] of Object.entries(byTicker)) {
    const pick = list[0];
    process.stdout.write(`${ticker.padEnd(5)} ${path.basename(pick.file).slice(0, 58).padEnd(60)}`);
    try {
      const data = await pdf(fs.readFileSync(pick.file));
      if (!data.text || data.text.trim().length < 200) { console.log('no extractable text (scanned?)'); continue; }
      const f = await extract(data.text, pick.meta);
      if (!f) { console.log('no extraction'); continue; }

      // The release date comes from the FILENAME, not the model — it is the one
      // field we can know for certain and the one that must not be wrong.
      const row = {
        ticker, release_date: pick.meta.release_date,
        period_end: f.period_end || null, period_months: f.period_months || null,
        nta: f.nta ?? null, wacr: f.wacr ?? null, npi: f.npi ?? null,
        gearing: f.gearing ?? null, icr: f.icr ?? null,
        hedge_pct: f.hedge_pct ?? null, hedge_maturity: f.hedge_maturity ?? null,
        wale: f.wale ?? null, occupancy: f.occupancy ?? null,
        ffo: f.ffo ?? null, affo: f.affo ?? null, dps: f.dps ?? null,
        source: 'results_pack',
        is_estimate: (f.confidence ?? 0) < 0.7,
      };

      if (!row.period_end) { console.log(`SKIP — no period_end stated (conf ${f.confidence})`); continue; }
      if (row.release_date <= row.period_end) { console.log(`SKIP — release ${row.release_date} <= period end ${row.period_end}`); continue; }

      results.push({ row, extra: f, file: path.basename(pick.file) });
      console.log(`ok  conf ${(f.confidence ?? 0).toFixed(2)}  NTA ${f.nta ?? '—'}  WACR ${f.wacr ?? '—'}  gearing ${f.gearing ?? '—'}`);
    } catch (e) {
      console.log('ERR ' + e.message.slice(0, 90));
    }
  }

  console.log(`\n${results.length} extraction(s).`);
  if (DRY) {
    results.forEach(r => console.log(`\n${r.row.ticker} (${r.file})\n` + JSON.stringify(r.extra, null, 1)));
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  for (const r of results) {
    const { error } = await db.from('reit_fundamentals')
      .upsert(r.row, { onConflict: 'ticker,period_end,release_date' });
    console.log(error ? `  ${r.row.ticker}: ${error.message}` : `  ${r.row.ticker}: written`);
  }
  console.log('\nDone. Guidance figures are in the extraction output but are not yet persisted — reit_fundamentals has no guidance columns.');
})();
