'use strict';
// Moolre payouts for Payroll: send a worker's pay straight from the FBI Moolre wallet to their
// MoMo number or bank account, then record the payment on the payroll record automatically.
//
// Settings (environment variables, never stored in the browser or in this repo):
//   MOOLRE_API_USER        Moolre username
//   MOOLRE_API_KEY         Private API key of the API Service linked to the wallet that pays salaries
//   MOOLRE_ACCOUNT_NUMBER  Moolre wallet account number that the money is sent from
//   MOOLRE_API_BASE        optional, defaults to https://api.moolre.com
//   MOOLRE_MAX_PAYOUT      optional safety cap per single payout in GHS (0 = no cap)
const crypto = require('node:crypto');

const CHANNELS = {
  mtn: { code: '1', label: 'MTN MoMo' },
  telecel: { code: '6', label: 'Telecel Cash' },
  at: { code: '7', label: 'AT Money' },
  bank: { code: '2', label: 'Bank transfer' }
};
const PAYROLL_LOCK = 492012; // same lock the Payroll save uses, so writes never overlap
const ACTIVE = ['sending', 'pending', 'unknown'];

function cfg() {
  const e = process.env;
  return {
    user: String(e.MOOLRE_API_USER || '').trim(),
    key: String(e.MOOLRE_API_KEY || '').trim(),
    account: String(e.MOOLRE_ACCOUNT_NUMBER || '').trim(),
    base: String(e.MOOLRE_API_BASE || 'https://api.moolre.com').trim().replace(/\/+$/, ''),
    maxPayout: Number(e.MOOLRE_MAX_PAYOUT || 0) || 0
  };
}
function configured() { const c = cfg(); return !!(c.user && c.key && c.account); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v) { return Math.round(num(v) * 100) / 100; }
function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function normalizePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^233\d{9}$/.test(d)) return '0' + d.slice(3);
  if (/^0\d{9}$/.test(d)) return d;
  if (/^\d{9}$/.test(d)) return '0' + d;
  return '';
}
function guessNetwork(phone) {
  const p = normalizePhone(phone).slice(0, 3);
  if (['024', '025', '053', '054', '055', '059'].includes(p)) return 'mtn';
  if (['020', '050'].includes(p)) return 'telecel';
  if (['026', '027', '056', '057'].includes(p)) return 'at';
  return '';
}

// Same pay maths as the Payroll screen, so the balance here always matches what you see there.
function basePay(r) { return Math.max(0, num(r.rate) * Math.max(1, num(r.qty) || 1)); }
function allowances(r) { return num(r.allowance) + num(r.transport) + num(r.feeding) + num(r.accommodation) + num(r.overtime) + num(r.otherAllowance) + num(r.bonus); }
function net(r) { return Math.max(0, basePay(r) + allowances(r) - num(r.deduction) - num(r.advance) + num(r.previousBalance)); }
function paid(r) { return Math.min(net(r), Math.max(0, (Array.isArray(r.payments) ? r.payments : []).reduce((s, p) => s + num(p.amount), 0))); }
function balance(r) { return round2(Math.max(0, net(r) - paid(r))); }

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS moolre_payouts (
    externalref TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    worker_id TEXT,
    worker_name TEXT,
    amount NUMERIC(12,2) NOT NULL,
    channel TEXT NOT NULL,
    receiver TEXT NOT NULL,
    bank_code TEXT,
    receiver_name TEXT,
    status TEXT NOT NULL,
    moolre_txid TEXT,
    code TEXT,
    message TEXT,
    response_json JSONB,
    paid_by TEXT,
    payment_id TEXT,
    recorded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL)`);
  // Only one payout per payroll record can be in flight at a time: stops double taps and double payments.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_moolre_payouts_one_active ON moolre_payouts(record_id) WHERE status IN ('sending','pending','unknown')`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_moolre_payouts_record ON moolre_payouts(record_id)');
}

