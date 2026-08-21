#!/usr/bin/env node
/* RECONCILIATION HARNESS
 * ======================
 * Runs the three-statement engine exactly as the browser does and tests year 1
 * against what the company published. This is the only out-of-sample test a
 * forward model has: the REIT tells you its own next-year FFO and DPS, and a
 * model that cannot reproduce them is not a model, it is a template with the
 * REIT's name on it.
 *
 * Data below is a verbatim snapshot of the Supabase rows as at 2026-08-19, so
 * a run is reproducible and any change in the numbers is a change in the ENGINE
 * rather than in the data underneath it. Re-snapshot when the packs update.
 *
 *   node scripts/reconcile.js            all names, summary
 *   node scripts/reconcile.js CIP        one name, full detail
 *   node scripts/reconcile.js CIP --fix  apply the corrected seeding
 */
const RM = require('../public/reit-model.js');

// ── SNAPSHOT ────────────────────────────────────────────────────────────────
// reit_fundamentals, latest release per ticker.
const FUNDAMENTALS = {
  CIP: { period_end:'2026-06-30', release_date:'2026-08-10', period_months:12,
         npi:null, portfolio_value:3934000000, cost_of_debt:null,
         guidance_fy:'FY27', guidance_ffo_low:0.188, guidance_ffo_high:0.192, guidance_dps:0.173,
         lfl_noi_growth:0.052, ffo:114100000, affo:null, dps:0.1680, nta:4.01, wacr:0.0580,
         gearing:0.3490, icr:2.4, hedge_pct:0.540, hedge_maturity:null, occupancy:0.9520, wale:7.0 },
  DXI: { period_end:'2026-06-30', release_date:'2026-08-11', period_months:12,
         npi:null, portfolio_value:1500000000, cost_of_debt:null,
         guidance_fy:'FY27', guidance_ffo_low:0.170, guidance_ffo_high:0.170, guidance_dps:0.166,
         lfl_noi_growth:0.053, ffo:55700000, affo:null, dps:0.1660, nta:3.42, wacr:0.0591,
         gearing:0.3120, icr:null, hedge_pct:0.540, hedge_maturity:null, occupancy:0.9880, wale:5.2 },
  DXC: null,   // no results pack captured
};

// reit_model_assumptions (the workbook layer).
const WORKBOOK = {
  CIP: { base_noi_m:195.6, cap_rate:0.0515, exit_cap:0.056, escalation:0.035, reversion:0.13,
         req_return:0.12, payout_ratio:0.93, gearing_current:0.347, base_pe:14,
         occupancy:null, fee_rate_gav:null, cost_of_debt:null, hedge_ratio:null,
         expiry_profile:{FY26E:0.043,FY27E:0.117,FY28E:0.089,FY29E:0.149,FY30E:0.12} },
  DXI: { base_noi_m:85, cap_rate:0.0591, exit_cap:0.0575, escalation:0.033, reversion:0.06,
         req_return:0.12, payout_ratio:0.93, gearing_current:0.29, base_pe:14,
         occupancy:null, fee_rate_gav:null, cost_of_debt:null, hedge_ratio:null,
         expiry_profile:{FY26E:0.043,FY27E:0.068,FY28E:0.197,FY29E:0.096,FY30E:0.142} },
  DXC: { base_noi_m:46, cap_rate:0.064, exit_cap:0.0625, escalation:0.029, reversion:0,
         req_return:0.12, payout_ratio:1, gearing_current:0.302, base_pe:14,
         occupancy:null, fee_rate_gav:null, cost_of_debt:null, hedge_ratio:null,
         expiry_profile:{FY26E:0.04,FY27E:0.05,FY28E:0.06,FY29E:0.07,FY30E:0.09} },
};

// reit_models.securities_m
const SECURITIES = { CIP:634.9, DXI:317.27, DXC:143 };
const PRICES     = { CIP:2.99,  DXI:2.36,   DXC:2.73 };

/* reit_assets roll-up. CIP is a REAL 83-asset compendium register. DXI and DXC
 * are the workbook's sector summary rows (9 and 3 lines that sum exactly to the
 * FY25 NOI) — a roll-up of a summary is not bottom-up, and pretending otherwise
 * is how a blended cap rate gets laundered into looking asset-level. */
