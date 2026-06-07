#!/usr/bin/env node
/* =====================================================================
 * emit-model-sql.js  -  workbook -> SQL upserts (MCP load path)
 *
 * Same cell map as export-model.js, but instead of writing via supabase-js
 * (which needs the service key), it emits INSERT ... ON CONFLICT SQL to
 * stdout so the statements can be run through the Supabase MCP execute_sql
 * (admin rights via the PAT). Mirrors export-model.js exactly.
 *
 * Usage: node emit-model-sql.js TICKER "path.xlsx" [version] > out.sql
 * ===================================================================== */
const XLSX = require('xlsx');

const argv = process.argv.slice(2);
const [TICKER, PATH, VERSION_ARG] = argv;
if (!TICKER || !PATH) { console.error('usage: node emit-model-sql.js TICKER path.xlsx [version]'); process.exit(1); }
const MODEL_VERSION = parseInt(VERSION_ARG || '1', 10);
const AS_OF = new Date().toISOString().slice(0,10);
const BUILT_AT = new Date().toISOString();

const META = {
  DXI: { name:'Dexus Industria REIT',          mgmt:'external', parent:'Dexus (DXS)',     stake:18.6, fy:'30 June' },
  DXC: { name:'Dexus Convenience Retail REIT',  mgmt:'external', parent:'Dexus (DXS)',     stake:null, fy:'30 June' },
  CIP: { name:'Centuria Industrial REIT',       mgmt:'external', parent:'Centuria (CNI)',  stake:16.1, fy:'30 June' },
  REP: { name:'RAM Essential Services Property', mgmt:'external', parent:'RAM',            stake:null, fy:'30 June' },
  RGN: { name:'Region Group',                   mgmt:'internal', parent:null,              stake:null, fy:'30 June' },
  WPR: { name:'Waypoint REIT',                  mgmt:'internal', parent:null,              stake:null, fy:'30 June' },
};

const wb = XLSX.readFile(PATH, { cellFormula:false });
const FC_COLS = ['E','F','G','H','I'];
const FY_FC   = ['FY26E','FY27E','FY28E','FY29E','FY30E'];

const cell = (sheet, ref) => { const ws = wb.Sheets[sheet]; const c = ws && ws[ref]; return c == null ? null : c.v; };
const jObj = (sheet, r, fys, cols) => Object.fromEntries(fys.map((fy,i) => [fy, cell(sheet, cols[i] + r)]));

// --- SQL value serialization ---
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function upsert(table, rows, conflictCols) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const conflict = conflictCols.split(',').map(s => s.trim());
  const updates = cols.filter(c => !conflict.includes(c)).map(c => `${c}=EXCLUDED.${c}`);
  const valuesSql = rows.map(r => `  (${cols.map(c => sqlVal(r[c])).join(', ')})`).join(',\n');
  const doClause = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${valuesSql}\nON CONFLICT (${conflict}) ${doClause};`;
}

const m = META[TICKER] || { name:TICKER, mgmt:null, parent:null, stake:null, fy:'30 June' };
const out = [];
out.push(`-- ===== ${TICKER} v${MODEL_VERSION} (from ${PATH.split(/[\\/]/).pop()}) =====`);
out.push(`UPDATE reit_models SET is_current=false WHERE ticker=${sqlVal(TICKER)};`);

// 1. header
out.push(upsert('reit_models', [{
  ticker:TICKER, name:m.name, model_version:MODEL_VERSION,
  mgmt_model:m.mgmt, manager_parent:m.parent, manager_stake_pct:m.stake, fy_end:m.fy,
  securities_m: cell('Assumptions','E39'),
  is_current:true, built_at:BUILT_AT,
}], 'ticker,model_version'));

// 3. assumptions
out.push(upsert('reit_model_assumptions', [{
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
}], 'ticker,model_version'));

// 4. actuals
const actuals = [['FY24','C'],['FY25','D']].map(([fy,c]) => ({
  ticker:TICKER, fy,
  noi_m: cell('Assumptions',c+'43'), mgmt_fee_m: cell('Assumptions',c+'28'),
  net_finance_m: cell('Debt',c+'23'), ffo_m: cell('P&L',c+'12'),
  ffo_per_unit: cell('P&L',c+'20'), dpu: cell('P&L',c+'24'),
  nta: cell('Balance Sheet',c+'33'), gearing: cell('Debt',c+'27'),
  ocf_cover: cell('Cash Flow',c+'19'),
}));
out.push(upsert('reit_model_actuals', actuals, 'ticker,fy'));

// 5a. forecasts
const fc = FC_COLS.map((c,i) => ({
  ticker:TICKER, model_version:MODEL_VERSION, fy:FY_FC[i],
  noi_m: cell('Assumptions',c+'43'), ffo_m: cell('P&L',c+'12'),
  epu: cell('P&L',c+'20'), dpu: cell('P&L',c+'24'),
  nta: cell('Balance Sheet',c+'33'), gearing: cell('Debt',c+'27'),
  affo_cover: cell('Cash Flow',c+'20'), ocf_cover: cell('Cash Flow',c+'19'),
  lfl_growth: cell('Assumptions',c+'50'),
}));
out.push(upsert('reit_model_forecasts', fc, 'ticker,model_version,fy'));

// 5b. outputs
out.push(upsert('reit_model_outputs', [{
  ticker:TICKER, model_version:MODEL_VERSION,
  equity_dcf_value: cell('Valuation','E59'), buy_threshold: cell('Valuation','E95'),
  breakeven_irr: cell('Valuation','E63'), terminal_pe: cell('Valuation','E49'),
  nav_nta: cell('Valuation','E6'), business_dcf_value: cell('Valuation','E81'),
  internalisation_synergy: cell('Valuation','E105'), takeover_value: cell('Valuation','E107'),
  takeover_upside: cell('Valuation','E108'), blended_value: cell('Valuation','E90'),
  eq_score: cell('Earnings Quality','E28'), ddm_value: cell('Valuation','E27'),
  ffo_multiple_value: cell('Valuation','E32'), price_at_build: cell('Control','E5'),
}], 'ticker,model_version'));

// 6. asset register
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
      as_of: AS_OF,
    });
  }
}
if (assets.length) out.push(upsert('reit_assets', assets, 'ticker,asset_name,as_of'));

// also seed reit_prices
out.push(upsert('reit_prices', [{ ticker:TICKER, last_price: cell('Control','E5'), price_date:AS_OF }], 'ticker'));

process.stdout.write(out.filter(Boolean).join('\n\n') + '\n');
