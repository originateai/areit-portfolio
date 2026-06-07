-- ===== DXI v1 (from DXI_Dexus_Industria_Model.xlsx) =====

UPDATE reit_models SET is_current=false WHERE ticker='DXI';

INSERT INTO reit_models (ticker, name, model_version, mgmt_model, manager_parent, manager_stake_pct, fy_end, securities_m, is_current, built_at) VALUES
  ('DXI', 'Dexus Industria REIT', 1, 'external', 'Dexus (DXS)', 18.6, '30 June', 315.987948717949, TRUE, '2026-06-06T11:23:35.677Z')
ON CONFLICT (ticker,model_version) DO UPDATE SET name=EXCLUDED.name, mgmt_model=EXCLUDED.mgmt_model, manager_parent=EXCLUDED.manager_parent, manager_stake_pct=EXCLUDED.manager_stake_pct, fy_end=EXCLUDED.fy_end, securities_m=EXCLUDED.securities_m, is_current=EXCLUDED.is_current, built_at=EXCLUDED.built_at;

INSERT INTO reit_model_assumptions (ticker, model_version, base_noi_m, cap_rate, escalation, reversion, expiry_profile, payout_ratio, gearing_current, debt_ladder, req_return, erp, beta, base_pe, industrial_premium, terminal_adjustments, exit_cap, dcf_unlevered_rate, synergy_multiple, control_premium) VALUES
  ('DXI', 1, 85, 0.0591, 0.033, 0.06, '{"FY26E":0.043,"FY27E":0.068,"FY28E":0.197,"FY29E":0.096,"FY30E":0.142}'::jsonb, 0.93, 0.29, '{"FY26":0,"FY27":130,"FY28":120,"FY29":90,"FY30":110,"Beyond":0}'::jsonb, 0.12, 0.055, 0.9, 14, 2.5, '{"gearing":0,"affo":-0.25,"underrent":0.25,"mgmt":-0.75,"quality":0}'::jsonb, 0.0575, 0.07, 12, 0)
ON CONFLICT (ticker,model_version) DO UPDATE SET base_noi_m=EXCLUDED.base_noi_m, cap_rate=EXCLUDED.cap_rate, escalation=EXCLUDED.escalation, reversion=EXCLUDED.reversion, expiry_profile=EXCLUDED.expiry_profile, payout_ratio=EXCLUDED.payout_ratio, gearing_current=EXCLUDED.gearing_current, debt_ladder=EXCLUDED.debt_ladder, req_return=EXCLUDED.req_return, erp=EXCLUDED.erp, beta=EXCLUDED.beta, base_pe=EXCLUDED.base_pe, industrial_premium=EXCLUDED.industrial_premium, terminal_adjustments=EXCLUDED.terminal_adjustments, exit_cap=EXCLUDED.exit_cap, dcf_unlevered_rate=EXCLUDED.dcf_unlevered_rate, synergy_multiple=EXCLUDED.synergy_multiple, control_premium=EXCLUDED.control_premium;

INSERT INTO reit_model_actuals (ticker, fy, noi_m, mgmt_fee_m, net_finance_m, ffo_m, ffo_per_unit, dpu, nta, gearing, ocf_cover) VALUES
  ('DXI', 'FY24', 81.1, 8.329, 14.991, 55.28, 17.4236454754625, 16.4, 3.23515617612759, 0.273, 1.02013596175297),
  ('DXI', 'FY25', 85, 8.104, 16.284, 57.812, 18.2217039114949, 16.4, 3.33652094430611, 0.29, 1.06495429375764)
