-- ===== RGN v1 (from RGN_Region_Group_Model.xlsx) =====

UPDATE reit_models SET is_current=false WHERE ticker='RGN';

INSERT INTO reit_models (ticker, name, model_version, mgmt_model, manager_parent, manager_stake_pct, fy_end, securities_m, is_current, built_at) VALUES
  ('RGN', 'Region Group', 1, 'internal', NULL, NULL, '30 June', 1158.75, TRUE, '2026-06-06T11:23:36.951Z')
ON CONFLICT (ticker,model_version) DO UPDATE SET name=EXCLUDED.name, mgmt_model=EXCLUDED.mgmt_model, manager_parent=EXCLUDED.manager_parent, manager_stake_pct=EXCLUDED.manager_stake_pct, fy_end=EXCLUDED.fy_end, securities_m=EXCLUDED.securities_m, is_current=EXCLUDED.is_current, built_at=EXCLUDED.built_at;

INSERT INTO reit_model_assumptions (ticker, model_version, base_noi_m, cap_rate, escalation, reversion, expiry_profile, payout_ratio, gearing_current, debt_ladder, req_return, erp, beta, base_pe, industrial_premium, terminal_adjustments, exit_cap, dcf_unlevered_rate, synergy_multiple, control_premium) VALUES
  ('RGN', 1, 255.5, 0.06, 0.02, 0.01, '{"FY26E":0.14,"FY27E":0.16,"FY28E":0.15,"FY29E":0.13,"FY30E":0.12}'::jsonb, 0.88, 0.325, '{"FY26":0,"FY27":320,"FY28":350,"FY29":350,"FY30":359,"Beyond":0}'::jsonb, 0.12, 0.055, 0.85, 14, 0.5, '{"gearing":0,"affo":-0.1,"underrent":0.1,"mgmt":0.5,"quality":0.25}'::jsonb, 0.0625, 0.07, 0, 0.1)
ON CONFLICT (ticker,model_version) DO UPDATE SET base_noi_m=EXCLUDED.base_noi_m, cap_rate=EXCLUDED.cap_rate, escalation=EXCLUDED.escalation, reversion=EXCLUDED.reversion, expiry_profile=EXCLUDED.expiry_profile, payout_ratio=EXCLUDED.payout_ratio, gearing_current=EXCLUDED.gearing_current, debt_ladder=EXCLUDED.debt_ladder, req_return=EXCLUDED.req_return, erp=EXCLUDED.erp, beta=EXCLUDED.beta, base_pe=EXCLUDED.base_pe, industrial_premium=EXCLUDED.industrial_premium, terminal_adjustments=EXCLUDED.terminal_adjustments, exit_cap=EXCLUDED.exit_cap, dcf_unlevered_rate=EXCLUDED.dcf_unlevered_rate, synergy_multiple=EXCLUDED.synergy_multiple, control_premium=EXCLUDED.control_premium;

INSERT INTO reit_model_actuals (ticker, fy, noi_m, mgmt_fee_m, net_finance_m, ffo_m, ffo_per_unit, dpu, nta, gearing, ocf_cover) VALUES
  ('RGN', 'FY24', 250, 15, 56, 178, 15.3448275862069, 13.6, 2.42241379310345, 0.32, 1.05223123732252),
  ('RGN', 'FY25', 255.5, 15.5, 59, 180, 15.5172413793103, 13.7, 2.4698275862069, 0.325, 1.05713566574377)
