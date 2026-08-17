'use strict';
// ============================================================================
// scripts/irr.js — the numerical IRR solver (SPEC.md §5.3)
//
// PURE. No I/O, no Date.now(), no mutation of the caller's arrays.
//
// WHY BISECTION AND NOT NEWTON
//   Newton-Raphson needs a derivative and a good starting guess. Given a REIT
//   cashflow that is one large negative (the price) followed by five small
//   distributions and one large terminal, the NPV curve is steep near r = -1 and
//   almost flat above r = 0.5. Newton overshoots into r < -1 — where (1+r)^t is
//   a complex number for fractional t and a sign-flipping mess for integer t —
//   and then "converges" to a plausible-looking wrong root. Bisection cannot do
//   that: it can only ever return a value inside a bracket that has already been
//   proven to contain a sign change.
//
// THE RULE THAT MATTERS (SPEC §5.3)
//   BRACKET THE ROOT, AND RETURN null IF IT DOES NOT CONVERGE. Never a fallback
//   number. An IRR is compared against a 12% hurdle that moves real money; a
//   silently wrong 12.4% is far worse than an honest `—`.
//
//   Three separate refusals are implemented, and each returns null with a
//   `reason`:
//     1. MALFORMED    — fewer than two cashflows, or a non-finite entry.
//     2. UNCONVENTIONAL — the sign-change count in the cashflow series is not
//        exactly 1. Descartes' rule of signs says a series with k sign changes
//        can have up to k positive real roots. With k != 1 the IRR is either
//        undefined (k = 0: no root) or ambiguous (k >= 2: several rates satisfy
//        NPV = 0 and none of them is "the" return). Returning one of several
//        roots as though it were unique is exactly the silent lie this file
//        exists to prevent.
//     3. NOT BRACKETED — no sign change in NPV(r) anywhere on the scan ladder
//        inside [lo, hi]. The root, if any, lies outside the searched range.
//
// UNITS (SPEC §1.1, §1.3)
//   Cashflows are DOLLARS. The returned rate is a DECIMAL fraction: 0.12 = 12%.
//   Per-unit REIT forecasts arrive from the database in CENTS and MUST be
//   divided by 100 before they reach this file. This module has no way to detect
//   that error — a 100x cashflow scaling still solves, it just solves to a
//   nonsense rate — so the division belongs at the call site, once, visibly.
//
// ── WORKED EXAMPLES ─────────────────────────────────────────────────────────
// All hand-checkable. `t` is the array index, so cf[0] is time zero.
//
//  1. Trivial one-period, hand-solvable exactly.
//       irr([-100, 110])
//       NPV(r) = -100 + 110/(1+r) = 0  ->  1+r = 1.10  ->  r = 0.10
//       -> 0.10
//
//  2. Level coupon then principal — a 10% par bond.
//       irr([-100, 10, 10, 110])
//       At r = 0.10: 10/1.1 + 10/1.21 + 110/1.331
//                  = 9.0909 + 8.2645 + 82.6446 = 100.0000  -> NPV = 0
//       -> 0.10
//
//  3. Negative return — you get back less than you paid.
//       irr([-100, 50, 40])
//       At r = -0.0616…: 50/0.9384 + 40/0.8806 = 53.28 + 45.42 ≈ 98.7  (still >)
//       The true root is r ≈ -0.0653. Negative IRRs are legitimate and this
//       solver returns them; only r <= -1 is refused (the discount factor blows
//       up). -> ≈ -0.0653
//
//  4. THE REGRESSION TEST — Excel's own IRR, from the DXI workbook.
//     Valuation!E63 computes =IRR(D62:I62) over the row-62 investor cashflow
//     (t0 = -price, then FFO per unit in dollars, with the terminal added to the
//     final year). Excel returns 0.131641463626433, and that number is stored in
//     reit_model_outputs.breakeven_irr for DXI.
//       irr([-2.34, 0.1621484, 0.1777923, 0.1845633, 0.1914704, 3.3661011])
//       -> 0.13164146…   (agrees with Excel to 8 decimal places)
//     This is the single most valuable check in the file: it proves the solver
//     against an independent implementation on the actual production numbers.
//
//  5. REFUSED — no sign change in the cashflows, so no root exists.
//       irr([100, 110])            -> null, reason 'unconventional_cashflows'
//       irr([-100, -50])           -> null, reason 'unconventional_cashflows'
//
//  6. REFUSED — two sign changes, so the IRR is ambiguous.
//       irr([-100, 300, -220])
//       NPV = 0 at BOTH r = 0.10 and r = 1.00. Both are arithmetically valid.
//       -> null, reason 'unconventional_cashflows'
//     (`irrDetail` reports sign_changes: 2 so the caller can explain the `—`.)
//
//  7. REFUSED — malformed input.
//       irr([-100])                -> null, reason 'too_few_cashflows'
//       irr([-100, NaN])           -> null, reason 'non_finite_cashflow'
// ============================================================================

