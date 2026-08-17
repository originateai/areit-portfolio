-- ============================================================
-- fundamentals_capture — Agent D (fundamentals capture)
--
-- Makes `reit_fundamentals` fillable. The table already had the right SHAPE
-- (SPEC.md §1.4: period_end = what the number describes, release_date = when we
-- were allowed to know it) but three things stood in the way of using it:
--
--   1. the unique key was (ticker, release_date) — too narrow to be the
--      point-in-time grain, and it silently blocks any upsert keyed on the
--      correct (ticker, period_end, release_date) triple;
--   2. nothing distinguished a figure lifted verbatim from a results pack from
--      one derived off a vendor feed;
--   3. flow measures (NPI / FFO / AFFO / DPS) carried no period length, so a
--      half-year NPI and a full-year NPI were indistinguishable — see §3 below,
--      this one is a factor-of-two error in a real-money signal.
--
-- SPEC.md §1.2  every money column here is DOLLARS. No cents columns.
-- SPEC.md §1.3  every rate column here is a DECIMAL FRACTION (0.0625, not 6.25).
-- SPEC.md §1.4  release_date is the results-pack RELEASE date, never period_end.
-- SPEC.md §8.3  idempotent / re-runnable.
-- SPEC.md §8.4  RLS + `for select using (true)` + `grant select to anon,
--               authenticated`. VERIFIED against the live table, see §5.
--
-- Table is EMPTY (0 rows, verified 2026-08-17), so every change below is
-- zero-risk on existing data.
--
-- Run in: Supabase -> SQL Editor -> New Query. Safe to run repeatedly.
-- ============================================================


-- ── 1. is_estimate — provenance, not decoration ───────────────────────────────
-- false  = the figure is as printed in the results pack / annual report.
-- true   = the figure is DERIVED (e.g. gearing computed as net debt / total
--          assets off a statutory balance sheet) and is a PROXY for the number
--          the REIT itself reports. It is close, not identical, and the UI must
--          be able to say so. SPEC.md §9: an unverified number is labelled.
--
-- Defaults to false so a hand-keyed results-pack row is authoritative unless it
-- says otherwise; the EODHD backfill sets it to true explicitly.
alter table public.reit_fundamentals
  add column if not exists is_estimate boolean not null default false;


-- ── 2. source — widen the vocabulary ──────────────────────────────────────────
-- Column already exists with default 'results_pack'. Documented values:
--   'results_pack'   hand-keyed from the REIT's own half/full-year pack
--   'annual_report'  hand-keyed from the statutory annual report
--   'eodhd_derived'  computed from EODHD statutory financials (is_estimate=true)
-- No CHECK constraint: a new provenance should not need a migration.
comment on column public.reit_fundamentals.source is
  'Provenance: results_pack | annual_report | eodhd_derived. Pair with is_estimate.';


-- ── 3. period_months — the factor-of-two guard on every flow measure ──────────
-- NPI, FFO, AFFO and DPS are FLOWS over the reporting period. NTA, WACR,
-- gearing, ICR, WALE, occupancy and the hedge fields are STOCKS at period_end.
--
-- The implied cap rate (SPEC §5.2) is `NPI / (price*shares + net debt)` and it
-- needs an ANNUALISED NPI. Feed it a half-year NPI and the cap rate comes back
-- at ~3% instead of ~6% — a wrong-but-entirely-plausible number driving a
-- real-money BUY. Recording the period length lets the consumer annualise
-- deterministically instead of guessing from the month of period_end.
--
--   6  = half-year pack (the ASX norm: Dec interim, Jun full-year half)
--   12 = full-year figures
--   3  = quarterly, if a REIT ever reports that way
--
-- NULL is legitimate and means "this row carries no flow measure" — which is
-- exactly the case for the EODHD gearing backfill. Constraint §4 enforces that.
alter table public.reit_fundamentals
  add column if not exists period_months smallint;

comment on column public.reit_fundamentals.period_months is
  'Length in months of the period the FLOW measures (npi/ffo/affo/dps) cover: 6=half, 12=full year. NULL only when the row carries no flow measure. Annualise NPI by 12/period_months before computing an implied cap rate.';


