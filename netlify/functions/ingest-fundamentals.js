// netlify/functions/ingest-fundamentals.js
// Agent D — the ONLY writer into `reit_fundamentals` (SPEC.md §1.4, §9).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FUNCTION EXISTS
//
// `reit_fundamentals` splits two dates on purpose:
//   period_end   — WHAT the number describes (the balance date)
//   release_date — WHEN we were allowed to know it (the results-pack release)
//
// Dating a fundamental to period_end instead of release_date is look-ahead
// bias. It does not throw, it does not look wrong, and it does not show up in
// the UI: it just makes every backtest that touches the row quietly optimistic,
// because the model "knew" a December NTA in December when in reality it was
// published in February. That is the single failure mode this file exists to
// prevent, which is why release_date is REQUIRED and unconditional — there is
// no default, no fallback and no "use period_end if missing" path anywhere
// below. A row we cannot date honestly is a row we do not write.
//
// The range guards follow the same doctrine as scripts/export-model.js: collect
// every problem, report them together, and write NOTHING if any row failed.
// A wrong-but-plausible fundamental (gearing 35 instead of 0.35, a cap rate of
// 6.25 instead of 0.0625) is worse than a missing one, because a missing one
// renders `—` and a plausible one drives a real-money BUY.
//
// ─────────────────────────────────────────────────────────────────────────────
// USAGE
//
// 1. MANUAL — hand-keyed from a results pack. This is the primary path; most of
//    the field set (WACR, NPI, ICR, hedging, WALE, occupancy, FFO/AFFO) exists
//    nowhere but the pack itself.
//
//    POST { mode: 'manual', rows: [{
//            ticker: 'CIP', period_end: '2025-12-31', release_date: '2026-02-11',
//            period_months: 6,
//            nta: 3.95, wacr: 0.0575, npi: 108300000, gearing: 0.353,
//            icr: 4.1, hedge_pct: 0.78, hedge_maturity: 2.9,
//            wale: 8.2, occupancy: 0.972, ffo: 71200000, dps: 0.0850,
//            source: 'results_pack'
//          }] }
//
// 2. EODHD — backfill from statutory financials already stored in
//    `fundamentals.raw`, or fetched live. Writes ONE field (gearing) and only
//    where a genuine release date exists. See the long note above buildEodhd().
//
//    POST { mode: 'eodhd', tickers: ['CIP','DXI'], dry_run: true }
//    POST { mode: 'eodhd', universe: 'landlords', from: 'db' }
//
// Add `dry_run: true` to ANY call to validate and see exactly what would be
// written without writing it. Run the backfill dry first, every time.
//
// ─────────────────────────────────────────────────────────────────────────────
// UNITS — SPEC.md §1.2 / §1.3, restated because this is where they get typed in
//   nta, dps            DOLLARS per security      (3.95 — NOT 395 cents)
//   npi, ffo, affo      DOLLARS total             (108300000 — NOT $108.3m)
//   wacr, gearing,
//   occupancy, hedge_pct DECIMAL FRACTION         (0.0575 — NOT 5.75)
//   icr                 MULTIPLE                  (4.1 = 4.1x)
//   wale, hedge_maturity YEARS
//
// `reit_fundamentals` is a NEW table (0 rows), so unlike reit_model_forecasts
// there is no cents legacy here. Everything per-unit is dollars. Do not mix.

const { getSupabase } = require('./_shared.js');
const { getFundamentals } = require('./eodhd-client.js');

// ── RANGE GUARDS ─────────────────────────────────────────────────────────────
// Same shape and same intent as the RANGE table in scripts/export-model.js:
// a plausible band per KIND of number, so a value read or typed into the wrong
// field is rejected rather than stored. `null` bound = unbounded on that side.
//
// These are the TIGHT bands (implausible). The migration carries a second,
// generous set of CHECK constraints (impossible) as defence in depth.
const RANGE = {
  rate:     [0.005, 0.25],   // cap rates / WACR — 0.5% to 25%
  pct:      [0, 1.5],        // ratios expressed 0-1 (gearing tolerates >1 in distress)
  unit_pct: [0, 1],          // strictly 0-1 (occupancy, hedge share)
  dollars:  [0, 100],        // per-security figures in DOLLARS (nta, dps)
  money:    [0, 1e11],       // aggregate dollar figures (npi, ffo, affo)
  multiple: [0, 100],        // interest cover
  years:    [0, 30],         // WALE, hedge maturity
};