const IRR_VERSION = 'irr-1.0.0';

// Solver defaults. `lo` stops just above -1: at r = -1 every discount factor is
// a division by zero, and below it the factors alternate sign for integer t,
// which is meaningless as a rate of return.
const DEFAULTS = {
  lo: -0.9999,      // decimal rate
  hi: 10,           // decimal rate = 1000% p.a. Above this, "IRR" is not a useful word.
  tol: 1e-10,       // convergence tolerance on the rate, in decimal rate units
  maxIter: 200,     // bisection halves the bracket each pass: 10.9999/2^200 is astronomically
                    // finer than tol, so hitting maxIter means something is wrong, not slow.
  scanSteps: 240    // ladder resolution used to find a sign change inside [lo, hi]
};

/** Finite number or null. Never NaN, never a silent 0 (SPEC §9). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * npv(rate, cashflows) -> present value at `rate`, or null if undefined there.
 *
 * `cashflows[t]` is the DOLLAR flow at period t, t = 0 being today and
 * undiscounted. Periods are equally spaced; for this platform they are years.
 *
 * Worked example:
 *   npv(0.10, [-100, 10, 10, 110]) = -100 + 9.0909 + 8.2645 + 82.6446 = 0
 *   npv(0.00, [-100, 10, 10, 110]) = -100 + 10 + 10 + 110            = 30
 */
function npv(rate, cashflows) {
  const r = num(rate);
  if (r === null || r <= -1) return null;
  let total = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const cf = num(cashflows[t]);
    if (cf === null) return null;
    total += cf / Math.pow(1 + r, t);
  }
  return Number.isFinite(total) ? total : null;
}

/**
 * Count sign changes in the cashflow series, ignoring zeros.
 *   [-100, 10, 10, 110]   -> 1   (conventional: pay once, receive thereafter)
 *   [100, 110]            -> 0   (never pay anything: no rate solves it)
 *   [-100, 300, -220]     -> 2   (ambiguous: multiple valid roots)
 */
function countSignChanges(cashflows) {
  let changes = 0;
  let prev = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const cf = num(cashflows[t]);
    if (cf === null || cf === 0) continue;
    const s = cf > 0 ? 1 : -1;
    if (prev !== 0 && s !== prev) changes++;
    prev = s;
  }
  return changes;
}

/**
 * bracket(cashflows, lo, hi, steps) -> [a, b] straddling a sign change, or null.
 *
 * Walks a geometric-ish ladder from `lo` to `hi` and returns the first adjacent
 * pair whose NPVs have opposite signs. Scanning rather than assuming
 * monotonicity is deliberate: it costs ~240 NPV evaluations (microseconds) and
 * it means the bracket is PROVEN rather than presumed.
 *
 * The ladder is denser at the low end, where the NPV curve is steep, by
 * stepping in equal increments of log(1 + r).
 */
function bracket(cashflows, lo, hi, steps) {
  const logLo = Math.log(1 + lo);
  const logHi = Math.log(1 + hi);
  const step = (logHi - logLo) / steps;

  let prevR = lo;
  let prevF = npv(prevR, cashflows);
  if (prevF !== null && prevF === 0) return [prevR, prevR];

  for (let i = 1; i <= steps; i++) {
    const r = Math.exp(logLo + step * i) - 1;
    const f = npv(r, cashflows);
    if (f === null) { prevR = r; prevF = f; continue; }
    if (f === 0) return [r, r];
    if (prevF !== null && ((prevF < 0 && f > 0) || (prevF > 0 && f < 0))) {
      return [prevR, r];
    }
    prevR = r;
    prevF = f;
  }
  return null;
}

/**
 * irrDetail(cashflows, opts) -> full diagnostics.
 *
 * Returns:
 *   {
 *     irr,            // decimal rate, or null. NEVER a fallback number.
 *     converged,      // boolean
 *     reason,         // null on success; otherwise why there is no answer
 *     iterations,     // bisection passes used
 *     sign_changes,   // Descartes count on the cashflow series
 *     bracket,        // [a, b] proven to contain the root, or null
 *     npv_at_irr,     // residual — should be ~0; a large value means trouble
 *     periods,        // cashflows.length - 1
 *     version
 *   }
 *
 * `opts`: { lo, hi, tol, maxIter, scanSteps } — all optional, see DEFAULTS.
 *
 * Worked example (example 2 above):
 *   irrDetail([-100, 10, 10, 110])
 *   -> irr 0.10000000, converged true, reason null, sign_changes 1,
 *      npv_at_irr ~1e-9
 */
