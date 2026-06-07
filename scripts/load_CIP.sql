-- ===== CIP v1 (from CIP_Centuria_Industrial_Model.xlsx) =====

UPDATE reit_models SET is_current=false WHERE ticker='CIP';

INSERT INTO reit_models (ticker, name, model_version, mgmt_model, manager_parent, manager_stake_pct, fy_end, securities_m, is_current, built_at) VALUES
  ('CIP', 'Centuria Industrial REIT', 1, 'external', 'Centuria (CNI)', 16.1, '30 June', 628.003448275862, TRUE, '2026-06-06T11:23:36.540Z')
ON CONFLICT (ticker,model_version) DO UPDATE SET name=EXCLUDED.name, mgmt_model=EXCLUDED.mgmt_model, manager_parent=EXCLUDED.manager_parent, manager_stake_pct=EXCLUDED.manager_stake_pct, fy_end=EXCLUDED.fy_end, securities_m=EXCLUDED.securities_m, is_current=EXCLUDED.is_current, built_at=EXCLUDED.built_at;

INSERT INTO reit_model_assumptions (ticker, model_version, base_noi_m, cap_rate, escalation, reversion, expiry_profile, payout_ratio, gearing_current, debt_ladder, req_return, erp, beta, base_pe, industrial_premium, terminal_adjustments, exit_cap, dcf_unlevered_rate, synergy_multiple, control_premium) VALUES
  ('CIP', 1, 195.6, 0.0515, 0.035, 0.13, '{"FY26E":0.043,"FY27E":0.117,"FY28E":0.089,"FY29E":0.149,"FY30E":0.12}'::jsonb, 0.93, 0.347, '{"FY26":300,"FY27":350,"FY28":363,"FY29":346,"FY30":0,"Beyond":0}'::jsonb, 0.12, 0.055, 0.95, 14, 2.5, '{"gearing":0,"affo":-0.25,"underrent":0.5,"mgmt":-1,"quality":0.25}'::jsonb, 0.056, 0.0725, 12, 0)
ON CONFLICT (ticker,model_version) DO UPDATE SET base_noi_m=EXCLUDED.base_noi_m, cap_rate=EXCLUDED.cap_rate, escalation=EXCLUDED.escalation, reversion=EXCLUDED.reversion, expiry_profile=EXCLUDED.expiry_profile, payout_ratio=EXCLUDED.payout_ratio, gearing_current=EXCLUDED.gearing_current, debt_ladder=EXCLUDED.debt_ladder, req_return=EXCLUDED.req_return, erp=EXCLUDED.erp, beta=EXCLUDED.beta, base_pe=EXCLUDED.base_pe, industrial_premium=EXCLUDED.industrial_premium, terminal_adjustments=EXCLUDED.terminal_adjustments, exit_cap=EXCLUDED.exit_cap, dcf_unlevered_rate=EXCLUDED.dcf_unlevered_rate, synergy_multiple=EXCLUDED.synergy_multiple, control_premium=EXCLUDED.control_premium;

INSERT INTO reit_model_actuals (ticker, fy, noi_m, mgmt_fee_m, net_finance_m, ffo_m, ffo_per_unit, dpu, nta, gearing, ocf_cover) VALUES
  ('CIP', 'FY24', 186.1, 23.092, 49.95, 109.258, 17.2086942825642, 16, 3.87084580248858, 0.344, 0.947570483540715),
  ('CIP', 'FY25', 195.6, 23.023, 57.6, 110.877, 17.4636950700898, 16.3, 3.91762482280674, 0.347, 0.92644897462235)
