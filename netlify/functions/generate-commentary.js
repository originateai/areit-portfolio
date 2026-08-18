// netlify/functions/generate-commentary.js
// Writes investment commentary on one ticker from EVERYTHING the platform holds
// on it: filed research, our own valuation run, the broker panel, the position,
// distribution history and the bond anchor.
//
// The point is synthesis the user cannot get from any single screen — where our
// model disagrees with the street and why, whether the income is covered, what
// the research says that the numbers do not.
//
// GROUNDING RULES (enforced in the prompt and in what is supplied):
//   * Only facts drawn from the supplied context. No outside recall about the
//     REIT, no invented figures, no remembered news.
//   * Where the context is thin, say so rather than padding.
//   * This is analysis for the owner's own decision-making, not advice.
//
// POST JSON: { ticker: "DXI", refresh?: true }
// Returns:   { ticker, commentary, sources, model, generated_at }
//
// Env: ANTHROPIC_API_KEY required. ANTHROPIC_MODEL optional.

const { getSupabase } = require('./_shared.js');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const SYSTEM = `You are writing investment commentary for the owner of a personal
A-REIT and listed-credit income portfolio. He is a professional investor: write
for a peer, not a retail audience. No throat-clearing, no disclaimers about
seeking advice, no restating the question.

His mandate is explicit: significant passive income, judged on a 12% IRR and a 7%
yield measured GROSS, with tax applied afterwards as an overlay. Distribution
sustainability matters more to him than share-price momentum.

ABSOLUTE RULES:
- Use ONLY the supplied context. You may not use anything you recall about this
  security from training. If a figure is not in the context, you do not know it.
- Never invent a number, a date, a broker view or an event.
- Where the evidence is thin, say plainly what is missing and what would change
  the picture. Thin evidence is a finding, not a gap to paper over.
- Distinguish clearly between OUR model's figures and the BROKERS' figures.
- Flag any figure the context marks as an estimate or assumption.

Structure the response in short markdown sections, in this order, omitting any
section the context cannot support:

## Position
## What the research says
## Our model vs the street
## Income durability
## What would change our mind

Be concise and specific. Prefer one sharp sentence with a number in it to three
general ones. If the honest answer is "there is not enough here to say", say it.`;

