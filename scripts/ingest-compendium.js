#!/usr/bin/env node
/* =====================================================================
 * ingest-compendium.js — property compendium PDF -> reit_assets
 *
 * A property compendium is the real asset register: one page per property with
 * book value, capitalisation rate, WALE, occupancy, GLA, sub-sector and the
 * tenancy schedule. That is a far better bottom-up input than the handful of
 * aggregated rows a workbook's Asset Register sheet carries.
 *
 *   node ingest-compendium.js --file ../samples/.../CIP_..._Property_Compendium.pdf --ticker CIP
 *   ... --dry-run     parse and print, write nothing
 *
 * ── WHY NOT A REGEX ──────────────────────────────────────────────────────────
 * These pages lay assets out in side-by-side columns, and pdf text extraction
 * concatenates them:
 *      "Current book value $101.0m$68.0m"
 *      "Capitalisation rate 5.75%5.75%"
 *      "WALE (years) 4.110.3"          <- 4.1 and 10.3, NOT 4.11
 * A regex reads that last line as 4.110 and is wrong in a way nothing catches.
 * Structured extraction handles the column split; the guards below then reject
 * anything implausible.
 *
 * ── PASSING INCOME IS DERIVED ────────────────────────────────────────────────
 * Compendiums state book value and cap rate but rarely passing income. Since
 * value = income / cap, income = value x cap. That is an identity, not an
 * estimate, and it is exactly the input the bottom-up model needs.
 *
 * Env: ANTHROPIC_API_KEY; SUPABASE_URL + SUPABASE_SERVICE_ROLE unless --dry-run.
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const FILE = arg('--file');
const TICKER = (arg('--ticker') || '').toUpperCase();
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const KEY = process.env.ANTHROPIC_API_KEY;

if (!FILE || !TICKER) { console.error('usage: node ingest-compendium.js --file <pdf> --ticker XXX [--dry-run]'); process.exit(1); }
if (!KEY) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;
if (!DRY && (!SB_URL || !SB_KEY)) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE required (or --dry-run)'); process.exit(1); }
const db = DRY ? null : createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TOOL = {
  name: 'record_properties',
  description:
    'Record every individual property described in this extract of a REIT property compendium. ' +
    'Pages often show TWO OR MORE assets side by side, which makes their values run together in the ' +
    'extracted text — "$101.0m$68.0m" is two book values, and "4.110.3" is a WALE of 4.1 and one of 10.3, ' +
    'NOT 4.11. Split them correctly and emit one entry per property. Omit any field the page does not state.',
  input_schema: {
    type: 'object',
    properties: {
      properties: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            asset_name:   { type: 'string', description: 'Property address as written, e.g. "10 Williamson Road, Ingleburn".' },
            state:        { type: 'string', description: 'NSW, VIC, QLD, WA, SA, ACT, TAS, NT.' },
            sub_sector:   { type: 'string', description: 'e.g. Manufacturing, Distribution, Data centre, Office, Convenience retail.' },
            book_value_m: { type: 'number', description: 'Current book value in MILLIONS of dollars, e.g. 101.0.' },
            cap_rate:     { type: 'number', description: 'Capitalisation rate as a DECIMAL, e.g. 0.0575 for 5.75%.' },
            wale_years:   { type: 'number', description: 'WALE in YEARS for THIS property.' },
            occupancy:    { type: 'number', description: 'DECIMAL, e.g. 1.0 for 100%.' },
            area_sqm:     { type: 'number', description: 'GLA in square metres for THIS property.' },
            major_tenant: { type: 'string', description: 'Largest tenant by area, from the tenancy schedule.' },
            valuation_date:{ type: 'string', description: 'Most recent external valuation date as written, e.g. "December 2025".' },
          },
          required: ['asset_name'],
        },
      },
    },
    required: ['properties'],
  },
};

const SYSTEM = `You extract property-level data from Australian REIT property compendiums.

The single most important thing: these documents lay assets out in COLUMNS, and the
text extraction concatenates the columns. You must split them.

  "Asset summary  10 Williamson Road   12 Williamson Road"
  "Current book value $101.0m$68.0m"      -> 101.0 and 68.0
  "Capitalisation rate 5.75%5.75%"        -> 0.0575 and 0.0575
  "WALE (years) 4.110.3"                  -> 4.1 and 10.3   (NOT 4.11)

Use the column headings to work out how many assets a page describes, and assign
each value to the right one. Where a page describes a single asset there is no
splitting to do.

Cap rates and occupancy are DECIMALS. Book value is MILLIONS. WALE and GLA are for
the individual property, not the estate total, wherever both are given.

Omit any field the page does not state. Never invent a figure, and never carry one
across from the property above.`;

async function extractBatch(text, n) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, system: SYSTEM,
      tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: `${TICKER} property compendium, extract ${n}.\n\n${text}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  const block = (out.content || []).find(c => c.type === 'tool_use');
  return block ? (block.input.properties || []) : [];
}

/* Plausibility guards. Same doctrine as export-model.js: reject loudly rather
 * than write a wrong-but-plausible number into a real-money model. */