ON CONFLICT (ticker,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, mgmt_fee_m=EXCLUDED.mgmt_fee_m, net_finance_m=EXCLUDED.net_finance_m, ffo_m=EXCLUDED.ffo_m, ffo_per_unit=EXCLUDED.ffo_per_unit, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, ocf_cover=EXCLUDED.ocf_cover;

INSERT INTO reit_model_forecasts (ticker, model_version, fy, noi_m, ffo_m, epu, dpu, nta, gearing, affo_cover, ocf_cover, lfl_growth) VALUES
  ('CIP', 1, 'FY26E', 201.57767314, 115.255304644349, 18.3526547442971, 17.0679689121963, 3.96956012535147, 0.373925503842525, 0.877484437603958, 0.92599758731725, 0.0407856499999999),
  ('CIP', 1, 'FY27E', 213.806197982655, 119.565004084197, 19.2503101717274, 17.9027884597065, 4.18980065414822, 0.383355326306466, 0.882814905924642, 0.931378042415771, 0.0507423499999999),
  ('CIP', 1, 'FY28E', 226.849733442581, 123.71797700598, 20.030154661784, 18.6280438354591, 4.43877375175306, 0.387171168312073, 0.878845663052316, 0.927516887089976, 0.0469749500000001),
  ('CIP', 1, 'FY29E', 242.337346226641, 131.430473710254, 21.2788212303268, 19.7893037442039, 4.77574059963561, 0.382116804980744, 0.89691702744563, 0.944368421051148, 0.0550479499999998),
  ('CIP', 1, 'FY30E', 257.731932136749, 139.797810687901, 22.6335075728091, 21.0491620427124, 5.12659759044504, 0.375733375462871, 0.906053620899786, 0.952203219891927, 0.0511459999999999)
ON CONFLICT (ticker,model_version,fy) DO UPDATE SET noi_m=EXCLUDED.noi_m, ffo_m=EXCLUDED.ffo_m, epu=EXCLUDED.epu, dpu=EXCLUDED.dpu, nta=EXCLUDED.nta, gearing=EXCLUDED.gearing, affo_cover=EXCLUDED.affo_cover, ocf_cover=EXCLUDED.ocf_cover, lfl_growth=EXCLUDED.lfl_growth;

INSERT INTO reit_model_outputs (ticker, model_version, equity_dcf_value, buy_threshold, breakeven_irr, terminal_pe, nav_nta, business_dcf_value, internalisation_synergy, takeover_value, takeover_upside, blended_value, eq_score, ddm_value, ffo_multiple_value, price_at_build) VALUES
  ('CIP', 1, 2.77841292927295, 2.77841292927295, 0.109280725622075, 16, 3.96956012535147, 4.22914487327209, 0.436478774527966, 4.66562364780005, 0.608835740620708, 3.36339615463849, 64, 2.5368810732567, 2.38584511675863, 2.9)
ON CONFLICT (ticker,model_version) DO UPDATE SET equity_dcf_value=EXCLUDED.equity_dcf_value, buy_threshold=EXCLUDED.buy_threshold, breakeven_irr=EXCLUDED.breakeven_irr, terminal_pe=EXCLUDED.terminal_pe, nav_nta=EXCLUDED.nav_nta, business_dcf_value=EXCLUDED.business_dcf_value, internalisation_synergy=EXCLUDED.internalisation_synergy, takeover_value=EXCLUDED.takeover_value, takeover_upside=EXCLUDED.takeover_upside, blended_value=EXCLUDED.blended_value, eq_score=EXCLUDED.eq_score, ddm_value=EXCLUDED.ddm_value, ffo_multiple_value=EXCLUDED.ffo_multiple_value, price_at_build=EXCLUDED.price_at_build;

INSERT INTO reit_assets (ticker, asset_name, sector, state, major_tenant, passing_income_m, cap_rate, wale_years, occupancy, as_of) VALUES
  ('CIP', 'Telstra Data Centre, Clayton VIC', 'Industrial', 'VIC', 'Data centre - Telstra (9% of income)', 17.3, 0.049, 353.061224489796, 12, '2026-06-06'),
  ('CIP', 'VIC industrial - balance (Campbellfield, Dandenong Sth, Derrimut)', 'Industrial', 'VIC', 'Woolworths/Arnott''s/Visy DCs', 51.9, 0.051, 1017.64705882353, 8.8, '2026-06-06'),
  ('CIP', 'NSW/ACT industrial (Fairfield, Gregory Hills, Enfield, Bella Vista)', 'Industrial', 'NSW/ACT', 'Urban infill logistics', 61.5, 0.05, 1230, 4.1, '2026-06-06'),
  ('CIP', 'QLD industrial (Bundamba, Richlands, Archerfield, Ormeau)', 'Industrial', 'QLD', 'Distribution / logistics', 38.5, 0.051, 754.901960784314, 9.2, '2026-06-06'),
  ('CIP', 'WA industrial (Canning Vale, Bibra Lake, Spearwood)', 'Industrial', 'WA', 'Logistics / manufacturing', 17.3, 0.053, 326.415094339623, 5.1, '2026-06-06'),
  ('CIP', 'SA industrial (Edinburgh, Marleston, Direk dev)', 'Industrial', 'SA', 'Logistics + development', 5.8, 0.054, 107.407407407407, 5.3, '2026-06-06'),
  ('CIP', 'Equity-accounted JVs (Erskine Park, Glendenning, Sub-Trust 33) + interest income', 'Industrial', 'Various', '51%-owned co-investments', 3.3, 0.0464, 71.1206896551724, 9, '2026-06-06')
ON CONFLICT (ticker,asset_name,as_of) DO UPDATE SET sector=EXCLUDED.sector, state=EXCLUDED.state, major_tenant=EXCLUDED.major_tenant, passing_income_m=EXCLUDED.passing_income_m, cap_rate=EXCLUDED.cap_rate, wale_years=EXCLUDED.wale_years, occupancy=EXCLUDED.occupancy;

INSERT INTO reit_prices (ticker, last_price, price_date) VALUES
  ('CIP', 2.9, '2026-06-06')
ON CONFLICT (ticker) DO UPDATE SET last_price=EXCLUDED.last_price, price_date=EXCLUDED.price_date;