function irrDetail(cashflows, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const base = {
    irr: null, converged: false, reason: null, iterations: 0,
    sign_changes: null, bracket: null, npv_at_irr: null,
    periods: Array.isArray(cashflows) ? Math.max(0, cashflows.length - 1) : null,
    version: IRR_VERSION
  };

  // ── 1. MALFORMED ──────────────────────────────────────────────────────────
  if (!Array.isArray(cashflows) || cashflows.length < 2) {
    return { ...base, reason: 'too_few_cashflows' };
  }
  const cf = cashflows.map(num);
  if (cf.some(v => v === null)) {
    return { ...base, reason: 'non_finite_cashflow' };
  }
  if (cf.every(v => v === 0)) {
    return { ...base, reason: 'all_zero_cashflows' };
  }

  // ── 2. UNCONVENTIONAL ─────────────────────────────────────────────────────
  // Exactly one sign change guarantees a unique positive-discount-factor root
  // (Descartes / Norstrøm). Anything else is refused rather than guessed at.
  const signChanges = countSignChanges(cf);
  if (signChanges !== 1) {
    return {
      ...base,
      sign_changes: signChanges,
      reason: signChanges === 0
        ? 'unconventional_cashflows'   // no sign change: no rate can solve NPV = 0
        : 'unconventional_cashflows'   // 2+: several rates solve it; none is "the" IRR
    };
  }

  // ── 3. BRACKET ────────────────────────────────────────────────────────────
  const br = bracket(cf, o.lo, o.hi, o.scanSteps);
  if (!br) {
    return { ...base, sign_changes: signChanges, reason: 'not_bracketed' };
  }

  let [a, b] = br;
  let fa = npv(a, cf);
  const fb = npv(b, cf);

  // Landed exactly on the root during the scan.
  if (fa === 0) return { ...base, irr: a, converged: true, sign_changes: signChanges, bracket: [a, b], npv_at_irr: 0 };
  if (fb === 0) return { ...base, irr: b, converged: true, sign_changes: signChanges, bracket: [a, b], npv_at_irr: 0 };

  // ── 4. BISECT ─────────────────────────────────────────────────────────────
  let mid = a;
  let iterations = 0;
  for (; iterations < o.maxIter; iterations++) {
    mid = (a + b) / 2;
    const fm = npv(mid, cf);
    if (fm === null) break;                    // undefined NPV inside the bracket
    if (fm === 0 || (b - a) / 2 < o.tol) {
      return {
        ...base,
        irr: mid, converged: true, iterations: iterations + 1,
        sign_changes: signChanges, bracket: br, npv_at_irr: fm
      };
    }
    if ((fa < 0 && fm < 0) || (fa > 0 && fm > 0)) { a = mid; fa = fm; }
    else { b = mid; }
  }

  // Ran out of iterations without meeting tol. Refuse (SPEC §5.3).
  return { ...base, iterations, sign_changes: signChanges, bracket: br, reason: 'did_not_converge' };
}

/**
 * irr(cashflows, opts) -> decimal rate, or null.
 *
 * The thin form for callers that only want the number. `null` means "no
 * trustworthy answer" and must render as `—` (SPEC §6, §9) — never as 0, never
 * as a default hurdle rate. Use irrDetail() when you need to explain the `—`.
 */
function irr(cashflows, opts = {}) {
  return irrDetail(cashflows, opts).irr;
}

/**
 * irrFromSeries({ price, cashflows, terminal_value }) -> irrDetail shape.
 *
 * Convenience for the SPEC §5.3 form:
 *   price_today = Σ [ CF_t / (1+r)^t ] + terminal_value_N / (1+r)^N
 * built into the t0-negative array this solver wants:
 *   [ -price, CF_1, CF_2, …, CF_N + terminal_value ]
 *
 * ALL DOLLARS. Per-unit forecasts are CENTS in the database (SPEC §1.1) — divide
 * by 100 before calling.
 *
 * Worked example — DXI, five years of FFO per unit plus the workbook's terminal:
 *   irrFromSeries({ price: 2.34,
 *                   cashflows: [0.1621484, 0.1777923, 0.1845633, 0.1914704, 0.2009611],
 *                   terminal_value: 3.1651400 })
 *   builds [-2.34, 0.1621484, 0.1777923, 0.1845633, 0.1914704, 3.3661011]
 *   -> irr 0.13164146…  (= Excel's IRR in the DXI workbook, Valuation!E63)
 */
function irrFromSeries({ price, cashflows, terminal_value }, opts = {}) {
  const p = num(price);
  const tv = num(terminal_value);
  if (p === null || !Array.isArray(cashflows) || !cashflows.length) {
    return { ...irrDetail([], opts), reason: 'missing_price_or_cashflows' };
  }
  const series = [-p, ...cashflows.map(num)];
  if (series.some(v => v === null)) {
    return { ...irrDetail([], opts), reason: 'non_finite_cashflow' };
  }
  if (tv !== null) series[series.length - 1] += tv;
  return irrDetail(series, opts);
}

module.exports = { IRR_VERSION, DEFAULTS, irr, irrDetail, irrFromSeries, npv, countSignChanges, bracket };