ON CONFLICT (ticker,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, mgmt_fee_m=EXCLUDED.mgmt_fee_m, net_finance_m=EXCLUDED.net_finance_m, ffo_m=EXCLUDED.ffo_m, ffo_per_unit=EXCLUDED.ffo_per_unit, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, ocf_cover=EXCLUDED.ocf_cover;

INSERT INTO reit_model_forecasts (ticker, model_version, fy, noi_m, ffo_m, epu, dpu, nta, gearing, affo_cover, ocf_cover, lfl_growth) VALUES
  ('DXI', 1, 'FY26E', 77.499988706, 51.2369333838274, 16.2148378100209, 15.0797991633194, 3.34003077973112, 0.254204904599628, 0.968239168754012, 1.02280330325808, 0.0356651399999999),
  ('DXI', 1, 'FY27E', 83.3841228856979, 55.800339991046, 17.7792344266592, 16.5346880167931, 3.35629702254411, 0.304476837271868, 0.969284185290362, 1.02131300459357, 0.03721464),
  ('DXI', 1, 'FY28E', 91.1539240844076, 57.6887937242236, 18.4563302526269, 17.164387134943, 3.48558002592237, 0.33856390581517, 0.955978397248477, 1.00816795597915, 0.0452100599999998),
  ('DXI', 1, 'FY29E', 98.7043767198092, 59.8477527170702, 19.1470442995238, 17.8067511985571, 3.6652093313999, 0.355491998734301, 0.971061744145631, 1.02316528067497, 0.03895008),
  ('DXI', 1, 'FY30E', 105.830334163774, 62.8142526151254, 20.0961142709748, 18.6893862720066, 3.88554961373059, 0.360414707577035, 0.970847614819942, 1.02220230451717, 0.0418011599999999)
ON CONFLICT (ticker,model_version,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, ffo_m=EXCLUDED.ffo_m, epu=EXCLUDED.epu, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, affo_cover=EXCLUDED.affo_cover, ocf_cover=EXCLUDED.ocf_cover, lfl_growth=EXCLUDED.lfl_growth;

INSERT INTO reit_model_outputs (ticker, model_version, equity_dcf_value, buy_threshold, breakeven_irr, terminal_pe, nav_nta, business_dcf_value, internalisation_synergy, takeover_value, takeover_upside, blended_value, eq_score, ddm_value, ffo_multiple_value, price_at_build) VALUES
  ('DXI', 1, 2.44957679839491, 2.44957679839491, 0.131641463626433, 15.75, 3.34003077973112, 3.85264678732189, 0.267830576184547, 4.12047736350644, 0.760887762182239, 2.96088490170264, 92, 2.26352279206925, 2.10792891530272, 2.34)
ON CONFLICT (ticker,model_version) DO UPDATE SET equity_dcf_value=EXCLUDED.equity_dcf_value, buy_threshold=EXCLUDED.buy_threshold, breakeven_irr=EXCLUDED.breakeven_irr, terminal_pe=EXCLUDED.terminal_pe, nav_nta=EXCLUDED.nav_nta, business_dcf_value=EXCLUDED.business_dcf_value, internalisation_synergy=EXCLUDED.internalisation_synergy, takeover_value=EXCLUDED.takeover_value, takeover_upside=EXCLUDED.takeover_upside, blended_value=EXCLUDED.blended_value, eq_score=EXCLUDED.eq_score, ddm_value=EXCLUDED.ddm_value, ffo_multiple_value=EXCLUDED.ffo_multiple_value, price_at_build=EXCLUDED.price_at_build;

INSERT INTO reit_assets (ticker, asset_name, sector, state, major_tenant, passing_income_m, cap_rate, wale_years, occupancy, as_of) VALUES
  ('DXI', 'ASCEND Estate, Jandakot Airport (33.3% interest)', 'Industrial', 'WA', 'Airport logistics estate + pipeline', 10.5, 0.0585, 179.487179487179, 6.5, '2026-06-06'),
  ('DXI', 'WA industrial - balance (61 assets)', 'Industrial', 'WA', 'Diversified logistics', 18.2, 0.0595, 305.882352941176, 5.8, '2026-06-06'),
  ('DXI', 'Velociti, Moorebank', 'Industrial', 'NSW', 'Modern logistics facility', 4.5, 0.056, 80.3571428571429, 8.5, '2026-06-06'),
  ('DXI', 'WesTrac Tomago + 32 Cox Pl Glendenning', 'Industrial', 'NSW', 'WesTrac (CAT) / urban logistics', 6, 0.0575, 104.347826086957, 7, '2026-06-06'),
  ('DXI', 'NSW industrial - balance', 'Industrial', 'NSW', 'Urban infill logistics', 6.5, 0.059, 110.169491525424, 6, '2026-06-06'),
  ('DXI', 'VIC industrial (Truganina, Ravenhall, Knoxfield)', 'Industrial', 'VIC', 'Logistics & warehouses', 18, 0.06, 300, 5.5, '2026-06-06'),
  ('DXI', 'SA industrial (Adelaide Airport, Butler Bvd)', 'Industrial', 'SA', 'Logistics', 3.6, 0.061, 59.016393442623, 5, '2026-06-06'),
  ('DXI', 'QLD industrial - balance (ex-BTP)', 'Industrial', 'QLD', 'Industrial', 5.6, 0.06, 93.3333333333333, 5, '2026-06-06'),
  ('DXI', 'Brisbane Technology Park (held for sale)', 'Business Park', 'QLD', 'Office/business park - DIVESTING $155.5m', 12.1, 0.078, 155.128205128205, 3, '2026-06-06')
ON CONFLICT (ticker,asset_name,as_of) DO UPDATE SET sector=EXCLUDED.sector, state=EXCLUDED.state, major_tenant=EXCLUDED.major_tenant, passing_income_m=EXCLUDED.passing_income_m, cap_rate=EXCLUDED.cap_rate, wale_years=EXCLUDED.wale_years, occupancy=EXCLUDED.occupancy;

INSERT INTO reit_prices (ticker, last_price, price_date) VALUES
  ('DXI', 2.34, '2026-06-06')
ON CONFLICT (ticker) DO UPDATE SET last_price=EXCLUDED.last_price, price_date=EXCLUDED.price_date;