-- ── 4. constraints ────────────────────────────────────────────────────────────
-- Guarded with DO blocks because Postgres has no ADD CONSTRAINT IF NOT EXISTS.

-- 4a. THE UPSERT KEY. The pre-existing UNIQUE (ticker, release_date) is dropped:
--     it is strictly narrower than the point-in-time grain, so while it is in
--     place an upsert on (ticker, period_end, release_date) still trips it. It
--     also forbids two legitimate cases — a REIT releasing two periods on one
--     day, and a later pack restating an earlier period_end.
alter table public.reit_fundamentals
  drop constraint if exists reit_fundamentals_ticker_release_date_key;

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.reit_fundamentals'::regclass
                   and conname  = 'reit_fundamentals_pit_key') then
    alter table public.reit_fundamentals
      add constraint reit_fundamentals_pit_key
      unique (ticker, period_end, release_date);
  end if;
end $$;

-- 4b. THE LOOK-AHEAD GUARD. You cannot know a period's results before the
--     period has ended. `>` and not `>=`: a results pack released ON the
--     balance date is impossible, and same-day is the exact signature of the
--     EODHD `filing_date` field, which defaults to period_end for ~83% of rows
--     (28,432 of 34,056, verified 2026-08-17) and must never be mistaken for a
--     release date. This constraint is the schema-level half of that defence;
--     ingest-fundamentals.js is the loud half.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.reit_fundamentals'::regclass
                   and conname  = 'reit_fundamentals_release_after_period') then
    alter table public.reit_fundamentals
      add constraint reit_fundamentals_release_after_period
      check (release_date > period_end);
  end if;
end $$;

-- 4c. period_months, when present, is a real reporting period.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.reit_fundamentals'::regclass
                   and conname  = 'reit_fundamentals_period_months_ck') then
    alter table public.reit_fundamentals
      add constraint reit_fundamentals_period_months_ck
      check (period_months is null or period_months in (3, 6, 12));
  end if;
end $$;

-- 4d. A flow measure without a period length is unusable (see §3).
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.reit_fundamentals'::regclass
                   and conname  = 'reit_fundamentals_flow_needs_period') then
    alter table public.reit_fundamentals
      add constraint reit_fundamentals_flow_needs_period
      check (
        period_months is not null
        or (npi is null and ffo is null and affo is null and dps is null)
      );
  end if;
end $$;

-- 4e. THE DECIMAL-vs-PERCENT GUARD (SPEC §1.3 — the second 100x landmine).
--     These bounds are deliberately GENEROUS: they are the "impossible" band,
--     not the "implausible" band. ingest-fundamentals.js carries the tight
--     plausibility ranges (cap rate 0.005-0.25, gearing 0-1.5, ...) and rejects
--     loudly there. What this constraint catches is the operator who types 6.25
--     for a 6.25% cap rate, or 97 for 97% occupancy — the error that otherwise
--     writes a wrong-but-plausible-looking figure and is never noticed again.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.reit_fundamentals'::regclass
                   and conname  = 'reit_fundamentals_rates_are_decimals') then
    alter table public.reit_fundamentals
      add constraint reit_fundamentals_rates_are_decimals
      check (
            (wacr       is null or (wacr      >  0 and wacr      <= 1))
        and (gearing    is null or (gearing   >= 0 and gearing   <= 2))
        and (occupancy  is null or (occupancy >  0 and occupancy <= 1))
        and (hedge_pct  is null or (hedge_pct >= 0 and hedge_pct <= 1))
      );
  end if;
end $$;


-- ── 5. index — every point-in-time query sorts this way ───────────────────────
-- "latest fundamental known as at date D" is
--   ... where ticker = $1 and release_date <= $2 order by release_date desc limit 1
-- ALREADY PRESENT on the live table as `reit_fund_ticker_idx` (verified
-- 2026-08-17). Repeated here under the same name so this migration is complete
-- on a fresh database and a no-op on the live one.
create index if not exists reit_fund_ticker_idx
  on public.reit_fundamentals (ticker, release_date desc);