const ROLLUP = {
  CIP: { real:true,  assets:83, income_m:225.4, value_m:3885, cap:0.0580 },
  DXI: { real:false, assets:9,  income_m:85.0,  value_m:1388, cap:0.0612 },
  DXC: { real:false, assets:3,  income_m:46.0,  value_m:722,  cap:0.0637 },
};

// ── SEEDING ─────────────────────────────────────────────────────────────────
/* CURRENT: mirrors seedAssumptions() in index.html, no-scenario branch. It
 * builds an explicit field list and therefore silently DROPS every calibrated
 * assumption that is not named in it. */
function seedCurrent(tk) {
  const D = RM.DEFAULTS, a = WORKBOOK[tk] || {}, f = FUNDAMENTALS[tk];
  const roll = rollupAssumptions(tk);
  const cal = f ? RM.calibrateFromActuals(f, { securities_m: SECURITIES[tk] }) : null;
  return {
    ...D,
    base_noi_m:      roll?.base_noi_m ?? a.base_noi_m ?? null,
    cap_rate:        roll?.cap_rate ?? a.cap_rate ?? null,
    opening_investment_properties_m: roll?.opening_investment_properties_m ?? null,
    escalation:      a.escalation ?? D.escalation,
    reversion:       a.reversion ?? D.reversion,
    gearing_target:  cal?.assumptions.gearing_target ?? a.gearing_current ?? D.gearing_target,
    cost_of_debt:    cal?.assumptions.cost_of_debt ?? a.cost_of_debt ?? D.cost_of_debt,
    hedge_ratio:     cal?.assumptions.hedge_ratio ?? a.hedge_ratio ?? D.hedge_ratio,
    occupancy:       cal?.assumptions.occupancy ?? a.occupancy ?? D.occupancy,
    base_occupancy:  cal?.assumptions.base_occupancy ?? a.occupancy ?? D.base_occupancy,
    like_for_like_growth: cal?.assumptions.like_for_like_growth ?? null,
    mgmt_fee_pct_gav: a.fee_rate_gav ?? D.mgmt_fee_pct_gav,
    payout_ratio:    a.payout_ratio ?? D.payout_ratio,
    required_return: a.req_return ?? D.required_return,
    exit_cap_rate:   a.exit_cap ?? null,
    ffo_multiple:    a.base_pe ?? D.ffo_multiple,
    securities_m:    SECURITIES[tk] ?? null,
  };
}

/* FIXED: the precedence the comment in index.html actually describes —
 * defaults < workbook < asset roll-up < reported actuals. Each layer is closer
 * to the truth than the one before, so each is spread WHOLE over the last.
 * Nothing has to be named twice, so nothing can be forgotten. */
function seedFixed(tk) {
  const D = RM.DEFAULTS, a = WORKBOOK[tk] || {}, f = FUNDAMENTALS[tk];
  const roll = rollupAssumptions(tk);
  const cal = f ? RM.calibrateFromActuals(f, { securities_m: SECURITIES[tk] }) : null;
  const fromWorkbook = clean({
    base_noi_m: a.base_noi_m, cap_rate: a.cap_rate, escalation: a.escalation,
    reversion: a.reversion, occupancy: a.occupancy, base_occupancy: a.occupancy,
    gearing_target: a.gearing_current, cost_of_debt: a.cost_of_debt,
    hedge_ratio: a.hedge_ratio, mgmt_fee_pct_gav: a.fee_rate_gav,
    payout_ratio: a.payout_ratio, required_return: a.req_return,
    exit_cap_rate: a.exit_cap, ffo_multiple: a.base_pe,
  });
  const out = { ...D, ...fromWorkbook, ...(roll||{}), ...(cal?.assumptions||{}),
                securities_m: SECURITIES[tk] ?? null };
  delete out._derived_interest_m;

  /* The opening balance sheet must come from the SAME pack as everything else.
   * Equity is NTA x securities; net debt is what gearing implies against it.
   * Left to the default the model starts from an invented balance sheet and
   * every interest number after it is wrong. */
  if (f?.nta != null && SECURITIES[tk] && f.gearing != null) {
    const equity = Number(f.nta) * SECURITIES[tk];
    const totalAssets = equity / (1 - Number(f.gearing));
    out.opening_net_debt_m = totalAssets - equity;
  }
  return out;
}

