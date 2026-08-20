// netlify/functions/parse-broker-note.js
// Reads a broker research note (text extracted client-side with pdf.js, same as the
// evidence reader) and asks Claude to pull out the broker's forecasts for each REIT it
// covers, as STRUCTURED data via forced tool use. Returns PROPOSED rows only — the user
// reviews them on value-layer.html and approves before anything is written (parse-and-
// approve pattern, same as read-evidence-doc.js).
//
// POST JSON: { text: "<document text>", source?: "<filename>" }
// Returns:   { broker_name, note_date, forecasts:[{ticker,eps_fy26..30,dpu_fy26..28,rating,
//                                                  price_at_note,valuation,target_return}], model }
//
// Env: ANTHROPIC_API_KEY (required). ANTHROPIC_MODEL optional (defaults to claude-opus-5).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5';

// Mirrors the reit_broker_forecasts columns. Units match the value-layer table:
// EPS/FFO per security in CENTS, valuation in A$ per security, target_return as a DECIMAL
// (12% -> 0.12). Everything except ticker is optional — emit only what the note states.
//
// DPU is extracted SEPARATELY from EPS and is not derived from it. A broker forecasting
// 19.0c of FFO and 17.3c of distribution is telling you the payout ratio it expects, and
// that is the single most useful thing in the note for an income portfolio. Inferring one
// from the other would erase exactly the number worth having.
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
            dpu_fy26:      { type: 'number', description: 'FY2026 forecast DISTRIBUTION per security, in CENTS. This is the distribution/dividend the broker forecasts, NOT its earnings/FFO forecast — if the note gives only one figure, decide which it is from the note\'s own labelling and leave the other out rather than repeating the number in both.' },
            dpu_fy27:      { type: 'number', description: 'FY2027 forecast distribution per security, in CENTS.' },
            dpu_fy28:      { type: 'number', description: 'FY2028 forecast distribution per security, in CENTS.' },
            rating:        { type: 'string', description: 'The broker\'s recommendation exactly as stated, e.g. "BUY", "HOLD", "NEUTRAL", "OVERWEIGHT", "ADD", "SELL", "UNDERWEIGHT". Omit if the note states none.' },
            price_at_note: { type: 'number', description: 'The security\'s market price at the time of the note, in A$ per security. Usually printed on the front page next to the target. Omit if not stated.' },
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
          content: `This is a sell-side broker research note on one or more ASX-listed A-REITs. Identify the research house, the note's date, and for every REIT covered extract:

- forecast FFO/AFFO (or EPS) per security for FY2026-FY2030, in cents
- forecast DISTRIBUTION per security (DPS/DPU) for FY2026-FY2028, in cents — this is a different figure from earnings and must come from the note's distribution line, never derived from the earnings line
- the recommendation/rating as stated
- the price target / valuation in A$ per security
- the market price at the date of the note, in A$
- the expected total return, as a decimal (12% -> 0.12)

Australian REIT notes usually print a forecast table with a row each for FFO/EPS and DPS across the forecast years. Read the row labels rather than the column position, and check whether the table is in cents or dollars before recording — a note quoting $0.173 and one quoting 17.3c mean the same thing and both must be recorded as 17.3.

Omit any field the note does not state — do not guess, interpolate, or carry a figure across from an adjacent year. Record everything with the tool.

${source}--- NOTE ---
${doc}`,
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
    /* A note that prints one figure and labels it ambiguously can come back with
     * the same number in both the earnings and the distribution slot. That is not
     * a forecast, it is a transcription artefact, and it would silently show a
     * 100% payout ratio on the stock page. Drop the DPU side and say so. */
    const forecasts = (Array.isArray(out.forecasts) ? out.forecasts : []).map(fc => {
      const dup = ['26','27','28'].filter(y =>
        fc[`dpu_fy${y}`] != null && fc[`eps_fy${y}`] != null &&
        Number(fc[`dpu_fy${y}`]) === Number(fc[`eps_fy${y}`]));
      dup.forEach(y => { delete fc[`dpu_fy${y}`]; });
      return dup.length ? { ...fc, _dropped: `DPU FY${dup.join(', FY')} matched EPS exactly — read as one figure labelled twice, not a 100% payout` } : fc;
    });
    return { statusCode: 200, body: JSON.stringify({
      broker_name: out.broker_name || '',
      note_date:   out.note_date || '',
      forecasts,
      model: MODEL(),
    })};
  } catch (err) {
    console.error('parse-broker-note failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