-- ── 6. RLS and grants — VERIFIED, then tightened ──────────────────────────────
-- SPEC.md §10 says grants are already in place platform-wide. Verified against
-- the live table 2026-08-17 and that is true for READ:
--   * RLS enabled                                          -> yes
--   * `for select using (true)`                            -> yes, two policies
--     ("public read reit_fundamentals" for PUBLIC, and
--      "reit_fundamentals_anon_select" for anon+authenticated). Duplicated but
--     harmless — both are permissive SELECT, so they OR together. Left alone.
--   * grant select to anon, authenticated                  -> yes
--
-- What was NOT in place: anon and authenticated also held INSERT, UPDATE,
-- DELETE and TRUNCATE. Nothing needs them — every write goes through
-- ingest-fundamentals.js on the service role — and TRUNCATE on the browser's
-- anon key is a hole, not a convenience. Revoked below.
--
-- If the integrator later wires a browser-side capture form that writes
-- directly rather than through the function, this revoke must be reconsidered
-- (the recommendation is: don't — keep the validation on the server).

alter table public.reit_fundamentals enable row level security;

do $$ begin
  if not exists (select 1 from pg_policy
                 where polrelid = 'public.reit_fundamentals'::regclass
                   and polname  = 'reit_fundamentals_anon_select') then
    create policy reit_fundamentals_anon_select
      on public.reit_fundamentals for select
      to anon, authenticated
      using (true);
  end if;
end $$;

grant select on public.reit_fundamentals to anon, authenticated;
revoke insert, update, delete, truncate on public.reit_fundamentals from anon, authenticated;


-- ── 7. column documentation — units, in the database itself ───────────────────
comment on table public.reit_fundamentals is
  'Point-in-time REIT fundamentals (SPEC.md §1.4). period_end = what the number describes; release_date = when we were allowed to know it. EVERY backtest and score must filter on release_date. Upsert key: (ticker, period_end, release_date).';

comment on column public.reit_fundamentals.period_end   is 'Balance date the figures describe. NEVER use this to date a signal.';
comment on column public.reit_fundamentals.release_date is 'Date the results pack was released to market. This is the point-in-time key.';
comment on column public.reit_fundamentals.nta          is 'NTA per security. DOLLARS (SPEC §1.2). Stock measure at period_end.';
comment on column public.reit_fundamentals.wacr         is 'Weighted average book cap rate. DECIMAL fraction (SPEC §1.3): 0.0625 = 6.25%.';
comment on column public.reit_fundamentals.npi          is 'Net property income for the period. DOLLARS (not $m). Flow — annualise by 12/period_months before the implied cap rate (SPEC §5.2).';
comment on column public.reit_fundamentals.gearing      is 'DECIMAL fraction: 0.35 = 35%. is_estimate=true means net debt / total assets off the statutory balance sheet, which is a proxy for the REIT-reported covenant gearing, not the same number.';
comment on column public.reit_fundamentals.icr          is 'Interest cover, a MULTIPLE (3.2 = 3.2x), not a rate.';
comment on column public.reit_fundamentals.hedge_pct    is 'Share of drawn debt hedged. DECIMAL fraction: 0.75 = 75%.';
comment on column public.reit_fundamentals.hedge_maturity is 'Weighted average hedge maturity, YEARS.';
comment on column public.reit_fundamentals.wale         is 'Weighted average lease expiry, YEARS.';
comment on column public.reit_fundamentals.occupancy    is 'DECIMAL fraction: 0.985 = 98.5%.';
comment on column public.reit_fundamentals.ffo          is 'Funds from operations for the period. DOLLARS total (not per unit, not $m). Flow.';
comment on column public.reit_fundamentals.affo         is 'Adjusted FFO for the period. DOLLARS total. Flow.';
comment on column public.reit_fundamentals.dps          is 'Distribution per security declared for the period. DOLLARS (SPEC §1.2) — NOT cents. Flow.';
comment on column public.reit_fundamentals.is_estimate  is 'false = as printed in the results pack. true = derived/proxy; the UI must label it.';
