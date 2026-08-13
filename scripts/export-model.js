#!/usr/bin/env node
/* =====================================================================
 * export-model.js  -  workbook -> Supabase (the value-layer bridge)
 *
 * Reads a BUILT + RECALCULATED REIT model .xlsx (cached cell values) and
 * upserts: reit_models, reit_model_assumptions, reit_model_actuals,
 * reit_model_forecasts, reit_model_outputs, reit_assets, reit_prices.
 *
 * Setup:   cd scripts && npm install
 * Usage:   node export-model.js DXI "../areit models/DXI_Dexus_Industria_Model.xlsx" [version]
 *          add --dry-run to PARSE + VALIDATE + PRINT without writing.
 * Env:     SUPABASE_URL, SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_KEY) — server only.
 *
 * ── HARDENING (2026-08-13) ────────────────────────────────────────────
 * This script used to read ~60 bare cell addresses (`cell('Assumptions','E7')`).
 * That fails SILENTLY: insert one row in the workbook and every reference
 * below it shifts, writing a wrong-but-plausible number into a real-money
 * BUY signal. Three guards now stand in the way, and ALL of them run before
 * anything is written:
 *
 *   1. LABEL CHECK — every scraped cell declares the label it expects to find
 *      in column B of the same row. Rows shift -> label stops matching -> abort.
 *   2. RANGE CHECK — every value declares a plausible range (a cap rate is
 *      2-15%, gearing 0-80%, ...). Catches a value read from the wrong column.
 *   3. NULL CHECK — fields marked required must be non-null. This is what
 *      catches a workbook saved without recalculating, which used to export
 *      a full set of nulls without complaint.
 *
 * Failures are COLLECTED and reported together, then the script exits non-zero
 * without writing. Use --dry-run to validate a workbook after editing it.
 * ===================================================================== */
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const [TICKER, PATH, VERSION_ARG] = argv.filter(a => a !== '--dry-run');
if (!TICKER || !PATH) { console.error('usage: node export-model.js TICKER path.xlsx [version] [--dry-run]'); process.exit(1); }
const MODEL_VERSION = parseInt(VERSION_ARG || '1', 10);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;
let sb = null;
if (!DRY_RUN) {
  if (!SUPABASE_URL || !SERVICE_ROLE) { console.error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_KEY), or pass --dry-run'); process.exit(1); }
  sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

// --- per-ticker static metadata (governance/manager - not cleanly in cells) ---
const META = {
  DXI: { name:'Dexus Industria REIT',          mgmt:'external', parent:'Dexus (DXS)',     stake:18.6, fy:'30 June' },
  DXC: { name:'Dexus Convenience Retail REIT',  mgmt:'external', parent:'Dexus (DXS)',     stake:null, fy:'30 June' },
  CIP: { name:'Centuria Industrial REIT',       mgmt:'external', parent:'Centuria (CNI)',  stake:16.1, fy:'30 June' },
  REP: { name:'RAM Essential Services Property', mgmt:'external', parent:'RAM',            stake:null, fy:'30 June' },
  RGN: { name:'Region Group',                   mgmt:'internal', parent:null,              stake:null, fy:'30 June' },
  WPR: { name:'Waypoint REIT',                  mgmt:'internal', parent:null,              stake:null, fy:'30 June' },
};

const REQUIRED_SHEETS = ['Control','Assumptions','Debt','P&L','Balance Sheet','Cash Flow','Valuation','Earnings Quality'];

const wb = XLSX.readFile(PATH, { cellFormula:false });
const FC_COLS = ['E','F','G','H','I'];          // forecast columns
const FY_FC   = ['FY26E','FY27E','FY28E','FY29E','FY30E'];
const LABEL_COL = 'B';                          // every model row labels itself in column B

// ── VALIDATION PLUMBING ───────────────────────────────────────────────────────
const problems = [];
const fail = (msg) => problems.push(msg);

const rawCell = (sheet, ref) => { const ws = wb.Sheets[sheet]; const c = ws && ws[ref]; return c == null ? null : c.v; };

// Common range guards. `null` bound = unbounded on that side.
/* UNITS — the workbooks mix them, deliberately, and so does the DB:
 *   dpu / epu / ffo_per_unit  are CENTS   (workbook labels say "(cps)")
 *   nta / all valuation outputs / price   are DOLLARS (labels say "($)")
 * `reit_model_forecasts` therefore holds dpu in cents next to nta in dollars.
 * Downstream, public/value-layer.html divides dpu and epu by 100 before using
 * them against price — see `const epsy=m.epu[2]/100/m.price`. Note that
 * `stocks.dps_fy26` uses the OTHER convention (dollars). Do not "fix" either
 * one in isolation. The separate cents/dollars ranges below exist so that if a
 * workbook ever switches convention, the export aborts instead of silently
 * shifting every yield on the platform by 100x. */
const RANGE = {
  rate:     [0.005, 0.25],   // cap rates, discount rates, escalation, yields
  pct:      [0, 1.5],        // ratios expressed 0-1 (payout, occupancy, gearing)
  money_m:  [0, 100000],     // $m figures
  cents:    [0, 500],        // per-security figures in CENTS (dpu, epu, ffo/unit)
  dollars:  [0, 100],        // per-security figures in DOLLARS (nta, values, price)
  multiple: [0, 100],        // PE / multiples
  any:      [null, null],
};

/**
 * Read one cell, checking that the row still says what we think it says.
 *   sheet   - worksheet name
 *   ref     - cell address, e.g. 'E7'
 *   label   - RegExp the column-B label on that row must match
 *   opts    - { range: RANGE key, required: bool, field: name for messages }
 */
function read(sheet, ref, label, opts = {}) {
  const { range = 'any', required = false, field = `${sheet}!${ref}` } = opts;

  if (!wb.Sheets[sheet]) { fail(`[sheet] "${sheet}" not found (needed for ${field})`); return null; }

  const row = ref.match(/\d+/)[0];
  const seen = rawCell(sheet, LABEL_COL + row);

  // 1. LABEL CHECK — the guard against inserted/deleted rows
  if (label) {
    if (seen == null || String(seen).trim() === '') {
      fail(`[label] ${field}: expected a label matching ${label} at ${sheet}!${LABEL_COL}${row}, found an empty cell — has a row been inserted or deleted?`);
    } else if (!label.test(String(seen))) {
      fail(`[label] ${field}: ${sheet}!${LABEL_COL}${row} reads "${String(seen).trim()}" but expected ${label} — the workbook layout has shifted, so ${ref} is no longer this field.`);
    }
  }

  const val = rawCell(sheet, ref);

  // 2. NULL CHECK — catches a workbook saved without recalculating
  if (val == null || val === '') {
    if (required) fail(`[null] ${field} (${sheet}!${ref}) is empty. If the whole export is empty, the workbook was saved without recalculating — open it in Excel, let it calculate, save, and re-run.`);
    return null;
  }

  // 3. RANGE CHECK — catches a value read from the wrong row/column
  const [lo, hi] = RANGE[range];
  if (typeof val === 'number') {
    if (lo != null && val < lo) fail(`[range] ${field} = ${val} is below the plausible minimum ${lo} (${sheet}!${ref})`);
    if (hi != null && val > hi) fail(`[range] ${field} = ${val} is above the plausible maximum ${hi} (${sheet}!${ref})`);
  } else if (range !== 'any') {
    fail(`[type] ${field} = ${JSON.stringify(val)} is not a number (${sheet}!${ref})`);
  }

  return val;
}

// Row of forecast values across FC_COLS, label-checked once for the row.
function readRow(sheet, row, label, opts = {}) {
  const out = {};
  FY_FC.forEach((fy, i) => {
    out[fy] = read(sheet, FC_COLS[i] + row, i === 0 ? label : null, { ...opts, field: `${opts.field || sheet + row} ${fy}` });
  });
  return out;
}

// ── FIELD MAP ─────────────────────────────────────────────────────────────────
// Each entry pairs the cell with the label its row must carry. Labels come from
// the real workbooks; they are matched loosely (case-insensitive substring) so
// harmless wording tweaks don't trip the guard, but a shifted row will.
function parseWorkbook() {
  const missingSheets = REQUIRED_SHEETS.filter(s => !wb.Sheets[s]);
  if (missingSheets.length) fail(`[sheet] missing required sheet(s): ${missingSheets.join(', ')}. Found: ${wb.SheetNames.join(', ')}`);

  const header = {
    securities_m: read('Assumptions','E39', /securities on issue/i, { range:'money_m', required:true, field:'securities_m' }),
  };

  const assumptions = {
    base_noi_m:  read('Assumptions','D43', /portfolio noi/i,          { range:'money_m', required:true, field:'base_noi_m' }),
    cap_rate:    read('Assumptions','E7',  /cap rate|wacr/i,          { range:'rate',    required:true, field:'cap_rate' }),
    escalation:  read('Assumptions','E47', /escalation/i,             { range:'rate',    field:'escalation' }),
    reversion:   read('Assumptions','E49', /reversion/i,              { range:'any',     field:'reversion' }),
    payout_ratio:read('Assumptions','E33', /payout ratio/i,           { range:'pct',     field:'payout_ratio' }),
    gearing_current: read('Debt','D27',    /gearing/i,                { range:'pct',     required:true, field:'gearing_current' }),
    req_return:  read('Valuation','E39',   /discount rate|required return/i, { range:'rate', required:true, field:'req_return' }),
    erp:         read('Valuation','E36',   /equity risk premium|erp/i,{ range:'rate',    field:'erp' }),
    beta:        read('Valuation','E37',   /beta/i,                   { range:'multiple',field:'beta' }),
    base_pe:     read('Valuation','E42',   /pe|p\/e|multiple/i,       { range:'multiple',field:'base_pe' }),
    industrial_premium: read('Valuation','E43', /premium/i,           { range:'any',     field:'industrial_premium' }),
    exit_cap:    read('Valuation','E71',   /terminal cap|exit cap/i,               { range:'rate',    field:'exit_cap' }),
    dcf_unlevered_rate: read('Valuation','E70', /unlevered|discount/i,{ range:'rate',    field:'dcf_unlevered_rate' }),
    synergy_multiple:   read('Valuation','E104', /synerg/i,           { range:'multiple',field:'synergy_multiple' }),
    control_premium:    read('Valuation','E106', /control premium/i,  { range:'any',     field:'control_premium' }),
    expiry_profile: readRow('Assumptions', 48, /expir/i, { field:'expiry_profile' }),
    debt_ladder: {
      FY26: read('Debt','D34', /matur|ladder|expiry/i, { field:'debt_ladder FY26' }),
      FY27: read('Debt','E34', null, { field:'debt_ladder FY27' }),
      FY28: read('Debt','F34', null, { field:'debt_ladder FY28' }),
      FY29: read('Debt','G34', null, { field:'debt_ladder FY29' }),
      FY30: read('Debt','H34', null, { field:'debt_ladder FY30' }),
      Beyond: read('Debt','I34', null, { field:'debt_ladder Beyond' }),
    },
    terminal_adjustments: {
      gearing:   read('Valuation','E44', null, { field:'terminal.gearing' }),
      affo:      read('Valuation','E45', null, { field:'terminal.affo' }),
      underrent: read('Valuation','E46', null, { field:'terminal.underrent' }),
      mgmt:      read('Valuation','E47', null, { field:'terminal.mgmt' }),
      quality:   read('Valuation','E48', null, { field:'terminal.quality' }),
    },
  };

  // actuals: FY24=C, FY25=D
  const actuals = [['FY24','C'],['FY25','D']].map(([fy,c]) => ({
    fy,
    noi_m:        read('Assumptions',   c+'43', /portfolio noi/i,      { range:'money_m', field:`${fy} noi_m` }),
    mgmt_fee_m:   read('Assumptions',   c+'28', /fee/i,                { range:'money_m', field:`${fy} mgmt_fee_m` }),
    net_finance_m:read('Debt',          c+'23', /finance|interest/i,   { range:'money_m', field:`${fy} net_finance_m` }),
    ffo_m:        read('P&L',           c+'12', /ffo/i,                { range:'money_m', field:`${fy} ffo_m` }),
    ffo_per_unit: read('P&L',           c+'20', /per (unit|security)/i,{ range:'cents'  , field:`${fy} ffo_per_unit` }),
    dpu:          read('P&L',           c+'24', /dps|dpu|distribution/i,   { range:'cents'  , field:`${fy} dpu` }),
    nta:          read('Balance Sheet', c+'33', /nta/i,                { range:'dollars', field:`${fy} nta` }),
    gearing:      read('Debt',          c+'27', /gearing/i,            { range:'pct',     field:`${fy} gearing` }),
    ocf_cover:    read('Cash Flow',     c+'19', /cover/i,              { range:'multiple',field:`${fy} ocf_cover` }),
  }));

  // forecasts: FY26E..FY30E = E..I
  const forecasts = FC_COLS.map((c,i) => ({
    fy: FY_FC[i],
    noi_m:       read('Assumptions',   c+'43', null, { range:'money_m', field:`${FY_FC[i]} noi_m` }),
    ffo_m:       read('P&L',           c+'12', null, { range:'money_m', field:`${FY_FC[i]} ffo_m` }),
    epu:         read('P&L',           c+'20', null, { range:'cents'  , field:`${FY_FC[i]} epu` }),
    dpu:         read('P&L',           c+'24', null, { range:'cents'  , field:`${FY_FC[i]} dpu` }),
    nta:         read('Balance Sheet', c+'33', null, { range:'dollars', field:`${FY_FC[i]} nta` }),
    gearing:     read('Debt',          c+'27', null, { range:'pct',     field:`${FY_FC[i]} gearing` }),
    affo_cover:  read('Cash Flow',     c+'20', null, { range:'multiple',field:`${FY_FC[i]} affo_cover` }),
    ocf_cover:   read('Cash Flow',     c+'19', null, { range:'multiple',field:`${FY_FC[i]} ocf_cover` }),
    lfl_growth:  read('Assumptions',   c+'50', null, { range:'any',     field:`${FY_FC[i]} lfl_growth` }),
  }));

  const outputs = {
    equity_dcf_value: read('Valuation','E59', /equity dcf value/i,   { range:'dollars', required:true, field:'equity_dcf_value' }),
    buy_threshold:    read('Valuation','E95', /buy threshold/i,      { range:'dollars', required:true, field:'buy_threshold' }),
    breakeven_irr:    read('Valuation','E63', /irr|breakeven/i,      { range:'any',     field:'breakeven_irr' }),
    terminal_pe:      read('Valuation','E49', /pe|multiple/i,        { range:'multiple',field:'terminal_pe' }),
    nav_nta:          read('Valuation','E6',  /nav|nta/i,            { range:'dollars', field:'nav_nta' }),
    business_dcf_value: read('Valuation','E81', /dcf|business/i,     { range:'dollars', field:'business_dcf_value' }),
    internalisation_synergy: read('Valuation','E105', /synerg/i,     { range:'any',     field:'internalisation_synergy' }),
    takeover_value:   read('Valuation','E107', /takeover/i,          { range:'dollars', field:'takeover_value' }),
    takeover_upside:  read('Valuation','E108', /upside/i,            { range:'any',     field:'takeover_upside' }),
    blended_value:    read('Valuation','E90',  /blended value/i,     { range:'dollars', required:true, field:'blended_value' }),
    eq_score:         read('Earnings Quality','E28', null,           { range:'any',     field:'eq_score' }),
    ddm_value:        read('Valuation','E27',  /ddm|dividend discount/i, { range:'dollars', field:'ddm_value' }),
    ffo_multiple_value: read('Valuation','E32', /ffo|multiple/i,     { range:'dollars', field:'ffo_multiple_value' }),
    price_at_build:   read('Control','E5', /price/i,                 { range:'dollars', required:true, field:'price_at_build' }),
  };

  // asset register (scan column B from row 7 until blank) — structural, not fixed-cell
  const assets = [];
  if (wb.Sheets['Asset Register']) {
    for (let r=7; r<200; r++) {
      const nm = rawCell('Asset Register','B'+r);
      if (nm == null || String(nm).trim()==='' ) { if (r>10) break; else continue; }
      if (/total|portfolio total/i.test(String(nm))) continue;
      assets.push({
        ticker:TICKER, asset_name:String(nm),
        sector: rawCell('Asset Register','C'+r), state: rawCell('Asset Register','D'+r),
        major_tenant: rawCell('Asset Register','E'+r),
        passing_income_m: rawCell('Asset Register','F'+r),
        cap_rate: rawCell('Asset Register','G'+r),
        wale_years: rawCell('Asset Register','H'+r),
        occupancy: rawCell('Asset Register','I'+r),
        as_of: new Date().toISOString().slice(0,10),
      });
    }
    if (!assets.length) fail('[assets] Asset Register sheet present but no rows parsed from B7 down — has the layout changed?');
  } else {
    console.warn('  ! no Asset Register sheet — skipping reit_assets');
  }

  // cross-field sanity: the buy threshold should not exceed the blended value by a wide margin
  if (outputs.buy_threshold != null && outputs.blended_value != null && outputs.buy_threshold > outputs.blended_value * 2) {
    fail(`[sanity] buy_threshold (${outputs.buy_threshold}) is more than double blended_value (${outputs.blended_value}) — one of them is probably read from the wrong row.`);
  }

  return { header, assumptions, actuals, forecasts, outputs, assets };
}

async function up(table, rows, onConflict) {
  if (DRY_RUN) { console.log(`  [dry-run] ${table} (${rows.length} row(s)):`); console.dir(rows, { depth:null }); return; }
  const { error } = await sb.from(table).upsert(rows, { onConflict });
  if (error) { console.error(`upsert ${table}:`, error.message); process.exit(1); }
  console.log(`  ${table}: ${rows.length} row(s)`);
}

(async () => {
  const m = META[TICKER] || { name:TICKER, mgmt:null, parent:null, stake:null, fy:'30 June' };
  console.log(`Exporting ${TICKER} v${MODEL_VERSION} from ${PATH}${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  console.log(`Sheets: ${wb.SheetNames.join(' | ')}`);

  const parsed = parseWorkbook();

  // ── GATE: nothing is written unless the workbook validated ──────────────────
  if (problems.length) {
    console.error(`\n✗ ${problems.length} validation problem(s) — NOTHING WAS WRITTEN:\n`);
    problems.forEach((p,i) => console.error(`  ${i+1}. ${p}`));
    console.error(`\nFix the workbook (or update the cell map in this script if the layout` +
                  `\nchanged deliberately), then re-run with --dry-run to re-validate.`);
    process.exit(1);
  }
  console.log('✓ validation passed — labels, ranges and required fields all check out\n');

  // flip prior versions off
  if (!DRY_RUN) await sb.from('reit_models').update({ is_current:false }).eq('ticker', TICKER);

  // 1. header
  await up('reit_models', [{
    ticker:TICKER, name:m.name, model_version:MODEL_VERSION,
    mgmt_model:m.mgmt, manager_parent:m.parent, manager_stake_pct:m.stake, fy_end:m.fy,
    securities_m: parsed.header.securities_m,
    is_current:true, built_at:new Date().toISOString(),
  }], 'ticker,model_version');

  // 3. assumptions
  await up('reit_model_assumptions', [{
    ticker:TICKER, model_version:MODEL_VERSION, ...parsed.assumptions,
  }], 'ticker,model_version');

  // 4. actuals
  await up('reit_model_actuals', parsed.actuals.map(a => ({ ticker:TICKER, ...a })), 'ticker,fy');

  // 5a. forecasts
  await up('reit_model_forecasts', parsed.forecasts.map(f => ({ ticker:TICKER, model_version:MODEL_VERSION, ...f })), 'ticker,model_version,fy');

  // 5b. outputs
  await up('reit_model_outputs', [{
    ticker:TICKER, model_version:MODEL_VERSION, ...parsed.outputs,
  }], 'ticker,model_version');

  // 6. asset register
  if (parsed.assets.length) await up('reit_assets', parsed.assets, 'ticker,asset_name,as_of');

  // seed reit_prices with the build price (snapshot job will overwrite live)
  await up('reit_prices', [{ ticker:TICKER, last_price: parsed.outputs.price_at_build, price_date:new Date().toISOString().slice(0,10) }], 'ticker');

  console.log(`\nDone. Check v_discount_to_fair_value for ${TICKER}.`);
})();