// Talks to Moolre. A network failure or timeout is "uncertain": the money may or may not have gone.
async function call(path, body, method = 'POST') {
  const c = cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(c.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-USER': c.user, 'X-API-KEY': c.key },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { http: res.status, data, text: text.slice(0, 2000) };
  } catch (err) {
    const e = new Error(err.name === 'AbortError' ? 'Moolre did not answer in time.' : 'Could not reach Moolre: ' + (err.message || err));
    e.uncertain = true;
    throw e;
  } finally { clearTimeout(timer); }
}
function msgOf(d) {
  if (!d) return '';
  const m = Array.isArray(d.message) ? d.message.join(' ') : d.message;
  return clean(m || (typeof d.data === 'string' ? d.data : ''));
}

// Reads Moolre's answer to a transfer and decides: paid, pending, failed or unknown.
function outcomeOfTransfer(r) {
  const d = r.data;
  if (!d || typeof d !== 'object') return r.http >= 500 ? 'unknown' : (r.http >= 400 ? 'failed' : 'unknown');
  const st = String(d.status), tx = d.data && typeof d.data === 'object' ? String(d.data.txstatus) : '';
  if (st === '1' && tx === '1') return 'paid';
  if (tx === '2') return 'failed';
  if (st === '1') return 'pending';               // accepted, still processing
  if (d.code === 'OTGH02') return 'pending';       // "Pay out in Progress"
  if (st === '0') return 'failed';                // Moolre refused it (bad key, low balance, wrong number...)
  return 'unknown';
}
function outcomeOfStatus(r) {
  const d = r.data;
  if (!d || typeof d !== 'object') return null;
  const tx = d.data && typeof d.data === 'object' ? String(d.data.txstatus) : '';
  if (String(d.status) === '1' && tx === '1') return 'paid';
  if (tx === '2') return 'failed';
  if (tx === '0' || String(d.status) === '1') return 'pending';
  return 'notfound';
}

async function readPayroll(db) {
  const q = await db.query('SELECT state_json FROM payroll_state WHERE id=1');
  let s = q.rows[0] ? q.rows[0].state_json : null;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  return s && typeof s === 'object' ? s : { workers: [], records: [], payslips: [] };
}

