-- ===== WPR v1 (from WPR_Waypoint_REIT_Model.xlsx) =====

UPDATE reit_models SET is_current=false WHERE ticker='WPR';

INSERT INTO reit_models (ticker, name, model_version, mgmt_model, manager_parent, manager_stake_pct, fy_end, securities_m, is_current, built_at) VALUES
  ('WPR', 'Waypoint REIT', 1, 'internal', NULL, NULL, '30 June', 659.8, TRUE, '2026-06-06T11:23:37.345Z')
ON CONFLICT (ticker,model_version) DO UPDATE SET name=EXCLUDED.name, mgmt_model=EXCLUDED.mgmt_model, manager_parent=EXCLUDED.manager_parent, manager_stake_pct=EXCLUDED.manager_stake_pct, fy_end=EXCLUDED.fy_end, securities_m=EXCLUDED.securities_m, is_current=EXCLUDED.is_current, built_at=EXCLUDED.built_at;

INSERT INTO reit_model_assumptions (ticker, model_version, base_noi_m, cap_rate, escalation, reversion, expiry_profile, payout_ratio, gearing_current, debt_ladder, req_return, erp, beta, base_pe, industrial_premium, terminal_adjustments, exit_cap, dcf_unlevered_rate, synergy_multiple, control_premium) VALUES
  ('WPR', 1, 163.5, 0.0566, 0.03, -0.03, '{"FY26E":0.05,"FY27E":0.06,"FY28E":0.08,"FY29E":0.1,"FY30E":0.12}'::jsonb, 1, 0.327, '{"FY26":50,"FY27":300,"FY28":300,"FY29":185,"FY30":100,"Beyond":0}'::jsonb, 0.12, 0.055, 0.75, 14, 1, '{"gearing":0,"affo":-0.25,"underrent":-0.25,"mgmt":0.5,"quality":-0.25}'::jsonb, 0.0575, 0.0675, 0, 0.12)
ON CONFLICT (ticker,model_version) DO UPDATE SET base_noi_m=EXCLUDED.base_noi_m, cap_rate=EXCLUDED.cap_rate, escalation=EXCLUDED.escalation, reversion=EXCLUDED.reversion, expiry_profile=EXCLUDED.expiry_profile, payout_ratio=EXCLUDED.payout_ratio, gearing_current=EXCLUDED.gearing_current, debt_ladder=EXCLUDED.debt_ladder, req_return=EXCLUDED.req_return, erp=EXCLUDED.erp, beta=EXCLUDED.beta, base_pe=EXCLUDED.base_pe, industrial_premium=EXCLUDED.industrial_premium, terminal_adjustments=EXCLUDED.terminal_adjustments, exit_cap=EXCLUDED.exit_cap, dcf_unlevered_rate=EXCLUDED.dcf_unlevered_rate, synergy_multiple=EXCLUDED.synergy_multiple, control_premium=EXCLUDED.control_premium;

INSERT INTO reit_model_actuals (ticker, fy, noi_m, mgmt_fee_m, net_finance_m, ffo_m, ffo_per_unit, dpu, nta, gearing, ocf_cover) VALUES
  ('WPR', 'FY24', 158, 8.4, 40, 109.1, 16.4555052790347, 16.48, 2.76018099547511, 0.31, 0.993937530202522),
  ('WPR', 'FY25', 163.5, 8.6, 44, 110.4, 16.6515837104072, 16.64, 2.90045248868778, 0.327, 0.996163998143636)
