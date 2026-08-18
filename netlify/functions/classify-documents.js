// netlify/functions/classify-documents.js
// Bulk document router. Take a pile of results packs, analyst notes, annual
// reports and contract notes, and work out — per document — which ticker it
// belongs to, what kind of document it is, what period it covers, and (for a
// broker note) the rating and price target.
//
// PROPOSES ONLY. Nothing is written. The browser shows the proposals, you
// correct what's wrong, and the confirm step does the writing. That is the same
// parse-and-approve discipline the rest of this app uses for anything that
// touches real-money records, and it matters more here, not less: a
// misclassified results pack silently dates a fundamental to the wrong REIT.
//
// POST JSON: { docs: [ { filename, text }, ... ] }   (text extracted client-side)
// Returns:   { proposals: [ { filename, ticker, doc_type, doc_date, period_label,
//                             title, author, rating, price_target, confidence,
//                             reasoning, needs_review } ], warnings: [] }
//
// Env: ANTHROPIC_API_KEY required. ANTHROPIC_MODEL optional.

const API_URL = 'https://api.anthropic.com/v1/messages';

// Default to a current Claude model. read-evidence-doc.js still defaults to
// claude-opus-4-8, which is a generation behind — worth aligning.
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const DOC_TYPES = ['results_presentation','annual_report','analyst_report','research_note',
                   'contract_note','distribution_statement','tax_statement','other'];

const TOOL = {
  name: 'classify_documents',
  description:
    'Classify each supplied investment document. Return one entry per document, in the same order as supplied. ' +
    'Only state a field the document actually evidences — omit it otherwise. Never guess a ticker from a fund ' +
    'manager name alone (Dexus manages DXS, DXI and DXC; Charter Hall manages CQR, CLW and CQE), and never ' +
    'invent a price target or rating.',
  input_schema: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename:     { type: 'string', description: 'Echo the filename supplied, so entries can be matched back.' },
            ticker:       { type: 'string', description: 'ASX ticker the document is ABOUT, uppercase, e.g. DXI. Omit if genuinely unclear.' },
            doc_type:     { type: 'string', enum: DOC_TYPES },
            doc_date:     { type: 'string', description: 'Publication / ASX release date, YYYY-MM-DD. For a results pack this is the announcement date, NOT the balance date.' },
            period_label: { type: 'string', description: 'Reporting period the document covers, e.g. 1H26, FY25.' },
            title:        { type: 'string', description: 'Short human title, e.g. "1H26 Results Presentation".' },
            author:       { type: 'string', description: 'Broker or issuing house, for analyst reports.' },
            rating:       { type: 'string', description: 'Published recommendation as written, e.g. BUY, OUTPERFORM, HOLD.' },
            price_target: { type: 'number', description: 'Published price target in DOLLARS per security.' },
            confidence:   { type: 'number', description: '0 to 1. Below 0.7 means a human should check it.' },
            reasoning:    { type: 'string', description: 'One short sentence on what in the document drove the classification.' },
          },
          required: ['filename','confidence'],
        },
      },
    },
    required: ['documents'],
  },
};

const SYSTEM = `You classify Australian listed property and credit investment documents.

Rules that matter:
- The ticker is the entity the document is ABOUT, not the manager who wrote it.
- doc_date is the PUBLICATION or ASX RELEASE date. For a results pack this is
  never the balance date; a pack covering the half to 31 Dec is typically
  released in February. If you can only find the balance date, omit doc_date
  rather than substituting it — dating a fundamental to a period end is
  look-ahead bias and corrupts every backtest built on it.
- Price target and rating come only from an analyst note that states them.
- Set confidence honestly. A scanned page with no extractable text, or a
  document naming several REITs without a clear subject, is low confidence.
- Omit any field the document does not support. Omitted is always better than
  guessed.`;

exports.handler = async (event) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'ANTHROPIC_API_KEY is not set in the Netlify environment. Bulk classification is unavailable until it is.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'body must be JSON' }); }

  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (!docs.length) return json(400, { error: 'docs[] is required' });
  if (docs.length > 25) return json(400, { error: `${docs.length} documents in one request; send 25 or fewer per batch.` });

  const warnings = [];

  // Truncate per document. The head and tail of an investment document carry the
  // identity (cover page, ticker, date) and the summary; the middle is tables.
  const CAP = 14000;
  const prepared = docs.map((d, i) => {
    const text = String(d.text || '');
    if (!text.trim()) warnings.push(`${d.filename || 'doc ' + (i+1)}: no extractable text — likely a scanned image PDF. It cannot be classified and will need manual entry.`);
    const clipped = text.length > CAP
      ? text.slice(0, CAP * 0.7) + '\n\n[...middle omitted...]\n\n' + text.slice(-CAP * 0.3)
      : text;
    return { filename: d.filename || `document_${i+1}`, text: clipped };
  });

  const usable = prepared.filter(d => d.text.trim());
  if (!usable.length) return json(200, { proposals: [], warnings });

  const userContent = usable.map(d =>
    `<document filename="${d.filename}">\n${d.text}\n</document>`).join('\n\n');

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 8000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content:
          `Classify these ${usable.length} document(s). Return one entry per document, same order.\n\n${userContent}` }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json(res.status, { error: `Anthropic API ${res.status}`, detail: detail.slice(0, 500) });
    }

    const out = await res.json();
    const block = (out.content || []).find(c => c.type === 'tool_use');
    if (!block) return json(502, { error: 'Model did not return a classification.' });

    const proposals = (block.input?.documents || []).map(d => ({
      ...d,
      ticker: d.ticker ? String(d.ticker).toUpperCase().trim() : null,
      // Anything the model is unsure about, or that carries a real-money
      // consequence, is flagged for a human look rather than quietly accepted.
      needs_review: (d.confidence ?? 0) < 0.7 || !d.ticker || !d.doc_type,
    }));

    // Echo back anything the model dropped, so a document never silently vanishes.
    const returned = new Set(proposals.map(p => p.filename));
    prepared.forEach(d => {
      if (!returned.has(d.filename)) {
        proposals.push({ filename: d.filename, confidence: 0, needs_review: true,
                         reasoning: d.text.trim() ? 'Model returned no entry for this document.' : 'No extractable text.' });
      }
    });

    return json(200, { proposals, model: MODEL(), warnings });
  } catch (err) {
    console.error('classify-documents failed:', err.message);
    return json(500, { error: err.message, warnings });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
