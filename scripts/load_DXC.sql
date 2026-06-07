-- ===== DXC v1 (from DXC_Dexus_Convenience_Retail_Model.xlsx) =====

UPDATE reit_models SET is_current=false WHERE ticker='DXC';

INSERT INTO reit_models (ticker, name, model_version, mgmt_model, manager_parent, manager_stake_pct, fy_end, securities_m, is_current, built_at) VALUES
  ('DXC', 'Dexus Convenience Retail REIT', 1, 'external', 'Dexus (DXS)', NULL, '30 June', 141.928571428571, TRUE, '2026-06-06T11:23:36.113Z')
ON CONFLICT (ticker,model_version) DO UPDATE SET name=EXCLUDED.name, mgmt_model=EXCLUDED.mgmt_model, manager_parent=EXCLUDED.manager_parent, manager_stake_pct=EXCLUDED.manager_stake_pct, fy_end=EXCLUDED.fy_end, securities_m=EXCLUDED.securities_m, is_current=EXCLUDED.is_current, built_at=EXCLUDED.built_at;

INSERT INTO reit_model_assumptions (ticker, model_version, base_noi_m, cap_rate, escalation, reversion, expiry_profile, payout_ratio, gearing_current, debt_ladder, req_return, erp, beta, base_pe, industrial_premium, terminal_adjustments, exit_cap, dcf_unlevered_rate, synergy_multiple, control_premium) VALUES
  ('DXC', 1, 46, 0.064, 0.029, 0, '{"FY26E":0.04,"FY27E":0.05,"FY28E":0.06,"FY29E":0.07,"FY30E":0.09}'::jsonb, 1, 0.302, '{"FY26":0,"FY27":0,"FY28":120,"FY29":50,"FY30":52,"Beyond":0}'::jsonb, 0.12, 0.055, 0.8, 14, 1.5, '{"gearing":0,"affo":-0.25,"underrent":0,"mgmt":-0.75,"quality":0.25}'::jsonb, 0.0625, 0.0675, 12, 0)
ON CONFLICT (ticker,model_version) DO UPDATE SET base_noi_m=EXCLUDED.base_noi_m, cap_rate=EXCLUDED.cap_rate, escalation=EXCLUDED.escalation, reversion=EXCLUDED.reversion, expiry_profile=EXCLUDED.expiry_profile, payout_ratio=EXCLUDED.payout_ratio, gearing_current=EXCLUDED.gearing_current, debt_ladder=EXCLUDED.debt_ladder, req_return=EXCLUDED.req_return, erp=EXCLUDED.erp, beta=EXCLUDED.beta, base_pe=EXCLUDED.base_pe, industrial_premium=EXCLUDED.industrial_premium, terminal_adjustments=EXCLUDED.terminal_adjustments, exit_cap=EXCLUDED.exit_cap, dcf_unlevered_rate=EXCLUDED.dcf_unlevered_rate, synergy_multiple=EXCLUDED.synergy_multiple, control_premium=EXCLUDED.control_premium;

INSERT INTO reit_model_actuals (ticker, fy, noi_m, mgmt_fee_m, net_finance_m, ffo_m, ffo_per_unit, dpu, nta, gearing, ocf_cover) VALUES
  ('DXC', 'FY24', 44.8, 4.4, 8.8, 29.2, 20.4195804195804, 20.4, 3.55594405594406, 0.3, 0.980392156862745),
  ('DXC', 'FY25', 46, 4.5, 9.3, 29.6, 20.6993006993007, 20.6, 3.63986013986014, 0.302, 0.98445244076312)
