-- ============================================================
-- 20260605_01 — RLS + GRANTS AUDIT
-- Goal: the anon-key front-end (public/index.html) must be able to
-- READ every table. Postgres needs BOTH:
--   (a) a row-level-security SELECT policy `using (true)`, and
--   (b) a table-level `grant select to anon, authenticated`.
-- Missing either one => the front-end silently gets [] / 400s.
--
-- This migration is idempotent — safe to run repeatedly.
-- Run in: Supabase → SQL Editor → New Query.
-- ============================================================

-- ── 1. BLANKET READ ACCESS FOR EVERY TABLE IN public ──────────────────────────
-- Loops every base table in the public schema and guarantees the read path.
-- New tables added later are covered automatically by re-running this block.
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    -- enable RLS (no-op if already on)
    execute format('alter table public.%I enable row level security', r.tablename);

    -- (re)create a permissive SELECT policy for anon + authenticated
    execute format('drop policy if exists %I on public.%I',
                   r.tablename || '_anon_select', r.tablename);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (true)',
      r.tablename || '_anon_select', r.tablename);

    -- table-level grant (RLS without grant still blocks reads)
    execute format('grant select on public.%I to anon, authenticated', r.tablename);
  end loop;
end $$;

-- ── 2. WRITE ACCESS FOR THE TABLES THE PORTAL WRITES TO ───────────────────────
-- The SPA writes directly with the anon key on these tables (watchlist toggles,
-- manual distributions, settings edits, recorded trades, document metadata).
-- Without write policies + grants those UI actions fail with 401/42501.
-- Keep this list in sync with any new front-end .insert/.update/.upsert/.delete.
do $$
declare
  t text;
  writable text[] := array[
    'watchlist',
    'distributions',
    'settings',
    'real_trades',
    'model_trades',
    'reit_income_holdings',
    'holdings',
    'contract_notes',
    'document_uploads'
  ];
begin
  foreach t in array writable loop
    -- only touch tables that actually exist (later migrations add some)
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('drop policy if exists %I on public.%I', t || '_anon_write', t);
      execute format(
        'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
        t || '_anon_write', t);
      execute format('grant insert, update, delete on public.%I to anon, authenticated', t);
    end if;
  end loop;
end $$;

-- ── 3. SEQUENCES (needed by inserts into bigserial/identity columns) ───────────
grant usage, select on all sequences in schema public to anon, authenticated;

-- ── 4. DEFAULTS so future tables/sequences inherit access ─────────────────────
-- (applies to objects created by the role running this; harmless if redundant)
alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- ── 5. VERIFY — tables still missing a SELECT policy after this run ────────────
-- Should return ZERO rows. Run as a separate query to confirm.
--   select t.tablename
--   from pg_tables t
--   where t.schemaname='public'
--     and not exists (
--       select 1 from pg_policies p
--       where p.schemaname='public' and p.tablename=t.tablename and p.cmd in ('SELECT','ALL'));