ON CONFLICT (ticker,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, mgmt_fee_m=EXCLUDED.mgmt_fee_m, net_finance_m=EXCLUDED.net_finance_m, ffo_m=EXCLUDED.ffo_m, ffo_per_unit=EXCLUDED.ffo_per_unit, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, ocf_cover=EXCLUDED.ocf_cover;

INSERT INTO reit_model_forecasts (ticker, model_version, fy, noi_m, ffo_m, epu, dpu, nta, gearing, affo_cover, ocf_cover, lfl_growth) VALUES
  ('RGN', 1, 'FY26E', 260.974854, 188.2145054, 16.2428915124056, 14.2937445309169, 2.5557597761795, 0.317760129736982, 1.00957406553369, 1.06391245303224, 0.021428),
  ('RGN', 1, 'FY27E', 267.620262041728, 188.639473738946, 16.3088882195054, 14.3518216331648, 2.64802320881165, 0.311837002224144, 1.00383570090832, 1.06106367303675, 0.0216320000000001),
  ('RGN', 1, 'FY28E', 274.382126283486, 191.619417257353, 16.5665202239786, 14.5785377971012, 2.74199329592997, 0.305186380798379, 1.0058966912188, 1.06223469025862, 0.0215300000000001),
  ('RGN', 1, 'FY29E', 280.233599508608, 195.220220364337, 16.8778288499427, 14.8524893879496, 2.82667714047961, 0.298794798974506, 1.00248219935068, 1.0606915197911, 0.0213260000000002),
  ('RGN', 1, 'FY30E', 286.181277424579, 199.443801772865, 17.242979980363, 15.1738223827194, 2.91318540112421, 0.292536161778952, 1.00531737970368, 1.0622940130341, 0.0212240000000001)
ON CONFLICT (ticker,model_version,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, ffo_m=EXCLUDED.ffo_m, epu=EXCLUDED.epu, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, affo_cover=EXCLUDED.affo_cover, ocf_cover=EXCLUDED.ocf_cover, lfl_growth=EXCLUDED.lfl_growth;

INSERT INTO reit_model_outputs (ticker, model_version, equity_dcf_value, buy_threshold, breakeven_irr, terminal_pe, nav_nta, business_dcf_value, internalisation_synergy, takeover_value, takeover_upside, blended_value, eq_score, ddm_value, ffo_multiple_value, price_at_build) VALUES
  ('RGN', 1, 2.09013925868536, 2.09013925868536, 0.0853245738387723, 15.25, 2.5557597761795, 2.50628861807122, 0, 2.75691747987834, 0.148715616615975, 2.27998196939395, 80, 1.87184977665772, 2.11157589661273, 2.4)
ON CONFLICT (ticker,model_version) DO UPDATE SET equity_dcf_value=EXCLUDED.equity_dcf_value, buy_threshold=EXCLUDED.buy_threshold, breakeven_irr=EXCLUDED.breakeven_irr, terminal_pe=EXCLUDED.terminal_pe, nav_nta=EXCLUDED.nav_nta, business_dcf_value=EXCLUDED.business_dcf_value, internalisation_synergy=EXCLUDED.internalisation_synergy, takeover_value=EXCLUDED.takeover_value, takeover_upside=EXCLUDED.takeover_upside, blended_value=EXCLUDED.blended_value, eq_score=EXCLUDED.eq_score, ddm_value=EXCLUDED.ddm_value, ffo_multiple_value=EXCLUDED.ffo_multiple_value, price_at_build=EXCLUDED.price_at_build;

INSERT INTO reit_assets (ticker, asset_name, sector, state, major_tenant, passing_income_m, cap_rate, wale_years, occupancy, as_of) VALUES
  ('RGN', 'Metro convenience centres (NSW/VIC/QLD)', 'Convenience Retail', 'NSW/VIC/QLD', 'Woolworths / Coles anchored', 120, 0.0585, 2051.28205128205, 5.1, '2026-06-06'),
  ('RGN', 'Regional & sub-regional centres', 'Convenience Retail', 'National', 'Woolworths / Coles / IGA', 95.5, 0.0615, 1552.84552845528, 4.7, '2026-06-06'),
  ('RGN', 'Neighbourhood & non-core', 'Convenience Retail', 'Various', 'Supermarket + non-discretionary specialty', 40, 0.064, 625, 4.5, '2026-06-06'),
  ('RGN', '(no second sector)', NULL, NULL, NULL, 0, 0, 0, NULL, '2026-06-06'),
  ('RGN', 'Divestment-flagged (Divest?=1)', NULL, NULL, NULL, 0, NULL, 0, NULL, '2026-06-06')
ON CONFLICT (ticker,asset_name,as_of) DO UPDATE SET sector=EXCLUDED.sector, state=EXCLUDED.state, major_tenant=EXCLUDED.major_tenant, passing_income_m=EXCLUDED.passing_income_m, cap_rate=EXCLUDED.cap_rate, wale_years=EXCLUDED.wale_years, occupancy=EXCLUDED.occupancy;

INSERT INTO reit_prices (ticker, last_price, price_date) VALUES
  ('RGN', 2.4, '2026-06-06')
ON CONFLICT (ticker) DO UPDATE SET last_price=EXCLUDED.last_price, price_date=EXCLUDED.price_date;
