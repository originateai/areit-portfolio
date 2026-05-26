// netlify/functions/parse-research.js
// Accepts a base64-encoded file (Excel or PDF) from the admin upload page
// Sends it to Claude, extracts REIT fundamental data, returns structured JSON for preview

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { fileData, fileType, fileName } = body;
  // fileData: base64 string
  // fileType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | etc
  // fileName: original filename for context

  if (!fileData || !fileType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'fileData and fileType required' }) };
  }

  // Map MIME types to what Claude accepts
  const SUPPORTED = {
    'application/pdf': 'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': null, // Excel not directly supported
    'application/vnd.ms-excel': null,
  };

  const isPDF   = fileType === 'application/pdf' || fileType === 'pdf';
  const isExcel = fileType === 'excel' || fileType.includes('spreadsheetml') || fileType.includes('ms-excel');

  if (!isPDF && !isExcel) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Only PDF and Excel files supported. Got: ' + fileType }) };
  }

  // For Excel, we need to extract text first using a simple approach
  // Claude can read PDFs natively; for Excel we convert to CSV-like text via a JS parse
  let messageContent;

  if (isPDF) {
    messageContent = [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: fileData
        }
      },
      {
        type: 'text',
        text: buildPrompt(fileName)
      }
    ];
  } else {
    // Excel: the frontend will have already extracted text via SheetJS and sent it as text
    // fileData for Excel is plain text (TSV/CSV representation), not base64
    messageContent = [
      {
        type: 'text',
        text: `File: ${fileName}\n\nExtracted spreadsheet content:\n\n${fileData}\n\n${buildPrompt(fileName)}`
      }
    ];
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Claude API error: ' + err }) };
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\[[\s\S]*\])/);
    if (!jsonMatch) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          error: null,
          raw: text,
          reits: [],
          message: 'Claude could not find structured REIT data in this file. See raw output below.'
        })
      };
    }

    let reits;
    try {
      reits = JSON.parse(jsonMatch[1]);
    } catch(e) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: null, raw: text, reits: [], message: 'Could not parse Claude output as JSON.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: null, reits, raw: text, message: `Found ${reits.length} REITs` })
    };

  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

function buildPrompt(fileName) {
  return `You are extracting REIT fundamental data from a broker research document or company report.

File: ${fileName}

Extract data for every ASX-listed REIT you can find in this document. Return ONLY a JSON array with no preamble, no explanation, no markdown prose — just the JSON block.

For each REIT return:
{
  "ticker": "ASX ticker code (e.g. GOZ, HDN, CQR)",
  "name": "Company name",
  "nta": null or number (Net Tangible Assets per unit/share in AUD),
  "dps_fy26": null or number (Distributions per share/unit for FY26 in AUD),
  "dps_fy27": null or number (Distributions per share/unit for FY27 in AUD),
  "gearing": null or number (Gearing ratio as decimal e.g. 0.35 for 35%),
  "implied_cap": null or number (Implied capitalisation rate as decimal e.g. 0.065 for 6.5%),
  "cap_rate": null or number (Portfolio cap rate as decimal e.g. 0.065 for 6.5%),
  "yield_trigger": null or number (Yield at which to buy — leave null if not stated),
  "wale": null or number (Weighted average lease expiry in years),
  "occupancy": null or number (Occupancy rate as decimal e.g. 0.97 for 97%),
  "source": "brief description of where this data came from in the document e.g. 'Moelis estimates table p.4' or 'Company HY26 results'"
}

Rules:
- Only include fields you actually found in the document. Set everything else to null.
- Do not invent or estimate numbers. If uncertain, set to null.
- Gearing, implied_cap, cap_rate, yield_trigger, occupancy must be decimals not percentages.
- NTA and DPS must be in dollars (e.g. 1.52, not 152).
- If you see multiple NTA estimates (e.g. book vs adjusted), use the adjusted/reported NTA.
- If FY year labels are ambiguous, use context to determine which is FY26 vs FY27.
- Return [] if no REIT data found.

Return the JSON array now:`;
}
