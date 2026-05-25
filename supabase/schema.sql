-- ============================================================
-- AREIT PORTFOLIO — SUPABASE SCHEMA
-- Run this entire file in: Supabase → SQL Editor → New Query
-- ============================================================

-- Daily closing prices for all tracked stocks
CREATE TABLE IF NOT EXISTS prices (
  id          bigserial PRIMARY KEY,
  ticker      text NOT NULL,
  price       numeric(10,4) NOT NULL,
  volume      bigint,
  change_pct  numeric(8,6),
  market_date date NOT NULL DEFAULT CURRENT_DATE,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices(ticker, market_date DESC);

-- REIT holdings in wife's portfolio
CREATE TABLE IF NOT EXISTS reit_holdings (
  id             bigserial PRIMARY KEY,
  ticker         text NOT NULL UNIQUE,
  name           text NOT NULL,
  nta            numeric(10,4),
  dps_fy26       numeric(10,4),
  target_weight  numeric(5,4),
  yield_trigger  numeric(5,4) DEFAULT 0.08,
  units_held     numeric(12,4) DEFAULT 0,
  avg_cost       numeric(10,4) DEFAULT 0,
  created_at     timestamptz DEFAULT now()
);

-- Every buy in wife's REIT portfolio
CREATE TABLE IF NOT EXISTS reit_trades (
  id           bigserial PRIMARY KEY,
  ticker       text NOT NULL,
  trade_date   date NOT NULL DEFAULT CURRENT_DATE,
  units        numeric(12,4) NOT NULL,
  price        numeric(10,4) NOT NULL,
  amount       numeric(12,2) NOT NULL,
  trigger_type text,
  notes        text,
  executed     boolean DEFAULT false,
  created_at   timestamptz DEFAULT now()
);

-- Play portfolio paper trades
CREATE TABLE IF NOT EXISTS play_trades (
  id            bigserial PRIMARY KEY,
  ticker        text NOT NULL,
  company_name  text,
  trade_date    date NOT NULL DEFAULT CURRENT_DATE,
  direction     text NOT NULL DEFAULT 'LONG',
  entry_price   numeric(10,4),
  stop_price    numeric(10,4),
  target_price  numeric(10,4),
  units         integer,
  amount        numeric(12,2),
  exit_price    numeric(10,4),
  exit_date     date,
  pnl           numeric(12,2),
  pnl_pct       numeric(8,6),
  status        text DEFAULT 'OPEN',
  signal_score  integer,
  is_paper      boolean DEFAULT true,
  ig_deal_id    text,
  notes         text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_play_trades_date   ON play_trades(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_play_trades_status ON play_trades(status);

-- Daily morning scan output
CREATE TABLE IF NOT EXISTS morning_signals (
  id              bigserial PRIMARY KEY,
  signal_date     date NOT NULL DEFAULT CURRENT_DATE UNIQUE,
  sp500_change    numeric(8,6),
  nasdaq_change   numeric(8,6),
  vix             numeric(6,2),
  us_10yr         numeric(6,4),
  us_2yr          numeric(6,4),
  yield_curve     numeric(6,4),
  aus_10yr        numeric(6,4),
  aud_usd         numeric(8,6),
  aud_change      numeric(8,6),
  real_yield      numeric(6,4),
  credit_spread   numeric(6,4),
  breakeven_infl  numeric(6,4),
  composite_score integer,
  signal          text,
  summary         text,
  longs           text[],
  created_at      timestamptz DEFAULT now()
);

-- Daily bond and macro data from FRED
CREATE TABLE IF NOT EXISTS bond_data (
  id              bigserial PRIMARY KEY,
  data_date       date NOT NULL DEFAULT CURRENT_DATE UNIQUE,
  us_10yr         numeric(6,4),
  us_2yr          numeric(6,4),
  us_5yr          numeric(6,4),
  us_30yr         numeric(6,4),
  aus_10yr        numeric(6,4),
  aus_2yr         numeric(6,4),
  yield_curve_us  numeric(6,4),
  yield_curve_aus numeric(6,4),
  real_yield      numeric(6,4),
  breakeven_infl  numeric(6,4),
  ig_spread       numeric(6,4),
  hy_spread       numeric(6,4),
  vix             numeric(6,2),
  aud_usd         numeric(8,6),
  gold_price      numeric(10,2),
  oil_price       numeric(10,2),
  iron_ore_price  numeric(10,2),
  created_at      timestamptz DEFAULT now()
);

-- Alert and email log
CREATE TABLE IF NOT EXISTS alerts (
  id          bigserial PRIMARY KEY,
  alert_type  text NOT NULL,
  ticker      text,
  message     text NOT NULL,
  data        jsonb,
  sent        boolean DEFAULT false,
  sent_at     timestamptz,
  created_at  timestamptz DEFAULT now()
);

-- Monthly deployment log
CREATE TABLE IF NOT EXISTS deployment_log (
  id           bigserial PRIMARY KEY,
  deploy_month date NOT NULL,
  amount       numeric(12,2) NOT NULL DEFAULT 12000,
  deployed     numeric(12,2) DEFAULT 0,
  remaining    numeric(12,2),
  trades       integer DEFAULT 0,
  notes        text,
  created_at   timestamptz DEFAULT now()
);

-- ASX stocks watched by morning scan
CREATE TABLE IF NOT EXISTS watchlist (
  id        bigserial PRIMARY KEY,
  ticker    text NOT NULL UNIQUE,
  name      text NOT NULL,
  sector    text,
  active    boolean DEFAULT true,
  us_corr   numeric(4,3),
  beta      numeric(4,3),
  created_at timestamptz DEFAULT now()
);

-- ── SEED: REIT HOLDINGS ───────────────────────────────────────────────────────
INSERT INTO reit_holdings (ticker, name, nta, dps_fy26, target_weight, yield_trigger) VALUES
  ('HDN',    'HomeCo Daily Needs REIT',   1.42,  0.086, 0.25, 0.08),
  ('DXC',    'Dexus Convenience Retail',  3.79,  0.209, 0.20, 0.08),
  ('WPR',    'Waypoint REIT',             2.92,  0.172, 0.20, 0.08),
  ('CQR',    'Charter Hall Retail REIT',  4.90,  0.255, 0.15, 0.08),
  ('RGN',    'Region Group',              2.56,  0.141, 0.10, 0.08),
  ('GSBG37', 'Govt Bond 2037',          100.00,  4.750, 0.10, 0.00)
ON CONFLICT (ticker) DO NOTHING;

-- ── SEED: ASX200 WATCHLIST ────────────────────────────────────────────────────
INSERT INTO watchlist (ticker, name, sector, us_corr, beta) VALUES
  ('BHP',  'BHP Group',               'Resources',   0.78, 1.20),
  ('RIO',  'Rio Tinto',               'Resources',   0.76, 1.15),
  ('FMG',  'Fortescue',               'Resources',   0.72, 1.35),
  ('S32',  'South32',                 'Resources',   0.70, 1.25),
  ('NST',  'Northern Star',           'Gold',        0.85, 1.10),
  ('EVN',  'Evolution Mining',        'Gold',        0.83, 1.05),
  ('NCM',  'Newmont Australia',       'Gold',        0.82, 1.08),
  ('CBA',  'Commonwealth Bank',       'Financials',  0.70, 0.90),
  ('ANZ',  'ANZ Banking Group',       'Financials',  0.68, 1.00),
  ('WBC',  'Westpac Banking Corp',    'Financials',  0.67, 0.95),
  ('NAB',  'National Australia Bank', 'Financials',  0.69, 0.95),
  ('MQG',  'Macquarie Group',         'Financials',  0.75, 1.30),
  ('XRO',  'Xero',                    'Technology',  0.82, 1.45),
  ('WTC',  'WiseTech Global',         'Technology',  0.80, 1.50),
  ('REA',  'REA Group',               'Technology',  0.75, 1.20),
  ('CAR',  'CAR Group',               'Technology',  0.72, 1.15),
  ('WES',  'Wesfarmers',              'Consumer',    0.65, 0.85),
  ('WOW',  'Woolworths Group',        'Consumer',    0.55, 0.70),
  ('COL',  'Coles Group',             'Consumer',    0.52, 0.65),
  ('QAN',  'Qantas Airways',          'Industrials', 0.68, 1.40),
  ('TCL',  'Transurban Group',        'Infrastr.',   0.60, 0.75),
  ('WDS',  'Woodside Energy',         'Energy',      0.70, 1.10),
  ('STO',  'Santos',                  'Energy',      0.68, 1.15),
  ('HDN',  'HomeCo Daily Needs',      'REIT',        0.65, 0.80),
  ('DXC',  'Dexus Convenience',       'REIT',        0.63, 0.75),
  ('WPR',  'Waypoint REIT',           'REIT',        0.60, 0.70),
  ('CQR',  'Charter Hall Retail',     'REIT',        0.62, 0.72),
  ('RGN',  'Region Group',            'REIT',        0.61, 0.71)
ON CONFLICT (ticker) DO NOTHING;
