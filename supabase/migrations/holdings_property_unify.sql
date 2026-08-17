-- ============================================================
-- holdings_property_unify — Agent A (income & holdings)
--
-- SPEC.md §2.1  holdings gains `adjusted_cost_base` (tax-adjusted cost base)
--               and a nullable `property_id` cross-reference.
-- SPEC.md §2.3  the four direct-property tables.
-- SPEC.md §8.3  idempotent / re-runnable.
-- SPEC.md §8.4  EVERY new table: RLS enabled + `for select using (true)`
--               + `grant select to anon, authenticated`. Omit any one of the
--               three and the SPA renders an empty page with no error.
--
-- UNITS (SPEC.md §1.2/§1.3):
--   * every money column below is DOLLARS. No cents columns.
--   * every rate/percentage column below is a DECIMAL FRACTION
--     (ownership_pct 0.5 = 50%, interest_rate 0.062 = 6.2%). The UI formats.
--
-- This migration does NOT touch `real_trades` (immutable ledger, SPEC §2.1) and
-- does NOT touch or drop `reit_income_holdings` (retired but retained).
--
-- Run in: Supabase -> SQL Editor -> New Query. Safe to run repeatedly.
-- ============================================================


-- ── 1. property_holdings — the register of directly-owned property ────────────
-- Property is NOT a row in `holdings` with a fake ticker (SPEC §2.3): it is
-- levered, revalued twice a year, and has its own cashflows.
create table if not exists public.property_holdings (
  id                bigint generated always as identity primary key,
  name              text not null,
  address           text,
  property_type     text,                      -- 'residential'|'commercial'|'industrial'|'retail'|... free text
  ownership_pct     numeric not null default 1,-- DECIMAL fraction: 1 = 100%, 0.5 = half share
  purchase_price    numeric,                   -- DOLLARS, 100% of the property (not the owner's share)
  purchase_date     date,
  acquisition_costs numeric default 0,         -- DOLLARS: stamp duty, legals, buyer's agent
  capex_to_date     numeric default 0,         -- DOLLARS: capitalised improvements since purchase
  is_open           boolean default true,
  notes             text,
  created_at        timestamptz default now()
);


-- ── 2. property_valuations — point-in-time (SPEC §1.4) ────────────────────────
-- `valuation_date` is WHEN THE VALUATION WAS KNOWN (the report/appraisal date),
-- never a period end. Any query that backtests must filter on this column.
create table if not exists public.property_valuations (
  id             bigint generated always as identity primary key,
  property_id    bigint not null references public.property_holdings(id) on delete cascade,
  valuation      numeric not null,             -- DOLLARS, 100% of the property
  valuation_date date not null,
  source         text,                         -- 'bank'|'independent'|'agent_appraisal'|'owner_estimate'|'corelogic'
  is_estimate    boolean default true,         -- false only for a formal independent valuation
  created_at     timestamptz default now()
);

create index if not exists property_valuations_property_date_idx
  on public.property_valuations (property_id, valuation_date desc);


-- ── 3. property_loans — the leverage ──────────────────────────────────────────
-- `balance` is a point-in-time debt balance as at `balance_date`. Keep the row
-- history rather than mutating one row, so equity value can be reconstructed.
create table if not exists public.property_loans (
  id            bigint generated always as identity primary key,
  property_id   bigint not null references public.property_holdings(id) on delete cascade,
  lender        text,
  balance       numeric not null,              -- DOLLARS drawn as at balance_date
  interest_rate numeric,                       -- DECIMAL fraction: 0.062 = 6.2%
  rate_type     text,                          -- 'variable'|'fixed'|'split'
  io_expiry     date,                          -- interest-only expiry, null if P&I
  balance_date  date not null,
  created_at    timestamptz default now()
);

create index if not exists property_loans_property_date_idx
  on public.property_loans (property_id, balance_date desc);


-- ── 4. property_cashflows — the income statement, per period ──────────────────
-- Enter every figure at 100% OF THE PROPERTY. The owner's share is applied by
-- the engine via property_holdings.ownership_pct (SPEC §3.1). Entering an
-- already-apportioned figure here double-counts the ownership split.
--
-- `depreciation` and `capital_works` are NON-CASH. They are excluded from the
-- cash income figure and exist solely to feed the tax overlay (SPEC §4.4),
-- where they reduce taxable income without reducing cash.
create table if not exists public.property_cashflows (
  id            bigint generated always as identity primary key,
  property_id   bigint not null references public.property_holdings(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  gross_rent    numeric default 0,             -- DOLLARS
  agent_fees    numeric default 0,             -- DOLLARS  ]
  rates         numeric default 0,             -- DOLLARS  ]
  insurance     numeric default 0,             -- DOLLARS  ]- cash operating costs
  strata        numeric default 0,             -- DOLLARS  ]
  maintenance   numeric default 0,             -- DOLLARS  ]
  other_costs   numeric default 0,             -- DOLLARS  ]
  interest_paid numeric default 0,             -- DOLLARS, cash interest on the loan
  depreciation  numeric default 0,             -- DOLLARS, NON-CASH (Div 40) -> SPEC §4.4
  capital_works numeric default 0,             -- DOLLARS, NON-CASH (Div 43) -> SPEC §4.4
  created_at    timestamptz default now()
);

