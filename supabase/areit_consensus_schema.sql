-- =====================================================================
-- A-REIT VALUE-LAYER — BROKER CONSENSUS SCHEMA  (Supabase / Postgres)
-- Project: areit  (opziisvjfkjwwdbclniw)
--
-- Run AFTER areit_value_layer_schema_v2.sql. Idempotent: safe to re-run.
-- Backs the consensus panel in value-layer.html.
--
-- value-layer.html upserts with onConflict 'ticker,broker_name,note_date'
-- and reads this table with the ANON key as part of the initial page load,
-- so it needs BOTH a public read policy and an authenticated write policy.
-- =====================================================================

create table if not exists reit_broker_forecasts (
  id            bigint generated always as identity primary key,
  ticker        text not null references stocks(ticker),
  broker_name   text not null,
  eps_fy26      numeric,
  eps_fy27      numeric,
  eps_fy28      numeric,
  eps_fy29      numeric,
  eps_fy30      numeric,
  valuation     numeric,        -- broker price target / valuation, $
  target_return numeric,        -- decimal (0.12 = 12%)
  note_date     date not null default current_date,
  created_at    timestamptz default now(),
  unique (ticker, broker_name, note_date)
);

-- RLS: public read (the page loads this table with the anon key), auth write.
alter table reit_broker_forecasts enable row level security;

drop policy if exists read_all on reit_broker_forecasts;
create policy read_all on reit_broker_forecasts
  for select using (true);

drop policy if exists write_auth on reit_broker_forecasts;
create policy write_auth on reit_broker_forecasts
  for all to authenticated using (true) with check (true);

grant select on reit_broker_forecasts to anon, authenticated;
grant insert, update, delete on reit_broker_forecasts to authenticated;
