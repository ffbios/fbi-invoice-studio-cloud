'use strict';
// Phone notifications for Invoice Studio (standard Web Push, no extra app):
//  - new invoice (from the admin app or the staff portal)
//  - payment recorded on an invoice, and new MoMo payments
//  - event reminders: 2 days before, the day before and the morning of the event
// Pushes carry no data. The phone's service worker collects the waiting messages with its own key,
// so nothing has to be encrypted for the push service and an expired sign-in does not matter.
const crypto = require('node:crypto');

const TYPES = ['invoice', 'payment', 'event'];
const WATCH_MS = Number(process.env.NOTIFY_WATCH_MS || 60 * 1000);
const REMINDER_HOUR_UTC = Number(process.env.REMINDER_HOUR_UTC || 7); // 7:00 in Ghana (GMT)
const SUBJECT = process.env.PUSH_SUBJECT || 'https://invoice.fbigh.com';

let pool = null;
let vapid = null; // { publicKey (base64url raw), privateKey (KeyObject) }

const b64u = buf => Buffer.from(buf).toString('base64url');
const sha256 = v => crypto.createHash('sha256').update(String(v || '')).digest('hex');
const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
function cedi(n) { return 'GH₵' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function ensureTables(p) {
  pool = p;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_config (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_pem TEXT NOT NULL, created_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      prefs JSONB NOT NULL DEFAULT '{"invoice":true,"payment":true,"event":true}',
      created_at BIGINT NOT NULL,
      last_ok_at BIGINT,
      last_error TEXT,
      failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_messages (
      id BIGSERIAL PRIMARY KEY,
      sub_id BIGINT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL, url TEXT, tag TEXT,
      created_at BIGINT NOT NULL, delivered_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_push_messages_sub ON push_messages(sub_id, delivered_at);
    CREATE TABLE IF NOT EXISTS notify_seen (key TEXT PRIMARY KEY, created_at BIGINT NOT NULL);
  `);
  const q = await pool.query('SELECT public_key, private_pem FROM push_config WHERE id=1');
  if (q.rowCount) {
    vapid = { publicKey: q.rows[0].public_key, privateKey: crypto.createPrivateKey(q.rows[0].private_pem) };
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const raw = publicKey.export({ format: 'jwk' });
    const pub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]));
    await pool.query('INSERT INTO push_config (id, public_key, private_pem, created_at) VALUES (1,$1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [pub, privateKey.export({ type: 'pkcs8', format: 'pem' }), Date.now()]);
    const again = await pool.query('SELECT public_key, private_pem FROM push_config WHERE id=1');
    vapid = { publicKey: again.rows[0].public_key, privateKey: crypto.createPrivateKey(again.rows[0].private_pem) };
  }
}

// VAPID (RFC 8292): a short signed token that tells the push service the message really comes from this server.
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function ping(sub) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidHeader(sub.endpoint), TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.status === 404 || r.status === 410) { // the phone removed the app or turned notifications off
      await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
      return { ok: false, status: r.status, removed: true };
    }
    if (r.status >= 200 && r.status < 300) {
      await pool.query('UPDATE push_subscriptions SET last_ok_at=$1, last_error=NULL, failures=0 WHERE id=$2', [Date.now(), sub.id]);
      return { ok: true, status: r.status };
    }
    const text = (await r.text().catch(() => '')).slice(0, 200);
    await pool.query('UPDATE push_subscriptions SET last_error=$1, failures=failures+1 WHERE id=$2', [`HTTP ${r.status} ${text}`, sub.id]);
    console.warn('Push failed', r.status, text);
    return { ok: false, status: r.status, error: text };
  } catch (e) {
    await pool.query('UPDATE push_subscriptions SET last_error=$1, failures=failures+1 WHERE id=$2', [String(e.message || e).slice(0, 200), sub.id]).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// Queues a message for every phone that wants this type, then wakes those phones.
async function notify(type, { title, body, url, tag }, onlySubId) {
  if (!pool || !vapid) return { sent: 0 };
  const subs = onlySubId
    ? (await pool.query('SELECT * FROM push_subscriptions WHERE id=$1', [onlySubId])).rows
    : (await pool.query('SELECT * FROM push_subscriptions')).rows.filter(s => !type || (s.prefs || {})[type] !== false);
  const now = Date.now();
  const results = [];
  for (const s of subs) {
    await pool.query('INSERT INTO push_messages (sub_id, title, body, url, tag, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.id, clean(title).slice(0, 120), clean(body).slice(0, 400), url || '/', tag || null, now]);
    results.push(await ping(s));
  }
  return { sent: results.filter(r => r.ok).length, results };
}

// ---------- watching invoices and payments (covers the admin app and the staff portal) ----------
function invoicesOf(state) {
  let s = state;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return []; } }
  const list = s && s.data && Array.isArray(s.data.data) ? s.data.data : [];
  return list.filter(x => x && typeof x === 'object' && !x.deleted);
}
function paymentsOf(inv) {
  if (Array.isArray(inv.payments) && inv.payments.length) return inv.payments.filter(p => Number(p.amount) > 0);
  return [];
}

async function markSeen(keys) {
  const now = Date.now();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    await pool.query('INSERT INTO notify_seen (key, created_at) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING', ['{' + chunk.map(k => '"' + k.replace(/["\\]/g, '') + '"').join(',') + '}', now]);
  }
}

async function watchOnce() {
  const st = await pool.query('SELECT state_json FROM app_state WHERE id=1');
  if (!st.rowCount) return;
  const invoices = invoicesOf(st.rows[0].state_json);
  const seen = new Set((await pool.query("SELECT key FROM notify_seen WHERE key LIKE 'inv:%' OR key LIKE 'pay:%'")).rows.map(r => r.key));
  const firstRun = !seen.size;
  const newInv = [], newPay = [];
  for (const inv of invoices) {
    const id = String(inv.id || inv.no || '');
    if (!id) continue;
    if (!seen.has('inv:' + id)) newInv.push(inv);
    for (const p of paymentsOf(inv)) {
      const pk = 'pay:' + id + ':' + String(p.id || p.receiptNo || p.date + p.amount);
      if (!seen.has(pk)) newPay.push({ inv, p, key: pk });
    }
  }
  await markSeen(newInv.map(i => 'inv:' + String(i.id || i.no)).concat(newPay.map(x => x.key)));
  if (firstRun) return; // first start: remember what already exists, announce nothing
  if (newInv.length > 5) await notify('invoice', { title: newInv.length + ' new invoices', body: 'Open Invoice Studio to see them.', url: '/?open=invoices', tag: 'inv-bulk' });
  else for (const inv of newInv) {
    await notify('invoice', {
      title: 'New invoice ' + (inv.no || ''),
      body: [inv.client || 'No client', cedi(inv.total), inv.category].filter(Boolean).join(' · '),
      url: '/?open=' + encodeURIComponent('invoice:' + (inv.id || '')), tag: 'inv-' + (inv.id || inv.no)
    });
  }
  if (newPay.length > 5) await notify('payment', { title: newPay.length + ' new payments recorded', body: 'Open Invoice Studio to see them.', url: '/?open=receipts', tag: 'pay-bulk' });
  else for (const { inv, p } of newPay) {
    const total = Number(inv.total || 0), after = Number(p.balanceAfter);
    await notify('payment', {
      title: 'Payment received ' + cedi(p.amount),
      body: [inv.client || 'Client', 'Invoice ' + (inv.no || ''), p.receiptNo ? 'Receipt ' + p.receiptNo : '', p.method || '',
        Number.isFinite(after) ? (after <= 0.005 ? 'Fully paid' : 'Balance ' + cedi(after)) : (total ? 'Total ' + cedi(total) : '')].filter(Boolean).join(' · '),
      url: '/?open=' + encodeURIComponent('invoice:' + (inv.id || '')), tag: 'pay-' + (p.id || p.receiptNo)
    });
  }
}

// ---------- event reminders ----------
function dayString(d) { return d.toISOString().slice(0, 10); }
async function remindOnce(now = new Date()) {
  if (now.getUTCHours() < REMINDER_HOUR_UTC) return;
  const st = await pool.query('SELECT state_json FROM app_state WHERE id=1');
  if (!st.rowCount) return;
  const today = dayString(now);
  const plus = n => dayString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)));
  const when = { 0: 'Today', 1: 'Tomorrow', 2: 'In 2 days' };
  for (const inv of invoicesOf(st.rows[0].state_json)) {
    if (String(inv.status) === 'Cancelled') continue;
    const ev = String(inv.eventDate || inv.rentalStart || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev) || ev < today) continue;
    for (const n of [2, 1, 0]) {
      if (plus(n) !== ev) continue;
      const key = 'evt:' + (inv.id || inv.no) + ':' + ev + ':' + n;
      const ins = await pool.query('INSERT INTO notify_seen (key, created_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key', [key, Date.now()]);
      if (!ins.rowCount) continue;
      const end = String(inv.eventEndDate || '').slice(0, 10);
      await notify('event', {
        title: when[n] + ': ' + (inv.client || 'event') + (inv.no ? ' (' + inv.no + ')' : ''),
        body: [ev + (end && end !== ev ? ' to ' + end : ''), inv.jobLocation || inv.clientAddress || '', inv.category || ''].filter(Boolean).join(' · '),
        url: '/?open=' + encodeURIComponent('invoice:' + (inv.id || '')), tag: 'evt-' + (inv.id || inv.no) + '-' + n
      });
    }
  }
}

function start() {
  const tick = async () => {
    try { await watchOnce(); } catch (e) { console.warn('Notification watcher:', e.message); }
    try { await remindOnce(); } catch (e) { console.warn('Event reminders:', e.message); }
  };
  setTimeout(tick, 5000);
  setInterval(tick, WATCH_MS).unref?.();
}

// ---------- HTTP ----------
async function handleRoute(req, res, url, h) {
  const { json, parseJsonBody, requireAuth } = h;
  const p = url.pathname;
  if (!p.startsWith('/api/push/')) return false;

  // Called by the phone's service worker with its own key (works even when signed out).
  if (p === '/api/push/pending' && req.method === 'POST') {
    const b = await parseJsonBody(req);
    const q = await pool.query('SELECT id FROM push_subscriptions WHERE key_hash=$1', [sha256(b.key)]);
    if (!q.rowCount) { json(res, 404, { ok: false, error: 'Unknown device' }); return true; }
    const m = await pool.query(`UPDATE push_messages SET delivered_at=$2 WHERE id IN (
        SELECT id FROM push_messages WHERE sub_id=$1 AND delivered_at IS NULL AND created_at > $3 ORDER BY id LIMIT 10)
      RETURNING title, body, url, tag, created_at`, [q.rows[0].id, Date.now(), Date.now() - 3 * 86400000]);
    json(res, 200, { ok: true, messages: m.rows.sort((a, b) => Number(a.created_at) - Number(b.created_at)) });
    return true;
  }

  if (!(await requireAuth(req, res))) return true;

  if (p === '/api/push/config' && req.method === 'GET') {
    const subs = await pool.query('SELECT id, label, prefs, created_at, last_ok_at, last_error FROM push_subscriptions ORDER BY created_at DESC');
    json(res, 200, { ok: true, publicKey: vapid.publicKey, devices: subs.rows.map(s => ({ id: String(s.id), label: s.label || 'Device', prefs: s.prefs, createdAt: Number(s.created_at), lastOkAt: s.last_ok_at ? Number(s.last_ok_at) : null, lastError: s.last_error || '' })) });
    return true;
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await parseJsonBody(req);
    const sub = b.subscription || {};
    if (!/^https:\/\//.test(String(sub.endpoint || '')) && !process.env.PUSH_ALLOW_HTTP) { json(res, 400, { ok: false, error: 'This browser did not give a valid notification address.' }); return true; }
    const key = crypto.randomBytes(24).toString('base64url');
    const prefs = {}; TYPES.forEach(t => { prefs[t] = !(b.prefs && b.prefs[t] === false); });
    const q = await pool.query(`INSERT INTO push_subscriptions (endpoint, key_hash, label, prefs, created_at) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (endpoint) DO UPDATE SET key_hash=EXCLUDED.key_hash, label=EXCLUDED.label, prefs=EXCLUDED.prefs, failures=0, last_error=NULL RETURNING id`,
      [String(sub.endpoint), sha256(key), clean(b.label).slice(0, 80) || 'Device', JSON.stringify(prefs), Date.now()]);
    json(res, 200, { ok: true, id: String(q.rows[0].id), key });
    return true;
  }
  { const m = p.match(/^\/api\/push\/devices\/(\d+)(?:\/(prefs|test|remove))?$/);
    if (m && req.method === 'POST') {
      const id = m[1], action = m[2];
      if (action === 'prefs') {
        const b = await parseJsonBody(req); const prefs = {}; TYPES.forEach(t => { prefs[t] = !!(b.prefs && b.prefs[t]); });
        await pool.query('UPDATE push_subscriptions SET prefs=$1::jsonb WHERE id=$2', [JSON.stringify(prefs), id]);
        json(res, 200, { ok: true, prefs }); return true;
      }
      if (action === 'test') {
        const out = await notify(null, { title: 'Invoice Studio notifications are on', body: 'You will be told about new invoices, payments and upcoming events.', url: '/', tag: 'test' }, id);
        const r = (out.results || [])[0] || {};
        json(res, 200, { ok: !!r.ok, status: r.status || null, error: r.ok ? null : (r.error || (r.removed ? 'This device turned notifications off.' : 'The phone could not be reached.')) });
        return true;
      }
      if (action === 'remove') { await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [id]); json(res, 200, { ok: true }); return true; }
    }
  }
  json(res, 404, { ok: false, error: 'Not found.' });
  return true;
}

module.exports = { ensureTables, start, notify, handleRoute, watchOnce, remindOnce, vapidHeader, getPublicKey: () => vapid && vapid.publicKey };
