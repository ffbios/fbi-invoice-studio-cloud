'use strict';
// Secure payslips: every payslip is ISSUED by the server, gets a serial number + secret verification code,
// a fingerprint of its figures, a QR code, and a public verification page at /verify.
// A forged or edited payslip either has no matching serial/code, or its figures differ from the verified record.
const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');

const VERIFY_HOST = String(process.env.PAYSLIP_VERIFY_HOST || 'verify.fbigh.com').trim().toLowerCase();
const VERIFY_BASE = 'https://' + VERIFY_HOST;
const path = require('node:path');
const fs = require('node:fs');
const LOGO_FILE = path.join(__dirname, 'assets', 'fbi-logo.png');
const PAYROLL_LOCK = 492012;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function money(v) { return 'GH₵' + num(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function randomCode(n) { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; return s; }
function maskAccount(v) { const d = String(v || '').replace(/\s+/g, ''); if (d.length < 6) return d ? '••••' : ''; return d.slice(0, 3) + '••••' + d.slice(-3); }
function fmtDate(ms) { return new Date(Number(ms)).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' }); }

// Same pay maths as the Payroll screen.
function basePay(r) { return Math.max(0, num(r.rate) * Math.max(1, num(r.qty) || 1)); }
function gross(r) { return Math.max(0, basePay(r) + num(r.allowance) + num(r.transport) + num(r.feeding) + num(r.accommodation) + num(r.overtime) + num(r.otherAllowance) + num(r.bonus)); }
function net(r) { return Math.max(0, gross(r) - num(r.deduction) - num(r.advance) + num(r.previousBalance)); }
function paid(r) { return Math.min(net(r), Math.max(0, (Array.isArray(r.payments) ? r.payments : []).reduce((s, p) => s + num(p.amount), 0))); }
function balance(r) { return Math.max(0, net(r) - paid(r)); }
function status(r) { const n = net(r), p = paid(r); if (n <= 0) return 'Pending'; if (p >= n - 0.005) return 'Paid'; if (p > 0.005) return 'Partially Paid'; return 'Pending'; }

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS payslip_issues (
    serial TEXT PRIMARY KEY, code TEXT NOT NULL, record_id TEXT NOT NULL, worker_id TEXT,
    fingerprint TEXT NOT NULL, figures_hash TEXT NOT NULL, snapshot JSONB NOT NULL, issued_at BIGINT NOT NULL, issued_by TEXT)`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_payslip_issues_record ON payslip_issues(record_id, issued_at DESC)');
  await pool.query('CREATE SEQUENCE IF NOT EXISTS payslip_serial_seq START 1');
}

async function readJsonRow(db, sql) {
  const q = await db.query(sql); let v = q.rows[0] ? q.rows[0].state_json : null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return v;
}

function companyFrom(appState) {
  const s = (appState && appState.data && appState.data.settings) || (appState && appState.settings) || {};
  return {
    name: String(s.biz || 'FILM BEYOND IMAGINATION (FBI)').trim(),
    address: String(s.baddr || 'Dome, Accra').trim(),
    phone: String(s.bphone || s.bnum || '').trim(),
    email: String(s.bemail || '').trim(),
    website: 'fbigh.com',
    signatory: String(s.owner || '').trim()
  };
}

// The figures that make up a payslip. Same record + same figures = same payslip (no new serial).
function figuresOf(rec, worker) {
  const earnings = [
    ['Basic pay (' + (num(rec.rate) ? money(rec.rate) : '') + ' × ' + Math.max(1, num(rec.qty) || 1) + ')', basePay(rec)],
    ['Transport allowance', num(rec.transport)], ['Feeding allowance', num(rec.feeding)], ['Accommodation', num(rec.accommodation)],
    ['Overtime', num(rec.overtime)], ['Other allowance', num(rec.otherAllowance)], ['General allowance', num(rec.allowance)], ['Bonus', num(rec.bonus)]
  ].filter((l, i) => i === 0 || l[1] !== 0).map(l => ({ label: l[0], amount: r2(l[1]) }));
  const deductions = [['Deductions', num(rec.deduction)], ['Salary advance', num(rec.advance)]].filter(l => l[1] !== 0).map(l => ({ label: l[0], amount: r2(l[1]) }));
  const payments = (Array.isArray(rec.payments) ? rec.payments : []).slice(-5).map(p => ({ date: String(p.date || ''), amount: r2(p.amount), method: String(p.method || ''), reference: String(p.reference || '') }));
  return {
    worker: {
      name: String(worker.name || '').trim(), code: validStaffId(worker.workerCode) ? String(worker.workerCode).trim() : '', role: String(rec.role || worker.role || '').trim(),
      department: String(worker.department || '').trim(), type: String(worker.workerType || '').trim(),
      payMethod: String(worker.paymentMethod || '').trim(),
      payTo: worker.paymentMethod === 'Bank' ? [worker.bank, maskAccount(worker.accountNumber)].filter(Boolean).join(' ') : (worker.paymentMethod === 'Cash' ? 'Cash' : maskAccount(worker.momo || worker.phone))
    },
    work: { date: String(rec.workDate || ''), basis: String(rec.basis || ''), project: String(rec.project || '') },
    earnings, deductions, previousBalance: r2(rec.previousBalance),
    gross: r2(gross(rec)), net: r2(net(rec)), paid: r2(paid(rec)), balance: r2(balance(rec)), status: status(rec), payments
  };
}

// A usable staff ID: not empty, no spaces (so form hints like "Leave blank if not assigned" don't count).
function validStaffId(v) { const t = String(v || '').trim(); return !!t && t.length <= 24 && !/\s/.test(t); }

// Gives the worker on this record the next FBI-WK-#### number if they have no real staff ID yet, and saves it.
async function ensureStaffId(pool, recordId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [PAYROLL_LOCK]);
    const q = await client.query('SELECT state_json FROM payroll_state WHERE id=1 FOR UPDATE');
    let st = q.rows[0] ? q.rows[0].state_json : null; if (typeof st === 'string') st = JSON.parse(st);
    const rec = st && (st.records || []).find(r => String(r.id) === String(recordId));
    const w = rec && (st.workers || []).find(x => String(x.id) === String(rec.workerId));
    if (!w || validStaffId(w.workerCode)) { await client.query('COMMIT'); return; }
    let max = 0;
    for (const x of st.workers) { const m = String(x.workerCode || '').trim().match(/^FBI-WK-(\d+)$/i); if (m) max = Math.max(max, Number(m[1])); }
    w.workerCode = 'FBI-WK-' + String(max + 1).padStart(4, '0');
    w.updatedAt = new Date().toISOString();
    st.savedAt = Date.now();
    await client.query('UPDATE payroll_state SET saved_at=$1, state_json=$2::jsonb WHERE id=1', [st.savedAt, JSON.stringify(st)]);
    await client.query('COMMIT');
  } catch (err) { try { await client.query('ROLLBACK'); } catch {} throw err; } finally { client.release(); }
}

// Issues (or re-uses) the payslip for a payroll record. Returns the stored row.
async function issue(pool, recordId, issuedBy, onlyWorkerId) {
  await ensureStaffId(pool, recordId);
  const payroll = await readJsonRow(pool, 'SELECT state_json FROM payroll_state WHERE id=1') || {};
  const rec = (payroll.records || []).find(r => String(r.id) === String(recordId));
  if (!rec || (onlyWorkerId && String(rec.workerId) !== String(onlyWorkerId))) { const e = new Error('Payroll record not found.'); e.status = 404; throw e; }
  const worker = (payroll.workers || []).find(w => String(w.id) === String(rec.workerId)) || {};
  const appState = await readJsonRow(pool, 'SELECT state_json FROM app_state WHERE id=1') || {};
  const figures = figuresOf(rec, worker);
  const company = companyFrom(appState);
  const figuresHash = crypto.createHash('sha256').update(canonical({ figures, company })).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [PAYROLL_LOCK + 7]);
    const last = await client.query('SELECT * FROM payslip_issues WHERE record_id=$1 ORDER BY issued_at DESC LIMIT 1', [String(recordId)]);
    if (last.rows[0] && last.rows[0].figures_hash === figuresHash) { await client.query('COMMIT'); return last.rows[0]; }
    const seq = (await client.query("SELECT nextval('payslip_serial_seq') AS n")).rows[0].n;
    const issuedAt = Date.now();
    const serial = 'FBI-PS-' + new Date(issuedAt).getUTCFullYear() + '-' + String(seq).padStart(6, '0');
    const code = randomCode(8);
    const snapshot = { serial, issuedAt, company, figures };
    const fp = crypto.createHash('sha256').update(serial + '|' + code + '|' + canonical(snapshot)).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
    const ins = await client.query(`INSERT INTO payslip_issues (serial,code,record_id,worker_id,fingerprint,figures_hash,snapshot,issued_at,issued_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`, [serial, code, String(recordId), String(rec.workerId || ''), fp, figuresHash, JSON.stringify(snapshot), issuedAt, String(issuedBy || '').slice(0, 80)]);
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (err) { try { await client.query('ROLLBACK'); } catch {} throw err; } finally { client.release(); }
}

function verifyUrl(row) { return VERIFY_BASE + '/' + encodeURIComponent(row.serial) + '?c=' + encodeURIComponent(row.code); }

function qrSvg(text, px) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), quiet = 2, size = n + quiet * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="Verification QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b0d12"/></svg>`;
}

// A security pattern drawn from the serial, so every payslip's background is unique.
function guilloche(serial) {
  const h = crypto.createHash('sha256').update(String(serial)).digest();
  const W = 800, H = 1130, paths = [];
  const bands = [[0.17, '#c9a54a'], [0.5, '#b0124f'], [0.83, '#c9a54a']];
  bands.forEach(([fy, col], bi) => {
    for (let k = 0; k < 7; k++) {
      const amp = 18 + (h[bi * 7 + k] % 22), f1 = 2 + (h[(bi * 7 + k + 3) % 32] % 5), f2 = 5 + (h[(bi * 7 + k + 9) % 32] % 7), ph = (h[(k + 17) % 32] / 255) * Math.PI * 2;
      let d = '';
      for (let x = 0; x <= W; x += 8) {
        const t = x / W * Math.PI * 2;
        const y = H * fy + amp * Math.sin(f1 * t + ph + k * 0.45) + amp * 0.45 * Math.sin(f2 * t - ph);
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      paths.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="0.6" opacity="0.32"/>`);
    }
  });
  // rosette behind the net-pay area
  const cx = W * 0.5, cy = H * 0.5; let rd = '';
  const petals = 9 + (h[5] % 6), rr = 120 + (h[6] % 40);
  for (let a = 0; a <= 360; a += 1.5) {
    const t = a * Math.PI / 180, r = rr + 34 * Math.sin(petals * t) + 10 * Math.sin((petals * 3) * t + h[7] / 40);
    rd += (a ? 'L' : 'M') + (cx + r * Math.cos(t)).toFixed(1) + ' ' + (cy + r * Math.sin(t)).toFixed(1);
  }
  for (let i = 0; i < 5; i++) paths.push(`<path d="${rd}" transform="rotate(${i * (360 / petals / 5)} ${cx} ${cy})" fill="none" stroke="#c9a54a" stroke-width="0.55" opacity="0.18"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${paths.join('')}</svg>`;
}

function payslipHtml(row, opts) {
  opts = opts || {};
  const s = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
  const f = s.figures, c = s.company, w = f.worker;
  const url = verifyUrl(row);
  const bg = 'data:image/svg+xml;base64,' + Buffer.from(guilloche(row.serial)).toString('base64');
  const micro = ('FILM BEYOND IMAGINATION • GENUINE PAYSLIP • ' + row.serial + ' • ').repeat(14);
  const wm = esc((w.name || '').toUpperCase() + ' • ' + row.serial + ' • ');
  const lineRows = (list) => list.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${money(l.amount)}</td></tr>`).join('');
  const totalDed = f.deductions.reduce((a, l) => a + l.amount, 0);
  const statusCls = f.status === 'Paid' ? 'ok' : (f.status === 'Partially Paid' ? 'warn' : 'info');
  const pay = f.payments.length ? f.payments[f.payments.length - 1] : null;
  const logo = opts.logoUrl || '/assets/fbi-logo.png';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payslip ${esc(row.serial)} – ${esc(w.name)}</title><meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e9ebef;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;color:#141821;font-size:13px}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:8px;justify-content:center;align-items:center;padding:10px;background:#0f1218;color:#cfd5de;font-size:13px}
.bar button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid #3a4150;background:#1b2029;color:#fff;cursor:pointer}.bar button.p{background:#a80e4d;border-color:#a80e4d}
.sheet{position:relative;width:210mm;min-height:297mm;margin:18px auto;background:#fff;box-shadow:0 10px 40px rgba(15,18,24,.18);overflow:hidden}
.sec{position:absolute;inset:0;background:url(${bg}) center/100% 100% no-repeat;pointer-events:none}
.wm{position:absolute;inset:-30% -30%;display:flex;flex-wrap:wrap;align-content:center;transform:rotate(-30deg);pointer-events:none;opacity:.055;font-weight:800;font-size:15px;letter-spacing:2px;line-height:42px;color:#0f1218;word-break:break-all}
.wmlogo{position:absolute;left:50%;top:55%;width:120mm;transform:translate(-50%,-50%);opacity:.05;pointer-events:none;filter:grayscale(1)}
.micro{position:absolute;left:7mm;right:7mm;font-size:3.6px;letter-spacing:.3px;color:#8d6b1f;white-space:nowrap;overflow:hidden;line-height:1}.micro.t{top:5mm}.micro.b{bottom:5mm}
.frame{position:absolute;inset:4mm;border:.6mm solid #c9a54a;pointer-events:none}.frame:after{content:"";position:absolute;inset:1.6mm;border:.25mm solid #a80e4d}
.in{position:relative;padding:12mm 13mm 11mm}
.head{display:flex;justify-content:space-between;align-items:center;background:#0f1218;color:#fff;border-radius:3mm;padding:6mm 7mm}
.head img{height:15mm;width:auto;display:block}
.head .t{text-align:right}.head h1{margin:0;font-size:24px;letter-spacing:4px;font-weight:800;color:#e6c46a}.head .s{font-size:12px;color:#c7cdd6;margin-top:3px;font-variant-numeric:tabular-nums}
.co{display:flex;justify-content:space-between;gap:10px;margin:4mm 1mm 5mm;font-size:12px;color:#454c58}.co b{color:#141821}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm}
.box{border:1px solid #dfe3e9;border-radius:2.5mm;padding:4mm 4.5mm;background:rgba(255,255,255,.86)}
.box h3{margin:0 0 2.5mm;font-size:10.5px;letter-spacing:1.6px;color:#8d6b1f;text-transform:uppercase}
.kv{display:grid;grid-template-columns:30mm 1fr;row-gap:1.6mm;font-size:12.5px}.kv span{color:#5b6472}.kv b{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12.5px}td{padding:2.1mm 0;border-bottom:1px solid #eceff3}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.tot td{border-bottom:0;border-top:1.5px solid #141821;font-weight:700;padding-top:2.6mm}
.net{margin:5mm 0 0;display:flex;justify-content:space-between;align-items:center;border-radius:3mm;padding:5mm 6mm;background:linear-gradient(135deg,#a80e4d,#6e0a33);color:#fff;border:.5mm solid #c9a54a}
.net span{font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.85}.net b{font-size:28px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.sum{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin-top:4mm}.sum div{border:1px solid #dfe3e9;border-radius:2.5mm;padding:3mm 4mm;background:rgba(255,255,255,.86)}.sum span{display:block;font-size:10.5px;color:#5b6472;text-transform:uppercase;letter-spacing:1px}.sum b{font-size:16px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1mm 3mm;border-radius:99px;font-size:12px;font-weight:700}.pill.ok{background:#e5f5ec;color:#127a4a}.pill.warn{background:#fdf1d9;color:#8a5a00}.pill.info{background:#e6eefb;color:#1d4f91}
.ver{display:grid;grid-template-columns:34mm 1fr;gap:5mm;align-items:center;margin-top:5mm;border:1px dashed #c9a54a;border-radius:3mm;padding:4mm;background:rgba(255,253,245,.92)}
.ver h3{margin:0 0 1.5mm;font-size:13px}.ver p{margin:0 0 1.5mm;font-size:11.5px;color:#454c58;line-height:1.45}.ver code{font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;font-weight:700;color:#141821;letter-spacing:1px}
.sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:7mm;font-size:11.5px;color:#454c58}.sign .line{width:62mm;border-top:1px solid #141821;padding-top:1.5mm;text-align:center}
.foot{margin-top:5mm;font-size:10.5px;color:#6b7280;text-align:center;line-height:1.5}
@media screen and (max-width:820px){.sheet{width:100%;min-height:auto;margin:0;box-shadow:none}.grid,.sum{grid-template-columns:1fr}.in{padding:9mm 7mm}.ver{grid-template-columns:1fr;justify-items:start}}
@page{size:A4;margin:0}@media print{body{background:#fff}.bar{display:none}.sheet{margin:0;box-shadow:none;width:210mm;height:297mm}}
</style></head><body>
${opts.toolbar === false ? '' : `<div class="bar"><span>Payslip ${esc(row.serial)}</span><button class="p" onclick="window.print()">Print / Save as PDF</button>${opts.closeButton ? '<button onclick="window.close()">Close</button>' : ''}</div>`}
<div class="sheet">
  <div class="sec"></div><div class="wm">${wm.repeat(160)}</div><img class="wmlogo" src="${esc(logo)}" alt="">
  <div class="frame"></div><div class="micro t">${esc(micro)}</div><div class="micro b">${esc(micro)}</div>
  <div class="in">
    <div class="head"><img src="${esc(logo)}" alt="FBI"><div class="t"><h1>PAYSLIP</h1><div class="s">No. <b>${esc(row.serial)}</b></div><div class="s">Issued ${esc(fmtDate(row.issued_at))}</div></div></div>
    <div class="co"><div><b>${esc(c.name)}</b><br>${esc(c.address)}</div><div style="text-align:right">${esc([c.phone, c.email].filter(Boolean).join(' • '))}<br>${esc(c.website)}</div></div>
    <div class="grid">
      <div class="box"><h3>Employee</h3><div class="kv"><span>Name</span><b>${esc(w.name)}</b><span>Staff ID</span><b>${esc(w.code || '\u2014')}</b><span>Role</span><b>${esc(w.role || '—')}</b><span>Department</span><b>${esc(w.department || '—')}</b><span>Paid via</span><b>${esc([w.payMethod, w.payTo].filter(Boolean).join(' • ') || '—')}</b></div></div>
      <div class="box"><h3>Pay details</h3><div class="kv"><span>Work date</span><b>${esc(f.work.date || '—')}</b><span>Pay basis</span><b>${esc(f.work.basis || '—')}</b><span>Project / event</span><b>${esc(f.work.project || '—')}</b><span>Status</span><b><span class="pill ${statusCls}">${esc(f.status)}</span></b></div></div>
      <div class="box"><h3>Earnings</h3><table>${lineRows(f.earnings)}<tr class="tot"><td>Gross pay</td><td class="r">${money(f.gross)}</td></tr></table></div>
      <div class="box"><h3>Deductions &amp; adjustments</h3><table>${f.deductions.length ? lineRows(f.deductions) : '<tr><td>No deductions</td><td class="r">' + money(0) + '</td></tr>'}${f.previousBalance ? `<tr><td>Previous balance owed (added)</td><td class="r">${money(f.previousBalance)}</td></tr>` : ''}<tr class="tot"><td>Total deductions</td><td class="r">${money(totalDed)}</td></tr></table></div>
    </div>
    <div class="net"><span>Net pay</span><b>${money(f.net)}</b></div>
    <div class="sum"><div><span>Amount paid</span><b>${money(f.paid)}</b></div><div><span>Balance due</span><b>${money(f.balance)}</b></div><div><span>Last payment</span><b style="font-size:12.5px">${pay ? esc(pay.date) + '<br>' + esc(pay.method) + (pay.reference ? ' • ' + esc(pay.reference) : '') : '—'}</b></div></div>
    <div class="ver">${qrSvg(url, 128)}<div><h3>Check this payslip is genuine</h3><p>Scan the QR code, or go to <b>${esc(VERIFY_HOST)}</b> and enter the payslip number and security code. A genuine payslip shows the same figures as above.</p><p>Payslip no. <code>${esc(row.serial)}</code> &nbsp; Security code <code>${esc(row.code)}</code></p><p>Document fingerprint <code style="font-size:11.5px">${esc(row.fingerprint)}</code></p></div></div>
    <div class="sign"><div>Computer-generated payslip. Valid only if it verifies online.</div><div class="line">${esc(c.signatory || 'Authorised signatory')}<br><span style="font-size:10.5px">for ${esc(c.name)}</span></div></div>
    <div class="foot">Any alteration makes this payslip invalid. Report suspected forgeries to ${esc(c.email || c.phone || c.name)}.</div>
  </div>
</div></body></html>`;
}

// ---- public verification page ----
const failures = new Map();
function tooMany(ip) { const now = Date.now(), list = (failures.get(ip) || []).filter(t => now - t < 15 * 60 * 1000); failures.set(ip, list); if (failures.size > 5000) failures.clear(); return list.length >= 20; }
function noteFail(ip) { const l = failures.get(ip) || []; l.push(Date.now()); failures.set(ip, l); }

function verifyPage(body, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0f1218;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;color:#141821;display:flex;flex-direction:column;align-items:center;padding:28px 16px}
.logo{height:48px;margin:6px 0 10px}.brand{color:#e6c46a;font-size:12.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px;text-align:center}.small a{color:#e6c46a;text-decoration:none;font-weight:600}.card{width:min(560px,100%);background:#fff;border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{font-size:22px;margin:0 0 6px}p{color:#4b5563;line-height:1.5;margin:0 0 14px}.st{display:flex;gap:12px;align-items:center;padding:14px 16px;border-radius:12px;margin-bottom:18px;font-weight:700;font-size:16px}
.ok{background:#e5f5ec;color:#0f6b40}.bad{background:#fdecea;color:#a3221a}.warn{background:#fdf1d9;color:#7a4f00}
dl{display:grid;grid-template-columns:150px 1fr;gap:10px 12px;margin:0;font-size:15px}dt{color:#6b7280}dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
form{display:grid;gap:10px}label{font-size:13px;font-weight:600;color:#4b5563}input{font:inherit;font-size:16px;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;text-transform:uppercase}
button{font:inherit;font-weight:700;padding:12px;border-radius:10px;border:0;background:#a80e4d;color:#fff;cursor:pointer}.small{font-size:12.5px;color:#9aa3b2;margin-top:18px;text-align:center;line-height:1.6}
@media(max-width:480px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}}</style></head>
<body><img class="logo" src="/assets/fbi-logo.png" alt="FBI"><div class="brand">FBI GH • Official document verification</div><div class="card">${body}</div><div class="small">This is the official verification service of Film Beyond Imagination (FBI GH).<br><a href="https://fbigh.com">fbigh.com</a></div></body></html>`;
}
function formHtml(serial, code, msg) {
  return `${msg || ''}<h1>Verify a payslip</h1><p>Enter the payslip number and security code printed in the verification box at the bottom of the payslip.</p>
<form method="get" action="/"><label for="s">Payslip number</label><input id="s" name="s" value="${esc(serial || '')}" placeholder="FBI-PS-2026-000123" required autocomplete="off">
<label for="c">Security code</label><input id="c" name="c" value="${esc(code || '')}" placeholder="8 characters" required autocomplete="off"><button type="submit">Verify</button></form>`;
}

async function handleVerify(req, res, url, h) {
  const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }); res.end(html); };
  let fromPath = ''; try { fromPath = decodeURIComponent(url.pathname.replace(/^\/+/, '').replace(/^verify\/?/i, '').replace(/\/+$/, '')); } catch {}
  const serial = String(url.searchParams.get('s') || fromPath || '').trim().toUpperCase().slice(0, 40);
  const code = String(url.searchParams.get('c') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!serial && !code) return send(200, verifyPage(formHtml('', ''), 'Verify a payslip'));
  const ip = h.requestIp(req);
  if (tooMany(ip)) return send(429, verifyPage('<div class="st bad">Too many attempts</div><p>Please wait 15 minutes and try again.</p>', 'Verify a payslip'));
  const q = await h.pool.query('SELECT * FROM payslip_issues WHERE serial=$1', [serial]);
  const row = q.rows[0];
  const a = Buffer.from(String(row ? row.code : 'x'.repeat(8))), b = Buffer.from(code.padEnd(a.length, '#').slice(0, a.length));
  if (!row || !code || !crypto.timingSafeEqual(a, b) || code.length !== String(row.code).length) {
    noteFail(ip);
    return send(404, verifyPage(formHtml(serial, code, '<div class="st bad">✕ &nbsp;Not a genuine FBI payslip</div><p>No payslip matches this number and security code. Check what you typed. If it still fails, the payslip was not issued by Film Beyond Imagination.</p>'), 'Payslip not verified'));
  }
  const s = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot, f = s.figures;
  const newer = await h.pool.query('SELECT serial, issued_at FROM payslip_issues WHERE record_id=$1 AND issued_at>$2 ORDER BY issued_at DESC LIMIT 1', [row.record_id, row.issued_at]);
  const sup = newer.rows[0];
  const body = `<div class="st ok">✓ &nbsp;Genuine payslip issued by ${esc(s.company.name)}</div>
${sup ? `<div class="st warn" style="font-size:14px">An updated payslip (${esc(sup.serial)}) was issued later for the same work, for example after another payment. The figures below are as at ${esc(fmtDate(row.issued_at))}.</div>` : ''}
<p>Compare these figures with the paper or PDF copy. If anything differs, the copy has been altered.</p>
<dl><dt>Payslip no.</dt><dd>${esc(row.serial)}</dd><dt>Issued</dt><dd>${esc(fmtDate(row.issued_at))}</dd><dt>Employee</dt><dd>${esc(f.worker.name)}</dd><dt>Staff ID</dt><dd>${esc(f.worker.code || '\u2014')}</dd>
<dt>Role</dt><dd>${esc(f.worker.role || '—')}</dd><dt>Work date</dt><dd>${esc(f.work.date || '—')}</dd><dt>Project / event</dt><dd>${esc(f.work.project || '—')}</dd>
<dt>Gross pay</dt><dd>${money(f.gross)}</dd><dt>Net pay</dt><dd>${money(f.net)}</dd><dt>Amount paid</dt><dd>${money(f.paid)}</dd><dt>Balance due</dt><dd>${money(f.balance)}</dd>
<dt>Status</dt><dd>${esc(f.status)}</dd><dt>Fingerprint</dt><dd style="font-family:Consolas,monospace">${esc(row.fingerprint)}</dd></dl>`;
  return send(200, verifyPage(body, 'Payslip ' + row.serial + ' verified'));
}

function sendHtml(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(html); }

function hostOf(req) { return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, ''); }
function isLocalHost(h) { return !h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'; }

// verify.fbigh.com shows ONLY the verification service - nothing from the invoicing system.
async function handleVerifyHost(req, res, url, h) {
  if (hostOf(req) !== VERIFY_HOST) return false;
  const p = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('Method not allowed'); return true; }
  if (p === '/assets/fbi-logo.png') {
    try { const b = fs.readFileSync(LOGO_FILE); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); res.end(b); } catch { res.writeHead(404); res.end(); }
    return true;
  }
  if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /\n'); return true; }
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
  if (p === '/' || p === '/verify' || /^\/(verify\/)?FBI-PS-\d{4}-\d{1,9}\/?$/i.test(p)) { await handleVerify(req, res, url, h); return true; }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(verifyPage('<h1>Page not found</h1><p>This address only verifies FBI documents.</p><p><a href="/" style="color:#a80e4d;font-weight:700">Verify a payslip</a></p>', 'Not found'));
  return true;
}

// Admin: POST /api/payslips/issue {recordId} -> {serial, code, url}; GET /api/payslips/view?recordId=  -> payslip page
async function handleRoute(req, res, url, h) {
  const p = url.pathname;
  if (p === '/verify' && req.method === 'GET') {
    // Old-style links on the invoice address move to verify.fbigh.com (served directly when tested on this PC).
    if (isLocalHost(hostOf(req))) { await handleVerify(req, res, url, h); return true; }
    res.writeHead(301, { Location: VERIFY_BASE + '/' + (url.search || '') }); res.end(); return true;
  }
  if (!p.startsWith('/api/payslips/')) return false;
  const session = await h.requireAuth(req, res); if (!session) return true;
  try {
    if (p === '/api/payslips/issue' && req.method === 'POST') {
      const b = await h.parseJsonBody(req);
      const row = await issue(h.pool, String(b.recordId || ''), session.username || 'admin');
      h.json(res, 200, { ok: true, serial: row.serial, code: row.code, fingerprint: row.fingerprint, issuedAt: Number(row.issued_at), verifyUrl: verifyUrl(row) }); return true;
    }
    if (p === '/api/payslips/view' && req.method === 'GET') {
      const row = await issue(h.pool, String(url.searchParams.get('recordId') || ''), session.username || 'admin');
      sendHtml(res, payslipHtml(row, { closeButton: true })); return true;
    }
    h.json(res, 404, { ok: false, error: 'Not found.' }); return true;
  } catch (err) {
    h.json(res, err.status || 500, { ok: false, error: err.message || 'Payslip failed.' }); return true;
  }
}

module.exports = { ensureTables, issue, payslipHtml, handleRoute, handleVerifyHost, verifyUrl, qrSvg, figuresOf, VERIFY_HOST };
