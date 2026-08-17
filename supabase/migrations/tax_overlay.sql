-- ============================================================
-- TAX OVERLAY — tax_settings + distribution_components
-- SPEC.md §4.1 (settings, not constants) and §4.2 (component split).
--
-- Written by Agent B (tax engine). The integrator numbers this file at merge
-- time (SPEC.md §7) — it deliberately carries no numeric prefix.
--
-- UNITS (SPEC.md §1.1–1.3, non-negotiable):
--   * every money column here is DOLLARS. There are no cents columns.
--   * every rate column here is a DECIMAL fraction: 0.45 means 45%.
--   * distribution_components amounts are DOLLARS PER UNIT by default; a row
--     sourced from an annual tax statement may instead be a DOLLAR TOTAL for
--     the holding — that is what the `basis` column records. Do not mix them
--     inside one (ticker, financial_year) group.
--
-- Idempotent — safe to re-run (SPEC.md §8.3).
-- Run in Supabase BEFORE deploying netlify/functions/tax-rollup.js (§1.7).
-- ============================================================

-- ── 1. TAX SETTINGS ──────────────────────────────────────────────────────────
-- One row per effective_from date. The engine reads the latest row whose
-- effective_from <= today. NOTHING in engine code hardcodes a tax rate: if this
-- table is empty, scripts/tax-engine.js throws rather than guessing (§4.1).
create table if not exists public.tax_settings (
  id             bigserial primary key,
  marginal_rate  numeric not null default 0.45,        -- decimal, e.g. 0.45 = 45%
  medicare_levy  numeric not null default 0.02,        -- decimal; applied for entity_type='individual' only
  cgt_discount   numeric not null default 0.5,         -- decimal; individual 0.5, SMSF 1/3, company 0
  entity_type    text    not null default 'individual',
  effective_from date    not null default current_date,
  created_at     timestamptz default now()
);

-- Additive column beyond the SPEC §4.1 list, and the report says so.
-- Reason: §4.2 writes the franking gross-up as credit/(1-0.30). That 0.30 is the
-- COMPANY tax rate — a tax rate — and §4.1 says never hardcode a tax rate in
-- engine code or SQL. It therefore has to live in settings. The engine falls
-- back to 0.30 if the column is absent, so this is compatible either way.
alter table public.tax_settings
  add column if not exists company_tax_rate numeric not null default 0.30;

-- entity_type enum (§4.1) — 'smsf' and 'company' are storable now even though
-- only 'individual' is fully exercised, so the SMSF day needs no migration.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tax_settings_entity_type_chk'
      and conrelid = 'public.tax_settings'::regclass
  ) then
    alter table public.tax_settings
      add constraint tax_settings_entity_type_chk
      check (entity_type in ('individual','smsf','company'));
  end if;
end $$;

-- Rates must be decimals, not percentages (§1.3). This constraint is the
-- database-side half of the same guard the engine applies in code.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tax_settings_decimal_rates_chk'
      and conrelid = 'public.tax_settings'::regclass
  ) then
    alter table public.tax_settings
      add constraint tax_settings_decimal_rates_chk
      check (
        marginal_rate    between 0 and 1
        and medicare_levy    between 0 and 1
        and cgt_discount     between 0 and 1
        and company_tax_rate between 0 and 1
      );
  end if;
end $$;

create unique index if not exists tax_settings_effective_from_uq
  on public.tax_settings (effective_from);

-- Seed exactly ONE row: 45% marginal + 2% medicare = 47% combined, 50% CGT
-- discount, individual. Guarded so a re-run never duplicates or overwrites a
-- rate the owner has since edited in the UI.
insert into public.tax_settings
  (marginal_rate, medicare_levy, cgt_discount, entity_type, company_tax_rate, effective_from)
select 0.45, 0.02, 0.5, 'individual', 0.30, date '2000-01-01'
where not exists (select 1 from public.tax_settings);

comment on table  public.tax_settings is
  'Tax parameters for the post-tax overlay. Rates are DECIMALS (0.45 = 45%). Engine reads the latest row with effective_from <= today. Modelling tool, not tax advice.';
comment on column public.tax_settings.medicare_levy is
  'Applied only when entity_type = ''individual''. Combined rate = marginal_rate + medicare_levy.';
comment on column public.tax_settings.cgt_discount is
  'Fraction of a capital gain that is discounted when held >12 months. Individual 0.5, SMSF 0.3333, company 0.';
comment on column public.tax_settings.company_tax_rate is
  'Franking gross-up rate. credit = franked_cash * r/(1-r). 0.30 for a full-rate company, 0.25 for a base-rate entity.';

