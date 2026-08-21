// netlify/functions/run-valuation.js
// Runs the fundamental value engine over every REIT with a current model and
// appends a row to `valuation_runs` (SPEC.md §5).
//
// This function does ALL the I/O; `scripts/model-engine.js` stays pure so a
// stored run can be reproduced exactly from the `inputs` blob it writes.
//
// Manual run: POST /.netlify/functions/run-valuation
//   ?dry=1        compute and return, write nothing
//   ?ticker=DXI   restrict to one ticker
//
// UNITS: the engine normalises cents->dollars and $m->$ internally. What this
// function must get right is the ANNUALISATION of NPI: reit_fundamentals.npi is
// a flow over `period_months`, and feeding a half-year figure to the implied cap
// rate halves it — ~3% where the truth is ~6%, a wrong-but-plausible number
// driving a real-money signal.

const { getSupabase } = require('./_shared.js');
const ENGINE = require('../../scripts/model-engine.js');
const TAX = require('../../scripts/tax-engine.js');

const HURDLES = { irr: 0.12, yield: 0.07 };

/** stocks flags -> the engine's subclass, which selects the blend weights. */
function subclassOf(s) {
  if (!s) return 'landlord';
  if (s.reit_subclass) {
    const v = String(s.reit_subclass).toLowerCase();
    if (v.includes('manager')) return 'fund_manager';
    if (v.includes('develop')) return 'developer';
    if (v.includes('landlord')) return 'landlord';
  }
  if (s.is_fund_manager || s.is_manager) return 'fund_manager';
  if (s.is_developer) return 'developer';
  return 'landlord';
}

/* ── COMPLETENESS GATE ────────────────────────────────────────────────────────
 * A stored valuation is a real-money record: it drives the hurdle test, the
 * screens, and the morning email. A REIT missing half its inputs still produces
 * a number — the engine renormalises the blend over whatever methods survived —
 * and that number is indistinguishable on screen from one built on a full set.
 * A fair value derived from book NTA alone and a fair value derived from five
 * methods against a calibrated pack should not sit in the same column unlabelled.
 *
 * So by default only vehicles with the full financial set are WRITTEN. The rest
 * are still computed and returned, with the missing pieces named, so the response
 * doubles as the to-do list for what to ingest next. `?all=1` overrides.
 *
 * Guidance and an asset register are reported but NOT required: guidance is the
 * calibration test rather than a valuation input, and the asset register only
 * adds the SOTP lens. Everything in REQUIRED is load-bearing. */
function completeness(ctx) {
  const missing = [];
  if (!ctx.securities)     missing.push('securities on issue (reit_models)');
  if (!ctx.workbook)       missing.push('workbook assumptions (reit_model_assumptions)');
  if (!ctx.forecasts)      missing.push('forecasts (reit_model_forecasts)');
  if (!ctx.price)          missing.push('price (reit_prices)');
  if (!ctx.pack)           missing.push('a 12-month results pack (reit_fundamentals)');
  else {
    if (!ctx.portfolioValue) missing.push('portfolio value');
    if (!ctx.wacr)           missing.push('disclosed WACR');
    if (!ctx.nta)            missing.push('NTA');
    if (!ctx.gearing)        missing.push('gearing');
    if (!ctx.ffo)            missing.push('FFO');
    if (!ctx.dps)            missing.push('DPS');
  }
  return { complete: missing.length === 0, missing,
           optional: { guidance: !!ctx.guidance, asset_register: ctx.assets || 0 } };
}