ON CONFLICT (ticker,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, mgmt_fee_m=EXCLUDED.mgmt_fee_m, net_finance_m=EXCLUDED.net_finance_m, ffo_m=EXCLUDED.ffo_m, ffo_per_unit=EXCLUDED.ffo_per_unit, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, ocf_cover=EXCLUDED.ocf_cover;

INSERT INTO reit_model_forecasts (ticker, model_version, fy, noi_m, ffo_m, epu, dpu, nta, gearing, affo_cover, ocf_cover, lfl_growth) VALUES
  ('DXC', 1, 'FY26E', 47.334, 29.9625875, 21.1110329642677, 21.1110329642677, 3.64615626572723, 0.316345708145464, 0.946600072507089, 0.979975027190158, 0.0289999999999999),
  ('DXC', 1, 'FY27E', 49.506686, 30.9438501875, 22.0802192979103, 22.0802192979103, 3.80213433358817, 0.326481364262081, 0.948293441497906, 0.980610040561715, 0.0289999999999999),
  ('DXC', 1, 'FY28E', 51.942379894, 32.1506377789375, 23.1180754445365, 23.1180754445365, 4.0144815623074, 0.326696291339334, 0.950234268725823, 0.981337850772184, 0.0289999999999999),
  ('DXC', 1, 'FY29E', 54.248708910926, 33.4844924505267, 24.0771902571841, 24.0771902571841, 4.22614538996665, 0.320607854891657, 0.952216686504536, 0.982081257439201, 0.0289999999999999),
  ('DXC', 1, 'FY30E', 56.2219214693428, 34.9669563315919, 25.1431632584636, 25.1431632584636, 4.43633555286017, 0.311198304145649, 0.954242514423412, 0.982840942908779, 0.0289999999999999)
ON CONFLICT (ticker,model_version,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, ffo_m=EXCLUDED.ffo_m, epu=EXCLUDED.epu, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, affo_cover=EXCLUDED.affo_cover, ocf_cover=EXCLUDED.ocf_cover, lfl_growth=EXCLUDED.lfl_growth;

INSERT INTO reit_model_outputs (ticker, model_version, equity_dcf_value, buy_threshold, breakeven_irr, terminal_pe, nav_nta, business_dcf_value, internalisation_synergy, takeover_value, takeover_upside, blended_value, eq_score, ddm_value, ffo_multiple_value, price_at_build) VALUES
  ('DXC', 1, 2.929116019805, 2.929116019805, 0.131560524376572, 14.75, 3.64615626572723, 4.39646885934658, 0.372382867132867, 4.76885172647944, 0.703161330885516, 3.47523258466434, 72, 3.05235913272772, 2.74443428535481, 2.8)
ON CONFLICT (ticker,model_version) DO UPDATE SET equity_dcf_value=EXCLUDED.equity_dcf_value, buy_threshold=EXCLUDED.buy_threshold, breakeven_irr=EXCLUDED.breakeven_irr, terminal_pe=EXCLUDED.terminal_pe, nav_nta=EXCLUDED.nav_nta, business_dcf_value=EXCLUDED.business_dcf_value, internalisation_synergy=EXCLUDED.internalisation_synergy, takeover_value=EXCLUDED.takeover_value, takeover_upside=EXCLUDED.takeover_upside, blended_value=EXCLUDED.blended_value, eq_score=EXCLUDED.eq_score, ddm_value=EXCLUDED.ddm_value, ffo_multiple_value=EXCLUDED.ffo_multiple_value, price_at_build=EXCLUDED.price_at_build;

INSERT INTO reit_assets (ticker, asset_name, sector, state, major_tenant, passing_income_m, cap_rate, wale_years, occupancy, as_of) VALUES
  ('DXC', 'Highway service centres (portfolio)', 'Convenience Retail', 'Eastern seaboard', 'Viva/Shell/BP/7-Eleven', 22, 0.0625, 352, 8.4, '2026-06-06'),
  ('DXC', 'Metro convenience (portfolio)', 'Convenience Retail', 'NSW/QLD/VIC', 'Coles Express/Ampol/EG', 18, 0.0645, 279.06976744186, 7.6, '2026-06-06'),
  ('DXC', 'Large-format / other convenience', 'Convenience Retail', 'Various', 'National brands', 6, 0.066, 90.9090909090909, 7, '2026-06-06'),
  ('DXC', '(no second sector)', NULL, NULL, NULL, 0, 0, 0, NULL, '2026-06-06'),
  ('DXC', 'Divestment-flagged (Divest?=1)', NULL, NULL, NULL, 0, NULL, 0, NULL, '2026-06-06')
ON CONFLICT (ticker,asset_name,as_of) DO UPDATE SET sector=EXCLUDED.sector, state=EXCLUDED.state, major_tenant=EXCLUDED.major_tenant, passing_income_m=EXCLUDED.passing_income_m, cap_rate=EXCLUDED.cap_rate, wale_years=EXCLUDED.wale_years, occupancy=EXCLUDED.occupancy;

INSERT INTO reit_prices (ticker, last_price, price_date) VALUES
  ('DXC', 2.8, '2026-06-06')
ON CONFLICT (ticker) DO UPDATE SET last_price=EXCLUDED.last_price, price_date=EXCLUDED.price_date;