ON CONFLICT (ticker,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, mgmt_fee_m=EXCLUDED.mgmt_fee_m, net_finance_m=EXCLUDED.net_finance_m, ffo_m=EXCLUDED.ffo_m, ffo_per_unit=EXCLUDED.ffo_per_unit, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, ocf_cover=EXCLUDED.ocf_cover;

INSERT INTO reit_model_forecasts (ticker, model_version, fy, noi_m, ffo_m, epu, dpu, nta, gearing, affo_cover, ocf_cover, lfl_growth) VALUES
  ('WPR', 1, 'FY26E', 166.1523925, 114.376978586572, 17.3350983004808, 17.3350983004808, 3.00705461929249, 0.323118034894832, 0.986885472771388, 0.995628490923796, 0.0284550000000001),
  ('WPR', 1, 'FY27E', 169.828917739305, 116.249784996939, 17.6189428610093, 17.6189428610093, 3.09565158248257, 0.318294165506458, 0.987096750329134, 0.995698916776378, 0.028146),
  ('WPR', 1, 'FY28E', 174.503968186833, 119.585328751135, 18.1244814718301, 18.1244814718301, 3.21098663013936, 0.311881403633145, 0.987456655296557, 0.995818885098852, 0.027528),
  ('WPR', 1, 'FY29E', 179.19986997074, 123.315893647203, 18.6898899131862, 18.6898899131862, 3.32688002603692, 0.305767413236288, 0.987836117830104, 0.995945372610035, 0.02691),
  ('WPR', 1, 'FY30E', 183.911392952011, 126.958576761975, 19.2419788969347, 19.2419788969347, 3.44319171973119, 0.299939929302793, 0.988185122752185, 0.996061707584062, 0.026292)
ON CONFLICT (ticker,model_version,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, ffo_m=EXCLUDED.ffo_m, epu=EXCLUDED.epu, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, affo_cover=EXCLUDED.affo_cover, ocf_cover=EXCLUDED.ocf_cover, lfl_growth=EXCLUDED.lfl_growth;

INSERT INTO reit_model_outputs (ticker, model_version, equity_dcf_value, buy_threshold, breakeven_irr, terminal_pe, nav_nta, business_dcf_value, internalisation_synergy, takeover_value, takeover_upside, blended_value, eq_score, ddm_value, ffo_multiple_value, price_at_build) VALUES
  ('WPR', 1, 2.26266935991005, 2.26266935991005, 0.0948441042067599, 14.75, 3.00705461929249, 3.16350816299915, 0, 3.54312914255905, 0.417251657023618, 2.68734431048556, 72, 2.35786664685926, 2.25356277906251, 2.5)
ON CONFLICT (ticker,model_version) DO UPDATE SET equity_dcf_value=EXCLUDED.equity_dcf_value, buy_threshold=EXCLUDED.buy_threshold, breakeven_irr=EXCLUDED.breakeven_irr, terminal_pe=EXCLUDED.terminal_pe, nav_nta=EXCLUDED.nav_nta, business_dcf_value=EXCLUDED.business_dcf_value, internalisation_synergy=EXCLUDED.internalisation_synergy, takeover_value=EXCLUDED.takeover_value, takeover_upside=EXCLUDED.takeover_upside, blended_value=EXCLUDED.blended_value, eq_score=EXCLUDED.eq_score, ddm_value=EXCLUDED.ddm_value, ffo_multiple_value=EXCLUDED.ffo_multiple_value, price_at_build=EXCLUDED.price_at_build;

INSERT INTO reit_assets (ticker, asset_name, sector, state, major_tenant, passing_income_m, cap_rate, wale_years, occupancy, as_of) VALUES
  ('WPR', 'Metro service stations (VIC/NSW/QLD)', 'Service Stations', 'VIC/NSW/QLD', 'Viva Energy (Shell/OTR)', 78, 0.0555, 1405.40540540541, 8.6, '2026-06-06'),
  ('WPR', 'Regional & highway sites', 'Service Stations', 'National', 'Viva Energy (Shell/Liberty)', 62, 0.058, 1068.96551724138, 8.2, '2026-06-06'),
  ('WPR', 'Convenience & non-core', 'Service Stations', 'Various', 'Viva/other operators', 23.5, 0.06, 391.666666666667, 7.5, '2026-06-06'),
  ('WPR', '(no second sector)', NULL, NULL, NULL, 0, 0, 0, NULL, '2026-06-06'),
  ('WPR', 'Divestment-flagged (Divest?=1)', NULL, NULL, NULL, 0, NULL, 0, NULL, '2026-06-06')
ON CONFLICT (ticker,asset_name,as_of) DO UPDATE SET sector=EXCLUDED.sector, state=EXCLUDED.state, major_tenant=EXCLUDED.major_tenant, passing_income_m=EXCLUDED.passing_income_m, cap_rate=EXCLUDED.cap_rate, wale_years=EXCLUDED.wale_years, occupancy=EXCLUDED.occupancy;

INSERT INTO reit_prices (ticker, last_price, price_date) VALUES
  ('WPR', 2.5, '2026-06-06')
ON CONFLICT (ticker) DO UPDATE SET last_price=EXCLUDED.last_price, price_date=EXCLUDED.price_date;
