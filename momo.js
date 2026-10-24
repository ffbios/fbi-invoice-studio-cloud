'use strict';
// MTN MoMo payments: reads "Payment received" SMS forwarded by the FBI MoMo Link phone app,
// stores each payment once (by MTN transaction ID) and lets the Invoice Studio match it to an invoice.
const crypto = require('node:crypto');

const PAIR_CODE_MINUTES = 15;
// A QR link that has not been opened on a phone stops working after this long.
const LINK_MINUTES = 30;
// MTN Ghana sends wallet alerts from the "MobileMoney" sender ID. Anything else is rejected,
// so an ordinary phone number cannot fake a payment by texting the phone.
const TRUSTED_SENDERS = String(process.env.MOMO_TRUSTED_SENDERS || 'MobileMoney,MTN MoMo,MTNMoMo,MTN MOMO')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function sha256(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }
function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function toAmount(v) { const n = Number(String(v || '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function normalizePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^233\d{9}$/.test(d)) return '0' + d.slice(3);
  if (/^0\d{9}$/.test(d)) return d;
  if (/^\d{9}$/.test(d)) return '0' + d;
  return '';
}
function isTrustedSender(sender) {
  const s = clean(sender).toLowerCase();
  return TRUSTED_SENDERS.includes(s);
}

// Turns one MoMo SMS into a payment, or returns null if it is not money coming in.
function parseMomoSms(text) {
  const body = clean(text);
  if (!body) return null;
  const lower = body.toLowerCase();
  // Money leaving the wallet, failed or reversed transactions are never payments.
  if (/payment made for|you have sent|transfer(?:red)? to|cash out|withdrawal|has been reversed|failed|declined|debited/.test(lower)) return null;
  if (!/received|cash in/.test(lower)) return null;

  const amountMatch = body.match(/(?:payment received for|cash in received for|you have received|received(?: payment of)?|cash in of)\s*(?:an amount of\s*)?(GHS|GH¢|GHC|¢)\s*([\d,]+(?:\.\d{1,2})?)/i)
    || body.match(/(GHS|GH¢|GHC)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:has been\s*)?(?:received|credited)/i);
  if (!amountMatch) return null;
  const amount = toAmount(amountMatch[2]);
  if (amount <= 0) return null;

  const txMatch = body.match(/(?:financial\s+)?transaction\s*id\s*[:#]?\s*([A-Za-z0-9]{6,})/i) || body.match(/\btrans(?:action)?\.?\s*id\s*[:#]?\s*([A-Za-z0-9]{6,})/i);
  const transactionId = txMatch ? txMatch[1] : '';

  // Payer: text after "from" up to the balance / reference / phone number.
  let payerName = '', payerPhone = '';
  const fromMatch = body.match(/\bfrom\s+(.+?)(?=\s*(?:current balance|available balance|your new balance|new balance|reference|ref:|\.\s|transaction id|$))/i);
  if (fromMatch) {
    let who = clean(fromMatch[1]);
    const phoneInWho = who.match(/\(?\+?(233\d{9}|0\d{9})\)?/);
    if (phoneInWho) { payerPhone = normalizePhone(phoneInWho[1]); who = clean(who.replace(phoneInWho[0], ' ')); }
    payerName = who.replace(/[,.;:]+$/, '').trim();
  }

  const refMatch = body.match(/reference\s*:\s*(.*?)(?=\s*(?:\.\s*(?:financial\s+)?transaction id|(?:financial\s+)?transaction id|\.\s*your new balance|your new balance|current balance|\.\s*fee|transaction fee|fee charged|$))/i);
  let reference = refMatch ? clean(refMatch[1]).replace(/[.\s]+$/, '') : '';
  let source = '';
  const bankMatch = reference.match(/\bfrom\s+(.+)$/i);
  if (bankMatch) { source = clean(bankMatch[1]); }
  if (!payerPhone) {
    const p = (reference.match(/\b(233\d{9}|0\d{9})\b/) || [])[1];
    if (p) payerPhone = normalizePhone(p);
  }
  const kind = /cash in/.test(lower) ? 'cash-in' : (source && /bank|limited|ltd|plc/i.test(source) ? 'bank-transfer' : 'momo-transfer');

  return {
    amount,
    currency: 'GHS',
    transactionId,
    payerName: payerName.slice(0, 120),
    payerPhone,
    reference: reference.slice(0, 300),
    source: source.slice(0, 120),
    kind
  };
}

async function ensureMomoTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS momo_payments (
      id BIGSERIAL PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      transaction_id TEXT,
      amount NUMERIC(14,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GHS',
      payer_name TEXT,
      payer_phone TEXT,
      reference TEXT,
      source TEXT,
      kind TEXT,
      sms_text TEXT NOT NULL,
      sms_sender TEXT,
      received_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      via TEXT NOT NULL DEFAULT 'phone',
      status TEXT NOT NULL DEFAULT 'new',
      invoice_id TEXT,
      invoice_no TEXT,
      receipt_no TEXT,
      client_id TEXT,
      client_name TEXT,
      matched_at BIGINT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_momo_payments_status ON momo_payments(status, received_at DESC);
    CREATE TABLE IF NOT EXISTS momo_devices (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT,
      last_sms_at BIGINT,
      app_version TEXT,
      last_rejected_sender TEXT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE momo_devices ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS momo_pair_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS momo_payer_links (
      payer_key TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT,
      updated_at BIGINT NOT NULL
    );
  `);
}

// The same person always produces the same key, whether we know their number or only their name.
function payerKey(p) {
  if (p.payer_phone) return 'phone:' + p.payer_phone;
  const name = clean(p.payer_name).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  return name ? 'name:' + name : '';
}

function paymentOut(r) {
  return {
    id: String(r.id), transactionId: r.transaction_id || '', amount: Number(r.amount), currency: r.currency,
    payerName: r.payer_name || '', payerPhone: r.payer_phone || '', reference: r.reference || '', source: r.source || '', kind: r.kind || '',
    smsText: r.sms_text, receivedAt: Number(r.received_at), createdAt: Number(r.created_at), via: r.via,
    status: r.status, invoiceId: r.invoice_id || '', invoiceNo: r.invoice_no || '', receiptNo: r.receipt_no || '',
    clientId: r.client_id || '', clientName: r.client_name || '', matchedAt: r.matched_at ? Number(r.matched_at) : null, note: r.note || '',
    payerKey: payerKey(r)
  };
}

async function storeSms(pool, { text, sender, receivedAt, via }) {
  const parsed = parseMomoSms(text);
  if (!parsed) return { stored: false, reason: 'not-a-payment' };
  const when = Number(receivedAt) > 1e12 ? Number(receivedAt) : Date.now();
  const dedupeKey = parsed.transactionId ? 'tx:' + parsed.transactionId : 'sms:' + sha256(clean(text));
  const q = await pool.query(
    `INSERT INTO momo_payments (dedupe_key, transaction_id, amount, currency, payer_name, payer_phone, reference, source, kind, sms_text, sms_sender, received_at, created_at, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [dedupeKey, parsed.transactionId || null, parsed.amount, parsed.currency, parsed.payerName || null, parsed.payerPhone || null, parsed.reference || null, parsed.source || null, parsed.kind, clean(text).slice(0, 2000), clean(sender).slice(0, 60) || null, when, Date.now(), via || 'phone']
  );
  if (!q.rowCount) return { stored: false, reason: 'duplicate' };
  const out = paymentOut(q.rows[0]);
  if (typeof module.exports.onPaymentStored === 'function') { try { module.exports.onPaymentStored(out); } catch (e) {} }
  return { stored: true, payment: out };
}

async function deviceFromRequest(pool, req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-fbi-momo-token'] || '').trim();
  if (token.length < 30) return null;
  const q = await pool.query('SELECT * FROM momo_devices WHERE token_hash=$1 AND revoked=FALSE', [sha256(token)]);
  const d = q.rows[0];
  if (!d) return null;
  // A phone linked by QR becomes active the first time it checks in, if it does so in time.
  if (d.pending) {
    if (Number(d.created_at) < Date.now() - LINK_MINUTES * 60 * 1000) return null;
    await pool.query('UPDATE momo_devices SET pending=FALSE WHERE id=$1', [d.id]);
    d.pending = false;
  }
  return d;
}

// Returns true when the request was a MoMo route and has been answered.
async function handleMomoRoute(req, res, url, h) {
  const { pool, json, parseJsonBody, requireAuth } = h;
  const p = url.pathname;
  if (!p.startsWith('/api/momo/')) return false;

  // ---- Phone app (FBI MoMo Link) ----
  if (p === '/api/momo/pair' && req.method === 'POST') {
    const b = await parseJsonBody(req);
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length !== 6) { json(res, 400, { ok: false, error: 'Enter the 6-digit code shown in Invoice Studio.' }); return true; }
    const now = Date.now();
    await pool.query('DELETE FROM momo_pair_codes WHERE expires_at < $1', [now]);
    const del = await pool.query('DELETE FROM momo_pair_codes WHERE code_hash=$1 AND expires_at >= $2 RETURNING code_hash', [sha256(code), now]);
    if (!del.rowCount) { json(res, 401, { ok: false, error: 'That code is wrong or has expired. Make a new one in Invoice Studio.' }); return true; }
    const token = crypto.randomBytes(32).toString('base64url');
    const name = clean(b.deviceName).slice(0, 80) || 'MoMo phone';
    await pool.query('INSERT INTO momo_devices (name, token_hash, created_at, last_seen_at, app_version) VALUES ($1,$2,$3,$3,$4)', [name, sha256(token), now, clean(b.appVersion).slice(0, 20) || null]);
    json(res, 200, { ok: true, token, deviceName: name });
    return true;
  }

  if ((p === '/api/momo/sms' || p === '/api/momo/heartbeat') && req.method === 'POST') {
    const device = await deviceFromRequest(pool, req);
    if (!device) { json(res, 401, { ok: false, error: 'This phone is not linked. Link it again from Invoice Studio.' }); return true; }
    const b = await parseJsonBody(req);
    const now = Date.now();
    const results = [];
    if (p === '/api/momo/sms') {
      const list = Array.isArray(b.messages) ? b.messages.slice(0, 200) : [];
      for (const m of list) {
        if (!isTrustedSender(m.sender)) {
          // Remember which sender was refused so a mismatch with MTN's real sender ID is easy to spot.
          if (parseMomoSms(m.body)) await pool.query('UPDATE momo_devices SET last_rejected_sender=$1 WHERE id=$2', [clean(m.sender).slice(0, 40), device.id]);
          results.push({ ref: m.ref || null, stored: false, reason: 'untrusted-sender' });
          continue;
        }
        const r = await storeSms(pool, { text: m.body, sender: m.sender, receivedAt: m.receivedAt, via: 'phone' });
        results.push({ ref: m.ref || null, stored: r.stored, reason: r.reason || null });
      }
    }
    await pool.query('UPDATE momo_devices SET last_seen_at=$1, app_version=COALESCE($2, app_version), last_sms_at=CASE WHEN $3 THEN $1 ELSE last_sms_at END, name=COALESCE($5, name) WHERE id=$4',
      [now, clean(b.appVersion).slice(0, 20) || null, results.some(r => r.stored), device.id, clean(b.deviceName).slice(0, 80) || null]);
    json(res, 200, { ok: true, results, stored: results.filter(r => r.stored).length });
    return true;
  }

  // ---- Invoice Studio (signed-in administrator) ----
  if (!(await requireAuth(req, res))) return true;

  // QR link: the key is made here, while the administrator is signed in, and travels to the phone
  // inside the QR code. The phone never has to ask for it, so there is no pairing request to block.
  if (p === '/api/momo/link-phone' && req.method === 'POST') {
    const now = Date.now();
    await pool.query('DELETE FROM momo_devices WHERE pending=TRUE AND created_at < $1', [now - LINK_MINUTES * 60 * 1000]);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO momo_devices (name, token_hash, created_at, pending) VALUES ($1,$2,$3,TRUE)', ['MoMo phone', sha256(token), now]);
    json(res, 200, { ok: true, token, expiresAt: now + LINK_MINUTES * 60 * 1000 });
    return true;
  }

  if (p === '/api/momo/pair-code' && req.method === 'POST') {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIR_CODE_MINUTES * 60 * 1000;
    await pool.query('INSERT INTO momo_pair_codes (code_hash, expires_at) VALUES ($1,$2) ON CONFLICT (code_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at', [sha256(code), expiresAt]);
    json(res, 200, { ok: true, code, expiresAt });
    return true;
  }

  if (p === '/api/momo/payments' && req.method === 'GET') {
    const status = String(url.searchParams.get('status') || 'all');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const where = ['new', 'matched', 'ignored'].includes(status) ? 'WHERE status=$1' : '';
    const q = await pool.query(`SELECT * FROM momo_payments ${where} ORDER BY received_at DESC, id DESC LIMIT ${limit}`, where ? [status] : []);
    const counts = await pool.query('SELECT status, COUNT(*)::int AS n FROM momo_payments GROUP BY status');
    const devices = await pool.query('SELECT id, name, created_at, last_seen_at, last_sms_at, app_version, last_rejected_sender FROM momo_devices WHERE revoked=FALSE AND pending=FALSE ORDER BY created_at DESC');
    const links = await pool.query('SELECT payer_key, client_id, client_name FROM momo_payer_links');
    json(res, 200, {
      ok: true,
      payments: q.rows.map(paymentOut),
      counts: Object.fromEntries(counts.rows.map(r => [r.status, r.n])),
      devices: devices.rows.map(d => ({ id: String(d.id), name: d.name, createdAt: Number(d.created_at), lastSeenAt: d.last_seen_at ? Number(d.last_seen_at) : null, lastSmsAt: d.last_sms_at ? Number(d.last_sms_at) : null, appVersion: d.app_version || '', lastRejectedSender: d.last_rejected_sender || '' })),
      payerLinks: Object.fromEntries(links.rows.map(r => [r.payer_key, { clientId: r.client_id, clientName: r.client_name || '' }]))
    });
    return true;
  }

  if (p === '/api/momo/paste' && req.method === 'POST') {
    const b = await parseJsonBody(req);
    const text = String(b.text || '');
    // Several SMS can be pasted at once; each starts with "Payment received" / "Cash In received".
    const chunks = text.split(/(?=(?:payment received for|cash in received for|you have received)\s)/i).map(clean).filter(Boolean);
    const out = [];
    for (const c of chunks) out.push(await storeSms(pool, { text: c, sender: 'pasted', receivedAt: Date.now(), via: 'pasted' }));
    const stored = out.filter(r => r.stored).length, dup = out.filter(r => r.reason === 'duplicate').length;
    if (!stored && !dup) { json(res, 400, { ok: false, error: 'No MoMo payment found in that text. Paste the full "Payment received for GHS …" message.' }); return true; }
    json(res, 200, { ok: true, stored, duplicates: dup, payments: out.filter(r => r.stored).map(r => r.payment) });
    return true;
  }

  { const m = p.match(/^\/api\/momo\/payments\/(\d+)\/(match|ignore|reopen)$/);
    if (m && req.method === 'POST') {
      const id = m[1], action = m[2];
      const b = await parseJsonBody(req);
      const cur = await pool.query('SELECT * FROM momo_payments WHERE id=$1', [id]);
      if (!cur.rowCount) { json(res, 404, { ok: false, error: 'Payment not found.' }); return true; }
      let q;
      if (action === 'match') {
        if (!b.invoiceId) { json(res, 400, { ok: false, error: 'Choose an invoice.' }); return true; }
        q = await pool.query(`UPDATE momo_payments SET status='matched', invoice_id=$2, invoice_no=$3, receipt_no=$4, client_id=$5, client_name=$6, matched_at=$7, note=$8 WHERE id=$1 RETURNING *`,
          [id, clean(b.invoiceId), clean(b.invoiceNo) || null, clean(b.receiptNo) || null, clean(b.clientId) || null, clean(b.clientName) || null, Date.now(), clean(b.note) || null]);
        const key = payerKey(cur.rows[0]);
        if (b.rememberPayer !== false && key && b.clientId) {
          await pool.query('INSERT INTO momo_payer_links (payer_key, client_id, client_name, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (payer_key) DO UPDATE SET client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name, updated_at=EXCLUDED.updated_at',
            [key, clean(b.clientId), clean(b.clientName) || null, Date.now()]);
        }
      } else if (action === 'ignore') {
        q = await pool.query(`UPDATE momo_payments SET status='ignored', note=$2, matched_at=NULL WHERE id=$1 RETURNING *`, [id, clean(b.note) || null]);
      } else {
        q = await pool.query(`UPDATE momo_payments SET status='new', invoice_id=NULL, invoice_no=NULL, receipt_no=NULL, matched_at=NULL, note=NULL WHERE id=$1 RETURNING *`, [id]);
      }
      json(res, 200, { ok: true, payment: paymentOut(q.rows[0]) });
      return true;
    }
  }

  { const m = p.match(/^\/api\/momo\/devices\/(\d+)\/unlink$/);
    if (m && req.method === 'POST') {
      await pool.query('UPDATE momo_devices SET revoked=TRUE WHERE id=$1', [m[1]]);
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

module.exports = { parseMomoSms, ensureMomoTables, handleMomoRoute, isTrustedSender, normalizePhone };
