#!/usr/bin/env node
/* =====================================================================
 * export-model.js  -  workbook -> Supabase (the value-layer bridge)
 *
 * Canonical copy (matches BUILD brief path `scripts/export-model.js`).
 * Same cell map + schema as the original in `areit models/`; the only change
 * is the credential line accepts EITHER env-var name so it works alongside the
 * Netlify functions (which use SUPABASE_SERVICE_KEY).
 *
 * Reads a BUILT + RECALCULATED REIT model .xlsx (cached cell values) and
 * upserts: reit_models, reit_model_assumptions, reit_model_actuals,
 * reit_model_forecasts, reit_model_outputs, reit_assets, reit_prices.
 *
 * Setup:   cd scripts && npm install
 * Usage:   node export-model.js DXI "../areit models/DXI_Dexus_Industria_Model.xlsx" [version]
 *          add --dry-run to PARSE + PRINT without writing (validate the parse first).
 * Env:     SUPABASE_URL, SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_KEY) — server only.
 *
 * IMPORTANT: the .xlsx must contain cached values (open/save in Excel, or it was
 * produced by the recalc step). SheetJS reads cell.v (the cached value); a file
 * saved without a recalc will export nulls.
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

const wb = XLSX.readFile(PATH, { cellFormula:false });
const FC_COLS = ['E','F','G','H','I'];          // forecast columns
const FY_FC   = ['FY26E','FY27E','FY28E','FY29E','FY30E'];

const cell = (sheet, ref) => { const ws = wb.Sheets[sheet]; const c = ws && ws[ref]; return c == null ? null : c.v; };
const jObj = (sheet, r, fys, cols) => Object.fromEntries(fys.map((fy,i) => [fy, cell(sheet, cols[i] + r)]));

async function up(table, rows, onConflict) {
  if (DRY_RUN) { console.log(`  [dry-run] ${table} (${rows.length} row(s)):`); console.dir(rows, { depth:null }); return; }
  const { error } = await sb.from(table).upsert(rows, { onConflict });
  if (error) { console.error(`upsert ${table}:`, error.message); process.exit(1); }
  console.log(`  ${table}: ${rows.length} row(s)`);
}

(async () => {
  const m = META[TICKER] || { name:TICKER, mgmt:null, parent:null, stake:null, fy:'30 June' };
  console.log(`Exporting ${TICKER} v${MODEL_VERSION} from ${PATH}${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);

  // flip prior versions off
  if (!DRY_RUN) await sb.from('reit_models').update({ is_current:false }).eq('ticker', TICKER);

  // 1. header
  await up('reit_models', [{
    ticker:TICKER, name:m.name, model_version:MODEL_VERSION,
    mgmt_model:m.mgmt, manager_parent:m.parent, manager_stake_pct:m.stake, fy_end:m.fy,
    securities_m: cell('Assumptions','E39'),
    // NB: price_at_build lives on reit_model_outputs (below), NOT reit_models —
    // including it here errors against the v2 schema. Corrected vs the original.
    is_current:true, built_at:new Date().toISOString(),
  }], 'ticker,model_version');

  // 3. assumptions
  await up('reit_model_assumptions', [{
    ticker:TICKER, model_version:MODEL_VERSION,
    base_noi_m: cell('Assumptions','D43'),
    cap_rate: cell('Assumptions','E7'),
    escalation: cell('Assumptions','E47'),
    reversion: cell('Assumptions','E49'),
    expiry_profile: jObj('Assumptions',48, FY_FC, FC_COLS),
    payout_ratio: cell('Assumptions','E33'),
    gearing_current: cell('Debt','D27'),
    debt_ladder: { FY26:cell('Debt','D34'),FY27:cell('Debt','E34'),FY28:cell('Debt','F34'),FY29:cell('Debt','G34'),FY30:cell('Debt','H34'),Beyond:cell('Debt','I34') },
    req_return: cell('Valuation','E39'),
    erp: cell('Valuation','E36'),
    beta: cell('Valuation','E37'),
    base_pe: cell('Valuation','E42'),
    industrial_premium: cell('Valuation','E43'),
    terminal_adjustments: { gearing:cell('Valuation','E44'), affo:cell('Valuation','E45'), underrent:cell('Valuation','E46'), mgmt:cell('Valuation','E47'), quality:cell('Valuation','E48') },
    exit_cap: cell('Valuation','E71'),
    dcf_unlevered_rate: cell('Valuation','E70'),
    synergy_multiple: cell('Valuation','E104'),
    control_premium: cell('Valuation','E106'),
  }], 'ticker,model_version');

  // 4. actuals (FY24=C, FY25=D)
  const actuals = [['FY24','C'],['FY25','D']].map(([fy,c]) => ({
    ticker:TICKER, fy,
    noi_m: cell('Assumptions',c+'43'), mgmt_fee_m: cell('Assumptions',c+'28'),
    net_finance_m: cell('Debt',c+'23'), ffo_m: cell('P&L',c+'12'),
    ffo_per_unit: cell('P&L',c+'20'), dpu: cell('P&L',c+'24'),
    nta: cell('Balance Sheet',c+'33'), gearing: cell('Debt',c+'27'),
    ocf_cover: cell('Cash Flow',c+'19'),
  }));
  await up('reit_model_actuals', actuals, 'ticker,fy');

  // 5a. forecasts (FY26E..FY30E = E..I)
  const fc = FC_COLS.map((c,i) => ({
    ticker:TICKER, model_version:MODEL_VERSION, fy:FY_FC[i],
    noi_m: cell('Assumptions',c+'43'), ffo_m: cell('P&L',c+'12'),
    epu: cell('P&L',c+'20'), dpu: cell('P&L',c+'24'),
    nta: cell('Balance Sheet',c+'33'), gearing: cell('Debt',c+'27'),
    affo_cover: cell('Cash Flow',c+'20'), ocf_cover: cell('Cash Flow',c+'19'),
    lfl_growth: cell('Assumptions',c+'50'),
  }));
  await up('reit_model_forecasts', fc, 'ticker,model_version,fy');

  // 5b. outputs
  await up('reit_model_outputs', [{
    ticker:TICKER, model_version:MODEL_VERSION,
    equity_dcf_value: cell('Valuation','E59'), buy_threshold: cell('Valuation','E95'),
    breakeven_irr: cell('Valuation','E63'), terminal_pe: cell('Valuation','E49'),
    nav_nta: cell('Valuation','E6'), business_dcf_value: cell('Valuation','E81'),
    internalisation_synergy: cell('Valuation','E105'), takeover_value: cell('Valuation','E107'),
    takeover_upside: cell('Valuation','E108'), blended_value: cell('Valuation','E90'),
    eq_score: cell('Earnings Quality','E28'), ddm_value: cell('Valuation','E27'),
    ffo_multiple_value: cell('Valuation','E32'), price_at_build: cell('Control','E5'),
  }], 'ticker,model_version');

  // 6. asset register (scan column B from row 7 until blank)
  const assets = [];
  if (wb.Sheets['Asset Register']) {
    for (let r=7; r<200; r++) {
      const nm = cell('Asset Register','B'+r);
      if (nm == null || String(nm).trim()==='' ) { if (r>10) break; else continue; }
      if (/total|portfolio total/i.test(String(nm))) continue;
      assets.push({
        ticker:TICKER, asset_name:String(nm),
        sector: cell('Asset Register','C'+r), state: cell('Asset Register','D'+r),
        major_tenant: cell('Asset Register','E'+r),
        passing_income_m: cell('Asset Register','F'+r),
        cap_rate: cell('Asset Register','G'+r),
        wale_years: cell('Asset Register','H'+r),
        occupancy: cell('Asset Register','I'+r),
        as_of: new Date().toISOString().slice(0,10),
      });
    }
  }
  if (assets.length) await up('reit_assets', assets, 'ticker,asset_name,as_of');

  // also seed reit_prices with the build price (snapshot job will overwrite live)
  await up('reit_prices', [{ ticker:TICKER, last_price: cell('Control','E5'), price_date:new Date().toISOString().slice(0,10) }], 'ticker');

  console.log(`Done. Check v_discount_to_fair_value for ${TICKER}.`);
})();
