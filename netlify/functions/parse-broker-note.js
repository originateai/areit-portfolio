// netlify/functions/parse-broker-note.js
// Reads a broker research note (text extracted client-side with pdf.js, same as the
// evidence reader) and asks Claude to pull out the broker's forecasts for each REIT it
// covers, as STRUCTURED data via forced tool use. Returns PROPOSED rows only — the user
// reviews them on value-layer.html and approves before anything is written (parse-and-
// approve pattern, same as read-evidence-doc.js).
//
// POST JSON: { text: "<document text>", source?: "<filename>" }
// Returns:   { broker_name, note_date, forecasts:[{ticker,eps_fy26..30,valuation,target_return}], model }
//
// Env: ANTHROPIC_API_KEY (required). ANTHROPIC_MODEL optional (defaults to claude-opus-4-8).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = () => process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Mirrors the reit_broker_forecasts columns. Units match the value-layer table:
// EPS/FFO per security in CENTS, valuation in A$ per security, target_return as a DECIMAL
// (12% -> 0.12). Everything except ticker is optional — emit only what the note states.
const TOOL = {
  name: 'record_broker_forecasts',
  description: 'Record the broker research house\'s forecasts for each ASX-listed A-REIT the note covers. Only include figures the note actually states; never invent numbers. Leave a field out if the note does not give it.',
  input_schema: {
    type: 'object',
    properties: {
      broker_name: { type: 'string', description: 'The research house / broker that wrote the note, e.g. "Macquarie", "UBS", "Morgan Stanley", "Morgans", "JPMorgan", "Citi". Not the analyst\'s personal name.' },
      note_date:   { type: 'string', description: 'Publication date of the note, YYYY-MM-DD. Omit if not stated.' },
      forecasts: {
        type: 'array',
        description: 'One entry per REIT covered by the note.',
        items: {
          type: 'object',
          properties: {
            ticker:        { type: 'string', description: 'ASX code in UPPERCASE, no exchange suffix (e.g. "DXS", "GMG", "SCG"). Strip any ".AX"/".AU".' },
            eps_fy26:      { type: 'number', description: 'FY2026 forecast FFO/AFFO or EPS per security, in CENTS (e.g. 21.5).' },
            eps_fy27:      { type: 'number', description: 'FY2027 forecast per security, in CENTS.' },
            eps_fy28:      { type: 'number', description: 'FY2028 forecast per security, in CENTS.' },
            eps_fy29:      { type: 'number', description: 'FY2029 forecast per security, in CENTS.' },
            eps_fy30:      { type: 'number', description: 'FY2030 forecast per security, in CENTS.' },
            valuation:     { type: 'number', description: 'Price target / valuation in A$ per security (e.g. 3.45).' },
            target_return: { type: 'number', description: 'Expected total/12-month return as a DECIMAL: 12% -> 0.12, -5% -> -0.05.' },
          },
          required: ['ticker'],
        },
      },
    },
    required: ['broker_name', 'forecasts'],
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
    const doc = text.slice(0, 120000); // guard context/cost — broker notes are small anyway
    const source = body.source ? `Source file: ${body.source}\n\n` : '';

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 8000,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{
          role: 'user',
          content: `This is a sell-side broker research note on one or more ASX-listed A-REITs. Identify the research house, the note's date, and for every REIT covered extract the forecast FFO/AFFO (or EPS) per security for FY2026–FY2030 in cents, the price target / valuation in A$ per security, and the expected total return. Convert any percentage return to a decimal (12% -> 0.12). Omit any field the note does not state — do not guess or interpolate. Record everything with the tool.\n\n${source}--- NOTE ---\n${doc}`,
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === TOOL.name);
    if (!toolBlock) throw new Error(`no structured output (stop_reason: ${data.stop_reason || 'unknown'})`);
    const out = toolBlock.input || {};
    return { statusCode: 200, body: JSON.stringify({
      broker_name: out.broker_name || '',
      note_date:   out.note_date || '',
      forecasts:   Array.isArray(out.forecasts) ? out.forecasts : [],
      model: MODEL(),
    })};
  } catch (err) {
    console.error('parse-broker-note failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