exports.handler = async (event) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'ANTHROPIC_API_KEY is not set in the Netlify environment.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'body must be JSON' }); }
  const ticker = String(body.ticker || '').toUpperCase().trim();
  if (!ticker) return json(400, { error: 'ticker is required' });

  const db = getSupabase();

  try {
    const [stock, docs, val, brokers, holding, dists, fundamentals, bond] = await Promise.all([
      db.from('stocks').select('ticker,name,asset_class,reit_subclass,landlord_sector,dps_fy26').eq('ticker', ticker).limit(1),
      db.from('document_uploads').select('doc_type,title,author,rating,price_target,doc_date,period_label,summary')
        .eq('ticker', ticker).order('doc_date', { ascending:false, nullsFirst:false }).limit(30),
      db.from('valuation_runs').select('*').eq('ticker', ticker).order('as_of', { ascending:false }).limit(1),
      db.from('reit_broker_forecasts').select('*').eq('ticker', ticker).order('note_date', { ascending:false }).limit(15),
      db.from('holdings').select('*').eq('ticker', ticker).limit(1),
      db.from('distributions').select('ex_date,amount_per_unit,franking_pct,total_received')
        .eq('ticker', ticker).order('ex_date', { ascending:false }).limit(12),
      db.from('reit_fundamentals').select('*').eq('ticker', ticker).order('release_date', { ascending:false }).limit(4),
      db.from('bond_data').select('aus_10yr,us_10yr,reit_spread,data_date').order('data_date', { ascending:false }).limit(1),
    ]);

    const s = stock.data?.[0], v = val.data?.[0], h = holding.data?.[0], b = bond.data?.[0];
    const documents = docs.data || [];

    if (!s && !documents.length && !v) {
      return json(404, { error: `Nothing held on ${ticker} — no stock record, no filed research, no valuation run. Upload some research first.` });
    }

    // Assemble the grounding context. Everything the model may use, and nothing
    // else. Units are stated inline because the platform mixes cents and dollars
    // deliberately and an unlabelled figure would be read wrong.
    const ctx = {
      security: s ? { ticker: s.ticker, name: s.name, asset_class: s.asset_class,
                      reit_subclass: s.reit_subclass, sector: s.landlord_sector,
                      dps_fy26_dollars: s.dps_fy26 } : null,

      our_valuation: v ? {
        as_of: v.as_of, engine: v.engine_version,
        price_dollars: v.price, fair_value_dollars: v.fair_value,
        discount_to_fair_value: v.discount_to_fair_value,
        irr_pre_tax: v.irr_pre_tax, irr_post_tax: v.irr_post_tax,
        yield_pre_tax: v.yield_pre_tax, yield_post_tax: v.yield_post_tax,
        meets_hurdle: v.meets_hurdle,
        methods_used: Object.keys(v.weights || {}),
        method_values_dollars: v.method_values,
        implied_cap_rate: v.implied_cap_rate,
        CAVEAT: Object.keys(v.weights || {}).length === 1
          ? 'Only ONE valuation method produced a value, so this "fair value" is that single method (book NTA), not a blend. Treat the discount as weak evidence.'
          : null,
      } : null,

      broker_panel: (brokers.data || []).map(x => ({
        broker: x.broker_name, note_date: x.note_date, rating: x.rating,
        price_target_dollars: x.valuation,
        eps_cents: { fy26: x.eps_fy26, fy27: x.eps_fy27, fy28: x.eps_fy28 },
        dpu_cents: { fy26: x.dpu_fy26, fy27: x.dpu_fy27, fy28: x.dpu_fy28 },
      })),

      filed_research: documents.map(d => ({
        type: d.doc_type, title: d.title, period: d.period_label, date: d.doc_date,
        author: d.author, rating: d.rating, price_target_dollars: d.price_target,
        note: d.summary,
      })),

      our_position: h ? { units: h.units, cost_base_dollars: h.cost_base,
                          brokerage_dollars: h.brokerage, entry_date: h.entry_date,
                          asset_class: h.asset_class, is_open: h.is_open } : null,

      distribution_history: (dists.data || []).map(d => ({
        ex_date: d.ex_date, per_unit_dollars: d.amount_per_unit,
        franking_pct: d.franking_pct, received_dollars: d.total_received,
      })),

      reported_fundamentals: (fundamentals.data || []).map(fx => ({
        period_end: fx.period_end, release_date: fx.release_date,
        nta_dollars: fx.nta, wacr: fx.wacr, gearing: fx.gearing, icr: fx.icr,
        occupancy: fx.occupancy, wale_years: fx.wale, is_estimate: fx.is_estimate,
      })),

      macro_anchor: b ? { aus_10yr: b.aus_10yr, us_10yr: b.us_10yr,
                          portfolio_reit_spread: b.reit_spread, as_at: b.data_date } : null,

      owner_hurdles: { irr_target: 0.12, yield_target: 0.07, measured: 'gross / pre-tax' },

      NOTES_ON_UNITS: 'Broker eps/dpu figures are CENTS per security. Everything labelled _dollars is dollars. Rates and ratios are decimal fractions (0.0625 = 6.25%).',
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-api-key': key, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: MODEL(), max_tokens: 2500, system: SYSTEM,
        messages: [{ role:'user', content:
          `Write commentary on ${ticker} using only this context.\n\n<context>\n${JSON.stringify(ctx, null, 1)}\n</context>` }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(()=> '');
      return json(res.status, { error: `Anthropic API ${res.status}`, detail: detail.slice(0,500) });
    }

    const out = await res.json();
    const commentary = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!commentary) return json(502, { error: 'Model returned no commentary.' });

    const generatedAt = new Date().toISOString();
    const sources = {
      documents: documents.length, brokers: (brokers.data||[]).length,
      has_valuation: !!v, has_position: !!h,
      distributions: (dists.data||[]).length,
      fundamentals: (fundamentals.data||[]).length,
    };

    // Best-effort persist; commentary is still returned if the table is absent.
    const { error: wErr } = await db.from('stock_commentary').insert({
      ticker, commentary, sources, model: MODEL(), generated_at: generatedAt,
    });

    return json(200, { ticker, commentary, sources, model: MODEL(),
                       generated_at: generatedAt,
                       persisted: !wErr, persist_error: wErr ? wErr.message : null });
  } catch (err) {
    console.error('generate-commentary failed:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
    body: JSON.stringify(body),
  };
}
