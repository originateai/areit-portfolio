-- ============================================================
-- 20260605_03 — DISTRIBUTIONS: source tag + upsert key
-- Supports the EODHD dividend ingestion (fetch-dividends-background) and the
-- cumulative-per-stock Income view. Idempotent.
-- ============================================================

alter table public.distributions add column if not exists source   text default 'manual'; -- 'manual' | 'eodhd' | 'statement'
alter table public.distributions add column if not exists currency text;

-- Upsert key for ingestion (onConflict: ticker,ex_date).
-- NOTE: if this errors with "could not create unique index" you have duplicate
-- (ticker, ex_date) rows. De-dupe first, keeping the highest total_received:
--   delete from public.distributions d using public.distributions d2
--   where d.ticker=d2.ticker and d.ex_date=d2.ex_date and d.id < d2.id;
create unique index if not exists distributions_ticker_exdate_uq
  on public.distributions (ticker, ex_date);
