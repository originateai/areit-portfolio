// netlify/functions/read-evidence-doc.js
// Task D (phase 2) — AI doc-reader. Takes text extracted from an ASX result PDF or
// agent IM (the browser extracts it with pdf.js, same as the existing uploader) and
// asks Claude to pull out CRE evidence rows as STRUCTURED data via forced tool use.
// It returns PROPOSED rows only — the user reviews and approves them on evidence.html
// before anything is inserted (same parse-and-approve pattern as the rest of the app).
//
// POST JSON: { text: "<document text>", source?: "<filename or note>" }
// Returns:   { transactions:[...], leasing_deals:[...], developments:[...] }
//
// Env: ANTHROPIC_API_KEY (required). ANTHROPIC_MODEL optional (defaults to
//      claude-opus-4-8; set to claude-haiku-4-5 for cheaper high-volume parsing).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = () => process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Tool schema mirrors the cre_* columns the ingest function accepts. Numbers stay
// numeric; dates ISO (YYYY-MM-DD). Everything optional — the model emits only what
// the document actually supports, and ingest-evidence re-validates on insert.
const TOOL = {
  name: 'record_market_evidence',
  description: 'Record commercial real-estate evidence extracted from the document: property transactions (sales), leasing deals, and development projects. Only include rows the document actually evidences; never invent figures. Leave a field out if the document does not state it.',
  input_schema: {
    type: 'object',
    properties: {
      transactions: {
        type: 'array',
        description: 'Asset sales / transactions.',
        items: {
          type: 'object',
          properties: {
            asset_name: { type: 'string' }, address: { type: 'string' },
            sector: { type: 'string', description: 'office | industrial | retail | diversified | other' },
            sub_sector: { type: 'string' }, state: { type: 'string', description: 'AU state, e.g. NSW' },
            metro: { type: 'string' },
            sale_price_m: { type: 'number', description: 'Sale price in A$ millions' },
            cap_rate: { type: 'number', description: 'As a decimal, e.g. 0.0575 for 5.75%' },
            passing_income_m: { type: 'number' }, wale_years: { type: 'number' },
            area_sqm: { type: 'number' }, rate_psm: { type: 'number', description: 'A$ per sqm' },
            sale_date: { type: 'string', description: 'YYYY-MM-DD' },
            vendor: { type: 'string' }, purchaser: { type: 'string' },
            reit_linked: { type: 'string', description: 'ASX ticker if a listed REIT is involved' },
          },
        },
      },
      leasing_deals: {
        type: 'array',
        description: 'Leasing transactions.',
        items: {
          type: 'object',
          properties: {
            property: { type: 'string' }, tenant: { type: 'string' },
            sector: { type: 'string' }, sub_sector: { type: 'string' },
            state: { type: 'string' }, metro: { type: 'string' },
            area_sqm: { type: 'number' }, face_rent_psm: { type: 'number' },
            effective_rent_psm: { type: 'number' },
            incentive_pct: { type: 'number', description: 'Decimal, e.g. 0.30 for 30%' },
            term_years: { type: 'number' },
            review_type: { type: 'string', description: 'fixed | CPI | market' },
            review_pct: { type: 'number', description: 'Decimal, e.g. 0.035 for 3.5%' },
            deal_date: { type: 'string', description: 'YYYY-MM-DD' },
            reit_linked: { type: 'string' },
          },
        },
      },
      developments: {
        type: 'array',
        description: 'Development / pipeline projects.',
        items: {
          type: 'object',
          properties: {
            project: { type: 'string' }, location: { type: 'string' },
            state: { type: 'string' }, sector: { type: 'string' },
            gla_sqm: { type: 'number' }, cost_m: { type: 'number' },
            end_value_m: { type: 'number' },
            yield_on_cost: { type: 'number', description: 'Decimal' },
            prelease_pct: { type: 'number', description: 'Decimal' },
            pc_date: { type: 'string', description: 'YYYY-MM-DD practical completion' },
            status: { type: 'string' }, reit_linked: { type: 'string' },
          },
        },
      },
    },
    required: ['transactions', 'leasing_deals', 'developments'],
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify env' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const text = (body.text || '').trim();
    if (text.length < 30) return { statusCode: 400, body: JSON.stringify({ error: 'no document text supplied' }) };
    // Guard the prompt size — these docs are large; keep well within context + cost.
    const doc = text.slice(0, 120000);
    const source = body.source ? `Source: ${body.source}\n\n` : '';

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 16000,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{
          role: 'user',
          content: `Extract every commercial real-estate transaction, leasing deal, and development project evidenced in the document below, and record them with the tool. Convert percentages to decimals (5.75% → 0.0575) and dates to YYYY-MM-DD. Omit any field the document does not state — do not guess. If a category has no evidence, return an empty array for it.\n\n${source}--- DOCUMENT ---\n${doc}`,
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === TOOL.name);
    if (!toolBlock) {
      // refusal or unexpected stop — surface it rather than silently returning nothing
      throw new Error(`no structured output (stop_reason: ${data.stop_reason || 'unknown'})`);
    }
    const out = toolBlock.input || {};
    return { statusCode: 200, body: JSON.stringify({
      transactions:  Array.isArray(out.transactions)  ? out.transactions  : [],
      leasing_deals: Array.isArray(out.leasing_deals) ? out.leasing_deals : [],
      developments:  Array.isArray(out.developments)  ? out.developments  : [],
      model: MODEL(),
    })};
  } catch (err) {
    console.error('read-evidence-doc failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