function rollupAssumptions(tk) {
  const r = ROLLUP[tk];
  if (!r || !r.real) return null;    // a summary is not an asset register
  return { base_noi_m: r.income_m, cap_rate: r.cap, opening_investment_properties_m: r.value_m };
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([,v]) => v != null));

// ── REPORT ──────────────────────────────────────────────────────────────────
const pc = v => v == null ? '   —  ' : (v*100).toFixed(2).padStart(6);
const c  = v => v == null ? '  —  ' : (v*100).toFixed(1).padStart(5) + 'c';

function run(tk, seed, label) {
  const f = FUNDAMENTALS[tk];
  const asm = seed(tk);
  const m = RM.buildModel(asm, { subclass:'landlord' });
  if (!m.ok) return { tk, label, ok:false, errors:m.errors };

  const y1 = m.years[0];
  const gv = f ? RM.validateAgainstGuidance(m, f) : null;
  const ffoErr = (f?.guidance_ffo_low != null && y1.ffo_per_unit != null)
    ? (y1.ffo_per_unit - (f.guidance_ffo_low + f.guidance_ffo_high)/2) / ((f.guidance_ffo_low + f.guidance_ffo_high)/2) : null;
  const dpsErr = (f?.guidance_dps != null && y1.dpu != null)
    ? (y1.dpu - f.guidance_dps) / f.guidance_dps : null;

  return { tk, label, ok:true, asm, m, y1, gv, ffoErr, dpsErr,
           articulates: m.articulates, checks: m.checks,
           value: m.valuation?.blended_value ?? null };
}

function line(r) {
  if (!r.ok) return `${r.tk.padEnd(4)} ${r.label.padEnd(9)} BUILD FAILED — ${r.errors.join('; ')}`;
  const f = FUNDAMENTALS[r.tk];
  return `${r.tk.padEnd(4)} ${r.label.padEnd(9)}` +
    ` FFO ${c(r.y1.ffo_per_unit)} vs ${f ? c((f.guidance_ffo_low+f.guidance_ffo_high)/2) : '  n/a'}` +
    ` (${r.ffoErr==null?'  —  ':((r.ffoErr>0?'+':'')+(r.ffoErr*100).toFixed(1)+'%').padStart(7)})` +
    `  DPS ${c(r.y1.dpu)} vs ${f ? c(f.guidance_dps) : '  n/a'}` +
    ` (${r.dpsErr==null?'  —  ':((r.dpsErr>0?'+':'')+(r.dpsErr*100).toFixed(1)+'%').padStart(7)})` +
    `  ${r.gv ? r.gv.verdict.padEnd(14) : 'NO_GUIDANCE   '}` +
    ` ${r.articulates ? 'articulates' : 'BREAKS ('+r.checks.length+')'}`;
}

function detail(r) {
  if (!r.ok) { console.log('  build failed: ' + r.errors.join('; ')); return; }
  const f = FUNDAMENTALS[r.tk], a = r.asm;
  console.log('\n  ── Assumptions in force ──');
  [['base_noi_m','$m NPI'],['cap_rate','cap'],['occupancy','occ'],['base_occupancy','base occ'],
   ['like_for_like_growth','LFL'],['escalation','escalation'],['reversion','reversion'],
   ['gearing_target','gearing'],['cost_of_debt','cost of debt'],['hedge_ratio','hedged'],
   ['mgmt_fee_pct_gav','mgmt fee %GAV'],['admin_cost_m','$m admin'],['payout_ratio','payout'],
   ['payout_basis','basis'],['opening_investment_properties_m','$m opening book'],
   ['opening_net_debt_m','$m opening net debt'],['securities_m','securities m']]
    .forEach(([k,l]) => {
      const v = a[k];
      const shown = v == null ? '—' : typeof v === 'number'
        ? (k.includes('_m')||k==='securities_m'||k==='ffo_multiple' ? v.toFixed(1) : (v*100).toFixed(2)+'%') : v;
      console.log(`    ${l.padEnd(22)} ${String(shown).padStart(10)}`);
    });

  console.log('\n  ── Year 1 vs the pack ──');
  const rows = [
    ['NPI $m',        r.m.years[0].npi,           null],
    ['FFO $m',        r.m.years[0].ffo_m,         f ? f.ffo/1e6 : null],
    ['FFO per unit',  r.m.years[0].ffo_per_unit,  f ? (f.guidance_ffo_low+f.guidance_ffo_high)/2 : null],
    ['DPU',           r.m.years[0].dpu,           f ? f.guidance_dps : null],
    ['NTA',           r.m.years[0].nta,           f ? f.nta : null],
    ['Gearing',       r.m.years[0].gearing,       f ? f.gearing : null],
    ['AFFO cover',    r.m.years[0].affo_cover,    null],
    ['ICR',           r.m.years[0].icr,           f ? f.icr : null],
  ];
  rows.forEach(([l, mod, rep]) => {
    const err = (mod != null && rep) ? (mod - rep)/rep : null;
    console.log(`    ${l.padEnd(14)} model ${fmt(mod).padStart(9)}   reported ${fmt(rep).padStart(9)}   ${
      err == null ? '' : ((err>0?'+':'')+(err*100).toFixed(1)+'%').padStart(8)}`);
  });
  if (r.gv?.message) console.log('\n  ' + r.gv.message);
  if (!r.articulates) {
    console.log('\n  ARTICULATION BREAKS:');
    r.checks.forEach(ch => console.log(`    yr${ch.year} ${ch.check} gap ${ch.gap_m}`));
  }
  console.log(`\n  Blended value $${r.value != null ? r.value.toFixed(2) : '—'} vs price $${PRICES[r.tk].toFixed(2)}`);
}
const fmt = v => v == null ? '—' : Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(1);