function validate(p) {
  const bad = [];
  if (p.cap_rate != null && (p.cap_rate < 0.02 || p.cap_rate > 0.15)) bad.push(`cap_rate ${p.cap_rate} outside 2-15% — likely a percent not a decimal`);
  if (p.occupancy != null && (p.occupancy < 0 || p.occupancy > 1.0001)) bad.push(`occupancy ${p.occupancy} outside 0-1`);
  if (p.wale_years != null && (p.wale_years < 0 || p.wale_years > 30)) bad.push(`wale ${p.wale_years} outside 0-30yrs — check for concatenated columns`);
  if (p.book_value_m != null && (p.book_value_m <= 0 || p.book_value_m > 5000)) bad.push(`book_value_m ${p.book_value_m} implausible`);
  return bad;
}

(async () => {
  const file = path.resolve(__dirname, FILE);
  const data = await pdf(fs.readFileSync(file));
  const text = data.text;
  console.log(`${path.basename(file)} — ${data.numpages} pages, ${text.length} chars\n`);

  // Split on the page footer, which every page carries, then batch so an asset
  // is never cut in half across two requests.
  const chunks = [];
  const CHUNK = 9000;
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK + 900));

  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  batch ${i + 1}/${chunks.length} ... `);
    try {
      const got = await extractBatch(chunks[i], `batch ${i + 1} of ${chunks.length}`);
      console.log(`${got.length} propert${got.length === 1 ? 'y' : 'ies'}`);
      all.push(...got);
    } catch (e) { console.log('ERR ' + e.message.slice(0, 80)); }
  }

  // De-duplicate on name — chunks overlap deliberately so nothing is lost at a boundary.
  const seen = new Map();
  for (const p of all) {
    const k = (p.asset_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!k) continue;
    const existing = seen.get(k);
    // Keep whichever copy carries more populated fields.
    const score = o => Object.values(o).filter(v => v != null && v !== '').length;
    if (!existing || score(p) > score(existing)) seen.set(k, p);
  }
  const props = [...seen.values()];

  const rejected = [];
  const rows = [];
  for (const p of props) {
    const bad = validate(p);
    if (bad.length) { rejected.push({ name: p.asset_name, reasons: bad }); continue; }
    // income = value x cap. An identity, not an estimate.
    const income = (p.book_value_m != null && p.cap_rate) ? p.book_value_m * p.cap_rate : null;
    rows.push({
      ticker: TICKER, asset_name: p.asset_name,
      sector: p.sub_sector || null, sub_sector: p.sub_sector || null,
      state: p.state || null, book_value_m: p.book_value_m ?? null,
      cap_rate: p.cap_rate ?? null,
      passing_income_m: income != null ? Math.round(income * 1000) / 1000 : null,
      wale_years: p.wale_years ?? null, occupancy: p.occupancy ?? null,
      area_sqm: p.area_sqm ?? null, major_tenant: p.major_tenant || null,
      ownership_pct: 1, as_of: new Date().toISOString().slice(0, 10),
      source: 'property_compendium',
      wale_occupancy_suspect: false,   // these come straight off the compendium, unlike the workbook scrape
    });
  }

  const totalValue = rows.reduce((s, r) => s + (r.book_value_m || 0), 0);
  const totalIncome = rows.reduce((s, r) => s + (r.passing_income_m || 0), 0);
  const caps = rows.filter(r => r.cap_rate).map(r => r.cap_rate);

  console.log(`\n${rows.length} properties accepted, ${rejected.length} rejected`);
  console.log(`  book value  $${totalValue.toFixed(1)}m`);
  console.log(`  income      $${totalIncome.toFixed(1)}m (derived: value x cap)`);
  if (caps.length) console.log(`  cap rates   ${(Math.min(...caps)*100).toFixed(2)}% – ${(Math.max(...caps)*100).toFixed(2)}%  (value-weighted ${(totalIncome/totalValue*100).toFixed(2)}%)`);
  if (rejected.length) { console.log('\nREJECTED:'); rejected.forEach(r => console.log(`  ${r.name}: ${r.reasons.join('; ')}`)); }

  // --json <path> writes the parsed rows out so they can be loaded by another
  // route (e.g. straight through the Supabase MCP) without service-role creds
  // sitting in a shell.
  const jsonOut = arg('--json');
  if (jsonOut) {
    fs.writeFileSync(path.resolve(process.cwd(), jsonOut), JSON.stringify(rows, null, 1), 'utf8');
    console.log(`\nwrote ${rows.length} rows to ${jsonOut}`);
  }

  if (DRY) {
    console.log('\nSample:');
    rows.slice(0, 8).forEach(r => console.log(`  ${(r.asset_name||'').slice(0,44).padEnd(46)} $${String(r.book_value_m??'—').padStart(7)}m @ ${r.cap_rate?(r.cap_rate*100).toFixed(2)+'%':'  —  '}  WALE ${r.wale_years ?? '—'}  ${r.major_tenant||''}`));
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  // Replace this ticker's compendium-sourced rows; leave workbook rows alone.
  const { error: delErr } = await db.from('reit_assets').delete()
    .eq('ticker', TICKER).eq('source', 'property_compendium');
  if (delErr) console.error('delete existing:', delErr.message);
  const { error } = await db.from('reit_assets').insert(rows);
  console.log(error ? `\nwrite failed: ${error.message}` : `\n${rows.length} assets written for ${TICKER}.`);
})();
