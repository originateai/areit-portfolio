// netlify/functions/parse-research.js
// Accepts PDF or Excel, extracts REIT fundamentals via Claude API

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Decompress if client sent gzip-compressed data
  if (body.compressed && body.fileData) {
    try {
      const zlib = require('zlib');
      const compressed = Buffer.from(body.fileData, 'base64');
      const decompressed = zlib.gunzipSync(compressed);
      body.fileData = decompressed.toString('base64');
    } catch(e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Decompression failed: ' + e.message }) };
    }
  }

  const { fileData, fileType, fileName } = body;
  if (!fileData || !fileType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'fileData and fileType required' }) };
  }

  const isPDF   = fileType === 'application/pdf' || fileType === 'pdf' || fileName?.match(/\.pdf$/i);
  const isExcel = fileType === 'excel' || fileType.includes('spreadsheet') || fileType.includes('ms-excel') || fileName?.match(/\.(xlsx|xls|xlsm)$/i);

  if (!isPDF && !isExcel) {
    return { statusCode: 400, body: JSON.stringify({ error: `Unsupported file type: ${fileType}` }) };
  }

  let messageContent;

  if (isPDF) {
    // Send PDF directly to Claude
    messageContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fileData }
      },
      { type: 'text', text: buildPrompt(fileName) }
    ];
  } else {
    // Excel: decode base64, parse with xlsx library
    try {
      const XLSX = require('xlsx');
      const buf  = Buffer.from(fileData, 'base64');
      const wb   = XLSX.read(buf, { type: 'buffer' });
      let text   = '';
      for (const sheetName of wb.SheetNames) {
        const ws  = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
        if (csv.trim().length > 100) {
          text += `\n\n=== Sheet: ${sheetName} ===\n${csv.slice(0, 8000)}`;
        }
      }
      messageContent = [
        {
          type: 'text',
          text: `File: ${fileName}\n\nExtracted spreadsheet content:\n${text}\n\n${buildPrompt(fileName)}`
        }
      ];
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Excel parse failed: ' + e.message }) };
    }
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
    const text   = result.content?.[0]?.text || '';

    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/(\[[\s\S]*\])/);
    if (!jsonMatch) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: null, raw: text, reits: [], message: 'Claude could not find structured REIT data in this file. See raw output below.' })
      };
    }

    let reits;
    try {
      reits = JSON.parse(jsonMatch[1]);
    } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ error: null, raw: text, reits: [], message: 'Could not parse Claude output as JSON.' }) };
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

Extract data for every ASX-listed REIT you can find. Return ONLY a JSON array, no preamble, no explanation, no markdown prose.

For each REIT return:
{
  "ticker": "ASX ticker (e.g. GOZ, HDN, CQR)",
  "name": "Company name",
  "nta": null or number (Net Tangible Assets per unit in AUD),
  "dps_fy26": null or number (Distributions per unit FY26 in AUD),
  "dps_fy27": null or number (Distributions per unit FY27 in AUD),
  "gearing": null or number (Gearing as decimal e.g. 0.35 for 35%),
  "implied_cap": null or number (Cap rate as decimal e.g. 0.065 for 6.5%),
  "cap_rate": null or number (Portfolio cap rate as decimal),
  "yield_trigger": null or number (Buy yield trigger as decimal),
  "wale": null or number (Weighted average lease expiry in years),
  "occupancy": null or number (Occupancy as decimal e.g. 0.97 for 97%),
  "source": "where this data came from e.g. 'Moelis Summary table'"
}

Rules:
- Only include fields actually found. Set everything else to null.
- Never invent numbers. If uncertain, null.
- Gearing, cap rates, occupancy must be decimals not percentages.
- NTA and DPS must be in dollars.
- If you see DPS yield and price, calculate DPS = yield * price.
- Return [] if no REIT data found.

Return the JSON array now:`;
}