/* ── DRIVERS ────────────────────────────────────────────────────────────────
 * The same probe the assumption editor runs in the browser: rebuild the model
 * at value ± one meaningful step and report half the spread in fair value. It
 * lives here as well as in the page so the ranking can be checked against a
 * fixed snapshot — a lever table that quietly reorders because a build failed
 * on one side would otherwise look like a finding.
 *
 * Steps are in DISPLAY units, so 0.25 on a cap rate is 25 basis points. */
const DRIVERS = [
  ['cap_rate',        0.25, '25bps', true],
  ['required_return', 0.50, '50bps', true],
  ['exit_cap_rate',   0.25, '25bps', true],
  ['cost_of_debt',    0.50, '50bps', true],
  ['escalation',      0.25, '25bps', true],
  ['reversion',       5.0,  '5pp',   true],
  ['payout_ratio',    5.0,  '5pp',   true],
  ['gearing_target',  5.0,  '5pp',   true],
];

function drivers(tk) {
  const asm = seedFixed(tk);
  const base = RM.buildModel(asm, { subclass:'landlord' });
  if (!base.ok) { console.log(`${tk}: base model will not build — ${base.errors.join('; ')}`); return; }
  const v0 = base.valuation?.blended_value;

  const probes = DRIVERS.map(([key, probe, plabel, isPct]) => {
    const b = asm[key];
    if (b == null) return { key, plabel, swing:null, why:'not set' };
    const step = isPct ? probe/100 : probe;
    const up = RM.buildModel({ ...asm, [key]: b + step }, { subclass:'landlord' });
    const dn = RM.buildModel({ ...asm, [key]: b - step }, { subclass:'landlord' });
    const uv = up.ok ? up.valuation?.blended_value : null;
    const dv = dn.ok ? dn.valuation?.blended_value : null;
    return { key, plabel, base:b, uv, dv,
             swing: (uv != null && dv != null) ? Math.abs(uv - dv)/2 : null,
             why: uv == null ? 'up build failed' : dv == null ? 'down build failed' : null };
  });

  console.log(`\n${tk} — fair value $${v0 != null ? v0.toFixed(2) : '—'} vs price $${PRICES[tk].toFixed(2)}`);
  console.log('  ' + 'DRIVER'.padEnd(18) + 'VALUE'.padStart(9) + '  ' + 'SWING'.padStart(8) + '  PER      DIRECTION');
  probes.filter(p => p.swing != null).sort((a,b) => b.swing - a.swing)
    .concat(probes.filter(p => p.swing == null))
    .forEach((p, i) => {
      const shown = p.base == null ? '—' : (DRIVERS.find(d => d[0] === p.key)[3] ? (p.base*100).toFixed(2)+'%' : String(p.base));
      console.log(`  ${String(i+1).padStart(2)}. ${p.key.padEnd(14)}${shown.padStart(9)}  ${
        p.swing == null ? ('— ' + p.why).padStart(8) : ('$'+p.swing.toFixed(3)).padStart(8)}  ${
        (p.plabel||'').padEnd(7)}  ${p.swing == null ? '' : p.uv > p.dv ? 'raises value' : p.uv < p.dv ? 'lowers value' : 'flat'}`);
    });
}