create index if not exists property_cashflows_property_period_idx
  on public.property_cashflows (property_id, period_end desc);


-- ── 5. holdings — tax-adjusted cost base + optional property link (SPEC §2.1) ─
-- `cost_base` stays the ORIGINAL acquisition cost and is never overwritten.
-- `adjusted_cost_base` is the tax-adjusted figure that tax-deferred
-- distributions reduce (SPEC §4.2). Agent B's tax engine owns the adjustment;
-- sync-holdings only seeds it to cost_base when it is null.
alter table public.holdings
  add column if not exists adjusted_cost_base numeric;                 -- DOLLARS

comment on column public.holdings.cost_base is
  'DOLLARS, total (not per-unit) original acquisition cost excluding brokerage. Never overwritten.';
comment on column public.holdings.adjusted_cost_base is
  'DOLLARS, total. cost_base less tax-deferred distributions received (SPEC 4.2). Seeded to cost_base.';

-- Optional cross-reference for a listed holding that relates to a directly-held
-- property (e.g. a unit trust interest in the same asset). Direct property does
-- NOT appear in `holdings` — it lives in property_holdings (SPEC §2.3). This is
-- a link, not the mechanism by which property enters the portfolio.
alter table public.holdings
  add column if not exists property_id bigint references public.property_holdings(id);

create index if not exists holdings_property_id_idx on public.holdings (property_id);

-- One derived row per ticker. Manual rows (source='manual') are untouched by
-- this constraint, so a hand-entered position can coexist with the ledger.
create unique index if not exists holdings_trades_ticker_uq
  on public.holdings (ticker) where source = 'trades';


-- ── 6. RLS + GRANTS — SPEC §8.4, the most repeated bug in this repo ───────────
-- All three of (enable RLS, select policy, table grant) are required. Missing
-- any one gives the anon-key SPA an empty result with no error.
do $$
declare
  t text;
  new_tables text[] := array[
    'property_holdings',
    'property_valuations',
    'property_loans',
    'property_cashflows'
  ];
begin
  foreach t in array new_tables loop
    execute format('alter table public.%I enable row level security', t);

    -- read
    execute format('drop policy if exists %I on public.%I', t || '_anon_select', t);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (true)',
      t || '_anon_select', t);
    execute format('grant select on public.%I to anon, authenticated', t);

    -- write: the SPA adds/edits properties, valuations, loans and cashflows
    -- directly with the anon key, exactly as it already does for `holdings`
    -- and `distributions` (see 20260605_01_rls_grants_audit.sql section 2).
    execute format('drop policy if exists %I on public.%I', t || '_anon_write', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_write', t);
    execute format('grant insert, update, delete on public.%I to anon, authenticated', t);
  end loop;
end $$;

-- identity columns need sequence usage for anon inserts
grant usage, select on all sequences in schema public to anon, authenticated;


-- ── 7. VERIFY (run separately; each should return ZERO rows) ──────────────────
--   -- tables missing a SELECT policy
--   select t.tablename from pg_tables t
--   where t.schemaname='public'
--     and t.tablename like 'property%'
--     and not exists (select 1 from pg_policies p
--                     where p.schemaname='public' and p.tablename=t.tablename
--                       and p.cmd in ('SELECT','ALL'));
--
--   -- tables missing the anon grant
--   select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='public' and c.relname like 'property%' and c.relkind='r'
--     and not has_table_privilege('anon', c.oid, 'SELECT');