exports.handler = async (event) => {
  const db = getSupabase();
  const qs = (event && event.queryStringParameters) || {};
  const dryRun = qs.dry === '1' || qs.dry === 'true';
  const writeAll = qs.all === '1' || qs.all === 'true';
  const only = qs.ticker ? String(qs.ticker).toUpperCase() : null;
  const asOf = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10); // AEST day

  const warnings = [];

  try {
    // ── current models ────────────────────────────────────────────────────────
    let mq = db.from('reit_models').select('*').eq('is_current', true);
    if (only) mq = mq.eq('ticker', only);
    const { data: models, error: mErr } = await mq;
    if (mErr) throw new Error(`reit_models: ${mErr.message}`);
    if (!models || !models.length) {
      return json(200, { ok: true, runs: 0, message: 'no current models to value', as_of: asOf });
    }

    const tickers = [...new Set(models.map(m => m.ticker))];

    // ── everything the engine needs, in as few round trips as possible ────────
    const [assumptions, forecasts, prices, stocks, fundamentals, assetRows, taxRows] = await Promise.all([
      db.from('reit_model_assumptions').select('*').in('ticker', tickers),
      db.from('reit_model_forecasts').select('*').in('ticker', tickers),
      db.from('reit_prices').select('*').in('ticker', tickers),
      db.from('stocks').select('*').in('ticker', tickers),
      db.from('reit_fundamentals').select('*').in('ticker', tickers)
        .order('release_date', { ascending: false }),
      db.from('reit_assets').select('*').in('ticker', tickers),
      db.from('tax_settings').select('*').lte('effective_from', asOf)
        .order('effective_from', { ascending: false }).limit(1),
    ]);

    // Tax settings are REQUIRED for the post-tax hurdle. Without them the run
    // still produces pre-tax figures rather than failing outright, but the 12%
    // and 7% tests are measured post-tax, so it must say so loudly.
    let settings = null;
    try {
      settings = TAX.resolveSettings(taxRows.data && taxRows.data[0]);
    } catch (e) {
      warnings.push(`tax_settings unavailable (${e.message}) — post-tax IRR and yield are null, ` +
                    `so the hurdle test cannot be evaluated. Seed public.tax_settings.`);
    }

    const by = (rows, key = 'ticker') => {
      const m = {};
      (rows || []).forEach(r => { (m[r[key]] = m[r[key]] || []).push(r); });
      return m;
    };
    const aMap = by(assumptions.data), fMap = by(forecasts.data), pMap = by(prices.data),
          sMap = by(stocks.data),      nMap = by(fundamentals.data),
          asMap = by(assetRows.data);

    const results = [];
    const incomplete = [];   // computed but deliberately not stored — see completeness()

    for (const model of models) {
      const tk = model.ticker;
      const a = (aMap[tk] || []).find(x => x.model_version === model.model_version) || (aMap[tk] || [])[0] || {};
      const fc = (fMap[tk] || []).filter(x => x.model_version === model.model_version);
      const px = (pMap[tk] || [])[0] || {};
      const s  = (sMap[tk] || [])[0] || null;

      if (!fc.length) warnings.push(`${tk}: no forecasts for model_version ${model.model_version} — DDM and IRR unavailable.`);

      // NPI, annualised. Only landlords use it, and only from a results pack.
      let npi = null;
      const fund = (nMap[tk] || []).find(r => r.npi != null);
      if (fund) {
        if (!fund.period_months) {
          warnings.push(`${tk}: reit_fundamentals.npi present but period_months is null — cannot annualise safely, so NPI is ignored rather than guessed.`);
        } else {
          npi = Number(fund.npi) * (12 / fund.period_months);
        }
      }

      /* PORTFOLIO VALUE AND DISCLOSED WACR — the preferred inputs to the implied
       * cap rate, because portfolio value x WACR recovers the passing income the
       * book was actually struck on, which is the same quantity the WACR it gets
       * compared against was set from. Reported NPI is a different measure and is
       * only the fallback (SPEC §5.2).
       *
       * These are STOCKS, not flows, so unlike NPI they need no annualisation —
       * a half-year pack states the portfolio value at that balance date and it
       * is already the full figure. Taken from the LATEST pack carrying them,
       * which is not necessarily the same row that carries NPI.
       *
       * nMap is ordered release_date DESC, so the first hit is the most recent. */
      const pvRow   = (nMap[tk] || []).find(r => r.portfolio_value != null);
      const wacrRow = (nMap[tk] || []).find(r => r.wacr != null);
      const gearRow = (nMap[tk] || []).find(r => r.gearing != null);
      const portfolioValue = pvRow ? Number(pvRow.portfolio_value) : null;
      const wacr = wacrRow ? Number(wacrRow.wacr) : null;
      // Gearing fallback for names with a pack but no workbook — the engine needs
      // it to imply net debt, and without net debt there is no enterprise value.
      const packGearing = gearRow ? Number(gearRow.gearing) : null;
      if (portfolioValue != null && wacr != null && pvRow !== wacrRow) {
        warnings.push(`${tk}: portfolio value is from the ${pvRow.period_end} pack but the WACR is from ${wacrRow.period_end} — ` +
          `the capitalised income mixes two balance dates. Capture both in one pack to remove the mismatch.`);
      }

      // Net debt: `stocks.net_debt` where captured, else let the engine imply it
      // from gearing. Recorded either way in the stored inputs.
      const netDebt = s && s.net_debt != null ? Number(s.net_debt) : null;

      const taxFns = settings
        ? { taxAdjust: TAX.taxAdjust, settings, profile: TAX.defaultProfile('reit') }
        : null;

      const v = ENGINE.valuate({
        ticker: tk,
        subclass: subclassOf(s),
        price: px.last_price != null ? Number(px.last_price) : null,
        model, assumptions: a, forecasts: fc,
        assets: asMap[tk] || [],      // bottom-up NAV input; supersedes the top-down cap-rate lens
        net_debt: netDebt,
        npi,
        portfolio_value: portfolioValue,
        wacr,
        gearing: packGearing,
      }, taxFns);

      const h = ENGINE.hurdleTest(v, HURDLES);

      const packRow = (nMap[tk] || []).find(r => r.period_months === 12) || null;
      const gate = completeness({
        securities: model.securities_m != null,
        workbook: !!(aMap[tk] || []).length,
        forecasts: fc.length > 0,
        price: px.last_price != null,
        pack: !!packRow,
        portfolioValue: portfolioValue != null,
        wacr: wacr != null,
        nta: packRow && packRow.nta != null,
        gearing: packRow && packRow.gearing != null,
        ffo: packRow && packRow.ffo != null,
        dps: packRow && packRow.dps != null,
        guidance: packRow && (packRow.guidance_ffo_low != null || packRow.guidance_dps != null),
        assets: (asMap[tk] || []).filter(a => !a.is_excluded).length,
      });
      if (!gate.complete && !writeAll) {
        incomplete.push({ ticker: tk, missing: gate.missing, optional: gate.optional,
                          computed_fair_value: v.fair_value, price: v.price });
        warnings.push(`${tk}: not written — missing ${gate.missing.join(', ')}. ` +
          `Computed fair value ${v.fair_value != null ? '$'+v.fair_value.toFixed(2) : 'null'} is returned for reference only. Use ?all=1 to store it anyway.`);
        continue;
      }

      if (v.fair_value == null) warnings.push(`${tk}: ${v.blend.reason || 'no fair value'}.`);
      if (v.irr_pre_tax == null && v.price != null)
        warnings.push(`${tk}: pre-tax IRR did not converge or had no inputs — reported as null, not substituted.`);

      results.push({
        ticker: tk,
        engine_version: v.engine_version,
        as_of: asOf,
        subclass: v.subclass,
        price: v.price,
        fair_value: v.fair_value,
        discount_to_fair_value: v.discount_to_fair_value,
        method_values: v.method_values,
        weights: v.weights,
        asset_detail: v.method_detail.asset_nav ? v.method_detail.asset_nav.inputs : null,
        implied_cap_rate: v.implied_cap_rate,
        /* THE TWO RATES, stored side by side (SPEC §5.2.2). A stored fair value
         * whose discount rate is not recorded cannot be audited or reproduced —
         * and since the hurdle looks like a discount rate, omitting these is how
         * the two silently get read as one again.
         *
         * NOTE — this object is ANOTHER WHITELIST. It is the fourth in this
         * codebase to quietly drop a field the layer beneath it had computed:
         * add every new engine output here at the same time as the engine gains
         * it, or the number exists everywhere except where it is read. */
        discount_rate: v.discount_rate ?? null,
        hurdle_rate: v.hurdle_rate ?? null,
        buy_price_at_hurdle: v.buy_price_at_hurdle ?? null,
        irr_pre_tax: v.irr_pre_tax,
        irr_post_tax: v.irr_post_tax,
        yield_pre_tax: v.yield_pre_tax,
        yield_post_tax: v.yield_post_tax,
        meets_hurdle: h.meets_hurdle,
        hurdle: h,
        inputs: {
          ...v.inputs,
          net_debt_source: netDebt != null ? 'stocks.net_debt' : 'implied from gearing',
          npi_source: fund ? `reit_fundamentals ${fund.period_end} released ${fund.release_date}, annualised x${fund.period_months ? (12 / fund.period_months) : 'n/a'}` : null,
          portfolio_value_source: pvRow ? `reit_fundamentals ${pvRow.period_end} released ${pvRow.release_date}` : null,
          wacr_source: wacrRow ? `reit_fundamentals ${wacrRow.period_end} released ${wacrRow.release_date}` : null,
          implied_cap_basis: v.implied_cap_detail?.inputs?.income_basis ?? null,
          tax_profile: taxFns ? taxFns.profile.source : null,
          method_reasons: Object.fromEntries(
            Object.entries(v.method_detail).map(([k, m]) => [k, m.reason])
          ),
          implied_cap_reason: v.implied_cap_detail.reason,
        },
      });
    }

    if (dryRun) {
      return json(200, { ok: true, dry_run: true, runs: 0, as_of: asOf,
                         computed: results.length, results,
                         skipped_incomplete: incomplete, warnings });
    }

    // Append-only (SPEC §5.5) — insert, never upsert.
    const { error: wErr } = await db.from('valuation_runs').insert(results);
    if (wErr) throw new Error(`valuation_runs insert: ${wErr.message}`);

    const passing = results.filter(r => r.meets_hurdle === true).map(r => r.ticker);
    /* Distinct from `incomplete`: these WERE written and have the full input set,
     * but the hurdle could not be evaluated (usually a null IRR). Not a failure
     * of the data, a failure of convergence. */
    const hurdleUnknown = results.filter(r => r.meets_hurdle === null).map(r => r.ticker);

    return json(200, {
      ok: true, runs: results.length, as_of: asOf,
      engine: ENGINE.ENGINE_VERSION,
      meets_hurdle: passing,
      hurdle_indeterminate: hurdleUnknown,
      skipped_incomplete: incomplete,
      message: `${results.length} valuation run(s) written. ` +
               `${passing.length} meet both hurdles` +
               (hurdleUnknown.length ? `, ${hurdleUnknown.length} could not be tested (null IRR)` : '') +
               (incomplete.length ? `. ${incomplete.length} vehicle(s) skipped as incomplete — see skipped_incomplete` : '') + '.',
      results, warnings,
    });

  } catch (err) {
    console.error('run-valuation failed:', err.message);
    return json(500, { error: err.message, as_of: asOf, warnings });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