// Adds the payment to the payroll record (once). Uses the same lock as the normal Payroll save.
async function recordPayment(pool, row) {
  const paymentId = 'moolre-' + row.externalref;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [PAYROLL_LOCK]);
    const q = await client.query('SELECT state_json FROM payroll_state WHERE id=1 FOR UPDATE');
    let state = q.rows[0] ? q.rows[0].state_json : null;
    if (typeof state === 'string') state = JSON.parse(state);
    const rec = state && Array.isArray(state.records) ? state.records.find(r => String(r.id) === String(row.record_id)) : null;
    if (!rec) { await client.query('ROLLBACK'); return { ok: false, error: 'The payroll record was deleted, so the payment could not be attached to it.' }; }
    rec.payments = Array.isArray(rec.payments) ? rec.payments : [];
    if (!rec.payments.some(p => String(p.id) === paymentId)) {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const ch = CHANNELS[row.channel] ? CHANNELS[row.channel].label : row.channel;
      const ref = row.moolre_txid ? 'Moolre ' + row.moolre_txid : row.externalref;
      rec.payments.push({
        id: paymentId, date, amount: round2(row.amount),
        method: row.channel === 'bank' ? 'Bank' : 'Mobile Money',
        reference: ref, paidBy: row.paid_by || 'Moolre',
        notes: `Sent via Moolre (${ch}) to ${row.receiver_name || ''} ${row.receiver}`.replace(/\s+/g, ' ').trim(),
        moolre: { externalref: row.externalref, transactionId: row.moolre_txid || '', channel: row.channel, receiver: row.receiver, receiverName: row.receiver_name || '' }
      });
      rec.lastPaymentDate = date; rec.lastPaymentMethod = row.channel === 'bank' ? 'Bank' : 'Mobile Money';
      rec.lastPaymentReference = ref; rec.lastPaidBy = row.paid_by || 'Moolre';
      rec.updatedAt = now.toISOString();
      state.savedAt = Date.now();
      await client.query('UPDATE payroll_state SET saved_at=$1, state_json=$2::jsonb WHERE id=1', [state.savedAt, JSON.stringify(state)]);
    }
    await client.query('COMMIT');
    await pool.query('UPDATE moolre_payouts SET recorded=TRUE, payment_id=$2, updated_at=$3 WHERE externalref=$1', [row.externalref, paymentId, Date.now()]);
    return { ok: true, paymentId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

async function setOutcome(pool, ref, status, r) {
  const d = r && r.data;
  const txid = d && d.data && typeof d.data === 'object' ? clean(d.data.transactionid || '') : '';
  const q = await pool.query(
    `UPDATE moolre_payouts SET status=$2, code=COALESCE($3,code), message=COALESCE($4,message), moolre_txid=COALESCE(NULLIF($5,''),moolre_txid),
       response_json=COALESCE($6::jsonb,response_json), updated_at=$7 WHERE externalref=$1 RETURNING *`,
    [ref, status, d && d.code ? String(d.code) : null, d ? msgOf(d) || null : null, txid, d ? JSON.stringify(d) : null, Date.now()]);
  return q.rows[0];
}

// Asks Moolre what happened to one payout and settles it.
async function checkPayout(pool, ref) {
  const q = await pool.query('SELECT * FROM moolre_payouts WHERE externalref=$1', [ref]);
  let row = q.rows[0];
  if (!row) return null;
  if (ACTIVE.includes(row.status)) {
    const r = await call('/open/transact/status', { type: 1, idtype: 1, id: row.externalref, accountnumber: cfg().account });
    const out = outcomeOfStatus(r);
    if (out === 'paid' || out === 'failed') row = await setOutcome(pool, ref, out, r);
    else if (out === 'notfound' && Date.now() - Number(row.created_at) > 15 * 60 * 1000) {
      // Moolre has no record of it 15+ minutes later: it never went out.
      row = await setOutcome(pool, ref, 'failed', r);
    } else row = await setOutcome(pool, ref, row.status === 'unknown' ? 'unknown' : 'pending', r);
  }
  if (row.status === 'paid' && !row.recorded) await recordPayment(pool, row);
  const again = await pool.query('SELECT * FROM moolre_payouts WHERE externalref=$1', [ref]);
  return again.rows[0];
}

function publicRow(r) {
  if (!r) return null;
  return {
    ref: r.externalref, recordId: r.record_id, workerName: r.worker_name || '', amount: round2(r.amount),
    channel: r.channel, channelLabel: CHANNELS[r.channel] ? CHANNELS[r.channel].label : r.channel,
    receiver: r.receiver, receiverName: r.receiver_name || '', status: r.status, recorded: !!r.recorded,
    transactionId: r.moolre_txid || '', code: r.code || '', message: r.message || '',
    paidBy: r.paid_by || '', createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)
  };
}

let banksCache = { at: 0, list: [] };
async function getBanks() {
  if (banksCache.list.length && Date.now() - banksCache.at < 12 * 3600 * 1000) return banksCache.list;
  const r = await call('/open/transact/data?country=gha&data=banks', null, 'GET');
  const list = r.data && Array.isArray(r.data.data) ? r.data.data.map(b => ({ name: clean(b.name), code: clean(b.code) })).filter(b => b.name && b.code) : [];
  if (!list.length) throw new Error(msgOf(r.data) || 'Moolre did not return the bank list.');
  banksCache = { at: Date.now(), list };
  return list;
}

function readRecipient(b) {
  const channel = String(b.channel || '').toLowerCase();
  if (!CHANNELS[channel]) return { error: 'Choose MTN, Telecel, AT or Bank.' };
  let receiver, bankCode = '';
  if (channel === 'bank') {
    receiver = String(b.receiver || '').replace(/\s+/g, '');
    bankCode = clean(b.bankCode);
    if (!/^\d{6,20}$/.test(receiver)) return { error: 'Enter a valid bank account number.' };
    if (!bankCode) return { error: 'Choose the bank.' };
  } else {
    receiver = normalizePhone(b.receiver);
    if (!receiver) return { error: 'Enter a valid 10-digit mobile money number.' };
  }
  return { channel, receiver, bankCode };
}

