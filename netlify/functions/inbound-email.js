// netlify/functions/inbound-email.js
// Webhook for an inbound-email service. Forward a results pack or broker note to
// the address, and the attachments are classified, filed against the right
// ticker and stored — the same pipeline as the drag-and-drop, without you being
// at the keyboard.
//
// ── SETUP (you have to provision the address; I cannot create one) ────────────
// Pick any inbound provider that POSTs a webhook. Free tiers are ample here:
//
//   CloudMailin  — simplest. Gives you an address, POSTs JSON with attachments.
//   Mailgun      — Routes → "store and notify" → forward to this URL.
//   SendGrid     — Inbound Parse, needs an MX record on a subdomain you own.
//   Postmark     — Inbound stream.
//
// Point the webhook at:
//   https://areit.netlify.app/.netlify/functions/inbound-email?key=YOUR_SECRET
//
// Then set INBOUND_EMAIL_KEY in Netlify to the same secret. Without it this
// endpoint refuses everything — it is a public URL that writes to your database,
// so an unauthenticated version would let anyone file documents into your
// research library.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
// 1. Verifies the shared key.
// 2. Pulls attachments (and the body, if there are none).
// 3. Sends the text to classify-documents for ticker / type / date / period.
// 4. Stores each attachment and writes a document_uploads row.
//
// Anything it cannot classify confidently is still stored, flagged
// `needs_review`, with the ticker left NULL — so nothing is silently dropped and
// nothing is silently misfiled. Review them in the Research Library.
//
// NOTE ON PDFs: this runs server-side and has no pdf.js, so a PDF attachment is
// stored but its text is NOT extracted here. Classification then falls back to
// the filename and email subject, which is usually enough for "DXI 1H26 results
// presentation.pdf" and is not enough for "document(3).pdf". Those arrive
// flagged for review. Text and CSV attachments classify properly.

const { getSupabase } = require('./_shared.js');

exports.handler = async (event) => {
  const secret = process.env.INBOUND_EMAIL_KEY;
  if (!secret) return json(500, { error: 'INBOUND_EMAIL_KEY is not set. This endpoint writes to the database from a public URL and refuses to run unauthenticated.' });

  const key = (event.queryStringParameters || {}).key;
  if (key !== secret) return json(401, { error: 'bad or missing key' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const db = getSupabase();

  try {
    // Providers differ; accept the common shapes rather than binding to one.
    let payload;
    const ct = (event.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      payload = JSON.parse(event.body || '{}');
    } else {
      // form-encoded (Mailgun/SendGrid style)
      payload = Object.fromEntries(new URLSearchParams(event.body || ''));
    }

    const subject = payload.subject || payload.Subject || '(no subject)';
    const from    = payload.from || payload.sender || payload.From || 'unknown';
    const bodyText = payload['body-plain'] || payload.plain || payload.text || payload.TextBody || '';

    // Attachments: CloudMailin sends `attachments[]`, Mailgun sends
    // attachment-1..N with a JSON manifest, SendGrid sends a count + fields.
    let attachments = [];
    if (Array.isArray(payload.attachments)) {
      attachments = payload.attachments.map(a => ({
        filename: a.file_name || a.filename || a.name || 'attachment',
        content: a.content || a.data || null,
        encoding: a.content_transfer_encoding || a.encoding || 'base64',
        type: a.content_type || a.type || null,
      }));
    } else if (payload['attachment-count']) {
      const n = parseInt(payload['attachment-count'], 10) || 0;
      for (let i = 1; i <= n; i++) {
        const c = payload[`attachment-${i}`];
        if (c) attachments.push({ filename: `attachment-${i}`, content: c, encoding: 'base64', type: null });
      }
    }

    const warnings = [];
    if (!attachments.length) warnings.push('No attachments found; classified the email body instead.');

    // Build the classification payload. Server-side we have no PDF extractor, so
    // a PDF contributes its filename and the email subject — enough for a
    // well-named file, and explicitly not enough for "document(3).pdf".
    const docs = attachments.length
      ? attachments.map(a => {
          const isText = /\.(txt|csv)$/i.test(a.filename) || /text|csv/.test(a.type || '');
          let text = '';
          if (isText && a.content) {
            try { text = a.encoding === 'base64' ? Buffer.from(a.content, 'base64').toString('utf8') : String(a.content); }
            catch { text = ''; }
          }
          if (!text) {
            text = `Filename: ${a.filename}\nEmail subject: ${subject}\nFrom: ${from}\n\n` +
                   `(Binary attachment — no text extracted server-side. Classify from the filename and subject, ` +
                   `and set a low confidence if they are not informative.)\n\n${bodyText.slice(0, 2000)}`;
            warnings.push(`${a.filename}: binary attachment, classified from filename and subject only.`);
          }
          return { filename: a.filename, text };
        })
      : [{ filename: `${subject}.txt`, text: `Subject: ${subject}\nFrom: ${from}\n\n${bodyText}` }];

    // Reuse the same classifier the drag-and-drop uses — one code path.
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://areit.netlify.app';
    let proposals = [];
    try {
      const res = await fetch(`${base}/.netlify/functions/classify-documents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs }),
      });
      const out = await res.json();
      if (res.ok) proposals = out.proposals || [];
      else warnings.push(`Classifier returned ${res.status}: ${out.error || ''}. Documents stored unclassified.`);
    } catch (e) { warnings.push('Classifier unavailable: ' + e.message + '. Documents stored unclassified.'); }

    const byName = Object.fromEntries(proposals.map(p => [p.filename, p]));
    const filed = [];

    for (const a of attachments) {
      const p = byName[a.filename] || {};
      const ticker = p.ticker || null;
      const docType = p.doc_type || 'other';
      try {
        let stored = null;
        if (a.content) {
          const buf = Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8');
          const path = `${docType}/${ticker || '_unfiled'}/${Date.now()}_${a.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
          const { error: upErr } = await db.storage.from('documents')
            .upload(path, buf, { contentType: a.type || 'application/octet-stream', upsert: false });
          if (upErr) throw upErr;
          stored = path;
        }
        const { error } = await db.from('document_uploads').insert({
          doc_type: docType, ticker,
          doc_date: p.doc_date || null, period_label: p.period_label || null,
          title: p.title || a.filename, author: p.author || null,
          rating: p.rating || null, price_target: p.price_target ?? null,
          summary: p.reasoning || null,
          file_path: stored, file_name: a.filename,
          // needs_review survives into the library so a low-confidence arrival is
          // visible rather than sitting in the list looking as good as the rest.
          status: p.needs_review === false && ticker ? 'stored' : 'needs_review',
          notes: `via email from ${from} — subject: ${subject}`,
        });
        if (error) throw error;
        filed.push({ filename: a.filename, ticker, doc_type: docType, needs_review: p.needs_review !== false || !ticker });
      } catch (e) {
        warnings.push(`${a.filename}: ${e.message}`);
      }
    }

    return json(200, { ok: true, subject, from, filed: filed.length, documents: filed, warnings });
  } catch (err) {
    console.error('inbound-email failed:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
