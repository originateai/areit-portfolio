-- ============================================================
-- AREIT TRADING PLATFORM — COMPLETE SCHEMA v2
-- Drop existing tables and rebuild from scratch
-- Run in: Supabase → SQL Editor → New Query
-- ============================================================

-- ── DROP EXISTING TABLES ──────────────────────────────────────────────────────
DROP TABLE IF EXISTS deployment_log CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS bond_data CASCADE;
DROP TABLE IF EXISTS morning_signals CASCADE;
DROP TABLE IF EXISTS play_trades CASCADE;
DROP TABLE IF EXISTS reit_trades CASCADE;
DROP TABLE IF EXISTS reit_holdings CASCADE;
DROP TABLE IF EXISTS prices CASCADE;
DROP TABLE IF EXISTS watchlist CASCADE;

-- ── SETTINGS ─────────────────────────────────────────────────────────────────
-- User-configurable conviction sizing and portfolio settings
CREATE TABLE IF NOT EXISTS settings (
  id            bigserial PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  value         text NOT NULL,
  label         text,
  category      text,
  updated_at    timestamptz DEFAULT now()
);

-- ── STOCK UNIVERSE ────────────────────────────────────────────────────────────
-- ASX500 equities + REIT universe
CREATE TABLE IF NOT EXISTS stocks (
  id            bigserial PRIMARY KEY,
  ticker        text NOT NULL UNIQUE,
  name          text NOT NULL,
  sector        text,
  subsector     text,
  universe      text NOT NULL DEFAULT 'ASX500', -- 'ASX500' or 'REIT'
  is_reit       boolean DEFAULT false,
  active        boolean DEFAULT true,
  us_corr       numeric(4,3),
  beta          numeric(4,3),
  -- REIT specific
  nta           numeric(10,4),
  dps_fy26      numeric(10,4),
  dps_fy27      numeric(10,4),
  implied_cap   numeric(6,4),
  gearing       numeric(6,4),
  yield_trigger numeric(5,4) DEFAULT 0.08,
  -- Exclusion flags
  is_manager    boolean DEFAULT false,
  is_developer  boolean DEFAULT false,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- ── DAILY PRICES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prices (
  id            bigserial PRIMARY KEY,
  ticker        text NOT NULL,
  market_date   date NOT NULL DEFAULT CURRENT_DATE,
  open          numeric(10,4),
  high          numeric(10,4),
  low           numeric(10,4),
  close         numeric(10,4) NOT NULL,
  volume        bigint,
  change_pct    numeric(8,6),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(ticker, market_date)
);
CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices(ticker, market_date DESC);

-- ── DAILY TECHNICAL ANALYSIS ──────────────────────────────────────────────────
-- Stores calculated indicators for each stock each day
CREATE TABLE IF NOT EXISTS daily_analysis (
  id              bigserial PRIMARY KEY,
  ticker          text NOT NULL,
  analysis_date   date NOT NULL DEFAULT CURRENT_DATE,
  -- Price
  close           numeric(10,4),
  -- Moving averages
  ma20            numeric(10,4),
  ma50            numeric(10,4),
  ma200           numeric(10,4),
  -- Trend signals
  above_ma20      boolean,
  above_ma50      boolean,
  above_ma200     boolean,
  golden_cross    boolean, -- 50DMA crossed above 200DMA
  death_cross     boolean, -- 50DMA crossed below 200DMA
  -- Momentum
  rsi14           numeric(6,2),
  roc20           numeric(8,4), -- rate of change 20 day
  macd            numeric(10,4),
  macd_signal     numeric(10,4),
  macd_hist       numeric(10,4),
  -- Mean reversion
  bb_upper        numeric(10,4), -- bollinger band upper
  bb_lower        numeric(10,4), -- bollinger band lower
  bb_mid          numeric(10,4),
  bb_position     numeric(6,4), -- 0=at lower, 1=at upper
  pct_from_ma20   numeric(8,4),
  -- Volume
  vol_ma20        bigint,
  vol_ratio       numeric(8,4), -- today vol / 20day avg
  obv             numeric(16,0), -- on balance volume
  -- Candlestick patterns
  candle_hammer           boolean DEFAULT false,
  candle_engulfing_bull   boolean DEFAULT false,
  candle_engulfing_bear   boolean DEFAULT false,
  candle_doji             boolean DEFAULT false,
  candle_morning_star     boolean DEFAULT false,
  candle_evening_star     boolean DEFAULT false,
  candle_shooting_star    boolean DEFAULT false,
  candle_three_soldiers   boolean DEFAULT false,
  candle_pattern          text, -- summary of pattern
  -- Relative strength
  rs_vs_asx200    numeric(8,4), -- relative to index
  -- REIT specific
  dps_yield       numeric(6,4),
  disc_to_nta     numeric(6,4),
  yield_trigger_fired boolean DEFAULT false,
  -- Scoring
  layer1_macro    integer DEFAULT 0, -- 0 or 1
  layer2_trend    integer DEFAULT 0,
  layer3_momentum integer DEFAULT 0,
  layer4_reversion integer DEFAULT 0,
  layer5_volume   integer DEFAULT 0,
  layer6_candle   integer DEFAULT 0,
  total_score     integer DEFAULT 0, -- 0-6
  signal          text, -- 'STRONG_BUY','BUY','WATCH','NEUTRAL','SELL'
  conviction      text, -- 'EXCEPTIONAL','STRONG','MODERATE','WEAK'
  signal_reasons  text[],
  UNIQUE(ticker, analysis_date)
);
CREATE INDEX IF NOT EXISTS idx_analysis_date_score ON daily_analysis(analysis_date DESC, total_score DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_ticker ON daily_analysis(ticker, analysis_date DESC);

-- ── MORNING SIGNALS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS morning_signals (
  id              bigserial PRIMARY KEY,
  signal_date     date NOT NULL DEFAULT CURRENT_DATE UNIQUE,
  -- US overnight
  sp500_change    numeric(8,6),
  nasdaq_change   numeric(8,6),
  dow_change      numeric(8,6),
  vix             numeric(6,2),
  -- Bonds
  us_10yr         numeric(6,4),
  us_2yr          numeric(6,4),
  aus_10yr        numeric(6,4),
  yield_curve_us  numeric(6,4),
  real_yield      numeric(6,4),
  credit_spread   numeric(6,4),
  breakeven_infl  numeric(6,4),
  -- FX / Commodities
  aud_usd         numeric(8,6),
  aud_change      numeric(8,6),
  gold_change     numeric(8,6),
  oil_change      numeric(8,6),
  iron_ore_change numeric(8,6),
  copper_change   numeric(8,6),
  -- Macro signal
  macro_score     integer, -- -3 to +3
  macro_signal    text,    -- 'RISK_ON','NEUTRAL','RISK_OFF'
  -- Trade candidates
  composite_score integer,
  signal          text,
  summary         text,
  -- Selected trades
  equities_long   text[], -- ASX500 long candidates
  reits_long      text[], -- REIT long candidates
  reit_triggers   text[], -- REITs at 8% yield
  created_at      timestamptz DEFAULT now()
);

-- ── BOND DATA ─────────────────────────────────────────────────────────────────
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
  copper_price    numeric(10,4),
  created_at      timestamptz DEFAULT now()
);

-- ── MODEL PORTFOLIO ───────────────────────────────────────────────────────────
-- Paper trades — $50k model portfolio
CREATE TABLE IF NOT EXISTS model_trades (
  id              bigserial PRIMARY KEY,
  ticker          text NOT NULL,
  company_name    text,
  universe        text DEFAULT 'ASX500', -- 'ASX500' or 'REIT'
  trade_date      date NOT NULL DEFAULT CURRENT_DATE,
  direction       text NOT NULL DEFAULT 'LONG',
  entry_price     numeric(10,4),
  stop_price      numeric(10,4),
  target_price    numeric(10,4),
  units           integer,
  amount          numeric(12,2),
  exit_price      numeric(10,4),
  exit_date       date,
  pnl             numeric(12,2),
  pnl_pct         numeric(8,6),
  hold_days       integer,
  status          text DEFAULT 'OPEN', -- 'OPEN','CLOSED','STOPPED','TARGETED','EXPIRED'
  -- Strategy details
  total_score     integer,
  conviction      text,
  signal_reasons  text[],
  -- Layer scores
  layer1_macro    integer,
  layer2_trend    integer,
  layer3_momentum integer,
  layer4_reversion integer,
  layer5_volume   integer,
  layer6_candle   integer,
  candle_pattern  text,
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_trades_date   ON model_trades(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_model_trades_status ON model_trades(status);
CREATE INDEX IF NOT EXISTS idx_model_trades_ticker ON model_trades(ticker);

-- ── REAL PORTFOLIO ────────────────────────────────────────────────────────────
-- Actual trades placed in CommSec — entered via contract note
CREATE TABLE IF NOT EXISTS real_trades (
  id              bigserial PRIMARY KEY,
  ticker          text NOT NULL,
  company_name    text,
  universe        text DEFAULT 'ASX500',
  trade_date      date NOT NULL,
  direction       text NOT NULL, -- 'BUY' or 'SELL'
  units           integer NOT NULL,
  price           numeric(10,4) NOT NULL,
  brokerage       numeric(8,2) DEFAULT 19.95, -- CommSec default
  total_cost      numeric(12,2),
  -- If sell
  proceeds        numeric(12,2),
  pnl             numeric(12,2),
  pnl_pct         numeric(8,6),
  -- Reference
  contract_note   text, -- contract note number
  broker          text DEFAULT 'CommSec',
  -- Tracking
  current_price   numeric(10,4),
  current_value   numeric(12,2),
  unrealised_pnl  numeric(12,2),
  -- Model comparison
  model_trade_id  bigint REFERENCES model_trades(id),
  followed_model  boolean,
  notes           text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_real_trades_date   ON real_trades(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_real_trades_ticker ON real_trades(ticker);

-- ── REIT INCOME HOLDINGS ──────────────────────────────────────────────────────
-- Real REIT holdings for income tracking
CREATE TABLE IF NOT EXISTS reit_income_holdings (
  id              bigserial PRIMARY KEY,
  ticker          text NOT NULL UNIQUE,
  name            text NOT NULL,
  units_held      numeric(12,4) DEFAULT 0,
  avg_cost        numeric(10,4) DEFAULT 0,
  total_cost      numeric(12,2) DEFAULT 0,
  -- Current data (updated daily)
  current_price   numeric(10,4),
  current_value   numeric(12,2),
  unrealised_pnl  numeric(12,2),
  -- Income
  dps_fy26        numeric(10,4),
  annual_income   numeric(12,2),
  yield_on_cost   numeric(6,4),
  yield_on_market numeric(6,4),
  -- Dates
  first_bought    date,
  last_bought     date,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ── DISTRIBUTIONS RECEIVED ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS distributions (
  id              bigserial PRIMARY KEY,
  ticker          text NOT NULL,
  ex_date         date NOT NULL,
  pay_date        date,
  amount_per_unit numeric(8,4) NOT NULL,
  units_held      numeric(12,4),
  total_received  numeric(12,2),
  franking_pct    numeric(5,2) DEFAULT 0,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

-- ── ALERTS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id          bigserial PRIMARY KEY,
  alert_type  text NOT NULL, -- 'yield_trigger','score_6','stop_hit','target_hit','morning'
  ticker      text,
  universe    text,
  message     text NOT NULL,
  data        jsonb,
  sent        boolean DEFAULT false,
  sent_at     timestamptz,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_date ON alerts(created_at DESC);

-- ── PERFORMANCE SNAPSHOTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS performance (
  id              bigserial PRIMARY KEY,
  snap_date       date NOT NULL UNIQUE,
  -- Model portfolio
  model_capital   numeric(12,2) DEFAULT 50000,
  model_invested  numeric(12,2) DEFAULT 0,
  model_cash      numeric(12,2) DEFAULT 50000,
  model_value     numeric(12,2) DEFAULT 50000,
  model_pnl       numeric(12,2) DEFAULT 0,
  model_pnl_pct   numeric(8,6) DEFAULT 0,
  model_trades_open integer DEFAULT 0,
  model_win_rate  numeric(6,4),
  -- Real portfolio
  real_value      numeric(12,2) DEFAULT 0,
  real_pnl        numeric(12,2) DEFAULT 0,
  real_pnl_pct    numeric(8,6) DEFAULT 0,
  -- REIT income
  reit_value      numeric(12,2) DEFAULT 0,
  reit_yield      numeric(6,4) DEFAULT 0,
  reit_income_ytd numeric(12,2) DEFAULT 0,
  -- Benchmark
  asx200_close    numeric(10,2),
  asx200_change   numeric(8,6),
  created_at      timestamptz DEFAULT now()
);

-- ── SEED: SETTINGS ────────────────────────────────────────────────────────────
INSERT INTO settings (key, value, label, category) VALUES
  ('conviction_4_equity',  '1000', '4/6 Score — Equity Position Size ($)', 'sizing'),
  ('conviction_5_equity',  '2000', '5/6 Score — Equity Position Size ($)', 'sizing'),
  ('conviction_6_equity',  '4000', '6/6 Score — Equity Position Size ($)', 'sizing'),
  ('conviction_4_reit',    '1000', '4/6 Score — REIT Position Size ($)',   'sizing'),
  ('conviction_5_reit',    '2000', '5/6 Score — REIT Position Size ($)',   'sizing'),
  ('conviction_6_reit',    '4000', '6/6 Score — REIT Position Size ($)',   'sizing'),
  ('max_position',         '4000', 'Maximum Single Position ($)',           'sizing'),
  ('max_deployed_pct',     '40',   'Maximum Capital Deployed (%)',          'sizing'),
  ('model_capital',        '50000','Model Portfolio Capital ($)',           'portfolio'),
  ('yield_trigger',        '0.08', 'REIT Yield Trigger (%)',                'reit'),
  ('vix_trigger',          '25',   'VIX Alert Threshold',                   'macro'),
  ('stop_loss_pct',        '1.5',  'Stop Loss (%)',                         'risk'),
  ('target_pct',           '3.0',  'Profit Target (%)',                     'risk'),
  ('alert_email',          'James.storey@outlook.com.au', 'Alert Email',   'alerts'),
  ('brokerage',            '19.95','CommSec Brokerage ($)',                 'portfolio')
ON CONFLICT (key) DO NOTHING;

-- ── SEED: REIT UNIVERSE ───────────────────────────────────────────────────────
INSERT INTO stocks (ticker, name, sector, subsector, universe, is_reit, nta, dps_fy26, implied_cap, gearing, yield_trigger) VALUES
  -- Retail REITs
  ('SCG',  'Scentre Group',              'REIT', 'Retail Premium',    'REIT', true, 3.95, 0.202, 0.057, 0.304, 0.08),
  ('VCX',  'Vicinity Centres',           'REIT', 'Retail CBD',        'REIT', true, 2.51, 0.133, 0.058, 0.258, 0.08),
  ('BWP',  'BWP Trust',                  'REIT', 'Retail Bunnings',   'REIT', true, 4.10, 0.192, 0.056, 0.228, 0.08),
  ('RGN',  'Region Group',               'REIT', 'Retail Neighbhood', 'REIT', true, 2.56, 0.141, 0.063, 0.327, 0.08),
  ('HDN',  'HomeCo Daily Needs REIT',    'REIT', 'Retail Convenience','REIT', true, 1.42, 0.086, 0.065, 0.346, 0.08),
  ('CQR',  'Charter Hall Retail REIT',   'REIT', 'Retail Supermarket','REIT', true, 4.90, 0.255, 0.064, 0.360, 0.08),
  ('CDP',  'Carindale Property Trust',   'REIT', 'Retail Regional',   'REIT', true, 5.88, 0.360, 0.067, 0.265, 0.08),
  -- Commercial REITs
  ('CIP',  'Centuria Industrial REIT',   'REIT', 'Industrial',        'REIT', true, 3.97, 0.168, 0.070, 0.359, 0.08),
  ('GOZ',  'Growthpoint Properties',     'REIT', 'Office/Industrial', 'REIT', true, 3.10, 0.183, 0.082, 0.412, 0.09),
  ('DXI',  'Dexus Industria REIT',       'REIT', 'Industrial',        'REIT', true, 3.40, 0.166, 0.078, 0.262, 0.08),
  ('COF',  'Centuria Office REIT',       'REIT', 'Office',            'REIT', true, 1.32, 0.102, 0.091, 0.425, 0.10),
  ('GDI',  'GDI Property Group',         'REIT', 'Office',            'REIT', true, 1.19, 0.050, 0.098, 0.350, 0.09),
  ('GDF',  'GARDA Property Group',       'REIT', 'Industrial',        'REIT', true, 1.57, 0.086, 0.085, 0.208, 0.08),
  ('LED',  'Lederer Capital',            'REIT', 'Commercial',        'REIT', true, 0.63, 0.065, 0.084, 0.416, 0.10),
  -- Specialised REITs
  ('DXC',  'Dexus Convenience Retail',   'REIT', 'Petrol/Convenience','REIT', true, 3.79, 0.209, 0.079, 0.298, 0.08),
  ('WPR',  'Waypoint REIT',              'REIT', 'Petrol Stations',   'REIT', true, 2.92, 0.172, 0.064, 0.327, 0.08),
  ('CLW',  'Charter Hall Long WALE',     'REIT', 'Long WALE',         'REIT', true, 4.68, 0.258, 0.064, 0.410, 0.08),
  ('ARF',  'Arena REIT',                 'REIT', 'Childcare',         'REIT', true, 3.63, 0.168, 0.058, 0.232, 0.08),
  ('ASK',  'Abacus Storage King',        'REIT', 'Self Storage',      'REIT', true, 1.76, 0.079, 0.063, 0.323, 0.08),
  ('CQE',  'Charter Hall Social Infra',  'REIT', 'Social Infrastr.',  'REIT', true, 3.89, 0.172, 0.070, 0.348, 0.08),
  ('HCW',  'HealthCo Healthcare REIT',   'REIT', 'Healthcare',        'REIT', true, 1.16, 0.060, 0.085, 0.285, 0.08),
  ('REP',  'RAM Essential Services',     'REIT', 'Essential Services','REIT', true, 0.80, 0.049, 0.078, 0.401, 0.09),
  ('RFF',  'Rural Funds Group',          'REIT', 'Agriculture',       'REIT', true, 3.10, 0.118, null,  0.391, 0.08),
  ('DXS_SKIP', 'Dexus — EXCLUDED',       'REIT', 'Fund Manager',      'REIT', false, null, null, null, null, null),
  -- Govt Bond
  ('GSBG37','Govt Bond 2037',            'Bond', 'Commonwealth',      'REIT', false, 100.0, 4.75, null, null, 0.00)
ON CONFLICT (ticker) DO NOTHING;

-- ── SEED: ASX500 UNIVERSE (top liquid stocks) ─────────────────────────────────
INSERT INTO stocks (ticker, name, sector, universe, is_reit, us_corr, beta) VALUES
  -- Resources
  ('BHP',  'BHP Group',               'Resources',   'ASX500', false, 0.78, 1.20),
  ('RIO',  'Rio Tinto',               'Resources',   'ASX500', false, 0.76, 1.15),
  ('FMG',  'Fortescue',               'Resources',   'ASX500', false, 0.72, 1.35),
  ('S32',  'South32',                 'Resources',   'ASX500', false, 0.70, 1.25),
  ('MIN',  'Mineral Resources',       'Resources',   'ASX500', false, 0.68, 1.45),
  ('ILU',  'Iluka Resources',         'Resources',   'ASX500', false, 0.62, 1.20),
  ('AWC',  'Alumina',                 'Resources',   'ASX500', false, 0.60, 1.10),
  ('OZL',  'OZ Minerals',             'Resources',   'ASX500', false, 0.65, 1.30),
  -- Gold
  ('NST',  'Northern Star',           'Gold',        'ASX500', false, 0.85, 1.10),
  ('EVN',  'Evolution Mining',        'Gold',        'ASX500', false, 0.83, 1.05),
  ('NCM',  'Newmont Australia',       'Gold',        'ASX500', false, 0.82, 1.08),
  ('WAF',  'West African Resources',  'Gold',        'ASX500', false, 0.75, 1.25),
  ('RRL',  'Regis Resources',         'Gold',        'ASX500', false, 0.73, 1.15),
  -- Financials
  ('CBA',  'Commonwealth Bank',       'Financials',  'ASX500', false, 0.70, 0.90),
  ('ANZ',  'ANZ Banking Group',       'Financials',  'ASX500', false, 0.68, 1.00),
  ('WBC',  'Westpac Banking Corp',    'Financials',  'ASX500', false, 0.67, 0.95),
  ('NAB',  'National Australia Bank', 'Financials',  'ASX500', false, 0.69, 0.95),
  ('MQG',  'Macquarie Group',         'Financials',  'ASX500', false, 0.75, 1.30),
  ('SUN',  'Suncorp Group',           'Financials',  'ASX500', false, 0.60, 0.85),
  ('IAG',  'Insurance Australia',     'Financials',  'ASX500', false, 0.58, 0.80),
  ('QBE',  'QBE Insurance',           'Financials',  'ASX500', false, 0.62, 0.90),
  -- Technology
  ('XRO',  'Xero',                    'Technology',  'ASX500', false, 0.82, 1.45),
  ('WTC',  'WiseTech Global',         'Technology',  'ASX500', false, 0.80, 1.50),
  ('REA',  'REA Group',               'Technology',  'ASX500', false, 0.75, 1.20),
  ('CAR',  'CAR Group',               'Technology',  'ASX500', false, 0.72, 1.15),
  ('SEK',  'Seek',                    'Technology',  'ASX500', false, 0.70, 1.10),
  ('CPU',  'Computershare',           'Technology',  'ASX500', false, 0.68, 1.05),
  -- Consumer
  ('WES',  'Wesfarmers',              'Consumer',    'ASX500', false, 0.65, 0.85),
  ('WOW',  'Woolworths Group',        'Consumer',    'ASX500', false, 0.55, 0.70),
  ('COL',  'Coles Group',             'Consumer',    'ASX500', false, 0.52, 0.65),
  ('JBH',  'JB Hi-Fi',               'Consumer',    'ASX500', false, 0.68, 1.10),
  ('HVN',  'Harvey Norman',           'Consumer',    'ASX500', false, 0.65, 1.05),
  ('MTS',  'Metcash',                 'Consumer',    'ASX500', false, 0.50, 0.75),
  -- Healthcare
  ('CSL',  'CSL Limited',             'Healthcare',  'ASX500', false, 0.72, 0.85),
  ('RMD',  'ResMed',                  'Healthcare',  'ASX500', false, 0.75, 0.90),
  ('COH',  'Cochlear',                'Healthcare',  'ASX500', false, 0.70, 0.85),
  ('SHL',  'Sonic Healthcare',        'Healthcare',  'ASX500', false, 0.62, 0.75),
  ('RHC',  'Ramsay Health Care',      'Healthcare',  'ASX500', false, 0.60, 0.80),
  ('PME',  'Pro Medicus',             'Healthcare',  'ASX500', false, 0.78, 1.20),
  -- Energy
  ('WDS',  'Woodside Energy',         'Energy',      'ASX500', false, 0.70, 1.10),
  ('STO',  'Santos',                  'Energy',      'ASX500', false, 0.68, 1.15),
  ('BPT',  'Beach Energy',            'Energy',      'ASX500', false, 0.65, 1.20),
  ('KAR',  'Karoon Energy',           'Energy',      'ASX500', false, 0.62, 1.25),
  -- Industrials
  ('QAN',  'Qantas Airways',          'Industrials', 'ASX500', false, 0.68, 1.40),
  ('TCL',  'Transurban Group',        'Industrials', 'ASX500', false, 0.60, 0.75),
  ('AZJ',  'Aurizon Holdings',        'Industrials', 'ASX500', false, 0.55, 0.70),
  ('BXB',  'Brambles',                'Industrials', 'ASX500', false, 0.65, 0.80),
  ('AMC',  'Amcor',                   'Industrials', 'ASX500', false, 0.60, 0.75),
  ('ORI',  'Orica',                   'Industrials', 'ASX500', false, 0.62, 0.90),
  -- Utilities
  ('AGL',  'AGL Energy',              'Utilities',   'ASX500', false, 0.45, 0.70),
  ('ORG',  'Origin Energy',           'Utilities',   'ASX500', false, 0.50, 0.85),
  ('APA',  'APA Group',               'Utilities',   'ASX500', false, 0.48, 0.65)
ON CONFLICT (ticker) DO NOTHING;

-- Delete the skip placeholder
DELETE FROM stocks WHERE ticker = 'DXS_SKIP';