async function validateName(rc) {
  const body = { type: 1, receiver: rc.receiver, channel: CHANNELS[rc.channel].code, currency: 'GHS', accountnumber: cfg().account };
  if (rc.channel === 'bank') body.sublistid = rc.bankCode;
  const r = await call('/open/transact/validate', body);
  const d = r.data || {};
  if (String(d.status) === '1' && typeof d.data === 'string' && d.data.trim()) return { ok: true, name: clean(d.data) };
  return { ok: false, error: msgOf(d) || 'Moolre could not confirm the account name.' };
}

async function handleRoute(req, res, url, h) {
  const { pool, json, parseJsonBody, requireAuth } = h;
  const p = url.pathname;
  if (!p.startsWith('/api/moolre/')) return false;
  const session = await requireAuth(req, res);
  if (!session) return true;
  try {
    if (p === '/api/moolre/status' && req.method === 'GET') {
      if (!configured()) { json(res, 200, { ok: true, configured: false }); return true; }
      const r = await call('/open/account/status', { type: 1, accountnumber: cfg().account });
      const d = r.data || {};
      if (String(d.status) !== '1') { json(res, 200, { ok: true, configured: true, connected: false, error: msgOf(d) || ('Moolre answered HTTP ' + r.http) }); return true; }
      json(res, 200, { ok: true, configured: true, connected: true, balance: round2(d.data && d.data.balance), accountName: clean(d.data && d.data.accountname), maxPayout: cfg().maxPayout });
      return true;
    }
    if (!configured()) { json(res, 503, { ok: false, error: 'Moolre is not set up on the server yet.' }); return true; }

    if (p === '/api/moolre/banks' && req.method === 'GET') { json(res, 200, { ok: true, banks: await getBanks() }); return true; }

    if (p === '/api/moolre/validate' && req.method === 'POST') {
      const rc = readRecipient(await parseJsonBody(req));
      if (rc.error) { json(res, 400, { ok: false, error: rc.error }); return true; }
      const v = await validateName(rc);
      json(res, v.ok ? 200 : 400, v); return true;
    }

    if (p === '/api/moolre/payouts' && req.method === 'GET') {
      const rid = clean(url.searchParams.get('recordId'));
      const q = rid ? await pool.query('SELECT * FROM moolre_payouts WHERE record_id=$1 ORDER BY created_at DESC', [rid])
        : await pool.query('SELECT * FROM moolre_payouts ORDER BY created_at DESC LIMIT 100');
      json(res, 200, { ok: true, payouts: q.rows.map(publicRow) }); return true;
    }

    const m = p.match(/^\/api\/moolre\/payouts\/([A-Za-z0-9-]+)\/check$/);
    if (m && req.method === 'POST') {
      const row = await checkPayout(pool, m[1]);
      if (!row) { json(res, 404, { ok: false, error: 'Payout not found.' }); return true; }
      json(res, 200, { ok: true, payout: publicRow(row) }); return true;
    }

    if (p === '/api/moolre/pay' && req.method === 'POST') {
      const b = await parseJsonBody(req);
      const recordId = clean(b.recordId);
      const amount = round2(b.amount);
      const paidBy = clean(b.paidBy).slice(0, 80) || 'Moolre';
      const rc = readRecipient(b);
      if (rc.error) { json(res, 400, { ok: false, error: rc.error }); return true; }
      if (!recordId) { json(res, 400, { ok: false, error: 'Missing payroll record.' }); return true; }
      if (!(amount >= 1)) { json(res, 400, { ok: false, error: 'The amount must be at least GH₵1.00.' }); return true; }
      const cap = cfg().maxPayout;
      if (cap > 0 && amount > cap) { json(res, 400, { ok: false, error: `This is above the GH₵${cap.toFixed(2)} limit for one payout.` }); return true; }

      const state = await readPayroll(pool);
      const rec = (state.records || []).find(r => String(r.id) === recordId);
      if (!rec) { json(res, 404, { ok: false, error: 'That payroll record is not saved on the server yet. Wait a moment and try again.' }); return true; }
      const worker = (state.workers || []).find(w => String(w.id) === String(rec.workerId)) || {};
      const bal = balance(rec);
      if (amount > bal + 0.005) { json(res, 400, { ok: false, error: `Only GH₵${bal.toFixed(2)} is still owed on this payroll.` }); return true; }

      // The name must be confirmed with Moolre right before sending.
      const v = await validateName(rc);
      if (!v.ok) { json(res, 400, { ok: false, error: 'Could not confirm the receiver: ' + v.error }); return true; }

      const ref = 'FBIPAY-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const now = Date.now();
      try {
        await pool.query(`INSERT INTO moolre_payouts (externalref,record_id,worker_id,worker_name,amount,channel,receiver,bank_code,receiver_name,status,paid_by,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sending',$10,$11,$11)`,
          [ref, recordId, String(rec.workerId || ''), clean(worker.name), amount, rc.channel, rc.receiver, rc.bankCode || null, v.name, paidBy, now]);
      } catch (err) {
        if (err.code === '23505') { json(res, 409, { ok: false, error: 'A Moolre payment for this payroll is already in progress. Check its status before paying again.' }); return true; }
        throw err;
      }

      const body = { type: 1, channel: CHANNELS[rc.channel].code, currency: 'GHS', amount: amount.toFixed(2), receiver: rc.receiver, externalref: ref,
        reference: ('FBI salary ' + (worker.name || '')).trim().slice(0, 60), accountnumber: cfg().account };
      if (rc.channel === 'bank') body.sublistid = rc.bankCode;

      let row;
      try {
        const r = await call('/open/transact/transfer', body);
        row = await setOutcome(pool, ref, outcomeOfTransfer(r), r);
      } catch (err) {
        if (!err.uncertain) throw err;
        await pool.query("UPDATE moolre_payouts SET status='unknown', message=$2, updated_at=$3 WHERE externalref=$1", [ref, err.message, Date.now()]);
        // Ask once right away; otherwise the background check settles it.
        try { row = await checkPayout(pool, ref); } catch { row = (await pool.query('SELECT * FROM moolre_payouts WHERE externalref=$1', [ref])).rows[0]; }
      }
      let warning = '';
      if (row.status === 'paid' && !row.recorded) {
        const rp = await recordPayment(pool, row);
        if (!rp.ok) warning = rp.error;
        row = (await pool.query('SELECT * FROM moolre_payouts WHERE externalref=$1', [ref])).rows[0];
      }
      json(res, 200, { ok: true, payout: publicRow(row), warning }); return true;
    }

    json(res, 404, { ok: false, error: 'Not found.' }); return true;
  } catch (err) {
    console.error('Moolre route failed:', err);
    json(res, 502, { ok: false, error: err.message || 'Moolre request failed.' }); return true;
  }
}

// Settles payouts that were still processing, every 2 minutes.
let timer = null;
function start(pool) {
  if (timer || !configured()) return;
  const tick = async () => {
    try {
      const q = await pool.query(`SELECT externalref FROM moolre_payouts WHERE (status = ANY($1) OR (status='paid' AND recorded=FALSE)) AND created_at > $2 ORDER BY created_at LIMIT 20`,
        [ACTIVE, Date.now() - 7 * 86400000]);
      for (const r of q.rows) { try { await checkPayout(pool, r.externalref); } catch (e) { console.warn('Moolre check failed for', r.externalref, e.message); } }
    } catch (e) { console.warn('Moolre background check failed:', e.message); }
  };
  timer = setInterval(tick, 120000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 15000).unref?.();
}

module.exports = { ensureTables, handleRoute, start, guessNetwork, outcomeOfTransfer, outcomeOfStatus, balance, CHANNELS };