-- ── 2. DISTRIBUTION COMPONENTS ───────────────────────────────────────────────
-- The AREIT distribution split (SPEC.md §4.2). One row per ticker per
-- distribution (ex_date), or one annual row per ticker from the tax statement.
-- Every amount is DOLLARS (see `basis` for per-unit vs total).
create table if not exists public.distribution_components (
  id                 bigserial primary key,
  ticker             text not null,
  financial_year     integer,                  -- FY ending: 2026 = FY26 (year to 30 Jun 2026)
  ex_date            date,                     -- null for an annual/whole-FY statement row
  franked_amount     numeric not null default 0,  -- $ franked dividend CASH received
  franking_credit    numeric not null default 0,  -- $ imputation credit attached (not cash)
  unfranked_amount   numeric not null default 0,  -- $ unfranked dividend
  interest_income    numeric not null default 0,  -- $ interest / credit-fund income
  tax_deferred       numeric not null default 0,  -- $ NOT taxed on receipt; REDUCES COST BASE -> CGT on sale
  cgt_concession     numeric not null default 0,  -- $ tax free, no cost-base effect
  foreign_income     numeric not null default 0,  -- $ foreign income CASH received (net of withholding)
  foreign_credit     numeric not null default 0,  -- $ foreign income tax offset attached (not cash)
  amit_cost_base_net numeric not null default 0,  -- $ AMIT net cost base adjustment: +ve = net REDUCTION
  basis              text not null default 'per_unit',  -- 'per_unit' | 'total'
  source             text not null default 'estimate',  -- 'statement' | 'announcement' | 'estimate' | 'default'
  is_estimate        boolean not null default true,
  notes              text,
  created_at         timestamptz default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'distribution_components_basis_chk'
      and conrelid = 'public.distribution_components'::regclass
  ) then
    alter table public.distribution_components
      add constraint distribution_components_basis_chk
      check (basis in ('per_unit','total'));
  end if;
end $$;

-- Upsert key. ex_date is nullable (annual statement rows), so it is coalesced
-- into the index rather than left to NULL-never-equals-NULL.
create unique index if not exists distribution_components_uq
  on public.distribution_components
     (ticker, coalesce(financial_year, 0), coalesce(ex_date, date '1900-01-01'), basis);

create index if not exists distribution_components_ticker_fy_idx
  on public.distribution_components (ticker, financial_year);

comment on table public.distribution_components is
  'Component split of a distribution (SPEC §4.2). Amounts are DOLLARS; `basis` says per-unit or holding-total. tax_deferred is DEFERRED, not exempt: it reduces cost base and is taxed as a discounted capital gain on sale.';
comment on column public.distribution_components.tax_deferred is
  'Not taxed on receipt. Reduces cost base -> capital gain on sale, then the CGT discount applies. NEVER model this as tax free.';
comment on column public.distribution_components.amit_cost_base_net is
  'AMIT net cost base adjustment in dollars. Positive = net cost base REDUCTION (same effect as tax_deferred). If a statement supplies this, do not also populate tax_deferred for the same period or the deferral is double counted.';
comment on column public.distribution_components.is_estimate is
  'true until an actual annual tax statement is loaded. The engine propagates this into its output so the UI can label the figure an estimate (SPEC §1.6).';

-- ── 3. RLS + GRANTS (SPEC.md §8.4 — the single most repeated bug in this repo)
-- Both halves are required: a policy AND a grant. Either one missing and the
-- front-end silently reads [].
alter table public.tax_settings            enable row level security;
alter table public.distribution_components enable row level security;

drop policy if exists tax_settings_anon_select on public.tax_settings;
create policy tax_settings_anon_select
  on public.tax_settings for select to anon, authenticated using (true);

drop policy if exists distribution_components_anon_select on public.distribution_components;
create policy distribution_components_anon_select
  on public.distribution_components for select to anon, authenticated using (true);

grant select on public.tax_settings            to anon, authenticated;
grant select on public.distribution_components to anon, authenticated;

-- Write access: the SPA has to let the owner set his own marginal rate and
-- paste the component split off a tax statement. Mirrors the writable-table
-- pattern in 20260605_01_rls_grants_audit.sql.
drop policy if exists tax_settings_anon_write on public.tax_settings;
create policy tax_settings_anon_write
  on public.tax_settings for all to anon, authenticated using (true) with check (true);

drop policy if exists distribution_components_anon_write on public.distribution_components;
create policy distribution_components_anon_write
  on public.distribution_components for all to anon, authenticated using (true) with check (true);

grant insert, update, delete on public.tax_settings            to anon, authenticated;
grant insert, update, delete on public.distribution_components to anon, authenticated;

grant usage, select on all sequences in schema public to anon, authenticated;

-- ── 4. VERIFY (run separately; both should return one row / zero problems) ────
--   select * from public.tax_settings order by effective_from desc;
--   select tablename from pg_tables t
--    where schemaname='public' and tablename in ('tax_settings','distribution_components')
--      and not exists (select 1 from pg_policies p
--                      where p.schemaname='public' and p.tablename=t.tablename
--                        and p.cmd in ('SELECT','ALL'));