// field -> range key. Anything not listed here is DROPPED from the row rather
// than written blind, so a stray CSV header or a renamed column cannot smuggle
// an unvalidated value into the table.
const FIELDS = {
  nta:            'dollars',
  wacr:           'rate',
  npi:            'money',
  gearing:        'pct',
  icr:            'multiple',
  hedge_pct:      'unit_pct',
  hedge_maturity: 'years',
  wale:           'years',
  occupancy:      'unit_pct',
  ffo:            'money',
  affo:           'money',
  dps:            'dollars',
};

// Flow measures cover a PERIOD, so they cannot be stored without its length.
// A half-year NPI fed to the implied cap rate (SPEC §5.2) halves the cap rate.
const FLOW_FIELDS = ['npi', 'ffo', 'affo', 'dps'];

const SOURCES = ['results_pack', 'annual_report', 'eodhd_derived'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function parseNum(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;   // NaN is meaningful: "given but unparseable"
}

// ── VALIDATION ───────────────────────────────────────────────────────────────
/**
 * Validate and clean one incoming row. Pushes human-readable problems onto
 * `problems` and returns the cleaned row, or null if the row is unusable.
 *
 * Worked examples (hand-checkable):
 *
 *   { ticker:'CIP', period_end:'2025-12-31', release_date:'2026-02-11',
 *     period_months:6, gearing:0.353, wacr:0.0575, npi:108300000 }
 *     -> accepted. release_date is 42 days after period_end.
 *
 *   { ticker:'CIP', period_end:'2025-12-31', gearing:0.353 }
 *     -> REJECTED: "release_date is missing". No fallback to period_end.
 *
 *   { ticker:'CIP', period_end:'2025-12-31', release_date:'2025-12-31', ... }
 *     -> REJECTED: release_date must be AFTER period_end. Same-day is both
 *        physically impossible and the exact signature of EODHD's filing_date.
 *
 *   { ticker:'CIP', period_end:'2025-12-31', release_date:'2026-02-11',
 *     gearing:35 }
 *     -> REJECTED: gearing 35 is above the plausible maximum 1.5. This is the
 *        percent-typed-as-percent error (SPEC §1.3); it must be 0.35.
 *
 *   { ticker:'CIP', period_end:'2025-12-31', release_date:'2026-02-11',
 *     npi:108300000 }
 *     -> REJECTED: npi is a flow measure and period_months was not given.
 */
function cleanRow(raw, problems, opts = {}) {
  const where = `${raw.ticker || '?'} ${raw.period_end || '?'}`;
  const fail = (msg) => problems.push(`[${where}] ${msg}`);
  let fatal = false;

  // — ticker —
  const ticker = raw.ticker ? String(raw.ticker).trim().toUpperCase() : null;
  if (!ticker) { fail('ticker is missing'); fatal = true; }

  // — period_end —
  const period_end = raw.period_end ? String(raw.period_end).trim() : null;
  if (!period_end) { fail('period_end is missing'); fatal = true; }
  else if (!DATE_RE.test(period_end) || Number.isNaN(Date.parse(period_end))) {
    fail(`period_end "${period_end}" is not a YYYY-MM-DD date`); fatal = true;
  }

  // — release_date — THE POINT OF THIS FUNCTION (SPEC §1.4) —
  const release_date = raw.release_date ? String(raw.release_date).trim() : null;
  if (!release_date) {
    fail('release_date is missing. It is REQUIRED and there is deliberately no ' +
         'fallback: dating a fundamental to period_end is look-ahead bias — it ' +
         'lets a backtest use a December NTA in December when the pack was not ' +
         'published until February. Find the ASX announcement date for this ' +
         'results pack, or do not capture the row at all (SPEC.md §1.4, §9).');
    fatal = true;
  } else if (!DATE_RE.test(release_date) || Number.isNaN(Date.parse(release_date))) {
    fail(`release_date "${release_date}" is not a YYYY-MM-DD date`); fatal = true;
  }

  // — the date relationship —
  if (!fatal) {
    const gap = daysBetween(period_end, release_date);

    if (gap < 0) {
      fail(`release_date ${release_date} is BEFORE period_end ${period_end}. ` +
           'A REIT cannot publish a period\'s results before the period has ended — ' +
           'the two dates are almost certainly swapped.');
      fatal = true;
    } else if (gap === 0) {
      fail(`release_date equals period_end (${period_end}). A results pack is ` +
           'never released on the balance date. This is also the exact signature ' +
           'of EODHD\'s `filing_date` field, which defaults to the period end on ' +
           '~83% of rows — if that is where this date came from, it is not a ' +
           'release date and must not be used as one.');
      fatal = true;
    } else if (gap > 400 && !opts.allow_late) {
      fail(`release_date ${release_date} is ${gap} days after period_end ` +
           `${period_end}. That is more than a year — most likely a wrong year ` +
           'in one of the two dates. If it is a genuine restatement, re-send ' +
           'with allow_late: true.');
      fatal = true;
    }

    if (release_date > today()) {
      fail(`release_date ${release_date} is in the future. A results pack that ` +
           'has not been released cannot be a point-in-time observation.');
      fatal = true;
    }
  }

  if (fatal) return null;

  // — measures —
  const out = { ticker, period_end, release_date };
  let measures = 0;

  for (const [field, rangeKey] of Object.entries(FIELDS)) {
    if (!(field in raw)) continue;
    const n = parseNum(raw[field]);
    if (n === null) continue;                       // explicitly empty -> leave null
    if (Number.isNaN(n)) { fail(`${field} = ${JSON.stringify(raw[field])} is not a number`); continue; }

    const [lo, hi] = RANGE[rangeKey];
    if (lo !== null && n < lo) {
      fail(`${field} = ${n} is below the plausible minimum ${lo} (${rangeKey})`);
      continue;
    }
    if (hi !== null && n > hi) {
      fail(`${field} = ${n} is above the plausible maximum ${hi} (${rangeKey})` +
           (rangeKey === 'rate' || rangeKey === 'pct' || rangeKey === 'unit_pct'
             ? ` — rates on this platform are DECIMALS (SPEC §1.3): ${n}% is ${n / 100}.`
             : ''));
      continue;
    }
    out[field] = n;
    measures++;
  }

  if (measures === 0) {
    fail('row carries no usable measure — every field was missing, empty or rejected. ' +
         'An empty point-in-time row is noise; nothing written.');
    return null;
  }

  // — period_months, required whenever a flow measure is present (see migration §3) —
  const hasFlow = FLOW_FIELDS.some(f => out[f] !== undefined);
  const pm = parseNum(raw.period_months);
  if (pm !== null && !Number.isNaN(pm)) {
    if (![3, 6, 12].includes(pm)) {
      fail(`period_months = ${pm} must be 3, 6 or 12`);
      return null;
    }
    out.period_months = pm;
  }
  if (hasFlow && out.period_months === undefined) {
    const present = FLOW_FIELDS.filter(f => out[f] !== undefined).join(', ');
    fail(`period_months is required because this row carries flow measure(s): ${present}. ` +
         'NPI/FFO/AFFO/DPS are amounts EARNED OVER a period, so a half-year figure and a ' +
         'full-year figure are indistinguishable without it — and the implied cap rate ' +
         '(SPEC §5.2) needs an annualised NPI. Send 6 for a half-year pack, 12 for a full year.');
    return null;
  }

  // — provenance —
  const source = raw.source ? String(raw.source).trim() : 'results_pack';
  if (!SOURCES.includes(source)) {
    fail(`source "${source}" is not one of: ${SOURCES.join(', ')}`);
    return null;
  }
  out.source = source;
  out.is_estimate = raw.is_estimate === true || source === 'eodhd_derived';

  return out;
}

// ── EODHD BACKFILL ───────────────────────────────────────────────────────────
//
// WHAT THIS DERIVES, AND — MORE IMPORTANTLY — WHAT IT REFUSES TO.
//
// The release date. EODHD exposes two date-ish fields and only one of them is
// real:
//   * Financials.*.quarterly[p].filing_date — USELESS. It equals period_end on
//     28,432 of 34,056 rows (83%, verified 2026-08-17). It is a period end
//     wearing a filing date's name. Using it would inject look-ahead bias into
//     every row while looking perfectly reasonable. NOT USED ANYWHERE BELOW.
//   * Earnings.History[p].reportDate — GENUINE. Spot-checked against the ASX
//     calendar: CIP 1H26 -> 2026-02-11, DXI FY25 -> 2025-08-11, WPR FY25 ->
//     2025-08-29, RGN 1H26 -> 2026-02-10. Across the 27 landlord REITs it
//     yields 476 periods, every one with reportDate strictly after period_end
//     and none more than 120 days later. That is a defensible release date.
//
// The measure. Exactly one field survives scrutiny:
//   * gearing = netDebt / totalAssets. Share-count independent, and it lands
//     within ~0-3pp of each REIT's own reported gearing (CIP Dec-25 0.353 vs
//     0.36 reported; DXC Jun-25 0.289 vs 0.298; RGN 0.338 vs 0.35; WPR 0.323
//     vs 0.327). It is NOT the same metric — the REITs report a covenant
//     gearing off drawn debt and a different asset base — so it is written with
//     is_estimate = true and source 'eodhd_derived', and a hand-keyed
//     results-pack row supersedes it.
//
// NTA is deliberately NOT derived, and this is the important refusal.
// EODHD's `commonStockSharesOutstanding` is intermittently wrong, so any
// per-share figure built on it is wrong on an unpredictable subset of rows:
//   WPR Jun-25  equity/shares = $0.015   (actual NTA ~$2.90)
//   DXI Dec-24  equity/shares = $2.52    (actual NTA ~$3.39)
//   DXC Dec-24  equity/shares = $1.58    (actual NTA ~$3.50)
//   CIP Dec-25  equity/shares = $3.95    (correct — which is the problem)
// It is right often enough to look trustworthy and wrong often enough to be
// dangerous. `netTangibleAssets` is also only populated on 110 of 364 landlord
// half-periods, and it divides by the same broken share count. NTA therefore
// comes from the results pack or it does not come at all.
//
// Also not derived, and why:
//   WACR, occupancy, WALE, hedge_pct, hedge_maturity — not in EODHD in any form.
//   NPI  — not in EODHD. Statutory revenue for an A-REIT includes fair-value
//          revaluations, so nothing in the income statement is NPI.
//   FFO / AFFO — non-IFRS measures the REIT defines itself; absent from EODHD,
//          and statutory net income is not a substitute (it carries revals).
//   ICR  — REITs report cover on adjusted earnings; statutory EBIT/interest
//          swings wildly with revaluations and would be actively misleading.
//   DPS  — obtainable from the dividend feed, but only by ex-date, which does
//          not map cleanly onto a reporting period. `distributions` already
//          holds this properly.

function eodhdRows(ticker, data) {
  const hist = data?.Earnings?.History || {};
  const bs   = data?.Financials?.Balance_Sheet?.quarterly || {};
  const rows = [];

  for (const [period, e] of Object.entries(hist)) {
    const release = e?.reportDate;
    // epsActual null => the period is scheduled but not yet reported. A future
    // reportDate is a calendar entry, not an observation.
    if (!release || e?.epsActual === null || e?.epsActual === undefined) continue;
    if (!DATE_RE.test(period) || !DATE_RE.test(release)) continue;

    const b = bs[period];
    if (!b) continue;

    const netDebt     = parseNum(b.netDebt);
    const totalAssets = parseNum(b.totalAssets);
    // Negative net debt shows up on interim quarters where EODHD simply has no
    // debt figure and nets cash against nothing. It is missing data, not a
    // net-cash balance sheet, so it is skipped rather than written as gearing 0.
    if (!netDebt || !totalAssets || Number.isNaN(netDebt) || Number.isNaN(totalAssets)) continue;
    if (netDebt <= 0 || totalAssets <= 0) continue;

    rows.push({
      ticker,
      period_end:   period,
      release_date: release,
      gearing:      netDebt / totalAssets,
      source:       'eodhd_derived',
      is_estimate:  true,
      // no period_months: gearing is a STOCK measure at period_end, and this
      // path writes no flow measures.
    });
  }
  return rows;
}

async function loadEodhd(db, tickers, from) {
  const out = [];
  if (from === 'api') {
    for (const t of tickers) {
      const data = await getFundamentals(t);
      if (data) out.push([t, data]);
    }
    return out;
  }
  // default: read the snapshot already in `fundamentals.raw` — free, and
  // deterministic, which matters because a re-run must not change history.
  for (let i = 0; i < tickers.length; i += 100) {
    const { data, error } = await db.from('fundamentals')
      .select('ticker, raw').in('ticker', tickers.slice(i, i + 100));
    if (error) throw new Error(`load fundamentals: ${error.message}`);
    (data || []).forEach(r => { if (r.raw) out.push([r.ticker, r.raw]); });
  }
  return out;
}

async function resolveTickers(db, body) {
  if (Array.isArray(body.tickers) && body.tickers.length) {
    return body.tickers.map(t => String(t).trim().toUpperCase());
  }
  // 'landlords' is the only universe that makes sense here: implied cap rates
  // and WACR are meaningless for developers and fund managers (CLAUDE.md).
  const q = db.from('stocks').select('ticker').eq('asset_class', 'reit');
  const { data, error } = body.universe === 'reits'
    ? await q
    : await q.eq('reit_subclass', 'landlord');
  if (error) throw new Error(`load stocks: ${error.message}`);
  return (data || []).map(s => s.ticker);
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body    = JSON.parse(event.body || '{}');
    const mode    = body.mode || 'manual';
    const dryRun  = body.dry_run === true;
    const db      = getSupabase();
    const problems = [];

    // 1. gather candidate rows
    let incoming = [];
    let skipped  = 0;

    if (mode === 'manual') {
      incoming = Array.isArray(body.rows) ? body.rows : [];
      if (!incoming.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'mode "manual" needs a non-empty rows[]' }) };
      }
    } else if (mode === 'eodhd') {
      const tickers = await resolveTickers(db, body);
      if (!tickers.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'no tickers resolved' }) };
      }
      const loaded = await loadEodhd(db, tickers, body.from === 'api' ? 'api' : 'db');
      loaded.forEach(([t, data]) => {
        const rows = eodhdRows(t, data);
        if (!rows.length) skipped++;
        incoming.push(...rows);
      });
      if (!incoming.length) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            ok: true, mode, written: 0,
            note: 'No period had BOTH a genuine Earnings.History.reportDate and a ' +
                  'usable balance sheet. Nothing written — that is the correct ' +
                  'outcome, not a failure.',
          }),
        };
      }
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: `unknown mode "${mode}" (expected 'manual' or 'eodhd')` }) };
    }

    // 2. validate everything BEFORE writing anything
    const clean = incoming
      .map(r => cleanRow(r || {}, problems, { allow_late: body.allow_late === true }))
      .filter(Boolean);

    // 3. THE GATE. Same doctrine as scripts/export-model.js: a partial write
    //    leaves the table in a state nobody can reason about, and the rejected
    //    rows are exactly the ones that would have been wrong. In manual mode
    //    any problem aborts the whole batch. In eodhd mode a rejected period is
    //    expected (sparse vendor data) and is reported rather than fatal — but
    //    if EVERYTHING failed, that is a real fault and it aborts.
    const strict = mode === 'manual' || clean.length === 0;
    if (problems.length && strict) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `${problems.length} validation problem(s) — NOTHING WAS WRITTEN`,
          problems,
          accepted: clean.length,
        }, null, 2),
      };
    }

    // 4. dry run — show exactly what would land
    if (dryRun) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true, dry_run: true, mode,
          would_write: clean.length,
          rejected: problems.length,
          problems,
          tickers: [...new Set(clean.map(r => r.ticker))].sort(),
          sample: clean.slice(0, 10),
        }, null, 2),
      };
    }

    // 5. upsert on the point-in-time grain
    let written = 0;
    for (let i = 0; i < clean.length; i += 200) {
      const chunk = clean.slice(i, i + 200);
      const { error } = await db.from('reit_fundamentals')
        .upsert(chunk, { onConflict: 'ticker,period_end,release_date' });
      if (error) throw new Error(`reit_fundamentals upsert: ${error.message}`);
      written += chunk.length;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, mode, written,
        rejected: problems.length,
        problems,
        tickers_without_usable_periods: skipped || undefined,
      }, null, 2),
    };
  } catch (err) {
    console.error('ingest-fundamentals failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