/* ── WALK ───────────────────────────────────────────────────────────────────
 * The same reconciliation the stock page prints: last reported NPI to first
 * forecast DPU, one line at a time. Run it here to confirm the engine's own
 * workings carry the line the page reads — a bridge that silently loses a step
 * still adds up, and looks finished. */
function walk(tk) {
  const asm = seedFixed(tk);
  const m = RM.buildModel(asm, { subclass:'landlord' });
  if (!m.ok) { console.log(`${tk}: ${m.errors.join('; ')}`); return; }
  const y = m.years[0], wk = y.workings || {}, secs = asm.securities_m;
  const prior = wk.noi_grown?.inputs?.prior_npi;
  const pu = v => v == null || !secs ? '     —' : ((v/secs)*100).toFixed(2).padStart(6) + 'c';
  const $m = v => v == null ? '      —' : v.toFixed(1).padStart(7);
  const L = (l, v) => console.log(`  ${l.padEnd(26)}${$m(v)}  ${pu(v)}`);

  console.log(`\n${tk} — last reported NPI to first forecast distribution`);
  if (prior == null) console.log('  !! workings.noi_grown.inputs.prior_npi MISSING — the page cannot show the base');
  L('Prior NPI (reported)', prior);
  L(`LFL growth ${(y.lfl_growth*100).toFixed(2)}%`, prior != null ? y.npi - prior : null);
  L('= Forecast NPI', y.npi);
  L('less management fee', y.mgmt_fee_m ? -y.mgmt_fee_m : 0);
  L('less corporate admin', -y.admin_m);
  L('= EBIT', y.ebit_m);
  L('less net finance cost', -y.net_finance_m);
  L('= FFO', y.ffo_m);
  L('less distributions', -y.distributions_m);
  L('= Retained', y.ffo_m - y.distributions_m);

  const v = m.valuation, W = v.weights || {};
  const valOf = k => k === 'ffo_multiple' ? v.ffo_multiple_value : v[k];
  console.log('\n  Methods reconciling to the blend:');
  let sum = 0;
  Object.keys(W).filter(k => W[k] > 0 && valOf(k) != null).forEach(k => {
    const c = valOf(k) * W[k]; sum += c;
    console.log(`    ${k.padEnd(16)} $${valOf(k).toFixed(2).padStart(6)} x ${(W[k]*100).toFixed(0).padStart(3)}%  = $${c.toFixed(3)}`);
  });
  console.log(`    ${'blended'.padEnd(16)} ${' '.repeat(9)}${' '.repeat(6)}  = $${sum.toFixed(3)}  (engine says $${v.blended_value.toFixed(3)})`);
  if (Math.abs(sum - v.blended_value) > 0.005) console.log('    !! contributions do NOT sum to the blended value — the page would show an unreconciled total');
}

// ── MAIN ────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
const only = arg && !arg.startsWith('--') ? arg.toUpperCase() : null;
const tickers = only ? [only] : ['CIP','DXI','DXC'];

if (process.argv.includes('--walk')) {
  console.log('\nTHE WALK — reported to forecast, line by line\n' + '='.repeat(70));
  tickers.forEach(walk);
  console.log('');
  process.exit(0);
}

if (process.argv.includes('--drivers')) {
  console.log('\nDRIVER SENSITIVITY — fair-value swing per one step, model rebuilt each side\n' + '='.repeat(70));
  tickers.forEach(drivers);
  console.log('');
  process.exit(0);
}

console.log('\nRECONCILIATION — model year 1 against published FY27 guidance\n' + '='.repeat(118));
tickers.forEach(tk => {
  const cur = run(tk, seedCurrent, 'current');
  const fix = run(tk, seedFixed,  'fixed');
  console.log(line(cur));
  console.log(line(fix));
  if (only) { console.log('\n' + '-'.repeat(60) + '\nCURRENT SEEDING'); detail(cur);
              console.log('\n' + '-'.repeat(60) + '\nFIXED SEEDING');  detail(fix); }
  console.log('-'.repeat(118));
});
console.log('\nCALIBRATED = within 5% of guidance · LOOSE = within 15% · MISCALIBRATED = worse\n');
