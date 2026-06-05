-- ============================================================
-- 20260605_02 — REIT FUNDAMENTAL COLUMNS ON stocks
-- The single-stock detail page renders the full REIT field set with labelled
-- placeholders. These columns back it. All IF NOT EXISTS so it is safe to run
-- even though most already exist on the live table.
--
-- Point-in-time discipline: WACR / NTA / WALE / occupancy / hedging must be
-- dated to the results-pack RELEASE date (see CLAUDE.md). `fundamentals_asof`
-- records that release date so the UI can show how stale a figure is.
-- ============================================================

alter table public.stocks add column if not exists nav              numeric(10,4);   -- net asset value / unit
alter table public.stocks add column if not exists gross_assets     numeric(16,2);   -- total property + other assets
alter table public.stocks add column if not exists market_cap       numeric(16,2);
alter table public.stocks add column if not exists wacr             numeric(6,4);    -- weighted avg cap rate (book)
alter table public.stocks add column if not exists implied_wacr     numeric(6,4);    -- implied cap rate from price
alter table public.stocks add column if not exists cap_rate         numeric(6,4);
alter table public.stocks add column if not exists wale             numeric(6,2);    -- weighted avg lease expiry (yrs)
alter table public.stocks add column if not exists occupancy        numeric(6,4);    -- 0–1
alter table public.stocks add column if not exists icr              numeric(6,2);    -- interest cover ratio (×)
alter table public.stocks add column if not exists hedged_pct       numeric(6,4);    -- % of debt hedged (0–1)
alter table public.stocks add column if not exists eps_fy26         numeric(10,4);   -- FFO/AFFO per unit proxy
alter table public.stocks add column if not exists npi              numeric(16,2);   -- net property income (results pack)
alter table public.stocks add column if not exists shares_on_issue  numeric(18,0);
alter table public.stocks add column if not exists net_debt         numeric(16,2);
alter table public.stocks add column if not exists landlord_sector  text;            -- retail/office/industrial/diversified/other
alter table public.stocks add column if not exists reit_subclass    text;            -- landlord/developer/manager
alter table public.stocks add column if not exists fundamentals_asof date;           -- results-pack release date

-- Implied cap rate (landlords only): npi / (price*shares + net_debt).
-- Computed in a function/ingestion against point-in-time NPI; left null here.
