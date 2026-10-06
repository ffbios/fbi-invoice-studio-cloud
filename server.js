const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'index.html');
const SEED_FILE = path.join(ROOT, 'seed-state.json');
const ARCHIVE_IMPORT_FILE = path.join(ROOT, 'archive-import.json');
const STATIC_FILES = {
  '/manifest.json': { file: path.join(ROOT, 'manifest.json'), type: 'application/manifest+json; charset=utf-8' },
  '/payroll-staff-form.html': { file: path.join(ROOT, 'payroll-staff-form.html'), type: 'text/html; charset=utf-8' },
  '/payroll-staff-portal.html': { file: path.join(ROOT, 'payroll-staff-portal.html'), type: 'text/html; charset=utf-8' },
  '/sw.js': { file: path.join(ROOT, 'sw.js'), type: 'application/javascript; charset=utf-8' },
  '/icons/icon-192.svg': { file: path.join(ROOT, 'icons', 'icon-192.svg'), type: 'image/svg+xml' },
  '/icons/icon-512.svg': { file: path.join(ROOT, 'icons', 'icon-512.svg'), type: 'image/svg+xml' },
  '/icons/icon-maskable-512.svg': { file: path.join(ROOT, 'icons', 'icon-maskable-512.svg'), type: 'image/svg+xml' },
  '/calendar.js': { file: path.join(ROOT, 'calendar.js'), type: 'application/javascript; charset=utf-8' },
  '/assets/fbi-brand-logo.svg': { file: path.join(ROOT, 'assets', 'fbi-brand-logo.svg'), type: 'image/svg+xml' },
  '/assets/fbi-logo.jpg': { file: path.join(ROOT, 'assets', 'fbi-logo.jpg'), type: 'image/jpeg' },
  '/icons/icon-192.png': { file: path.join(ROOT, 'icons', 'icon-192.png'), type: 'image/png' },
  '/icons/icon-512.png': { file: path.join(ROOT, 'icons', 'icon-512.png'), type: 'image/png' },
  '/icons/icon-maskable-512.png': { file: path.join(ROOT, 'icons', 'icon-maskable-512.png'), type: 'image/png' }
};
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? String(process.env.COOKIE_SECURE).toLowerCase() === 'true'
  : IS_PRODUCTION;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Create a PostgreSQL database and set DATABASE_URL before starting FBI Invoice Studio.');
  process.exit(1);
}

const dbConfig = process.env.PGHOST
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD
    }
  : { connectionString: process.env.DATABASE_URL };

const pool = new Pool({
  ...dbConfig,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function importArchiveState() {
  if (!fs.existsSync(ARCHIVE_IMPORT_FILE)) {
    console.warn('Archive import file is missing at ' + ARCHIVE_IMPORT_FILE);
    return;
  }

  try {
    const archive = JSON.parse(fs.readFileSync(ARCHIVE_IMPORT_FILE, 'utf8'));
    if (!archive || !Number(archive.version)) {
      console.warn('Archive import file is invalid or has no version.');
      return;
    }

    const archiveInvoices = Array.isArray(archive.invoices) ? archive.invoices : [];
    const archiveClients = Array.isArray(archive.clients) ? archive.clients : [];

    let result = await pool.query('SELECT state_json FROM app_state WHERE id=1');

    // If app_state is missing for any reason, rebuild a valid base state from seed
    // before applying the recovered records. Never delete an existing database row.
    if (!result.rows[0]) {
      if (!fs.existsSync(SEED_FILE)) {
        console.warn('Cannot repair app_state: seed-state.json is missing.');
        return;
      }
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (!seed || !seed.data || !Array.isArray(seed.data.data) || !Array.isArray(seed.data.clients) || !seed.data.settings) {
        console.warn('Cannot repair app_state: seed-state.json is invalid.');
        return;
      }
      await pool.query(
        'INSERT INTO app_state (id,version,saved_at,state_json) VALUES (1,$1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING',
        [Number(seed.version) || 1, Number(seed.savedAt) || Date.now(), JSON.stringify(seed)]
      );
      result = await pool.query('SELECT state_json FROM app_state WHERE id=1');
    }

    let state = result.rows[0]?.state_json;
    if (typeof state === 'string') state = JSON.parse(state);

    // Repair malformed/legacy state without discarding the database row.
    if (!state || !state.data || !Array.isArray(state.data.data) || !Array.isArray(state.data.clients) || !state.data.settings) {
      if (!fs.existsSync(SEED_FILE)) {
        console.warn('Cannot repair malformed app_state: seed-state.json is missing.');
        return;
      }
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (!seed || !seed.data || !Array.isArray(seed.data.data) || !Array.isArray(seed.data.clients) || !seed.data.settings) {
        console.warn('Cannot repair malformed app_state: seed-state.json is invalid.');
        return;
      }
      state = {
        version: Number(seed.version) || 1,
        savedAt: Number(seed.savedAt) || Date.now(),
        data: {
          data: [...seed.data.data],
          clients: [...seed.data.clients],
          settings: { ...seed.data.settings }
        }
      };
    }

    const beforeInvoices = state.data.data.length;
    const beforeClients = state.data.clients.length;

    for (const incoming of archiveClients) {
      const name = String(incoming.name || '').trim().toLowerCase();
      const phone = String(incoming.phone || '').replace(/\D/g, '');
      const exists = state.data.clients.some(c => {
        const cn = String(c.name || '').trim().toLowerCase();
        const cp = String(c.phone || '').replace(/\D/g, '');
        return (name && cn === name) || (phone && cp === phone);
      });
      if (!exists) state.data.clients.push(incoming);
    }

    for (const incoming of archiveInvoices) {
      const no = String(incoming.no || '').trim();
      const exists = state.data.data.some(x => String(x.no || '').trim() === no);
      if (!exists) state.data.data.push(incoming);
    }

    state.data.data.sort((a, b) => {
      const an = Number(String(a.no || '').replace(/\D/g, '')) || 0;
      const bn = Number(String(b.no || '').replace(/\D/g, '')) || 0;
      return bn - an;
    });

    const maxInvoiceNo = state.data.data.reduce((m, x) => {
      const n = Number(String(x.no || '').replace(/\D/g, '')) || 0;
      return Math.max(m, n);
    }, 0);
    state.data.settings.invoiceSequence = Math.max(
      Number(state.data.settings.invoiceSequence) || 1,
      maxInvoiceNo + 1
    );

    const invoicesAdded = state.data.data.length - beforeInvoices;
    const clientsAdded = state.data.clients.length - beforeClients;

    // Mark the archive as applied only after the recovered records are actually present.
    state.archiveImportVersion = Math.max(
      Number(state.archiveImportVersion) || 0,
      Number(archive.version)
    );
    state.savedAt = Date.now();

    await pool.query(
      'UPDATE app_state SET version=$1,saved_at=$2,state_json=$3::jsonb WHERE id=1',
      [Number(state.version) || 4, state.savedAt, JSON.stringify(state)]
    );

    console.log(
      `Archive recovery check complete: +${invoicesAdded} invoices, +${clientsAdded} clients; total ${state.data.data.length} invoices and ${state.data.clients.length} clients.`
    );
  } catch (err) {
    console.warn('Archive import could not be loaded:', err.message);
  }
}

async function initDb() {
  await ensureWhatsAppTables();
  await ensureSmsTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 1,
      saved_at BIGINT NOT NULL,
      state_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      security_q1 TEXT,
      security_a1_salt TEXT,
      security_a1_hash TEXT,
      security_q2 TEXT,
      security_a2_salt TEXT,
      security_a2_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
  `);

  await pool.query('CREATE TABLE IF NOT EXISTS payroll_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1, saved_at BIGINT NOT NULL, state_json JSONB NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS payroll_staff_registrations (id BIGSERIAL PRIMARY KEY,email TEXT NOT NULL UNIQUE,phone TEXT,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'pending\',worker_id TEXT,profile_json JSONB NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,reviewed_at BIGINT,reviewed_by TEXT)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_payroll_staff_registrations_status ON payroll_staff_registrations(status)');
  await pool.query('CREATE TABLE IF NOT EXISTS payroll_staff_sessions (token_hash TEXT PRIMARY KEY,registration_id BIGINT NOT NULL REFERENCES payroll_staff_registrations(id) ON DELETE CASCADE,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_payroll_staff_sessions_expires_at ON payroll_staff_sessions(expires_at)');
  await pool.query('ALTER TABLE app_state ADD COLUMN IF NOT EXISTS draft_saved_at BIGINT');
  await pool.query('ALTER TABLE app_state ADD COLUMN IF NOT EXISTS draft_json JSONB');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_q1 TEXT');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_a1_salt TEXT');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_a1_hash TEXT');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_q2 TEXT');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_a2_salt TEXT');
  await pool.query('ALTER TABLE auth_account ADD COLUMN IF NOT EXISTS security_a2_hash TEXT');

  const state = await pool.query('SELECT id FROM app_state WHERE id=1');
  if (state.rowCount === 0 && process.env.SEED_ON_EMPTY !== 'false' && fs.existsSync(SEED_FILE)) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (seed && seed.data && Array.isArray(seed.data.data) && Array.isArray(seed.data.clients) && seed.data.settings) {
        await pool.query(
          `INSERT INTO app_state (id, version, saved_at, state_json) VALUES (1,$1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`,
          [Number(seed.version) || 1, Number(seed.savedAt) || Date.now(), JSON.stringify(seed)]
        );
      }
    } catch (err) {
      console.warn('Seed state could not be loaded:', err.message);
    }
  }
  // Load the recovered archive after the empty database has been seeded.
  // This keeps the recovered invoices/clients available on a fresh cloud database.
  await importArchiveState();
}

function json(res, status, body, extraHeaders = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(raw);
}

function sendStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry || !fs.existsSync(entry.file)) return false;
  const stat = fs.statSync(entry.file);
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': stat.size,
    'Cache-Control': pathname === '/sw.js' || pathname === '/payroll-staff-form.html' || pathname === '/payroll-staff-portal.html' ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(entry.file).pipe(res);
  return true;
}

function sendPublicBusinessPage(res, kind) {
  const pages = {
    business: {
      title: 'Film Beyond Imagination | Business Information',
      body: `
        <main>
          <h1>Film Beyond Imagination</h1>
          <p class="lead">Creative media, live production, streaming and technology services in Accra, Ghana.</p>
          <section><h2>Services</h2><p>Photography, Videography, Live Production, Live Streaming, IT Services, Computer Networking and CCTV/Smart Security Solutions.</p></section>
          <section><h2>Business Contact</h2><p>Phone: <a href="tel:+233257407350">+233 25 740 7350</a><br>Email: <a href="mailto:filmbyfbi@gmail.com">filmbyfbi@gmail.com</a><br>Location: Accra, Ghana</p></section>
          <section><h2>WhatsApp</h2><p>Business WhatsApp: +233 25 740 7350</p></section>
        </main>`
    },
    privacy: {
      title: 'Film Beyond Imagination | Privacy Policy',
      body: `
        <main><h1>Privacy Policy</h1><p>Film Beyond Imagination uses information provided by customers and authorized business users to deliver invoicing, communications and related business services.</p><p>For the WhatsApp integration, business and invoice information may be processed to deliver authorized transactional notifications. Access tokens and other authentication secrets are stored server-side and are not intentionally exposed in the public application interface.</p><p>Contact: <a href="mailto:filmbyfbi@gmail.com">filmbyfbi@gmail.com</a></p></main>`
    },
    terms: {
      title: 'Film Beyond Imagination | Terms of Service',
      body: `
        <main><h1>Terms of Service</h1><p>Use of Film Beyond Imagination's online services is subject to lawful and authorized business use. Users are responsible for the accuracy of information they enter and for keeping their account credentials secure.</p><p>Services may include invoicing, client records, business communications and related media/technology workflows.</p><p>Contact: <a href="mailto:filmbyfbi@gmail.com">filmbyfbi@gmail.com</a></p></main>`
    }
  };
  const page=pages[kind]||pages.business;
  const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Film Beyond Imagination business information, services and contact details."><title>'+page.title+'</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#0b0b0d;color:#f6f6f6;line-height:1.6}header{padding:28px 20px;border-bottom:1px solid #29292d}header strong{font-size:20px;color:#d8b44a}main{max-width:820px;margin:0 auto;padding:44px 20px}h1{font-size:38px;margin:0 0 12px;color:#fff}h2{margin-top:34px;color:#d8b44a}.lead{font-size:20px;color:#cfcfd4}section{padding:4px 0}a{color:#e1bd58;text-decoration:none}footer{max-width:820px;margin:0 auto;padding:25px 20px 50px;color:#92929a;font-size:13px}</style></head><body><header><strong>FILM BEYOND IMAGINATION</strong></header>'+page.body+'<footer>© '+new Date().getFullYear()+' Film Beyond Imagination · Accra, Ghana · <a href="/business">Business</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer></body></html>';
  const raw=Buffer.from(html,'utf8');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':raw.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(raw);
}

function smsPageAssets() {
  return "<style id=\"fbi-sms-style\">\n.fbi-sms-view{padding-bottom:40px}\n.fbi-sms-top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}\n.fbi-sms-top h2{margin:0;font-size:20px}.fbi-sms-top p{margin:6px 0 0;color:#7e8796;font-size:11px}\n.fbi-sms-eyebrow{font-size:9px;letter-spacing:1.4px;color:#e63d7e;font-weight:900;text-transform:uppercase}\n.fbi-sms-actions{display:flex;gap:8px;flex-wrap:wrap}\n.fbi-sms-gateway-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;margin-bottom:14px;background:linear-gradient(180deg,#171b23,#11151b);border:1px solid #343b49;border-radius:12px;padding:14px 16px}.fbi-sms-gateway-main{display:flex;align-items:center;gap:12px;min-width:0}.fbi-sms-gateway-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#0d1117;border:1px solid #394151;font-size:18px}.fbi-sms-gateway-title{font-size:12px;font-weight:900;color:#f2f4f7}.fbi-sms-gateway-sub{margin-top:4px;color:#7f8999;font-size:9px;line-height:1.5}.fbi-sms-gateway-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:7px}.fbi-sms-gateway-meta span{border:1px solid #303744;background:#0c1016;border-radius:999px;padding:4px 7px;color:#b2bbc8;font-size:8px}.fbi-sms-gateway-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.fbi-sms-gateway-actions .btn{min-width:110px}.fbi-sms-gateway-status{display:inline-flex;align-items:center;gap:6px;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.5px}.fbi-sms-gateway-status .dot{width:7px;height:7px;border-radius:50%;background:#697384}.fbi-sms-gateway-status.online{color:#63e5a3}.fbi-sms-gateway-status.online .dot{background:#43d18b;box-shadow:0 0 9px #43d18b66}.fbi-sms-gateway-status.offline{color:#f2c15d}.fbi-sms-gateway-status.offline .dot{background:#d5a52b}.fbi-sms-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,.75fr);gap:14px}\n.fbi-sms-card{background:linear-gradient(180deg,#171b23,#13161d);border:1px solid #2b303c;border-radius:12px;padding:16px}\n.fbi-sms-card h3{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:#e63d7e}\n.fbi-sms-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}\n.fbi-sms-stat{background:#0f1218;border:1px solid #2b303c;border-radius:10px;padding:11px}.fbi-sms-stat span{display:block;color:#7e8796;font-size:8px;text-transform:uppercase}.fbi-sms-stat b{display:block;margin-top:5px;font-size:18px}.fbi-sms-stat .good{color:#63e5a3}\n.fbi-sms-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid #2b303c;padding-bottom:8px}\n.fbi-sms-tab{border:1px solid #303642;background:#0d1016;color:#aeb6c4;border-radius:8px;padding:8px 12px;font-size:10px;font-weight:800}.fbi-sms-tab.active{background:#a80e4d;color:#fff;border-color:#bd1b63}\n.fbi-sms-row{display:flex;gap:9px}.fbi-sms-row>*{flex:1}\n.fbi-sms-template-bar{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}\n.fbi-sms-template{font-size:9px;padding:7px 9px;border:1px solid #353c49;background:#0e1117;color:#c9d0db;border-radius:7px}\n.fbi-sms-count{display:flex;justify-content:space-between;gap:10px;margin-top:6px;color:#717b8a;font-size:9px}\n.fbi-sms-preview{margin-top:12px;background:#0c0f14;border:1px solid #2a303b;border-radius:10px;padding:13px}\n.fbi-sms-preview-label{font-size:8px;color:#6e7787;text-transform:uppercase;margin-bottom:7px}\n.fbi-sms-bubble{background:#1b222d;border-radius:4px 12px 12px 12px;padding:11px 12px;color:#eef2f7;font-size:11px;line-height:1.5;max-width:92%;white-space:pre-wrap}\n.fbi-sms-audience-options{display:grid;gap:8px;margin:11px 0}.fbi-sms-radio{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #2c333e;background:#0f1218;border-radius:8px;color:#c6cdd7;font-size:10px}.fbi-sms-radio input{width:auto;margin:0}\n.fbi-sms-client-list{max-height:330px;overflow:auto;border:1px solid #2b303c;border-radius:9px;background:#0c0f14}\n.fbi-sms-client{display:flex;align-items:center;gap:8px;padding:8px 9px;border-bottom:1px solid #222832}.fbi-sms-client input[type=checkbox]{width:auto}.fbi-sms-client .grow{min-width:0;flex:1}.fbi-sms-client b{display:block;font-size:10px;color:#edf0f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fbi-sms-client small{display:block;color:#70798a;font-size:8px;margin-top:2px}.fbi-sms-client .tag{font-size:7px;color:#63e5a3;padding:3px 5px;border-radius:999px;background:#123325}.fbi-sms-client .tag.blocked{color:#ff9aa8;background:#35161f}\n.fbi-sms-history-table{width:100%;border-collapse:collapse;min-width:760px;font-size:9px}.fbi-sms-history-table th{padding:8px;text-align:left;color:#737c8b;font-size:8px;text-transform:uppercase;border-bottom:1px solid #303642}.fbi-sms-history-table td{padding:9px 8px;border-bottom:1px solid #242a34;vertical-align:top}.fbi-sms-history-table td.num{text-align:right}\n.fbi-sms-pill{display:inline-flex;padding:4px 7px;border-radius:999px;font-size:7px;font-weight:900;text-transform:uppercase}.fbi-sms-pill.completed{background:#163126;color:#63e5a3}.fbi-sms-pill.partial{background:#382b13;color:#f2c15d}.fbi-sms-pill.failed{background:#3b1820;color:#ff8e9e}.fbi-sms-pill.ready{background:#163126;color:#63e5a3}\n.fbi-sms-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#8d96a5;font-size:9px}.fbi-sms-dot{width:8px;height:8px;border-radius:50%;background:#5a6575}.fbi-sms-dot.on{background:#43d18b;box-shadow:0 0 10px #43d18b66}\n.fbi-sms-empty{padding:30px;text-align:center;color:#6f7887;font-size:10px}.fbi-sms-warning{margin-top:12px;padding:10px 11px;border-radius:9px;border:1px solid #5a4721;background:#211b0f;color:#d7c28b;font-size:9px;line-height:1.5}.fbi-sms-confirm{display:flex;gap:8px;align-items:flex-start;margin-top:10px;color:#9aa3b1;font-size:9px;line-height:1.45}.fbi-sms-confirm input{width:auto;margin-top:2px}\n@media(max-width:980px){.fbi-sms-grid{grid-template-columns:1fr}.fbi-sms-stats{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.fbi-sms-top{flex-direction:column}.fbi-sms-row{flex-direction:column}.fbi-sms-stats{grid-template-columns:1fr 1fr}}\n</style>\n<script>\n(function(){\n'use strict';\nvar S={clients:[],campaigns:[],status:null,tab:'compose'};\nvar CUSTOMER='Happy Customer Service Week from Film Beyond Imagination! Thank you for trusting us. We are happy to serve you and share our services. Have a question or inquiry? Please contact us anytime. We look forward to going the extra mile for you. - FBI';\nfunction esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[c];});}\nasync function api(path,opts){var o=opts||{},h=Object.assign({'Content-Type':'application/json'},o.headers||{});var r=await fetch(path,Object.assign({credentials:'same-origin',headers:h},o));var d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error(d.error||'Request failed');return d;}\nfunction V(){return document.getElementById('view-sms');}function N(){return document.getElementById('fbiSmsNav');}\nfunction openSms(){document.querySelectorAll('.view').forEach(function(x){x.classList.remove('active');});var v=V();if(v)v.classList.add('active');var n=N();if(n)n.classList.add('active');var h=document.querySelector('.top h1');if(h)h.textContent='SMS Command Center';loadSms();}\nfunction addNav(){var nav=document.querySelector('.nav');if(!nav||N())return;var b=document.createElement('button');b.type='button';b.id='fbiSmsNav';b.className='nav-link';b.textContent='SMS Center';b.onclick=function(e){e.preventDefault();e.stopPropagation();openSms();};nav.appendChild(b);}\nfunction addView(){if(V())return;var main=document.querySelector('.main');if(!main)return;var v=document.createElement('section');v.id='view-sms';v.className='view fbi-sms-view';main.appendChild(v);}\nfunction render(){var v=V();if(!v)return;var s=S.status||{},cc=s.clientCounts||{},t=s.totals||{},g=s.gateway||{},online=!!g.online,hasGateway=!!g.gatewayId,lastSeen=g.lastSeen?new Date(Number(g.lastSeen)).toLocaleString():'Never';v.innerHTML='<div class=\"fbi-sms-top\"><div><div class=\"fbi-sms-eyebrow\">CLIENT COMMUNICATIONS</div><h2>SMS Command Center</h2><p>Send a single message or broadcast directly from the Invoice Studio client database.</p></div><div class=\"fbi-sms-actions\"><button class=\"btn\" id=\"fbiSmsRefresh\">Refresh</button></div></div><div id=\"fbiSmsStats\" class=\"fbi-sms-stats\"><div class=\"fbi-sms-stat\"><span>Clients</span><b>'+Number(cc.total||0)+'</b></div><div class=\"fbi-sms-stat\"><span>SMS-ready</span><b>'+Number(cc.eligible||0)+'</b></div><div class=\"fbi-sms-stat\"><span>Accepted</span><b class=\"good\">'+Number(t.sent||0)+'</b></div><div class=\"fbi-sms-stat\"><span>Delivered</span><b class=\"good\">'+Number(t.delivered||0)+'</b></div></div><div class=\"fbi-sms-status\"><span class=\"fbi-sms-dot '+(online?'on':'')+'\"></span><b style=\"color:#fff\">'+(online?'SMS gateway online':(hasGateway?'SMS gateway offline':'SMS gateway not paired'))+'</b><span>Gateway: '+esc(String(g.gatewayName||s.provider||'FBI Private SMS Gateway'))+'</span><span>SIM Line: '+esc(g.simLine||s.senderId||'Private SIM line')+'</span><span>'+Number(cc.eligible||0)+' eligible clients</span></div><div style=\"height:12px\"></div><div class=\"fbi-sms-gateway-card\"><div><div class=\"fbi-sms-gateway-main\"><div class=\"fbi-sms-gateway-icon\">SMS</div><div><div class=\"fbi-sms-gateway-title\">FBI PRIVATE SMS GATEWAY</div><div class=\"fbi-sms-gateway-sub\">This is the Android phone connected to Invoice Studio. It sends queued messages through the SIM installed in the gateway phone.</div><div class=\"fbi-sms-gateway-meta\"><span>'+esc(g.gatewayName||'Phone not paired')+'</span><span>'+esc(g.simLine||s.senderId||'SIM line not reported')+'</span><span>Last seen: '+esc(lastSeen)+'</span><span>Mode: '+esc(String(s.provider||'SELF-HOSTED-GSM').toUpperCase())+'</span></div></div></div></div><div class=\"fbi-sms-gateway-actions\"><div class=\"fbi-sms-gateway-status '+(online?'online':'offline')+'\"><i class=\"dot\"></i>'+(online?'Gateway Online':(hasGateway?'Gateway Offline':'Phone Not Paired'))+'</div><button class=\"btn primary\" id=\"fbiSmsPairGateway\">'+(hasGateway?'Pair / Replace Phone':'Pair This Phone')+'</button></div></div><div class=\"fbi-sms-tabs\"><button class=\"fbi-sms-tab '+(S.tab==='compose'?'active':'')+'\" data-tab=\"compose\">Compose</button><button class=\"fbi-sms-tab '+(S.tab==='history'?'active':'')+'\" data-tab=\"history\">Campaign History</button><button class=\"fbi-sms-tab '+(S.tab==='clients'?'active':'')+'\" data-tab=\"clients\">Client SMS Status</button></div><div id=\"fbiSmsBody\"></div>';document.getElementById('fbiSmsRefresh').onclick=loadSms;document.getElementById('fbiSmsPairGateway').onclick=function(){window.open('/sms-gateway-pair','_blank');};document.querySelectorAll('.fbi-sms-tab').forEach(function(b){b.onclick=function(){S.tab=this.getAttribute('data-tab');render();renderBody();};});renderBody();}\nfunction renderBody(){var b=document.getElementById('fbiSmsBody');if(!b)return;if(S.tab==='history')renderHistory(b);else if(S.tab==='clients')renderClients(b);else renderComposer(b);}\nfunction template(t){if(t==='customer')return CUSTOMER;if(t==='thank')return 'Thank you for choosing Film Beyond Imagination. We truly appreciate your continued support. Please contact us anytime for photography, videography, live production, streaming or technology services. - FBI';return 'Hello from Film Beyond Imagination. We are checking in to see how we can support your next project. Please contact us with any questions or enquiries. - FBI';}\nfunction selectedKeys(){return Array.from(document.querySelectorAll('.fbi-sms-client input[data-key]:checked')).map(function(x){return x.getAttribute('data-key');});}function mode(){var x=document.querySelector('input[name=fbiSmsMode]:checked');return x?x.value:'all';}\nfunction renderList(){var box=document.getElementById('fbiSmsClientList');if(!box)return;var q=String((document.getElementById('fbiSmsSearch')||{}).value||'').toLowerCase();var list=S.clients.filter(function(c){return !q||(c.name||'').toLowerCase().includes(q)||(c.company||'').toLowerCase().includes(q)||(c.phone||'').toLowerCase().includes(q);});var keep=new Set(selectedKeys());box.innerHTML=list.length?list.map(function(c){return '<label class=\"fbi-sms-client\"><input type=\"checkbox\" data-key=\"'+esc(c.key)+'\"'+(keep.has(c.key)?' checked':'')+'><span class=\"grow\"><b>'+esc(c.name)+'</b><small>'+esc([c.company,c.phone||'No phone',c.email].filter(Boolean).join(' · '))+'</small></span><span class=\"tag '+(c.optedOut?'blocked':'')+'\">'+(c.optedOut?'SMS BLOCKED':'SMS READY')+'</span></label>';}).join(''):'<div class=\"fbi-sms-empty\">No matching clients.</div>';updateCount();}\nfunction updateCount(){var m=mode(),n=0,b=0;if(m==='all'){n=Number(S.status?.clientCounts?.eligible||0);b=Number(S.status?.clientCounts?.blocked||0);}else{var map={};S.clients.forEach(function(c){map[c.key]=c;});selectedKeys().forEach(function(k){var c=map[k];if(!c)return;if(c.optedOut)b++;else if(c.normalizedPhone)n++;});}var x=document.getElementById('fbiSmsAudienceCount');if(x)x.textContent=n+' eligible recipient'+(n===1?'':'s')+(b?' · '+b+' blocked':'');}\nfunction renderComposer(body){body.innerHTML='<div class=\"fbi-sms-grid\"><div class=\"fbi-sms-card\"><h3>Compose Message</h3><div class=\"fbi-sms-template-bar\"><button class=\"fbi-sms-template\" data-t=\"customer\">Customer Service Week</button><button class=\"fbi-sms-template\" data-t=\"thank\">Thank You</button><button class=\"fbi-sms-template\" data-t=\"follow\">Project Follow-up</button></div><div class=\"fbi-sms-row\"><div><label>Campaign Name</label><input id=\"fbiSmsCampaignName\" value=\"Customer Service Week 2026\"></div><div><label>Sender ID</label><input value=\"'+esc(S.status?.senderId||'-')+'\" readonly></div></div><label>Message</label><textarea id=\"fbiSmsMessage\" rows=\"9\" maxlength=\"1000\"></textarea><div class=\"fbi-sms-count\"><span id=\"fbiSmsCharCount\"></span><span>Plain text uses fewer SMS segments. Your private gateway handles the actual SIM delivery.</span></div><div class=\"fbi-sms-preview\"><div class=\"fbi-sms-preview-label\">Client Preview</div><div class=\"fbi-sms-bubble\" id=\"fbiSmsPreview\"></div></div><div class=\"fbi-sms-warning\"><strong>Bulk SMS:</strong> use this only for recipients who are permitted to receive the message. Blocked clients are automatically excluded.</div><label class=\"fbi-sms-confirm\"><input type=\"checkbox\" id=\"fbiSmsConfirm\"><span>I confirm that this campaign is appropriate for the selected recipients and that required permission/consent has been obtained where applicable.</span></label><div class=\"fbi-sms-actions\" style=\"margin-top:12px\"><button class=\"btn primary\" id=\"fbiSmsSend\">Send SMS Campaign</button></div></div><div class=\"fbi-sms-card\"><h3>Audience</h3><div class=\"fbi-sms-audience-options\"><label class=\"fbi-sms-radio\"><input type=\"radio\" name=\"fbiSmsMode\" value=\"all\" checked> All clients with a valid phone number</label><label class=\"fbi-sms-radio\"><input type=\"radio\" name=\"fbiSmsMode\" value=\"selected\"> Selected clients only</label></div><div class=\"fbi-sms-row\"><div><label>Search clients</label><input id=\"fbiSmsSearch\" placeholder=\"Search name, company or phone\"></div><div><label>Test Number</label><input id=\"fbiSmsTestNumber\" placeholder=\"024... or +233...\"></div></div><div class=\"fbi-sms-actions\" style=\"margin:10px 0\"><button class=\"btn\" id=\"fbiSmsSelectAll\">Select All Visible</button><button class=\"btn\" id=\"fbiSmsClear\">Clear</button><button class=\"btn\" id=\"fbiSmsTest\">Send Test SMS</button></div><div id=\"fbiSmsAudienceCount\" style=\"margin-bottom:7px;color:#8d96a5;font-size:9px\"></div><div id=\"fbiSmsClientList\" class=\"fbi-sms-client-list\"></div></div></div>';var msg=document.getElementById('fbiSmsMessage'),prev=document.getElementById('fbiSmsPreview'),cnt=document.getElementById('fbiSmsCharCount');msg.value=CUSTOMER;function update(){var v=msg.value||'',u=/[^\\x00-\\x7F]/.test(v),size=u?70:160,p=v?Math.ceil(v.length/size):0;cnt.textContent=v.length+' characters · '+p+' SMS part'+(p===1?'':'s')+(u?' · Unicode mode':'');prev.textContent=v||'Your message preview will appear here';}msg.oninput=update;update();document.querySelectorAll('.fbi-sms-template').forEach(function(b){b.onclick=function(){msg.value=template(this.getAttribute('data-t'));update();};});document.getElementById('fbiSmsSearch').oninput=renderList;document.querySelectorAll('input[name=fbiSmsMode]').forEach(function(r){r.onchange=updateCount;});document.getElementById('fbiSmsClientList').onchange=updateCount;document.getElementById('fbiSmsSelectAll').onclick=function(){document.querySelectorAll('.fbi-sms-client input[data-key]').forEach(function(x){x.checked=true;});updateCount();};document.getElementById('fbiSmsClear').onclick=function(){document.querySelectorAll('.fbi-sms-client input[data-key]').forEach(function(x){x.checked=false;});updateCount();};document.getElementById('fbiSmsTest').onclick=sendTest;document.getElementById('fbiSmsSend').onclick=sendCampaign;renderList();}\nasync function sendTest(){var phone=String((document.getElementById('fbiSmsTestNumber')||{}).value||'').trim(),msg=String((document.getElementById('fbiSmsMessage')||{}).value||'').trim();if(!phone||!msg){alert('Enter the test number and message.');return;}if(!confirm('Send a test SMS to '+phone+'?'))return;try{var d=await api('/api/sms/test',{method:'POST',body:JSON.stringify({phone:phone,message:msg,campaignName:(document.getElementById('fbiSmsCampaignName')||{}).value||'SMS Test'})});alert(d.message||'Test SMS queued.');await loadSms();}catch(e){alert(e.message);}}\nasync function sendCampaign(){var msg=String((document.getElementById('fbiSmsMessage')||{}).value||'').trim(),name=String((document.getElementById('fbiSmsCampaignName')||{}).value||'').trim(),m=mode(),keys=selectedKeys(),count=parseInt(String((document.getElementById('fbiSmsAudienceCount')||{}).textContent||'0'),10)||0,ok=document.getElementById('fbiSmsConfirm');if(!msg){alert('Enter a message first.');return;}if(!count){alert('There are no eligible recipients in this audience.');return;}if(!ok||!ok.checked){alert('Please confirm the campaign recipient permission/consent before sending.');return;}if(!confirm('Send this SMS campaign to '+count+' eligible recipient'+(count===1?'':'s')+'?'))return;var btn=document.getElementById('fbiSmsSend');btn.disabled=true;try{var d=await api('/api/sms/send',{method:'POST',body:JSON.stringify({campaignName:name,message:msg,mode:m,clientKeys:keys,confirmMarketing:true})});alert((d.message||'Campaign sent.')+'\\nAccepted: '+d.accepted+'\\nFailed: '+d.failed+(d.skipped?'\\nBlocked/skipped: '+d.skipped:''));S.tab='history';await loadSms();}catch(e){alert(e.message);}finally{btn.disabled=false;}}\nfunction renderHistory(body){body.innerHTML='<div class=\"fbi-sms-card\"><h3>Campaign History</h3><p style=\"color:#7e8796;font-size:10px\">Campaigns and recipient results are stored in PostgreSQL. SMS is sent through your private GSM gateway, not a third-party SMS provider.</p><div style=\"overflow:auto\"><table class=\"fbi-sms-history-table\"><thead><tr><th>Date</th><th>Campaign</th><th>SIM Line</th><th>Total</th><th>Accepted</th><th>Delivered</th><th>Failed</th><th>Status</th></tr></thead><tbody>'+(S.campaigns.length?S.campaigns.map(function(c){return '<tr><td>'+esc(new Date(Number(c.created_at)).toLocaleString('en-GH',{timeZone:'Africa/Accra'}))+'</td><td><b>'+esc(c.name)+'</b><div style=\"margin-top:4px;color:#70798a;max-width:360px;white-space:pre-wrap\">'+esc(String(c.message||'').slice(0,140))+'</div></td><td>'+esc(c.sender||'')+'</td><td class=\"num\">'+Number(c.total_recipients||0)+'</td><td class=\"num\">'+Number(c.accepted_count||0)+'</td><td class=\"num\">'+Number(c.delivered_count||0)+'</td><td class=\"num\">'+Number(c.failed_count||0)+'</td><td><span class=\"fbi-sms-pill '+esc(c.status||'')+'\">'+esc(c.status||'')+'</span></td></tr>';}).join(''):'<tr><td colspan=\"8\" class=\"fbi-sms-empty\">No SMS campaigns yet.</td></tr>')+'</tbody></table></div></div>';}\nfunction renderClients(body){body.innerHTML='<div class=\"fbi-sms-card\"><h3>Client SMS Status</h3><p style=\"color:#7e8796;font-size:10px\">This table is read directly from Invoice Studio client records. New phone numbers appear automatically.</p><div style=\"overflow:auto\"><table class=\"fbi-sms-history-table\"><thead><tr><th>Client</th><th>Phone</th><th>Email</th><th>Status</th><th>Action</th></tr></thead><tbody>'+(S.clients.length?S.clients.map(function(c){return '<tr><td><b>'+esc(c.name)+'</b>'+(c.company?'<div style=\"margin-top:3px;color:#6f7887\">'+esc(c.company)+'</div>':'')+'</td><td>'+esc(c.phone||'Not provided')+'</td><td>'+esc(c.email||'')+'</td><td>'+(c.normalizedPhone?(c.optedOut?'<span class=\"fbi-sms-pill failed\">blocked</span>':'<span class=\"fbi-sms-pill ready\">ready</span>'):'No phone')+'</td><td>'+(c.normalizedPhone?'<button class=\"btn\" data-block=\"'+esc(c.normalizedPhone)+'\">'+(c.optedOut?'Allow SMS':'Block SMS')+'</button>':'')+'</td></tr>';}).join(''):'<tr><td colspan=\"5\" class=\"fbi-sms-empty\">No clients found.</td></tr>')+'</tbody></table></div></div>';body.querySelectorAll('[data-block]').forEach(function(b){b.onclick=async function(){var phone=this.getAttribute('data-block'),c=S.clients.find(function(x){return x.normalizedPhone===phone;});if(!c)return;var block=!c.optedOut;if(!confirm((block?'Block ':'Allow ')+'SMS for '+c.name+'?'))return;try{await api('/api/sms/opt-out',{method:'POST',body:JSON.stringify({phone:phone,blocked:block})});await loadSms();}catch(e){alert(e.message);}};});}\nasync function loadSms(){try{var p=await Promise.all([api('/api/sms/status'),api('/api/sms/clients'),api('/api/sms/campaigns')]);S.status=p[0];S.clients=p[1].clients||[];S.campaigns=p[2].campaigns||[];render();}catch(e){var v=V();if(v)v.innerHTML='<div class=\"fbi-sms-card\"><h2>SMS Command Center</h2><p>Unable to load SMS data.</p><div class=\"fbi-sms-note\"><strong>SMS gateway module error:</strong> '+esc(e.message)+'</div></div>';}}\nfunction boot(){addNav();addView();}\nif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();\n})();\n</script>";
}
async function sendIndex(res) {
  try {
    // Inject the authoritative PostgreSQL state into the initial HTML.
    // This removes the last client-side race: the app has its records before
    // any startup renderer, service worker, or async fetch can run.
    const stateResult = await pool.query('SELECT version,saved_at,state_json FROM app_state WHERE id=1');
    let state = stateResult.rows[0]?.state_json || null;
    if (typeof state === 'string') {
      try { state = JSON.parse(state); } catch { state = null; }
    }

    let html = fs.readFileSync(INDEX_FILE, 'utf8');
    html = html.replace('</head>', "<style id=\"fbi-auth-style\">\nbody.fbi-auth-pending{overflow:hidden}\n#fbiAuthGate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(circle at 50% 10%,#202634 0%,#08090c 60%);font-family:Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",Arial,sans-serif;color:#f7f8fb}\n#fbiAuthGate[hidden]{display:none}\n.fbi-auth-card{width:min(430px,100%);max-height:calc(100vh - 40px);overflow:auto;background:linear-gradient(180deg,#151a23,#0d1016);border:1px solid #303746;border-radius:24px;box-shadow:0 30px 80px #0009;padding:28px}\n.fbi-auth-brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.fbi-auth-brand img{width:46px;height:46px;object-fit:contain}.fbi-auth-brand strong{display:block;font-size:15px;letter-spacing:1.5px}.fbi-auth-brand span{display:block;color:#9099a9;font-size:11px;margin-top:3px;letter-spacing:1px}\n.fbi-auth-card h1{margin:0 0 7px;font-size:27px}.fbi-auth-card p{color:#9ba4b3;font-size:13px;line-height:1.5;margin:0 0 20px}\n.fbi-auth-form{display:grid;gap:12px}.fbi-auth-label{display:grid;gap:6px;color:#b4bdcb;font-size:12px;font-weight:700}.fbi-auth-label input,.fbi-auth-label select{width:100%;border:1px solid #323a49;background:#0b0e14;color:#f7f8fb;border-radius:12px;padding:13px 14px;outline:none}.fbi-auth-label input:focus,.fbi-auth-label select:focus{border-color:#c71954;box-shadow:0 0 0 3px #c7195422}\n.fbi-auth-primary{border:0;border-radius:12px;padding:13px 16px;background:#c71954;color:#fff;font-weight:800}.fbi-auth-primary:disabled{opacity:.6}.fbi-auth-secondary{border:1px solid #343b49;border-radius:12px;padding:12px 16px;background:#151a22;color:#e8ebf1;font-weight:700}.fbi-auth-links{display:flex;justify-content:flex-end;margin-top:2px}.fbi-auth-link{border:0;background:none;color:#d6dbe4;padding:4px 0;font-size:12px;text-decoration:underline}.fbi-auth-error{min-height:18px;color:#ff8aa9;font-size:12px}.fbi-auth-note{padding:11px 12px;border-radius:11px;background:#111722;border:1px solid #293141;color:#8f99aa;font-size:11px;line-height:1.5}\n@media(max-width:480px){.fbi-auth-card{padding:22px;border-radius:20px}}\n</style>\n<div id=\"fbiAuthGate\">\n<div class=\"fbi-auth-card\">\n<div class=\"fbi-auth-brand\"><img src=\"/assets/fbi-brand-logo.svg\" alt=\"FBI\"><div><strong>FBI INVOICE STUDIO</strong><span>ADMINISTRATOR ACCESS</span></div></div>\n<div id=\"fbiAuthContent\"></div>\n</div>\n</div>\n<script>\n(function(){\ndocument.body.classList.add('fbi-auth-pending');\nvar gate=document.getElementById('fbiAuthGate'),root=document.getElementById('fbiAuthContent');\nvar questions=[\"What was the name of your first school?\",\"What is the middle name of your mother?\",\"What was the name of your childhood best friend?\",\"What city were you born in?\",\"What was the name of your first pet?\",\"What was your childhood nickname?\",\"What was the first car you or your family owned?\",\"What is the name of the street where you grew up?\"];\nfunction esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[c];});}\nasync function api(path,options){var o=options||{};var r=await fetch(path,Object.assign({credentials:'same-origin',headers:Object.assign({'Content-Type':'application/json'},o.headers||{})},o));var d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error(d.error||'Request failed');return d;}\nfunction finish(){gate.hidden=true;document.body.classList.remove('fbi-auth-pending');window.dispatchEvent(new CustomEvent('fbi-authenticated'));}\nfunction showLogin(message){\nroot.innerHTML='<h1>Administrator Sign In</h1><p>Sign in to access your invoices, clients, receipts, payroll and business records.</p><form id=\"fbiLogin\" class=\"fbi-auth-form\"><label class=\"fbi-auth-label\">Username<input name=\"username\" autocomplete=\"username\" required></label><label class=\"fbi-auth-label\">Password<input type=\"password\" name=\"password\" autocomplete=\"current-password\" required></label><div class=\"fbi-auth-error\">'+esc(message||'')+'</div><button type=\"submit\" class=\"fbi-auth-primary\">Sign in</button><div class=\"fbi-auth-links\"><button type=\"button\" class=\"fbi-auth-link\" id=\"fbiForgot\">Forgot password?</button></div></form>';\ndocument.getElementById('fbiLogin').onsubmit=async function(e){e.preventDefault();var f=new FormData(e.currentTarget),btn=e.currentTarget.querySelector('button[type=\"submit\"]');btn.disabled=true;try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:f.get('username'),password:f.get('password')})});finish();}catch(err){showLogin(err.message);}};\ndocument.getElementById('fbiForgot').onclick=showResetStart;\n}\nfunction showSetup(message){\nroot.innerHTML='<h1>Create Administrator Account</h1><p>Create the administrator account that will control FBI Invoice Studio. This is a one-time setup.</p><form id=\"fbiSetup\" class=\"fbi-auth-form\"><label class=\"fbi-auth-label\">Administrator username<input name=\"username\" autocomplete=\"username\" minlength=\"3\" required></label><label class=\"fbi-auth-label\">Password<input type=\"password\" name=\"password\" autocomplete=\"new-password\" minlength=\"8\" required></label><label class=\"fbi-auth-label\">Confirm password<input type=\"password\" name=\"confirmPassword\" autocomplete=\"new-password\" minlength=\"8\" required></label><div class=\"fbi-auth-note\">Choose two different security questions and answers you will remember. Avoid answers that other people can easily guess.</div><label class=\"fbi-auth-label\">Security question 1<select name=\"securityQuestion1\" required>'+questions.map(function(q){return '<option>'+esc(q)+'</option>';}).join('')+'</select></label><label class=\"fbi-auth-label\">Answer 1<input name=\"securityAnswer1\" autocomplete=\"off\" required></label><label class=\"fbi-auth-label\">Security question 2<select name=\"securityQuestion2\" required>'+questions.map(function(q,i){return '<option '+(i===1?'selected':'')+'>'+esc(q)+'</option>';}).join('')+'</select></label><label class=\"fbi-auth-label\">Answer 2<input name=\"securityAnswer2\" autocomplete=\"off\" required></label><div class=\"fbi-auth-error\">'+esc(message||'')+'</div><button type=\"submit\" class=\"fbi-auth-primary\">Create administrator account</button></form>';\ndocument.getElementById('fbiSetup').onsubmit=async function(e){e.preventDefault();var f=new FormData(e.currentTarget),btn=e.currentTarget.querySelector('button[type=\"submit\"]');btn.disabled=true;try{await api('/api/auth/setup',{method:'POST',body:JSON.stringify(Object.fromEntries(f.entries()))});finish();}catch(err){showSetup(err.message);}};\n}\nasync function showResetStart(){\nroot.innerHTML='<h1>Reset Administrator Password</h1><p>Enter your administrator username. Your saved security questions will then appear.</p><form id=\"fbiResetStart\" class=\"fbi-auth-form\"><label class=\"fbi-auth-label\">Username<input name=\"username\" autocomplete=\"username\" required></label><div class=\"fbi-auth-error\"></div><button type=\"submit\" class=\"fbi-auth-primary\">Continue</button><button type=\"button\" class=\"fbi-auth-secondary\" id=\"fbiBackLogin\">Back to sign in</button></form>';\ndocument.getElementById('fbiBackLogin').onclick=function(){showLogin('');};\ndocument.getElementById('fbiResetStart').onsubmit=async function(e){e.preventDefault();var f=new FormData(e.currentTarget),box=e.currentTarget.querySelector('.fbi-auth-error');try{var d=await api('/api/auth/recovery-questions?username='+encodeURIComponent(f.get('username')));showResetForm(String(f.get('username')),d.questions);}catch(err){box.textContent=err.message;}};\n}\nfunction showResetForm(username,qs){\nroot.innerHTML='<h1>Verify Your Identity</h1><p>Answer both security questions, then choose a new password.</p><form id=\"fbiReset\" class=\"fbi-auth-form\"><label class=\"fbi-auth-label\">Username<input name=\"username\" value=\"'+esc(username)+'\" readonly></label><label class=\"fbi-auth-label\">'+esc(qs[0])+'<input name=\"securityAnswer1\" autocomplete=\"off\" required></label><label class=\"fbi-auth-label\">'+esc(qs[1])+'<input name=\"securityAnswer2\" autocomplete=\"off\" required></label><label class=\"fbi-auth-label\">New password<input type=\"password\" name=\"newPassword\" autocomplete=\"new-password\" minlength=\"8\" required></label><label class=\"fbi-auth-label\">Confirm new password<input type=\"password\" name=\"confirmPassword\" autocomplete=\"new-password\" minlength=\"8\" required></label><div class=\"fbi-auth-error\"></div><button type=\"submit\" class=\"fbi-auth-primary\">Reset password</button><button type=\"button\" class=\"fbi-auth-secondary\" id=\"fbiBackLogin\">Back to sign in</button></form>';\ndocument.getElementById('fbiBackLogin').onclick=function(){showLogin('');};\ndocument.getElementById('fbiReset').onsubmit=async function(e){e.preventDefault();var f=new FormData(e.currentTarget),box=e.currentTarget.querySelector('.fbi-auth-error');if(f.get('newPassword')!==f.get('confirmPassword')){box.textContent='Passwords do not match.';return;}try{await api('/api/auth/reset',{method:'POST',body:JSON.stringify({username:f.get('username'),securityAnswer1:f.get('securityAnswer1'),securityAnswer2:f.get('securityAnswer2'),newPassword:f.get('newPassword')})});finish();}catch(err){box.textContent=err.message;}};\n}\nasync function boot(){\ntry{var d=await api('/api/auth/status');if(d.authenticated){finish();return;}if(!d.accountExists){showSetup('');}else{showLogin('');}}\ncatch(err){root.innerHTML='<h1>Authentication unavailable</h1><p>FBI Invoice Studio could not verify the administrator session. Please refresh and try again.</p><div class=\"fbi-auth-error\">'+esc(err.message)+'</div>';}\n}\nboot();\n})();\n</script>" + '</head>');
    if (state && state.data && Array.isArray(state.data.data) && Array.isArray(state.data.clients)) {
      const safeState = JSON.stringify(state)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      const boot = '<script>window.__FBI_SERVER_STATE__=' + safeState + ';</script>';
      html = html.replace('</head>', boot + '</head>');
    }

    html = html.replace('</head>', smsPageAssets() + '</head>');
    const raw = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': raw.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(raw);
  } catch (err) {
    console.error('Index render failed:', err);
    // Serve the static shell rather than taking the whole app down.
    const raw = fs.readFileSync(INDEX_FILE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': raw.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(raw);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = 25 * 1024 * 1024;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); }
  catch { throw new Error('Invalid JSON request.'); }
}

function normalizeUsername(value) { return String(value || '').trim(); }

function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function hashRecovery(code) {
  return crypto.createHash('sha256')
    .update(String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase())
    .digest('base64');
}

const SECURITY_QUESTIONS = [
  'What was the name of your first school?',
  'What is the middle name of your mother?',
  'What was the name of your childhood best friend?',
  'What city were you born in?',
  'What was the name of your first pet?',
  'What was your childhood nickname?',
  'What was the first car you or your family owned?',
  'What is the name of the street where you grew up?'
];

function normalizeSecurityAnswer(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashSecurityAnswer(answer, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalizeSecurityAnswer(answer), salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifySecurityAnswer(answer, saltB64, expectedHash) {
  if (!saltB64 || !expectedHash) return false;
  return safeEqualB64(hashSecurityAnswer(answer, saltB64).hash, expectedHash);
}

function safeEqualB64(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'base64');
    const bb = Buffer.from(String(b || ''), 'base64');
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}

function generateRecoveryCode() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return raw.match(/.{1,4}/g).join('-');
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch {}
  }
  return out;
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function setSessionCookie(res, token) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fbi_invoice_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fbi_invoice_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

async function purgeSessions() {
  await pool.query('DELETE FROM auth_sessions WHERE expires_at <= $1', [Date.now()]);
}

async function currentSession(req) {
  await purgeSessions();
  const token = parseCookies(req).fbi_invoice_session;
  if (!token) return null;
  const { rows } = await pool.query('SELECT username, expires_at FROM auth_sessions WHERE token_hash=$1', [sessionTokenHash(token)]);
  const row = rows[0];
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  return { username: row.username, tokenHash: sessionTokenHash(token) };
}

async function createLoginSession(username, res) {
  await purgeSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await pool.query(
    'INSERT INTO auth_sessions (token_hash, username, created_at, expires_at) VALUES ($1,$2,$3,$4)',
    [sessionTokenHash(token), username, now, now + SESSION_TTL_MS]
  );
  setSessionCookie(res, token);
}

function validateCredentials(username, password) {
  if (username.length < 3 || username.length > 80) return 'Username must contain 3 to 80 characters.';
  if (String(password || '').length < 8) return 'Password must contain at least 8 characters.';
  return null;
}

async function getAccount() {
  const { rows } = await pool.query('SELECT username,password_salt,password_hash,recovery_hash,security_q1,security_a1_salt,security_a1_hash,security_q2,security_a2_salt,security_a2_hash,created_at,updated_at FROM auth_account WHERE id=1');
  return rows[0] || null;
}

async function requireAuth(req, res) {
  const session = await currentSession(req);
  if (!session) {
    json(res, 401, { ok: false, error: 'Administrator authentication required.' });
    return null;
  }
  return session;
}

async function handleAuthStatus(req, res) {
  const account = await getAccount();
  const session = await currentSession(req);
  return json(res, 200, {
    ok: true,
    accountExists: !!account,
    loginRequired: true,
    authenticated: !!session,
    username: session?.username || null,
    securityQuestionsConfigured: !!(account?.security_q1 && account?.security_a1_hash && account?.security_q2 && account?.security_a2_hash)
  });
}

async function handleAuthMe(req, res) {
  const session = await currentSession(req);
  if (!session) return json(res, 401, { ok: false, authenticated: false });
  return json(res, 200, { ok: true, authenticated: true, username: session.username });
}

async function handleAuthSetup(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [492011]);
    const existing = await client.query('SELECT id FROM auth_account WHERE id=1');
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return json(res, 409, { ok: false, error: 'An administrator account already exists. Please sign in.' });
    }
    const body = await parseJsonBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const confirm = String(body.confirmPassword || '');
    const validation = validateCredentials(username, password);
    if (validation) {
      await client.query('ROLLBACK');
      return json(res, 400, { ok: false, error: validation });
    }
    if (password !== confirm) {
      await client.query('ROLLBACK');
      return json(res, 400, { ok: false, error: 'Passwords do not match.' });
    }
    const securityQ1 = String(body.securityQuestion1 || '').trim();
    const securityA1 = String(body.securityAnswer1 || '');
    const securityQ2 = String(body.securityQuestion2 || '').trim();
    const securityA2 = String(body.securityAnswer2 || '');
    if (!SECURITY_QUESTIONS.includes(securityQ1) || !SECURITY_QUESTIONS.includes(securityQ2) || securityQ1 === securityQ2) {
      await client.query('ROLLBACK');
      return json(res, 400, { ok: false, error: 'Choose two different security questions.' });
    }
    if (normalizeSecurityAnswer(securityA1).length < 2 || normalizeSecurityAnswer(securityA2).length < 2) {
      await client.query('ROLLBACK');
      return json(res, 400, { ok: false, error: 'Both security answers are required.' });
    }
    const hp = hashPassword(password);
    const ha1 = hashSecurityAnswer(securityA1);
    const ha2 = hashSecurityAnswer(securityA2);
    const now = new Date().toISOString();
    await client.query(
      'INSERT INTO auth_account (id,username,password_salt,password_hash,recovery_hash,security_q1,security_a1_salt,security_a1_hash,security_q2,security_a2_salt,security_a2_hash,created_at,updated_at) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [username, hp.salt, hp.hash, hashRecovery(generateRecoveryCode()), securityQ1, ha1.salt, ha1.hash, securityQ2, ha2.salt, ha2.hash, now, now]
    );
    await client.query('COMMIT');
    await createLoginSession(username, res);
    return json(res, 200, { ok: true, username });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Account setup failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Account creation failed.' });
  } finally { client.release(); }
}

async function handleAuthLogin(req, res) {
  try {
    const account = await getAccount();
    if (!account) return json(res, 404, { ok: false, error: 'No administrator account exists yet. Create your account first.' });
    const body = await parseJsonBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const validation = validateCredentials(username, password);
    if (validation) return json(res, 400, { ok: false, error: validation });
    const supplied = hashPassword(password, account.password_salt).hash;
    if (username.toLowerCase() !== String(account.username).toLowerCase() || !safeEqualB64(supplied, account.password_hash)) {
      return json(res, 401, { ok: false, error: 'Invalid username or password.' });
    }
    await createLoginSession(account.username, res);
    return json(res, 200, { ok: true, username: account.username });
  } catch (err) {
    console.error('Login failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Authentication could not be completed.' });
  }
}

async function handleAuthLogout(req, res) {
  const token = parseCookies(req).fbi_invoice_session;
  if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [sessionTokenHash(token)]);
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}
async function handleAuthRecoveryQuestions(res) {
  const account = await getAccount();
  if (!account) return json(res, 404, { ok: false, error: 'No administrator account exists yet.' });
  if (!account.security_q1 || !account.security_q2 || !account.security_a1_hash || !account.security_a2_hash) {
    return json(res, 409, { ok: false, error: 'Security questions have not been configured for this administrator account.' });
  }
  return json(res, 200, { ok: true, questions: [account.security_q1, account.security_q2] });
}

async function handleAuthReset(req, res) {
  try {
    const account = await getAccount();
    if (!account) return json(res, 404, { ok: false, error: 'No administrator account exists.' });
    const body = await parseJsonBody(req);
    const username = normalizeUsername(body.username);
    const answer1 = String(body.securityAnswer1 || '');
    const answer2 = String(body.securityAnswer2 || '');
    const newPassword = String(body.newPassword || '');
    if (username.toLowerCase() !== String(account.username).toLowerCase() ||
        !verifySecurityAnswer(answer1, account.security_a1_salt, account.security_a1_hash) ||
        !verifySecurityAnswer(answer2, account.security_a2_salt, account.security_a2_hash)) {
      return json(res, 401, { ok: false, error: 'The username or security answers are incorrect.' });
    }
    if (newPassword.length < 8) return json(res, 400, { ok: false, error: 'Password must contain at least 8 characters.' });
    const hp = hashPassword(newPassword);
    await pool.query(
      'UPDATE auth_account SET password_salt=$1,password_hash=$2,updated_at=$3 WHERE id=1',
      [hp.salt, hp.hash, new Date().toISOString()]
    );
    await pool.query('DELETE FROM auth_sessions WHERE username=$1', [account.username]);
    await createLoginSession(account.username, res);
    return json(res, 200, { ok: true, username: account.username });
  } catch (err) {
    console.error('Password reset failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Password reset failed.' });
  }
}

async function handleStateGet(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  const { rows } = await pool.query('SELECT version,saved_at,state_json FROM app_state WHERE id=1');
  if (!rows[0]) return json(res, 200, { ok: true, state: null });
  let state = rows[0].state_json;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { return json(res, 500, { ok: false, error: 'Stored database record is invalid.' }); }
  }
  return json(res, 200, { ok: true, state });
}

function mergeInvoiceStates(existingState, incomingState) {
  const existingData = existingState && existingState.data && Array.isArray(existingState.data.data)
    ? existingState.data.data : [];
  const incomingData = incomingState.data.data;

  const invoiceMap = new Map();
  for (const item of existingData) {
    const key = String(item.id || item.no || ('existing-' + invoiceMap.size));
    invoiceMap.set(key, item);
  }
  for (const item of incomingData) {
    const key = String(item.id || item.no || ('incoming-' + invoiceMap.size));
    const existing = invoiceMap.get(key);
    if (!existing) {
      invoiceMap.set(key, item);
    } else {
      const existingJobStamp = Date.parse(String(existing.jobStatusUpdatedAt || '')) || 0;
      const incomingJobStamp = Date.parse(String(item.jobStatusUpdatedAt || '')) || 0;
      const mergedItem = { ...existing, ...item };
      if (existingJobStamp > incomingJobStamp) {
        if (Object.prototype.hasOwnProperty.call(existing, 'jobStatus')) mergedItem.jobStatus = existing.jobStatus;
        else delete mergedItem.jobStatus;
        if (Object.prototype.hasOwnProperty.call(existing, 'jobCompletedDate')) mergedItem.jobCompletedDate = existing.jobCompletedDate;
        else delete mergedItem.jobCompletedDate;
        mergedItem.jobStatusUpdatedAt = existing.jobStatusUpdatedAt;
      }
      invoiceMap.set(key, mergedItem);
    }
  }

  const existingClients = existingState && existingState.data && Array.isArray(existingState.data.clients)
    ? existingState.data.clients : [];
  const incomingClients = incomingState.data.clients;
  const clientMap = new Map();
  function clientKey(item) {
    const id = String(item.id || '').trim();
    if (id) return 'id:' + id;
    const name = String(item.name || '').trim().toLowerCase();
    const phone = String(item.phone || '').replace(/\D/g, '');
    return 'contact:' + name + '|' + phone;
  }
  for (const item of existingClients) clientMap.set(clientKey(item), item);
  for (const item of incomingClients) clientMap.set(clientKey(item), item);

  const deletedInvoiceIds = new Set(
    Array.isArray(incomingState.deletedInvoiceIds)
      ? incomingState.deletedInvoiceIds.map(v => String(v || '').trim()).filter(Boolean)
      : []
  );
  if (deletedInvoiceIds.size) {
    for (const [key, item] of invoiceMap) {
      const id = String(item.id || '').trim();
      const no = String(item.no || '').trim();
      if (deletedInvoiceIds.has(id) || deletedInvoiceIds.has(no)) invoiceMap.delete(key);
    }
  }

  const deletedClientIds = new Set(
    Array.isArray(incomingState.deletedClientIds)
      ? incomingState.deletedClientIds.map(v => String(v || '').trim()).filter(Boolean)
      : []
  );
  if (deletedClientIds.size) {
    for (const [key, item] of clientMap) {
      const id = String(item.id || '').trim();
      if (deletedClientIds.has(id)) clientMap.delete(key);
    }
  }

  const existingSettings = existingState && existingState.data && existingState.data.settings
    ? existingState.data.settings : {};

  return {
    version: Math.max(Number(existingState?.version) || 1, Number(incomingState.version) || 1),
    savedAt: Math.max(Number(existingState?.savedAt) || 0, Number(incomingState.savedAt) || 0, Date.now()),
    data: {
      data: Array.from(invoiceMap.values()),
      clients: Array.from(clientMap.values()),
      settings: { ...existingSettings, ...incomingState.data.settings }
    }
  };
}

async function handleStateWrite(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  try {
    const raw = await readBody(req);
    const incoming = JSON.parse(raw || '{}');
    if (!incoming || !incoming.data || !Array.isArray(incoming.data.data) || !Array.isArray(incoming.data.clients) || !incoming.data.settings) {
      return json(res, 400, { ok: false, error: 'Invalid Invoice Studio state.' });
    }

    const previousResult = await pool.query('SELECT state_json FROM app_state WHERE id=1');
    let previousState = previousResult.rows[0]?.state_json || null;
    if (typeof previousState === 'string') { try { previousState = JSON.parse(previousState); } catch { previousState = null; } }

    const currentResult = await pool.query('SELECT version,saved_at,state_json FROM app_state WHERE id=1');
    let merged = incoming;
    if (currentResult.rows[0]) {
      let currentState = currentResult.rows[0].state_json;
      if (typeof currentState === 'string') currentState = JSON.parse(currentState);
      if (currentState && currentState.data) {
        merged = mergeInvoiceStates(currentState, incoming);
      }
    }

    await pool.query(
      `INSERT INTO app_state (id,version,saved_at,state_json) VALUES (1,$1,$2,$3::jsonb)
       ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state_json=EXCLUDED.state_json`,
      [Number(merged.version) || 1, Number(merged.savedAt) || Date.now(), JSON.stringify(merged)]
    );

    await notifyInvoiceStateChanges(previousState, merged, 'Admin/Portal state sync');

    return json(res, 200, {
      ok: true,
      savedAt: Number(merged.savedAt) || Date.now(),
      invoiceCount: merged.data.data.length,
      clientCount: merged.data.clients.length
    });
  } catch (err) {
    console.error('Database write failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Database write failed.' });
  }
}


function mergePayrollStates(existingState, incomingState) {
  const existing = existingState && typeof existingState === 'object' ? existingState : {};
  const incoming = incomingState && typeof incomingState === 'object' ? incomingState : {};
  function stamp(v) { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0; }
  function mergeById(existingArr, incomingArr, mergeOne) {
    const map = new Map();
    for (const item of Array.isArray(existingArr) ? existingArr : []) {
      const key = String(item && item.id || '').trim();
      if (key) map.set(key, item);
    }
    for (const item of Array.isArray(incomingArr) ? incomingArr : []) {
      const key = String(item && item.id || '').trim();
      if (!key) continue;
      map.set(key, map.has(key) ? mergeOne(map.get(key), item) : item);
    }
    return Array.from(map.values());
  }
  function mergeWorker(a, b) {
    const newer = stamp(b.updatedAt) >= stamp(a.updatedAt) ? b : a;
    const older = newer === b ? a : b;
    return { ...older, ...newer, id: a.id || b.id, updatedAt: new Date(Math.max(stamp(a.updatedAt), stamp(b.updatedAt), Date.now() - 86400000)).toISOString() };
  }
  function mergeRecord(a, b) {
    const newer = stamp(b.updatedAt) >= stamp(a.updatedAt) ? b : a;
    const older = newer === b ? a : b;
    const paymentMap = new Map();
    for (const p of Array.isArray(a.payments) ? a.payments : []) {
      const key = String(p && p.id || p && p.reference || '').trim();
      if (key) paymentMap.set(key, p);
    }
    for (const p of Array.isArray(b.payments) ? b.payments : []) {
      const key = String(p && p.id || p && p.reference || '').trim();
      if (!key) continue;
      if (!paymentMap.has(key)) paymentMap.set(key, p);
      else {
        const oldP = paymentMap.get(key);
        paymentMap.set(key, stamp(p.date) >= stamp(oldP.date) ? { ...oldP, ...p } : { ...p, ...oldP });
      }
    }
    const merged = { ...older, ...newer, id: a.id || b.id };
    merged.payments = Array.from(paymentMap.values());
    if (merged.payments.length) {
      merged.payments.sort((x,y) => String(x.date || '').localeCompare(String(y.date || '')) || String(x.id || '').localeCompare(String(y.id || '')));
      const last = merged.payments[merged.payments.length - 1];
      merged.lastPaymentDate = last.date || merged.lastPaymentDate || '';
      merged.lastPaymentMethod = last.method || merged.lastPaymentMethod || '';
      merged.lastPaymentReference = last.reference || merged.lastPaymentReference || '';
      merged.lastPaidBy = last.paidBy || merged.lastPaidBy || '';
    }
    merged.updatedAt = new Date(Math.max(stamp(a.updatedAt), stamp(b.updatedAt), Date.now() - 86400000)).toISOString();
    return merged;
  }
  function mergePayslip(a, b) {
    const newer = stamp(b.generatedAt) >= stamp(a.generatedAt) ? b : a;
    const older = newer === b ? a : b;
    return { ...older, ...newer, id: a.id || b.id };
  }
  return {
    version: Math.max(Number(existing.version) || 1, Number(incoming.version) || 1),
    savedAt: Math.max(Number(existing.savedAt) || 0, Number(incoming.savedAt) || 0, Date.now()),
    workers: mergeById(existing.workers, incoming.workers, mergeWorker),
    records: mergeById(existing.records, incoming.records, mergeRecord),
    payslips: mergeById(existing.payslips, incoming.payslips, mergePayslip)
  };
}

async function handlePayrollStateGet(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  const { rows } = await pool.query('SELECT version,saved_at,state_json FROM payroll_state WHERE id=1');
  if (!rows[0]) return json(res, 200, { ok: true, state: null });
  let state = rows[0].state_json;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { return json(res, 500, { ok: false, error: 'Stored payroll record is invalid.' }); }
  }
  return json(res, 200, { ok: true, state });
}

async function handlePayrollStateWrite(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  const client = await pool.connect();
  try {
    const incoming = await parseJsonBody(req);
    if (!incoming || !Array.isArray(incoming.workers) || !Array.isArray(incoming.records) || !Array.isArray(incoming.payslips)) {
      return json(res, 400, { ok: false, error: 'Invalid Payroll state.' });
    }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [492012]);
    const currentResult = await client.query('SELECT version,saved_at,state_json FROM payroll_state WHERE id=1 FOR UPDATE');
    let current = null;
    if (currentResult.rows[0]) {
      current = currentResult.rows[0].state_json;
      if (typeof current === 'string') current = JSON.parse(current);
    }
    const merged = mergePayrollStates(current || {workers:[],records:[],payslips:[]}, incoming);
    const deletedWorkers = new Set((incoming.deletedWorkerIds || []).map(v => String(v || '').trim()).filter(Boolean));
    const deletedRecords = new Set((incoming.deletedRecordIds || []).map(v => String(v || '').trim()).filter(Boolean));
    const deletedPayslips = new Set((incoming.deletedPayslipIds || []).map(v => String(v || '').trim()).filter(Boolean));
    merged.workers = merged.workers.filter(w => !deletedWorkers.has(String(w.id || '')));
    merged.records = merged.records.filter(r => !deletedRecords.has(String(r.id || '')));
    merged.payslips = merged.payslips.filter(p => !deletedPayslips.has(String(p.id || '')));
    await client.query(
      `INSERT INTO payroll_state (id,version,saved_at,state_json) VALUES (1,$1,$2,$3::jsonb)
       ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state_json=EXCLUDED.state_json`,
      [Number(merged.version) || 1, Number(merged.savedAt) || Date.now(), JSON.stringify(merged)]
    );
    await client.query('COMMIT');
    return json(res, 200, { ok: true, savedAt: Number(merged.savedAt) || Date.now(), workerCount: merged.workers.length, recordCount: merged.records.length, payslipCount: merged.payslips.length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Payroll database write failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Payroll database write failed.' });
  } finally {
    client.release();
  }
}

function textFieldValue(lines, labels) {
  const lowerLabels = labels.map(x => String(x).toLowerCase());
  for (let i=0;i<lines.length;i++) {
    const line = lines[i].trim();
    const low = line.toLowerCase();
    for (const label of lowerLabels) {
      if (low === label || low === label + ':') {
        const next = String(lines[i+1] || '').trim();
        if (next && !lowerLabels.includes(next.toLowerCase().replace(/:$/,''))) return next;
      }
      if (low.startsWith(label + ':')) {
        const v = line.slice(label.length + 1).trim();
        if (v) return v;
      }
      const sep = low.indexOf(label + ' - ');
      if (sep === 0) return line.slice(label.length + 3).trim();
    }
  }
  return '';
}
function parsePayrollWorkerText(rawText) {
  const text = String(rawText || '').replace(/\u00a0/g,' ').replace(/\r/g,'');
  const lines = text.split(/\n+/).map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const get = (...labels) => textFieldValue(lines, labels);
  const email = get('email','email address') || ((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0] || '');
  const phones = text.match(/(?:\+233|0)\s?\d{2,3}[\s-]?\d{3}[\s-]?\d{3,4}/g) || [];
  const phone = get('phone number','phone','mobile number','mobile') || phones[0] || '';
  let paymentMethod = get('preferred payment method','payment method');
  if (!paymentMethod) {
    const low = text.toLowerCase();
    if (low.includes('mobile money') || low.includes('momo')) paymentMethod='Mobile Money';
    else if (low.includes('bank')) paymentMethod='Bank';
    else if (low.includes('cash')) paymentMethod='Cash';
  }
  return {
    workerCode:get('staff / worker id','staff id','worker id','employee id','employee number'),
    name:get('full name','employee name','staff name','name'),
    phone,
    email,
    address:get('residential address','home address','address'),
    role:get('role / job title','job title','role','position'),
    department:get('department','division','team'),
    workerType:get('worker type','employment type','employee type'),
    paymentMethod:paymentMethod || '',
    momo:get('momo number','mobile money number','momo'),
    bank:get('bank name','bank'),
    accountName:get('account name','account holder name'),
    accountNumber:get('account number','bank account number'),
    idRef:get('ghana card / id reference','ghana card','national id','id number'),
    emergency:get('emergency / contact person','emergency contact','next of kin name'),
    emergencyPhone:get('emergency phone','emergency contact phone','next of kin phone'),
    status:get('current status','status') || 'Active',
    notes:get('notes','additional information'),
    dateOfBirth:get('date of birth','dob'),
    gender:get('gender'),
    maritalStatus:get('marital status'),
    dateJoined:get('date joined','date of joining','employment start date'),
    tin:get('tin','tax identification number'),
    ssnit:get('ssnit','ssnit number'),
    nextOfKin:get('next of kin','next-of-kin')
  };
}

async function handlePayrollPdfImport(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  try {
    const body = await parseJsonBody(req);
    const b64 = String(body && body.data || '').replace(/^data:application\/pdf;base64,/i,'').trim();
    if (!b64) return json(res, 400, { ok: false, error: 'No PDF data was supplied.' });
    const approxBytes = Math.floor(b64.length * 3 / 4);
    if (approxBytes > 15 * 1024 * 1024) return json(res, 413, { ok: false, error: 'PDF is larger than 15 MB.' });
    const buffer = Buffer.from(b64,'base64');
    if (buffer.length < 4 || buffer.subarray(0,4).toString('ascii') !== '%PDF') return json(res, 400, { ok: false, error: 'The uploaded file is not a valid PDF.' });
    const { CanvasFactory } = require('pdf-parse/worker');
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer, CanvasFactory });
    const result = await parser.getText();
    await parser.destroy();
    let extractedText = String(result.text || '');
    const worker = parsePayrollWorkerText(extractedText);
    // PDFs generated by the FBI Staff Registration Form include a print-only
    // import page marked FBI-PAYROLL-PDF-V1. Chromium can reorder extracted text,
    // so explicitly recover the Full Name from that block when necessary.
    if (!worker.name && /FBI-PAYROLL-PDF-V1/i.test(extractedText)) {
      const marker = extractedText.split(/FBI-PAYROLL-PDF-V1/i)[1] || '';
      const lines = marker.split(/\r?\n/).map(v => String(v).trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/^[-•·\s]+/,'').trim();
        if (/^full name\s*:?\s*(.+)$/i.test(line)) {
          worker.name = line.replace(/^full name\s*:?\s*/i,'').trim();
          break;
        }
        if (/^full name\s*:?$/i.test(line)) {
          const next = String(lines[i + 1] || '').trim();
          if (next && !/^(staff \/ worker id|phone number|email)\s*:?$/i.test(next)) {
            worker.name = next.replace(/\s+/g,' ').trim();
            break;
          }
        }
      }
    }
    if (!worker.name && body && body.filename) {
      const filename = String(body.filename).replace(/\\.[^.]+$/, '');
      const m = filename.match(/FBI[- _]Payroll[- _]Staff[- _](.+)$/i);
      if (m && m[1]) {
        const candidate = m[1].replace(/[-_]+/g,' ').replace(/\\s+/g,' ').trim();
        if (candidate && !/^(form|registration|staff)$/i.test(candidate)) worker.name = candidate;
      }
    }

    if (!worker.name) {
      return json(res, 422, { ok: false, error: 'The PDF was read, but a Full Name could not be detected. Please generate a fresh PDF from the FBI Staff Registration Form and save it as PDF before importing.', extractedText: extractedText.slice(0,12000) });
    }
    return json(res, 200, { ok: true, worker, pages: result.total || null });
  } catch (err) {
    console.error('Payroll PDF import failed:', err);
    return json(res, 422, { ok: false, error: err.message || 'The PDF could not be read. Try a text-based PDF.' });
  }
}


function normalizePayrollStaffEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizePayrollStaffPhone(value) { return String(value || '').replace(/\D/g, '').slice(0,20); }
function validPayrollStaffEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function payrollStaffCookie(res,token,maxAge=43200){const secure=COOKIE_SECURE?'; Secure':'';res.setHeader('Set-Cookie','fbi_payroll_staff_session='+encodeURIComponent(token)+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+maxAge+secure);}
function clearPayrollStaffCookie(res){const secure=COOKIE_SECURE?'; Secure':'';res.setHeader('Set-Cookie','fbi_payroll_staff_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'+secure);}
async function getPayrollStaffRegistration(email){const q=await pool.query('SELECT * FROM payroll_staff_registrations WHERE email=$1',[normalizePayrollStaffEmail(email)]);return q.rows[0]||null;}
async function currentPayrollStaffSession(req){const t=parseCookies(req).fbi_payroll_staff_session;if(!t)return null;await pool.query('DELETE FROM payroll_staff_sessions WHERE expires_at<=$1',[Date.now()]);const q=await pool.query('SELECT registration_id,expires_at FROM payroll_staff_sessions WHERE token_hash=$1 AND expires_at>$2',[sessionTokenHash(t),Date.now()]);return q.rows[0]||null;}
async function createPayrollStaffSession(registrationId,res){const t=crypto.randomBytes(32).toString('base64url'),n=Date.now();await pool.query('INSERT INTO payroll_staff_sessions(token_hash,registration_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[sessionTokenHash(t),registrationId,n,n+43200000]);payrollStaffCookie(res,t);}
function payrollStaffProfile(w){return {id:w.id,workerCode:w.workerCode||'',name:w.name||'',phone:w.phone||'',email:w.email||w.portalEmail||'',address:w.address||'',role:w.role||'',department:w.department||'',workerType:w.workerType||'',paymentMethod:w.paymentMethod||'',momo:w.momo||'',bank:w.bank||'',accountName:w.accountName||'',accountNumber:w.accountNumber||'',idRef:w.idRef||'',dateOfBirth:w.dateOfBirth||'',gender:w.gender||'',maritalStatus:w.maritalStatus||'',dateJoined:w.dateJoined||'',tin:w.tin||'',ssnit:w.ssnit||'',nextOfKin:w.nextOfKin||'',emergency:w.emergency||'',emergencyPhone:w.emergencyPhone||'',status:w.status||'Active',notes:w.notes||''};}
async function readPayrollStateForStaff(workerId,db=pool){const q=await db.query('SELECT state_json FROM payroll_state WHERE id=1');let state=q.rows[0]?.state_json||null;if(typeof state==='string'){try{state=JSON.parse(state)}catch{state=null}}if(!state||!Array.isArray(state.workers)||!Array.isArray(state.records)||!Array.isArray(state.payslips))state={version:1,savedAt:Date.now(),workers:[],records:[],payslips:[]};const worker=state.workers.find(w=>String(w.id||'')===String(workerId||''))||null;return {state,worker};}
async function requirePayrollStaff(req,res){const session=await currentPayrollStaffSession(req);if(!session){json(res,401,{ok:false,error:'Please sign in to the Payroll Staff Portal.'});return null;}const q=await pool.query('SELECT * FROM payroll_staff_registrations WHERE id=$1',[session.registration_id]);const registration=q.rows[0]||null;if(!registration){clearPayrollStaffCookie(res);json(res,401,{ok:false,error:'Payroll staff account not found.'});return null;}if(registration.status!=='approved'||!registration.worker_id){clearPayrollStaffCookie(res);json(res,403,{ok:false,status:registration.status,error:registration.status==='pending'?'Your staff registration is awaiting administrator approval.':'Your staff registration is not active.'});return null;}const {state,worker}=await readPayrollStateForStaff(registration.worker_id);if(!worker){json(res,409,{ok:false,error:'Your approved staff profile is not available in Payroll.'});return null;}return {session,registration,state,worker};}
async function handlePayrollStaffRegister(req,res){try{const b=await parseJsonBody(req),name=String(b.name||'').trim(),email=normalizePayrollStaffEmail(b.email),phone=normalizePayrollStaffPhone(b.phone),password=String(b.password||''),confirm=String(b.confirmPassword||'');if(name.length<2)return json(res,400,{ok:false,error:'Full name is required.'});if(!validPayrollStaffEmail(email))return json(res,400,{ok:false,error:'Enter a valid email address.'});if(password.length<8)return json(res,400,{ok:false,error:'Password must contain at least 8 characters.'});if(password!==confirm)return json(res,400,{ok:false,error:'Passwords do not match.'});const profile={workerCode:String(b.workerCode||'').trim(),name,phone,email,address:String(b.address||'').trim(),role:String(b.role||'').trim(),department:String(b.department||'Other').trim()||'Other',workerType:String(b.workerType||'Media Worker').trim()||'Media Worker',paymentMethod:String(b.paymentMethod||'Mobile Money').trim()||'Mobile Money',momo:String(b.momo||'').trim(),bank:String(b.bank||'').trim(),accountName:String(b.accountName||'').trim(),accountNumber:String(b.accountNumber||'').trim(),idRef:String(b.idRef||'').trim(),dateOfBirth:String(b.dateOfBirth||'').trim(),gender:String(b.gender||'').trim(),maritalStatus:String(b.maritalStatus||'').trim(),dateJoined:String(b.dateJoined||'').trim(),tin:String(b.tin||'').trim(),ssnit:String(b.ssnit||'').trim(),nextOfKin:String(b.nextOfKin||'').trim(),emergency:String(b.emergency||'').trim(),emergencyPhone:String(b.emergencyPhone||'').trim(),notes:String(b.notes||'').trim()};const existing=await getPayrollStaffRegistration(email);if(existing?.status==='approved')return json(res,409,{ok:false,error:'A payroll staff account already exists for this email address.'});const hp=hashPassword(password),now=Date.now();if(existing){await pool.query('UPDATE payroll_staff_registrations SET phone=$1,password_salt=$2,password_hash=$3,status=\'pending\',worker_id=NULL,profile_json=$4::jsonb,updated_at=$5,reviewed_at=NULL,reviewed_by=NULL WHERE id=$6',[phone,hp.salt,hp.hash,JSON.stringify(profile),now,existing.id]);return json(res,200,{ok:true,status:'pending',message:'Your registration has been resubmitted for administrator approval.'});}const q=await pool.query('INSERT INTO payroll_staff_registrations(email,phone,password_salt,password_hash,status,profile_json,created_at,updated_at) VALUES($1,$2,$3,$4,\'pending\',$5::jsonb,$6,$6) RETURNING id',[email,phone,hp.salt,hp.hash,JSON.stringify(profile),now]);return json(res,200,{ok:true,status:'pending',registrationId:q.rows[0].id,message:'Registration submitted. Your administrator must approve your staff profile before payslips are available.'});}catch(err){console.error('Payroll staff registration failed:',err);return json(res,500,{ok:false,error:err.message||'Registration failed.'});}}
async function handlePayrollStaffLogin(req,res){try{const b=await parseJsonBody(req),email=normalizePayrollStaffEmail(b.email),password=String(b.password||''),r=await getPayrollStaffRegistration(email);if(!r)return json(res,401,{ok:false,error:'No payroll staff registration was found for this email address.'});if(r.status==='pending')return json(res,403,{ok:false,status:'pending',error:'Your staff registration is awaiting administrator approval.'});if(r.status!=='approved')return json(res,403,{ok:false,status:r.status,error:'Your staff registration is not active.'});const supplied=hashPassword(password,r.password_salt).hash;if(!safeEqualB64(supplied,r.password_hash))return json(res,401,{ok:false,error:'Invalid email or password.'});await createPayrollStaffSession(r.id,res);const {worker}=await readPayrollStateForStaff(r.worker_id);return json(res,200,{ok:true,user:payrollStaffProfile(worker)});}catch(err){return json(res,500,{ok:false,error:err.message||'Login failed.'});}}
async function handlePayrollStaffLogout(req,res){const t=parseCookies(req).fbi_payroll_staff_session;if(t)await pool.query('DELETE FROM payroll_staff_sessions WHERE token_hash=$1',[sessionTokenHash(t)]);clearPayrollStaffCookie(res);return json(res,200,{ok:true});}
async function handlePayrollStaffMe(req,res){const s=await requirePayrollStaff(req,res);if(!s)return;const rs=s.state.records.filter(r=>String(r.workerId||'')===String(s.worker.id||''));return json(res,200,{ok:true,user:payrollStaffProfile(s.worker),payroll:{recordCount:rs.length,payslipCount:s.state.payslips.filter(p=>rs.some(r=>String(r.id)===String(p.recordId))).length}});}
function payrollStaffBase(r){return Number(((Number(r.rate)||0)*(Number(r.qty)||1)).toFixed(2));}
function payrollStaffGross(r){return Number((payrollStaffBase(r)+(Number(r.transport)||0)+(Number(r.feeding)||0)+(Number(r.accommodation)||0)+(Number(r.overtime)||0)+(Number(r.otherAllowance)||0)+(Number(r.allowance)||0)+(Number(r.bonus)||0)).toFixed(2));}
function payrollStaffNet(r){return Number((payrollStaffGross(r)-(Number(r.deduction)||0)-(Number(r.advance)||0)+(Number(r.previousBalance)||0)).toFixed(2));}
function payrollStaffPaid(r){return Number((Array.isArray(r.payments)?r.payments:[]).reduce((s,p)=>s+(Number(p.amount)||0),0).toFixed(2));}
function payrollStaffBalance(r){return Number(Math.max(0,payrollStaffNet(r)-payrollStaffPaid(r)).toFixed(2));}
function payrollStaffStatus(r){const b=payrollStaffBalance(r);if(b<=0.005)return 'Paid';if(payrollStaffPaid(r)>0)return 'Partially Paid';return 'Pending';}
function nextPayrollStaffPayslipNo(state){let m=0;for(const p of (Array.isArray(state.payslips)?state.payslips:[])){const z=String(p.payslipNo||'').match(/(\d+)$/);if(z)m=Math.max(m,Number(z[1])||0);}return 'PAY'+String(m+1).padStart(4,'0');}
async function ensurePayrollStaffPayslip(workerId,recordId){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[492013]);const q=await client.query('SELECT state_json FROM payroll_state WHERE id=1 FOR UPDATE');let state=q.rows[0]?.state_json||{version:1,savedAt:Date.now(),workers:[],records:[],payslips:[]};if(typeof state==='string')state=JSON.parse(state);if(!Array.isArray(state.workers)||!Array.isArray(state.records)||!Array.isArray(state.payslips))throw new Error('Stored Payroll state is invalid.');const worker=state.workers.find(w=>String(w.id||'')===String(workerId||''));if(!worker)throw new Error('Worker record not found.');const record=state.records.find(r=>String(r.id||'')===String(recordId||'')&&String(r.workerId||'')===String(workerId||''));if(!record)throw new Error('Payroll record not found for this staff account.');let payslip=state.payslips.find(p=>String(p.recordId||'')===String(record.id||''));if(!payslip){payslip={id:'payslip-'+crypto.randomUUID(),recordId:record.id,payslipNo:nextPayrollStaffPayslipNo(state),generatedAt:new Date().toISOString(),generatedBy:worker.name||'Payroll Staff Portal',source:'staff-portal'};state.payslips.push(payslip);state.savedAt=Date.now();await client.query('INSERT INTO payroll_state(id,version,saved_at,state_json) VALUES(1,$1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state_json=EXCLUDED.state_json',[Number(state.version)||1,state.savedAt,JSON.stringify(state)]);}await client.query('COMMIT');return {state,worker,record,payslip};}catch(err){try{await client.query('ROLLBACK')}catch{}throw err;}finally{client.release();}}
async function handlePayrollStaffPayslips(req,res){const s=await requirePayrollStaff(req,res);if(!s)return;const rs=s.state.records.filter(r=>String(r.workerId||'')===String(s.worker.id||'')).sort((a,b)=>String(b.workDate||'').localeCompare(String(a.workDate||'')));const slips=new Map(s.state.payslips.map(p=>[String(p.recordId||''),p]));return json(res,200,{ok:true,payslips:rs.map(r=>({recordId:r.id,payslip:slips.get(String(r.id))||null,workDate:r.workDate||'',project:r.project||'',role:r.role||'',basis:r.basis||'',gross:payrollStaffGross(r),net:payrollStaffNet(r),paid:payrollStaffPaid(r),balance:payrollStaffBalance(r),status:payrollStaffStatus(r)}))});}
async function handlePayrollStaffGeneratePayslip(req,res){const s=await requirePayrollStaff(req,res);if(!s)return;try{const b=await parseJsonBody(req),out=await ensurePayrollStaffPayslip(s.worker.id,String(b.recordId||''));return json(res,200,{ok:true,payslip:out.payslip,recordId:out.record.id,net:payrollStaffNet(out.record),balance:payrollStaffBalance(out.record),status:payrollStaffStatus(out.record)});}catch(err){return json(res,400,{ok:false,error:err.message||'Payslip could not be generated.'});}}
function drawPayrollStaffPayslipPdf(doc,w,r,p){pdfHeader(doc,'PAYSLIP',p.payslipNo||'');doc.moveDown(5);doc.font('Helvetica-Bold').fontSize(12).text(w.name||'');doc.font('Helvetica').fontSize(9).fillColor('#444').text([w.workerCode,w.role,w.department].filter(Boolean).join(' · '));doc.moveDown(1);const left=42,gap=12,boxW=(511-gap)/2,metaY=doc.y,boxes=[['Pay Date',r.workDate||''],['Pay Basis',r.basis||''],['Project / Event',r.project||''],['Worker Type',w.workerType||'']];for(let i=0;i<boxes.length;i++){const col=i%2,rowN=Math.floor(i/2),x=left+col*(boxW+gap),y=metaY+rowN*42;doc.roundedRect(x,y,boxW,32,4).fillAndStroke('#f7f7f7','#dddddd');doc.fillColor('#777').font('Helvetica').fontSize(7).text(boxes[i][0],x+8,y+6);doc.fillColor('#111').font('Helvetica-Bold').fontSize(9).text(String(boxes[i][1]),x+8,y+16,{width:boxW-16,ellipsis:true});}let y=metaY+98;doc.fillColor('#111').font('Helvetica-Bold').fontSize(9).text('DESCRIPTION',left,y);doc.text('AMOUNT',455,y,{width:98,align:'right'});y+=14;const lines=[['Rate × Quantity',payrollStaffBase(r)],['Transport Allowance',Number(r.transport)||0],['Feeding Allowance',Number(r.feeding)||0],['Accommodation',Number(r.accommodation)||0],['Overtime',Number(r.overtime)||0],['Other Allowance',Number(r.otherAllowance)||0],['General Allowance',Number(r.allowance)||0],['Bonus',Number(r.bonus)||0],['Gross Pay',payrollStaffGross(r)],['Deductions',-(Number(r.deduction)||0)],['Advance',-(Number(r.advance)||0)],['Previous Balance Owed',Number(r.previousBalance)||0],['NET PAY',payrollStaffNet(r)]];for(const [label,amount] of lines){if(y>725){doc.addPage();pdfHeader(doc,'PAYSLIP',p.payslipNo||'');y=135;}const strong=label==='Gross Pay'||label==='NET PAY';doc.font(strong?'Helvetica-Bold':'Helvetica').fontSize(label==='NET PAY'?13:9).fillColor('#111').text(label,left,y);doc.text(money(amount,'GHS'),455,y,{width:98,align:'right'});if(label==='Gross Pay')doc.moveTo(left,y+13).lineTo(553,y+13).stroke('#888');if(label==='NET PAY')doc.moveTo(left,y+18).lineTo(553,y+18).stroke('#222');y+=label==='NET PAY'?26:18;}y+=8;doc.font('Helvetica').fontSize(9);doc.text('Amount Paid: '+money(payrollStaffPaid(r),'GHS'),left,y);doc.text('Balance: '+money(payrollStaffBalance(r),'GHS'),left,y+16);doc.text('Status: '+payrollStaffStatus(r),left,y+32);y+=52;if(Array.isArray(r.payments)&&r.payments.length){const last=r.payments[r.payments.length-1];doc.font('Helvetica-Bold').fontSize(9).text('Latest Payment',left,y);y+=14;doc.font('Helvetica').fontSize(8).text([last.date,last.method,last.reference?'Ref '+last.reference:'',last.paidBy?'Paid by '+last.paidBy:''].filter(Boolean).join(' · '),left,y,{width:511});y+=28;}doc.font('Helvetica').fontSize(8).fillColor('#555').text('Payment Method: '+(w.paymentMethod||'')+(w.momo?' · MoMo '+w.momo:'')+(w.bank?' · Bank '+w.bank+(w.accountNumber?' · A/C '+w.accountNumber:''):''),left,y,{width:511});}
async function handlePayrollStaffPayslipPdf(req,res){const s=await requirePayrollStaff(req,res);if(!s)return;try{const recordId=String(new URL(req.url,'http://localhost').searchParams.get('recordId')||'').trim();if(!recordId)return json(res,400,{ok:false,error:'A payroll record is required.'});const out=await ensurePayrollStaffPayslip(s.worker.id,recordId);return streamPdf(res,'FBI-'+String(out.payslip.payslipNo||'PAYSLIP')+'.pdf',doc=>drawPayrollStaffPayslipPdf(doc,out.worker,out.record,out.payslip));}catch(err){if(!res.headersSent)return json(res,400,{ok:false,error:err.message||'Payslip PDF could not be created.'});}}
async function handlePayrollRegistrationsList(req,res){try{const st=String(new URL(req.url,'http://localhost').searchParams.get('status')||'pending').trim().toLowerCase();const q=st&&st!=='all'?await pool.query('SELECT id,email,phone,status,profile_json,created_at,updated_at,reviewed_at,reviewed_by,worker_id FROM payroll_staff_registrations WHERE status=$1 ORDER BY created_at DESC',[st]):await pool.query('SELECT id,email,phone,status,profile_json,created_at,updated_at,reviewed_at,reviewed_by,worker_id FROM payroll_staff_registrations ORDER BY created_at DESC');return json(res,200,{ok:true,registrations:q.rows.map(r=>{let p=r.profile_json;if(typeof p==='string'){try{p=JSON.parse(p)}catch{p={}}}return {id:String(r.id),email:r.email||'',phone:r.phone||'',status:r.status||'pending',profile:p||{},createdAt:Number(r.created_at)||0,updatedAt:Number(r.updated_at)||0,reviewedAt:Number(r.reviewed_at)||0,reviewedBy:r.reviewed_by||'',workerId:r.worker_id||''};})});}catch(err){return json(res,500,{ok:false,error:err.message||'Registrations could not be loaded.'});}}
function payrollWorkerFromRegistration(r){let p=r.profile_json;if(typeof p==='string'){try{p=JSON.parse(p)}catch{p={}}}p=p||{};return {id:'worker-reg-'+String(r.id),registrationId:String(r.id),portalEmail:r.email||'',portalUsername:r.email||'',workerCode:String(p.workerCode||'').trim()||('FBI-WK-'+String(r.id).padStart(4,'0')),name:String(p.name||'').trim(),phone:String(p.phone||'').trim(),email:String(p.email||r.email||'').trim(),address:String(p.address||'').trim(),role:String(p.role||'').trim(),department:String(p.department||'Other').trim()||'Other',workerType:String(p.workerType||'Media Worker').trim()||'Media Worker',paymentMethod:String(p.paymentMethod||'Mobile Money').trim()||'Mobile Money',momo:String(p.momo||'').trim(),bank:String(p.bank||'').trim(),accountName:String(p.accountName||'').trim(),accountNumber:String(p.accountNumber||'').trim(),idRef:String(p.idRef||'').trim(),dateOfBirth:String(p.dateOfBirth||'').trim(),gender:String(p.gender||'').trim(),maritalStatus:String(p.maritalStatus||'').trim(),dateJoined:String(p.dateJoined||'').trim(),tin:String(p.tin||'').trim(),ssnit:String(p.ssnit||'').trim(),nextOfKin:String(p.nextOfKin||'').trim(),emergency:String(p.emergency||'').trim(),emergencyPhone:String(p.emergencyPhone||'').trim(),status:'Active',notes:String(p.notes||'').trim(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
async function handlePayrollRegistrationApprove(req,res){const id=String(new URL(req.url,'http://localhost').pathname.split('/').slice(-2,-1)[0]||'').trim();if(!id||!/^\d+$/.test(id))return json(res,400,{ok:false,error:'Invalid registration id.'});const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[492014]);const rq=await client.query('SELECT * FROM payroll_staff_registrations WHERE id=$1 FOR UPDATE',[id]),registration=rq.rows[0];if(!registration){await client.query('ROLLBACK');return json(res,404,{ok:false,error:'Registration not found.'});}if(registration.status==='approved'&&registration.worker_id){await client.query('COMMIT');return json(res,200,{ok:true,alreadyApproved:true,workerId:registration.worker_id});}let state=null;const sq=await client.query('SELECT state_json FROM payroll_state WHERE id=1 FOR UPDATE');if(sq.rows[0]?.state_json){state=sq.rows[0].state_json;if(typeof state==='string')state=JSON.parse(state);}if(!state||!Array.isArray(state.workers)||!Array.isArray(state.records)||!Array.isArray(state.payslips))state={version:1,savedAt:Date.now(),workers:[],records:[],payslips:[]};let worker=state.workers.find(w=>String(w.registrationId||'')===String(registration.id))||null;if(!worker){const email=normalizePayrollStaffEmail(registration.email),phone=normalizePayrollStaffPhone(registration.phone);worker=state.workers.find(w=>email&&normalizePayrollStaffEmail(w.email||w.portalEmail)===email)||null;if(!worker&&phone)worker=state.workers.find(w=>phone&&normalizePayrollStaffPhone(w.phone)===phone)||null;}const imported=payrollWorkerFromRegistration(registration);if(worker){const keepId=worker.id,keepCreated=worker.createdAt||imported.createdAt;Object.assign(worker,imported,{id:keepId,createdAt:keepCreated,updatedAt:new Date().toISOString()});}else{worker=imported;state.workers.push(worker);}state.savedAt=Date.now();await client.query('INSERT INTO payroll_state(id,version,saved_at,state_json) VALUES(1,$1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state_json=EXCLUDED.state_json',[Number(state.version)||1,state.savedAt,JSON.stringify(state)]);await client.query('UPDATE payroll_staff_registrations SET status=\'approved\',worker_id=$1,reviewed_at=$2,reviewed_by=$3,updated_at=$2 WHERE id=$4',[String(worker.id),Date.now(),'Admin Portal',id]);await client.query('COMMIT');return json(res,200,{ok:true,worker:payrollStaffProfile(worker),registrationId:id});}catch(err){try{await client.query('ROLLBACK')}catch{}console.error('Payroll registration approval failed:',err);return json(res,500,{ok:false,error:err.message||'Registration approval failed.'});}finally{client.release();}}
async function handlePayrollRegistrationReject(req,res){const id=String(new URL(req.url,'http://localhost').pathname.split('/').slice(-2,-1)[0]||'').trim();if(!id||!/^\d+$/.test(id))return json(res,400,{ok:false,error:'Invalid registration id.'});try{const q=await pool.query('UPDATE payroll_staff_registrations SET status=\'rejected\',reviewed_at=$1,reviewed_by=$2,updated_at=$1 WHERE id=$3 RETURNING id,status',[Date.now(),'Admin Portal',id]);if(!q.rows[0])return json(res,404,{ok:false,error:'Registration not found.'});return json(res,200,{ok:true,registrationId:id,status:'rejected'});}catch(err){return json(res,500,{ok:false,error:err.message||'Registration could not be rejected.'});}}

async function handleDraftGet(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  const { rows } = await pool.query('SELECT draft_saved_at,draft_json FROM app_state WHERE id=1');
  if (!rows[0] || !rows[0].draft_json) return json(res, 200, { ok: true, draft: null });
  return json(res, 200, {
    ok: true,
    draft: {
      savedAt: Number(rows[0].draft_saved_at) || 0,
      draft: rows[0].draft_json
    }
  });
}

async function handleDraftWrite(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  try {
    const body = await parseJsonBody(req);
    if (!body || !body.draft || typeof body.draft !== 'object') {
      return json(res, 400, { ok: false, error: 'Invalid draft.' });
    }
    const savedAt = Number(body.savedAt) || Date.now();
    await pool.query(
      'UPDATE app_state SET draft_saved_at=$1,draft_json=$2::jsonb WHERE id=1',
      [savedAt, JSON.stringify(body.draft)]
    );
    return json(res, 200, { ok: true, savedAt });
  } catch (err) {
    console.error('Draft save failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Draft save failed.' });
  }
}

async function handleDraftDelete(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  await pool.query('UPDATE app_state SET draft_saved_at=NULL,draft_json=NULL WHERE id=1');
  return json(res, 200, { ok: true });
}

// ===== SMS CENTER =====
const SMS_PROVIDER = 'self-hosted-gsm';
const SMS_ENABLED = String(process.env.SMS_ENABLED || 'false').toLowerCase() === 'true';
const SMS_GATEWAY_ENABLED = String(process.env.SMS_GATEWAY_ENABLED || 'true').toLowerCase() === 'true';
const SMS_GATEWAY_TOKEN = String(process.env.SMS_GATEWAY_TOKEN || '').trim();
const SMS_GATEWAY_NAME = String(process.env.SMS_GATEWAY_NAME || 'FBI Private SMS Gateway').trim();
const SMS_GATEWAY_LINE = String(process.env.SMS_GATEWAY_LINE || 'Private SIM line').trim().slice(0, 40);
const SMS_GATEWAY_OFFLINE_AFTER_MS = Math.max(30000, Number(process.env.SMS_GATEWAY_OFFLINE_AFTER_MS || 90000));

async function ensureSmsTables() {
  await pool.query('CREATE TABLE IF NOT EXISTS sms_campaigns (id UUID PRIMARY KEY,name TEXT NOT NULL,sender TEXT NOT NULL,message TEXT NOT NULL,total_recipients INTEGER NOT NULL DEFAULT 0,accepted_count INTEGER NOT NULL DEFAULT 0,delivered_count INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,skipped_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'queued\',created_at BIGINT NOT NULL,created_by TEXT)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_campaigns_created_at ON sms_campaigns(created_at DESC)');
  await pool.query('CREATE TABLE IF NOT EXISTS sms_message_log (id BIGSERIAL PRIMARY KEY,campaign_id UUID NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,client_id TEXT,client_name TEXT,phone TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'queued\',provider_status TEXT,provider_message_id TEXT,error_message TEXT,created_at BIGINT NOT NULL,delivered_at BIGINT)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_message_log_campaign ON sms_message_log(campaign_id,created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_message_log_provider_id ON sms_message_log(provider_message_id)');
  await pool.query('CREATE TABLE IF NOT EXISTS sms_opt_out (phone TEXT PRIMARY KEY,reason TEXT,created_at BIGINT NOT NULL)');
  await pool.query('ALTER TABLE sms_message_log ADD COLUMN IF NOT EXISTS gateway_claimed_at BIGINT');
  await pool.query('ALTER TABLE sms_message_log ADD COLUMN IF NOT EXISTS gateway_attempts INTEGER NOT NULL DEFAULT 0');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_message_log_gateway_queue ON sms_message_log(status,gateway_claimed_at,created_at)');
  await pool.query('CREATE TABLE IF NOT EXISTS sms_gateway_state (id INTEGER PRIMARY KEY CHECK (id=1),gateway_id TEXT NOT NULL,gateway_name TEXT NOT NULL,sim_line TEXT,port_label TEXT,modem_status TEXT NOT NULL DEFAULT \'unknown\',last_seen BIGINT NOT NULL,updated_at BIGINT NOT NULL,detail TEXT)');
  await pool.query('CREATE TABLE IF NOT EXISTS sms_gateway_devices (id UUID PRIMARY KEY,gateway_id TEXT NOT NULL,gateway_name TEXT NOT NULL,token_hash TEXT NOT NULL,created_at BIGINT NOT NULL,last_seen BIGINT,revoked_at BIGINT)');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS gateway_id TEXT');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS gateway_name TEXT');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS token_hash TEXT');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS created_at BIGINT');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS last_seen BIGINT');
  await pool.query('ALTER TABLE sms_gateway_devices ADD COLUMN IF NOT EXISTS revoked_at BIGINT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_gateway_devices_gateway_id ON sms_gateway_devices(gateway_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sms_gateway_devices_last_seen ON sms_gateway_devices(last_seen)');
  await pool.query('CREATE TABLE IF NOT EXISTS sms_gateway_pairings (id UUID PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,used_at BIGINT)');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS created_at BIGINT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS expires_at BIGINT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS used_at BIGINT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS pending_secret_hash TEXT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS pending_gateway_id TEXT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS pending_gateway_name TEXT');
  await pool.query('ALTER TABLE sms_gateway_pairings ADD COLUMN IF NOT EXISTS pending_at BIGINT');
}

function smsConfigured() {
  return SMS_ENABLED && SMS_GATEWAY_ENABLED && !!SMS_GATEWAY_TOKEN;
}

function extractGatewayToken(req) {
  const header=String(req.headers['x-fbi-sms-gateway-token']||'').trim();
  const auth=String(req.headers.authorization||'').trim();
  return header||(auth.toLowerCase().startsWith('bearer ')?auth.slice(7).trim():'');
}

async function gatewayAuthorized(req) {
  const supplied=extractGatewayToken(req);
  if(!supplied)return false;
  if(SMS_GATEWAY_TOKEN){
    const a=Buffer.from(supplied),b=Buffer.from(SMS_GATEWAY_TOKEN);
    if(a.length===b.length&&crypto.timingSafeEqual(a,b))return true;
  }
  const hash=crypto.createHash('sha256').update(supplied).digest('hex');
  const q=await pool.query('SELECT id FROM sms_gateway_devices WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1',[hash]);
  return !!q.rows[0];
}

function createSmsPairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function createSmsGatewayPairing() {
  const code=createSmsPairCode();
  const codeHash=crypto.createHash('sha256').update(code).digest('hex');
  const now=Date.now();
  const expires=now+10*60*1000;
  await pool.query('DELETE FROM sms_gateway_pairings WHERE expires_at<$1 OR used_at IS NOT NULL',[now]);
  await pool.query('INSERT INTO sms_gateway_pairings(id,code_hash,attempts,created_at,expires_at) VALUES($1,$2,0,$3,$4)',[crypto.randomUUID(),codeHash,now,expires]);
  return {code,expiresAt:expires};
}

async function handleSmsGatewayPairPage(req,res) {
  const session=await requireAuth(req,res);if(!session)return;
  try{
    const pairing=await createSmsGatewayPairing();
    const mins=Math.max(1,Math.ceil((pairing.expiresAt-Date.now())/60000));
    const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FBI SMS Gateway Pairing</title><style>body{margin:0;background:#0b0b0d;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100vw - 40px));background:#151518;border:1px solid #2b2b31;border-radius:18px;padding:28px;box-sizing:border-box;text-align:center}.brand{font-weight:700;letter-spacing:2px;color:#d4af37}.code{font-size:48px;font-weight:800;letter-spacing:10px;margin:24px 0;color:#fff}.note{color:#aaa;line-height:1.5}button{border:0;border-radius:10px;padding:12px 18px;background:#d4af37;color:#0b0b0d;font-weight:700;cursor:pointer}</style></head><body><div class="card"><div class="brand">FILM BEYOND IMAGINATION</div><h2>SMS Gateway Pairing</h2><div class="code">'+pairing.code+'</div><button onclick="navigator.clipboard?.writeText(\''+pairing.code+'\')">COPY CODE</button><p class="note">Enter this 6-digit code in the FBI SMS Gateway app on the company phone. It expires in '+mins+' minutes and can be used once.</p><p class="note">Keep this page private.</p></div></body></html>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(html);
  }catch(err){return json(res,500,{ok:false,error:err.message||'Unable to create gateway pairing code.'});}
}

async function handleSmsGatewayPairBootstrap(req,res){
  try{
    const code=String(req.headers['x-fbi-pair-code']||'').replace(/\D/g,'').slice(0,6);
    const gatewayId=String(req.headers['x-fbi-gateway-id']||'').trim().slice(0,120);
    const gatewayName=String(req.headers['x-fbi-gateway-name']||'FBI Android SMS Gateway').trim().slice(0,120)||'FBI Android SMS Gateway';
    const secretHash=String(req.headers['x-fbi-pair-secret-hash']||'').trim().toLowerCase();
    if(!/^\d{6}$/.test(code)||!gatewayId||!/^[a-f0-9]{64}$/.test(secretHash)){
      return json(res,400,{ok:false,error:'Pairing code, gateway ID and pairing secret are required.'});
    }
    const codeHash=crypto.createHash('sha256').update(code).digest('hex');
    const q=await pool.query('SELECT id,attempts,expires_at,used_at FROM sms_gateway_pairings WHERE code_hash=$1 LIMIT 1',[codeHash]);
    const row=q.rows[0];
    if(!row||row.used_at||Number(row.expires_at)<=Date.now()){
      return json(res,401,{ok:false,error:'Pairing code is invalid or expired.'});
    }
    const attempts=Number(row.attempts||0)+1;
    if(attempts>10){
      await pool.query('UPDATE sms_gateway_pairings SET attempts=$2 WHERE id=$1',[row.id,attempts]);
      return json(res,429,{ok:false,error:'Pairing code has been locked. Generate a new code.'});
    }
    const now=Date.now();
    await pool.query(
      'UPDATE sms_gateway_pairings SET attempts=$2,pending_secret_hash=$3,pending_gateway_id=$4,pending_gateway_name=$5,pending_at=$6 WHERE id=$1 AND used_at IS NULL AND expires_at>$6',
      [row.id,attempts,secretHash,gatewayId,gatewayName,now]
    );
    return json(res,200,{ok:true,exchangeId:row.id,expiresAt:Number(row.expires_at)});
  }catch(err){
    console.error('SMS gateway pairing bootstrap failed:',err);
    return json(res,500,{ok:false,error:'Gateway pairing bootstrap failed.',code:'PAIRING_BOOTSTRAP_ERROR'});
  }
}

async function handleSmsGatewayPairExchange(req,res){
  let client=null;
  try{
    const u=new URL(req.url,'http://localhost');
    const exchangeId=String(u.searchParams.get('exchangeId')||'').trim();
    const secret=String(u.searchParams.get('secret')||'').trim();
    if(!exchangeId||!secret)return json(res,400,{ok:false,error:'Pairing exchange credentials are required.'});
    const secretHash=crypto.createHash('sha256').update(secret).digest('hex');
    client=await pool.connect();
    await client.query('BEGIN');
    const q=await client.query(
      'SELECT id,expires_at,used_at,pending_secret_hash,pending_gateway_id,pending_gateway_name,attempts FROM sms_gateway_pairings WHERE id=$1 FOR UPDATE',
      [exchangeId]
    );
    const row=q.rows[0];
    if(!row||row.used_at||Number(row.expires_at)<=Date.now()||String(row.pending_secret_hash||'')!==secretHash||!row.pending_gateway_id){
      await client.query('ROLLBACK');
      return json(res,401,{ok:false,error:'Pairing exchange is invalid or expired.'});
    }
    const token=crypto.randomBytes(32).toString('base64url');
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const now=Date.now();
    const gatewayId=String(row.pending_gateway_id);
    const gatewayName=String(row.pending_gateway_name||'FBI Android SMS Gateway');
    const existing=await client.query('SELECT id FROM sms_gateway_devices WHERE gateway_id=$1 LIMIT 1',[gatewayId]);
    if(existing.rows[0]){
      await client.query(
        'UPDATE sms_gateway_devices SET gateway_name=$2,token_hash=$3,last_seen=$4,revoked_at=NULL WHERE gateway_id=$1',
        [gatewayId,gatewayName,tokenHash,now]
      );
    }else{
      await client.query(
        'INSERT INTO sms_gateway_devices(id,gateway_id,gateway_name,token_hash,created_at,last_seen,revoked_at) VALUES($1,$2,$3,$4,$5,$5,NULL)',
        [crypto.randomUUID(),gatewayId,gatewayName,tokenHash,now]
      );
    }
    const marked=await client.query(
      'UPDATE sms_gateway_pairings SET used_at=$2,pending_secret_hash=NULL,pending_gateway_id=NULL,pending_gateway_name=NULL,pending_at=NULL WHERE id=$1 AND used_at IS NULL RETURNING id',
      [exchangeId,now]
    );
    if(!marked.rows[0]){
      await client.query('ROLLBACK');
      return json(res,409,{ok:false,error:'This pairing exchange was already completed. Generate a new code.'});
    }
    await client.query('COMMIT');
    return json(res,200,{ok:true,token,gatewayId,gatewayName,serverTime:now});
  }catch(err){
    if(client){try{await client.query('ROLLBACK');}catch{}}
    console.error('SMS gateway pairing exchange failed:',err);
    return json(res,500,{ok:false,error:'Gateway pairing exchange failed.',code:'PAIRING_EXCHANGE_ERROR'});
  }finally{
    if(client)client.release();
  }
}

async function handleSmsGatewayPair(req,res){
  let client=null;
  try{
    // Android pairing uses GET + private headers because the Railway edge was
    // returning HTTP 429 before POST /api/sms/gateway/pair reached Node.
    // Keep POST support for the web/legacy clients.
    const isHeaderPair = req.method === 'GET';
    const body = isHeaderPair ? {} : await parseJsonBody(req);
    const code = String(isHeaderPair ? (req.headers['x-fbi-pair-code'] || '') : (body?.code || '')).replace(/\D/g,'').slice(0,6);
    const gatewayId = String(isHeaderPair ? (req.headers['x-fbi-gateway-id'] || '') : (body?.gatewayId || '')).trim().slice(0,120);
    const gatewayName = String(isHeaderPair ? (req.headers['x-fbi-gateway-name'] || 'FBI Android SMS Gateway') : (body?.gatewayName || 'FBI Android SMS Gateway')).trim().slice(0,120)||'FBI Android SMS Gateway';
    if(!/^\d{6}$/.test(code)||!gatewayId)return json(res,400,{ok:false,error:'A valid 6-digit pairing code and gateway ID are required.'});

    const codeHash=crypto.createHash('sha256').update(code).digest('hex');
    const q=await pool.query('SELECT id,attempts,expires_at,used_at FROM sms_gateway_pairings WHERE code_hash=$1 LIMIT 1',[codeHash]);
    const row=q.rows[0];
    if(!row||row.used_at||Number(row.expires_at)<=Date.now()){
      return json(res,401,{ok:false,error:'Pairing code is invalid or expired.'});
    }

    const attempts=Number(row.attempts||0)+1;
    if(attempts>10){
      await pool.query('UPDATE sms_gateway_pairings SET attempts=$2 WHERE id=$1',[row.id,attempts]);
      return json(res,429,{ok:false,error:'Pairing code has been locked. Generate a new code.'});
    }

    const token=crypto.randomBytes(32).toString('base64url');
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const now=Date.now();

    client=await pool.connect();
    await client.query('BEGIN');

    const existing=await client.query('SELECT id FROM sms_gateway_devices WHERE gateway_id=$1 LIMIT 1',[gatewayId]);
    if(existing.rows[0]){
      await client.query(
        'UPDATE sms_gateway_devices SET gateway_name=$2,token_hash=$3,last_seen=$4,revoked_at=NULL WHERE gateway_id=$1',
        [gatewayId,gatewayName,tokenHash,now]
      );
    }else{
      await client.query(
        'INSERT INTO sms_gateway_devices(id,gateway_id,gateway_name,token_hash,created_at,last_seen,revoked_at) VALUES($1,$2,$3,$4,$5,$5,NULL)',
        [crypto.randomUUID(),gatewayId,gatewayName,tokenHash,now]
      );
    }

    const marked=await client.query(
      'UPDATE sms_gateway_pairings SET attempts=$2,used_at=$3 WHERE id=$1 AND used_at IS NULL AND expires_at>$3 RETURNING id',
      [row.id,attempts,now]
    );
    if(!marked.rows[0]){
      await client.query('ROLLBACK');
      return json(res,409,{ok:false,error:'This pairing code was already used or expired. Generate a new code.'});
    }

    await client.query('COMMIT');
    return json(res,200,{ok:true,token,gatewayId,gatewayName,serverTime:now});
  }catch(err){
    if(client){try{await client.query('ROLLBACK');}catch{}}
    console.error('SMS gateway pairing failed:',err);
    return json(res,500,{ok:false,error:'Gateway pairing failed. Please generate a new code and try again.',code:'PAIRING_SERVER_ERROR'});
  }finally{
    if(client)client.release();
  }
}

function normalizeSmsPhone(value) {
  let s=String(value||'').trim().replace(/[\s()\-.]/g,'');
  if(!s)return '';
  if(s.startsWith('00'))s='+'+s.slice(2);
  if(s.startsWith('+233'))s='233'+s.slice(4);
  if(s.startsWith('233'))return /^233\d{9}$/.test(s)?s:'';
  if(s.startsWith('0')&&/^0\d{9}$/.test(s))return '233'+s.slice(1);
  if(/^\d{9}$/.test(s))return '233'+s;
  if(/^\d{10,15}$/.test(s))return s;
  return '';
}

function smsClientKey(client){
  const id=String(client?.id||'').trim();
  return id||('contact:'+String(client?.name||'').trim().toLowerCase()+'|'+normalizeSmsPhone(client?.phone));
}

async function loadInvoiceStateForSms(){
  const q=await pool.query('SELECT state_json FROM app_state WHERE id=1');
  let state=q.rows[0]?.state_json||null;
  if(typeof state==='string'){try{state=JSON.parse(state)}catch{state=null}}
  if(!state?.data||!Array.isArray(state.data.clients))return {data:{clients:[],data:[],settings:{}}};
  return state;
}

async function loadSmsOptOutSet(){
  const q=await pool.query('SELECT phone FROM sms_opt_out');
  return new Set(q.rows.map(r=>String(r.phone||'').trim()).filter(Boolean));
}

async function smsGatewaySnapshot(){
  const q=await pool.query('SELECT gateway_id,gateway_name,sim_line,port_label,modem_status,last_seen,updated_at,detail FROM sms_gateway_state WHERE id=1');
  const row=q.rows[0]||null;
  const online=!!row&&(Date.now()-Number(row.last_seen||0)<=SMS_GATEWAY_OFFLINE_AFTER_MS)&&String(row.modem_status||'').toLowerCase()==='online';
  return {online,gatewayId:row?.gateway_id||null,gatewayName:row?.gateway_name||SMS_GATEWAY_NAME,simLine:row?.sim_line||SMS_GATEWAY_LINE,portLabel:row?.port_label||'',modemStatus:row?.modem_status||'offline',lastSeen:Number(row?.last_seen||0)||null,detail:row?.detail||''};
}

async function refreshSmsCampaign(campaignId){
  const q=await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::int AS accepted,
      COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='processing')::int AS processing
    FROM sms_message_log WHERE campaign_id=$1
  `,[campaignId]);
  const r=q.rows[0]||{};
  const total=Number(r.total||0),accepted=Number(r.accepted||0),delivered=Number(r.delivered||0),failed=Number(r.failed||0),queued=Number(r.queued||0),processing=Number(r.processing||0);
  let status='queued';
  if(!total)status='failed';
  else if(queued||processing)status='sending';
  else if(accepted===total)status='completed';
  else if(accepted>0)status='partial';
  else if(failed===total)status='failed';
  else status='partial';
  await pool.query('UPDATE sms_campaigns SET accepted_count=$2,delivered_count=$3,failed_count=$4,status=$5 WHERE id=$1',[campaignId,accepted,delivered,failed,status]);
  return {total,accepted,delivered,failed,queued,processing,status};
}

async function createSmsCampaignRecord(args){
  const id=crypto.randomUUID();
  await pool.query('INSERT INTO sms_campaigns(id,name,sender,message,total_recipients,accepted_count,delivered_count,failed_count,skipped_count,status,created_at,created_by) VALUES($1,$2,$3,$4,$5,0,0,0,$6,\'queued\',$7,$8)',[id,args.name,args.sender,args.message,args.total,args.skipped,Date.now(),args.createdBy||'Admin']);
  return id;
}

function chooseSmsRecipients(clients,body,optOuts){
  const mode=String(body?.mode||'all').toLowerCase();
  const keys=new Set(Array.isArray(body?.clientKeys)?body.clientKeys.map(v=>String(v||'').trim()).filter(Boolean):[]);
  const selected=mode==='selected'?clients.filter(c=>keys.has(smsClientKey(c))):clients;
  let skipped=0;const out=[];const seen=new Set();
  for(const c of selected){
    const phone=normalizeSmsPhone(c?.phone);
    if(!phone||optOuts.has(phone)){if(phone&&optOuts.has(phone))skipped++;continue;}
    if(seen.has(phone))continue;
    seen.add(phone);
    out.push({clientId:c?.id?String(c.id):'',clientName:String(c?.name||c?.company||'Client').trim(),phone});
  }
  return {recipients:out,skipped};
}

async function logQueuedSms(campaignId,recipients,message){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const r of recipients){
      await client.query('INSERT INTO sms_message_log(campaign_id,client_id,client_name,phone,message,status,created_at) VALUES($1,$2,$3,$4,$5,\'queued\',$6)',[campaignId,r.clientId||null,r.clientName||null,r.phone,message,Date.now()]);
    }
    await client.query('COMMIT');
  }catch(err){try{await client.query('ROLLBACK')}catch{}throw err;}finally{client.release();}
}

async function handleSmsStatus(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  const state=await loadInvoiceStateForSms(),clients=Array.isArray(state?.data?.clients)?state.data.clients:[];
  const optOuts=await loadSmsOptOutSet(),withPhones=clients.filter(c=>!!normalizeSmsPhone(c?.phone)),blocked=withPhones.filter(c=>optOuts.has(normalizeSmsPhone(c?.phone)));
  const totals=await pool.query(`
    SELECT COUNT(*)::int AS messages,
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='processing')::int AS processing,
      COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::int AS sent,
      COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status='failed')::int AS failed
    FROM sms_message_log
  `);
  const gateway=await smsGatewaySnapshot();
  const campaigns=await pool.query('SELECT id,name,total_recipients,accepted_count,delivered_count,failed_count,skipped_count,status,created_at,created_by FROM sms_campaigns ORDER BY created_at DESC LIMIT 8');
  return json(res,200,{ok:true,configured:smsConfigured(),provider:SMS_PROVIDER,senderId:gateway.simLine,gateway,clientCounts:{total:clients.length,withPhone:withPhones.length,blocked:blocked.length,eligible:Math.max(0,withPhones.length-blocked.length)},totals:totals.rows[0]||{messages:0,queued:0,processing:0,sent:0,delivered:0,failed:0},campaigns:campaigns.rows});
}

async function handleSmsClients(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  const state=await loadInvoiceStateForSms(),optOuts=await loadSmsOptOutSet();
  const clients=(Array.isArray(state?.data?.clients)?state.data.clients:[]).map(c=>{
    const phone=normalizeSmsPhone(c?.phone);
    return {key:smsClientKey(c),id:c?.id?String(c.id):'',name:String(c?.name||c?.company||'Client').trim(),company:String(c?.company||'').trim(),phone:String(c?.phone||'').trim(),normalizedPhone:phone,email:String(c?.email||'').trim(),optedOut:!!phone&&optOuts.has(phone)};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  return json(res,200,{ok:true,clients});
}

async function handleSmsCampaigns(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  const q=await pool.query('SELECT id,name,sender,message,total_recipients,accepted_count,delivered_count,failed_count,skipped_count,status,created_at,created_by FROM sms_campaigns ORDER BY created_at DESC LIMIT 100');
  return json(res,200,{ok:true,campaigns:q.rows});
}

async function handleSmsBalance(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  const gateway=await smsGatewaySnapshot();
  return json(res,200,{ok:true,selfHosted:true,message:'No SMS provider balance is used. Messages are sent through the private GSM gateway and its SIM.',gateway});
}

async function handleSmsSend(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  if(!smsConfigured())return json(res,503,{ok:false,error:'Self-hosted SMS is not configured. Set SMS_ENABLED=true, SMS_GATEWAY_ENABLED=true and SMS_GATEWAY_TOKEN in Railway.'});
  try{
    const body=await parseJsonBody(req);
    const name=String(body?.campaignName||'').trim()||('SMS Campaign '+new Date().toLocaleDateString('en-GH'));
    const message=String(body?.message||'').trim();
    if(!message)return json(res,400,{ok:false,error:'Message is required.'});
    if(message.length>1000)return json(res,400,{ok:false,error:'Message is too long. Keep it within 1,000 characters.'});
    if(body?.confirmMarketing!==true)return json(res,400,{ok:false,error:'Please confirm that the selected contacts are permitted to receive this SMS campaign.'});
    const state=await loadInvoiceStateForSms(),clients=Array.isArray(state?.data?.clients)?state.data.clients:[],optOuts=await loadSmsOptOutSet(),chosen=chooseSmsRecipients(clients,body,optOuts);
    if(!chosen.recipients.length)return json(res,400,{ok:false,error:'No eligible client phone numbers were found.'});
    if(chosen.recipients.length>10000)return json(res,413,{ok:false,error:'This campaign is limited to 10,000 recipients per send.'});
    const campaignId=await createSmsCampaignRecord({name,sender:SMS_GATEWAY_LINE,message,total:chosen.recipients.length,createdBy:session.username,skipped:chosen.skipped});
    await logQueuedSms(campaignId,chosen.recipients,message);
    const stats=await refreshSmsCampaign(campaignId);
    return json(res,200,{ok:true,campaignId,status:stats.status,totalRecipients:chosen.recipients.length,queued:stats.queued,accepted:stats.accepted,failed:stats.failed,skipped:chosen.skipped,message:'SMS campaign queued. Your private SMS gateway will send it through the connected SIM.'});
  }catch(err){console.error('SMS campaign failed:',err);return json(res,500,{ok:false,error:err.message||'SMS campaign failed.'});}
}

async function handleSmsTest(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  if(!smsConfigured())return json(res,503,{ok:false,error:'Self-hosted SMS is not configured. Set SMS_ENABLED=true, SMS_GATEWAY_ENABLED=true and SMS_GATEWAY_TOKEN in Railway.'});
  try{
    const body=await parseJsonBody(req),phone=normalizeSmsPhone(body?.phone),message=String(body?.message||'').trim();
    if(!phone)return json(res,400,{ok:false,error:'Enter a valid phone number.'});
    if(!message)return json(res,400,{ok:false,error:'Message is required.'});
    const campaignId=await createSmsCampaignRecord({name:'[TEST] '+String(body?.campaignName||'SMS Test').trim(),sender:SMS_GATEWAY_LINE,message,total:1,createdBy:session.username,skipped:0});
    await logQueuedSms(campaignId,[{clientId:'',clientName:'Test Recipient',phone}],message);
    const stats=await refreshSmsCampaign(campaignId);
    return json(res,200,{ok:true,campaignId,status:stats.status,queued:stats.queued,message:'Test SMS queued for your private gateway.'});
  }catch(err){return json(res,500,{ok:false,error:err.message||'Test SMS failed.'});}
}

async function handleSmsOptOut(req,res){
  const session=await requireAuth(req,res);if(!session)return;
  try{
    const body=await parseJsonBody(req),phone=normalizeSmsPhone(body?.phone),blocked=body?.blocked!==false;
    if(!phone)return json(res,400,{ok:false,error:'A valid phone number is required.'});
    if(blocked)await pool.query('INSERT INTO sms_opt_out(phone,reason,created_at) VALUES($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET reason=EXCLUDED.reason',[phone,String(body?.reason||'Blocked from SMS marketing').trim(),Date.now()]);
    else await pool.query('DELETE FROM sms_opt_out WHERE phone=$1',[phone]);
    return json(res,200,{ok:true,phone,blocked});
  }catch(err){return json(res,500,{ok:false,error:err.message||'SMS preference update failed.'});}
}

async function handleSmsGatewayHeartbeat(req,res){
  if(!(await gatewayAuthorized(req)))return json(res,401,{ok:false,error:'Unauthorized SMS gateway.'});
  try{
    const body=await parseJsonBody(req),gatewayId=String(body?.gatewayId||'private-gateway-1').trim().slice(0,120),gatewayName=String(body?.gatewayName||SMS_GATEWAY_NAME).trim().slice(0,120)||SMS_GATEWAY_NAME,simLine=String(body?.simLine||SMS_GATEWAY_LINE).trim().slice(0,40)||SMS_GATEWAY_LINE,portLabel=String(body?.portLabel||'').trim().slice(0,120),modemStatus=String(body?.modemStatus||'unknown').trim().toLowerCase(),detail=String(body?.detail||'').trim().slice(0,500);
    await pool.query(`
      INSERT INTO sms_gateway_state(id,gateway_id,gateway_name,sim_line,port_label,modem_status,last_seen,updated_at,detail)
      VALUES(1,$1,$2,$3,$4,$5,$6,$6,$7)
      ON CONFLICT(id) DO UPDATE SET gateway_id=EXCLUDED.gateway_id,gateway_name=EXCLUDED.gateway_name,sim_line=EXCLUDED.sim_line,port_label=EXCLUDED.port_label,modem_status=EXCLUDED.modem_status,last_seen=EXCLUDED.last_seen,updated_at=EXCLUDED.updated_at,detail=EXCLUDED.detail
    `,[gatewayId,gatewayName,simLine,portLabel,modemStatus,Date.now(),detail]);
    return json(res,200,{ok:true,serverTime:Date.now()});
  }catch(err){return json(res,500,{ok:false,error:err.message||'Gateway heartbeat failed.'});}
}

async function handleSmsGatewayNext(req,res){
  if(!gatewayAuthorized(req))return json(res,401,{ok:false,error:'Unauthorized SMS gateway.'});
  try{
    const staleBefore=Date.now()-10*60*1000;
    await pool.query('UPDATE sms_message_log SET status=\'queued\',gateway_claimed_at=NULL WHERE status=\'processing\' AND gateway_claimed_at IS NOT NULL AND gateway_claimed_at<$1',[staleBefore]);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query(`
        SELECT id,campaign_id,client_id,client_name,phone,message,created_at,gateway_attempts
        FROM sms_message_log
        WHERE status='queued'
        ORDER BY created_at ASC,id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      if(!q.rows[0]){await client.query('COMMIT');return json(res,200,{ok:true,job:null});}
      const row=q.rows[0],attempts=Number(row.gateway_attempts||0)+1;
      await client.query('UPDATE sms_message_log SET status=\'processing\',gateway_claimed_at=$2,gateway_attempts=$3 WHERE id=$1',[row.id,Date.now(),attempts]);
      await client.query('COMMIT');
      return json(res,200,{ok:true,job:{id:String(row.id),campaignId:String(row.campaign_id),clientId:row.client_id||'',clientName:row.client_name||'Client',phone:row.phone,message:row.message,attempts}});
    }catch(err){try{await client.query('ROLLBACK')}catch{}throw err;}finally{client.release();}
  }catch(err){return json(res,500,{ok:false,error:err.message||'Unable to claim SMS job.'});}
}

async function handleSmsGatewayResult(req,res){
  if(!gatewayAuthorized(req))return json(res,401,{ok:false,error:'Unauthorized SMS gateway.'});
  try{
    const body=await parseJsonBody(req),id=String(body?.id||'').trim(),resultStatus=String(body?.status||'').trim().toLowerCase();
    if(!id||!['sent','failed'].includes(resultStatus))return json(res,400,{ok:false,error:'Job id and status=sent|failed are required.'});
    const providerId=String(body?.providerMessageId||'').trim().slice(0,200),providerStatus=String(body?.providerStatus||'').trim().slice(0,120),errorMessage=String(body?.error||'').trim().slice(0,1000);
    const q=await pool.query(`
      UPDATE sms_message_log
      SET status=$2,provider_status=$3,provider_message_id=$4,error_message=CASE WHEN $2='failed' THEN $5 ELSE NULL END,gateway_claimed_at=NULL
      WHERE id=$1
      RETURNING campaign_id
    `,[id,resultStatus,providerStatus||null,providerId||null,errorMessage||null]);
    if(!q.rows[0])return json(res,404,{ok:false,error:'SMS job not found.'});
    const stats=await refreshSmsCampaign(q.rows[0].campaign_id);
    return json(res,200,{ok:true,campaignId:String(q.rows[0].campaign_id),stats});
  }catch(err){return json(res,500,{ok:false,error:err.message||'Unable to record SMS gateway result.'});}
}

async function handleSmsWebhook(req,res){
  return json(res,200,{ok:true,selfHosted:true,message:'The self-hosted GSM gateway reports directly to Invoice Studio. No third-party SMS webhook is used.'});
}
// ===== END SMS CENTER =====
const WHATSAPP_API_VERSION = process.env.META_WHATSAPP_API_VERSION || 'v23.0';
const WHATSAPP_TOKEN = String(process.env.META_WHATSAPP_TOKEN || '').trim();
const WHATSAPP_PHONE_NUMBER_ID = String(process.env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_BUSINESS_ACCOUNT_ID = String(process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
const WHATSAPP_RECIPIENT = String(process.env.META_WHATSAPP_RECIPIENT || '').trim();
const WHATSAPP_TEMPLATE = String(process.env.META_WHATSAPP_TEMPLATE || 'fbi_invoice_alert').trim();
const WHATSAPP_TEMPLATE_LANGUAGE = String(process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim();
const WHATSAPP_ENABLED = String(process.env.META_WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';
const WHATSAPP_APP_ID = String(process.env.META_WHATSAPP_APP_ID || '').trim();
const WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = String(process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '').trim();

async function ensureWhatsAppTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_notification_log (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      invoice_id TEXT,
      invoice_no TEXT,
      recipient TEXT,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      payload_json JSONB,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_notification_log_created_at ON whatsapp_notification_log(created_at DESC);
  `);
}

function whatsappConfigured() {
  return WHATSAPP_ENABLED && !!WHATSAPP_TOKEN && !!WHATSAPP_PHONE_NUMBER_ID && !!WHATSAPP_RECIPIENT;
}

function invoiceRecipientText(v) {
  const s = String(v || '').replace(/\\s+/g, ' ').trim();
  return s || 'Client';
}

async function sendWhatsAppInvoiceAlert(eventType, invoice, source) {
  if (!whatsappConfigured() || !invoice || typeof invoice !== 'object') return { skipped: true, reason: 'not-configured' };

  const invoiceId = String(invoice.id || invoice.no || '').trim();
  const invoiceNo = String(invoice.no || invoice.invoiceNo || invoice.number || invoiceId || '').trim();
  const eventKey = eventType + ':' + (invoiceId || invoiceNo);
  const existing = await pool.query('SELECT id,status,provider_message_id FROM whatsapp_notification_log WHERE event_key=$1', [eventKey]);
  if (existing.rows[0]) return { skipped: true, reason: 'already-sent', log: existing.rows[0] };

  const clientName = invoiceRecipientText(invoice.client || invoice.clientName || invoice.customer || invoice.billTo || invoice.name);
  const amount = invoice.total ?? invoice.grandTotal ?? invoice.amount ?? invoice.netTotal ?? invoice.balance ?? '';
  const amountNumber = amount === '' ? '' : Number(amount || 0).toLocaleString('en-GH', {minimumFractionDigits:2, maximumFractionDigits:2});
  const currency = String(invoice.currency || invoice.curr || 'GHS').trim() || 'GHS';
  const amountText = amountNumber ? currency + ' ' + amountNumber : '';
  const status = String(invoice.status || invoice.invoiceStatus || (eventType === 'invoice-sent' ? 'Sent' : 'Created'));
  const creator = String(invoice.createdBy || invoice.staffName || invoice.user || source || 'Invoice Studio');
  const textBody = [
    'FBI INVOICE ALERT',
    eventType === 'invoice-sent' ? 'Invoice sent to client' : 'New invoice created',
    'Invoice: ' + invoiceNo,
    'Client: ' + clientName,
    amountText ? 'Amount: ' + amountText : '',
    'Status: ' + status,
    'Created by: ' + creator,
    'Time: ' + new Date().toLocaleString('en-GH', { timeZone: 'Africa/Accra' })
  ].filter(Boolean).join('\\n');

  const payload = {
    messaging_product: 'whatsapp',
    to: WHATSAPP_RECIPIENT,
    type: 'template',
    template: {
      name: WHATSAPP_TEMPLATE,
      language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: invoiceNo || '-' },
          { type: 'text', text: eventType === 'invoice-sent' ? 'Invoice sent to client' : 'New invoice created' },
          { type: 'text', text: clientName },
          { type: 'text', text: amountNumber || '-' },
          { type: 'text', text: currency },
          { type: 'text', text: status }
        ]
      }]
    }
  };

  try {
    const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    const providerId = body?.messages?.[0]?.id || null;
    const ok = response.ok && !!providerId;
    await pool.query(
      'INSERT INTO whatsapp_notification_log(event_key,event_type,invoice_id,invoice_no,recipient,status,provider_message_id,error_message,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT(event_key) DO NOTHING',
      [eventKey,eventType,invoiceId,invoiceNo,WHATSAPP_RECIPIENT,ok?'sent':'failed',providerId,ok?null:(body?.error?.message||'WhatsApp API request failed'),JSON.stringify({textBody,payload,source}),Date.now()]
    );
    if (!ok) console.warn('WhatsApp notification failed:', body);
    return { ok, providerId, error: ok ? null : (body?.error?.message || 'WhatsApp API request failed') };
  } catch (err) {
    await pool.query(
      'INSERT INTO whatsapp_notification_log(event_key,event_type,invoice_id,invoice_no,recipient,status,error_message,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(event_key) DO NOTHING',
      [eventKey,eventType,invoiceId,invoiceNo,WHATSAPP_RECIPIENT,'failed',err.message||'Request failed',JSON.stringify({textBody,payload,source}),Date.now()]
    );
    return { ok:false, error:err.message||'WhatsApp request failed' };
  }
}

async function notifyInvoiceStateChanges(previousState, mergedState, source) {
  const before = new Map((previousState?.data?.data || []).map(x => [String(x.id || x.no || ''), x]));
  const after = Array.isArray(mergedState?.data?.data) ? mergedState.data.data : [];
  const jobs = [];
  for (const invoice of after) {
    const key = String(invoice.id || invoice.no || '');
    if (!key) continue;
    const prior = before.get(key);
    if (!prior) jobs.push(sendWhatsAppInvoiceAlert('invoice-created', invoice, source));
    const priorSent = String(prior?.status || prior?.invoiceStatus || '').toLowerCase() === 'sent' || !!prior?.sentAt || !!prior?.sent;
    const nowSent = String(invoice.status || invoice.invoiceStatus || '').toLowerCase() === 'sent' || !!invoice.sentAt || !!invoice.sent;
    if (nowSent && !priorSent) jobs.push(sendWhatsAppInvoiceAlert('invoice-sent', invoice, source));
  }
  if (jobs.length) await Promise.allSettled(jobs);
}

async function handleWhatsAppTest(req, res) {
  if (!whatsappConfigured()) return json(res, 503, {ok:false,error:'WhatsApp is not configured. Set META_WHATSAPP_ENABLED=true, META_WHATSAPP_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID and META_WHATSAPP_RECIPIENT in Railway.'});

  // First verify that the token can access the configured WhatsApp Business Account and enumerate its phone numbers.
  let businessAccountCheck = null;
  if (WHATSAPP_BUSINESS_ACCOUNT_ID) {
    try {
      const wabaResponse = await fetch(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(WHATSAPP_BUSINESS_ACCOUNT_ID)}/phone_numbers?fields=id,display_phone_number,verified_name,is_on_biz_app,platform_type`,
        {headers:{Authorization:'Bearer '+WHATSAPP_TOKEN}}
      );
      const wabaBody = await wabaResponse.json().catch(()=>({}));
      businessAccountCheck = {
        httpStatus:wabaResponse.status,
        ok:wabaResponse.ok,
        phoneNumbers:Array.isArray(wabaBody?.data) ? wabaBody.data.map(x=>({id:x.id||null,displayPhoneNumber:x.display_phone_number||null,verifiedName:x.verified_name||null})) : [],
        error:wabaBody?.error ? {message:wabaBody.error.message||null,type:wabaBody.error.type||null,code:wabaBody.error.code||null} : null
      };
      if (!wabaResponse.ok) {
        return json(res, 502, {ok:false,stage:'business-account-access',error:wabaBody?.error?.message||'Meta rejected access to the configured WhatsApp Business Account.',businessAccountCheck});
      }
      const match = businessAccountCheck.phoneNumbers.find(x=>String(x.id)===WHATSAPP_PHONE_NUMBER_ID);
      if (!match) {
        return json(res, 502, {ok:false,stage:'phone-number-mismatch',error:'The configured Phone Number ID is not present in the WhatsApp Business Account returned by Meta.',configuredPhoneNumberId:WHATSAPP_PHONE_NUMBER_ID,businessAccountCheck});
      }
    } catch (err) {
      return json(res, 502, {ok:false,stage:'business-account-access',error:err.message||'Unable to reach Meta',businessAccountCheck});
    }
  }

  // First verify that the configured Phone Number ID is visible to the configured token.
  // This keeps Meta's generic "Unsupported post request" error from being mistaken for a template problem.
  let resourceCheck = null;
  try {
    const checkResponse = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(WHATSAPP_PHONE_NUMBER_ID)}?fields=id,display_phone_number,verified_name`,
      {headers:{Authorization:'Bearer '+WHATSAPP_TOKEN}}
    );
    const checkBody = await checkResponse.json().catch(()=>({}));
    resourceCheck = {
      httpStatus: checkResponse.status,
      ok: checkResponse.ok,
      id: checkBody?.id || null,
      displayPhoneNumber: checkBody?.display_phone_number || null,
      verifiedName: checkBody?.verified_name || null,
      isOnBizApp: typeof checkBody?.is_on_biz_app === 'boolean' ? checkBody.is_on_biz_app : null,
      platformType: checkBody?.platform_type || null,
      error: checkBody?.error ? {
        message: checkBody.error.message || null,
        type: checkBody.error.type || null,
        code: checkBody.error.code || null
      } : null
    };
    if (!checkResponse.ok) {
      return json(res, 502, {
        ok:false,
        stage:'phone-number-access',
        error:checkBody?.error?.message || 'Meta rejected access to the configured Phone Number ID.',
        resourceCheck
      });
    }
  } catch (err) {
    return json(res, 502, {ok:false,stage:'phone-number-access',error:err.message||'Unable to reach Meta',resourceCheck});
  }

  const fake = {id:'test-'+Date.now(),no:'TEST',clientName:'FBI WhatsApp Test',total:0,status:'Test'};
  const out = await sendWhatsAppInvoiceAlert('invoice-created', fake, 'Admin Test');
  return json(res, out.ok ? 200 : 502, {...out, messageId: out.providerId || null, stage: out.ok ? 'send' : 'send-message', resourceCheck});
}

async function handleWhatsAppDebugLog(req, res) {
  const q = await pool.query('SELECT id,event_type,invoice_id,invoice_no,status,error_message,created_at FROM whatsapp_notification_log ORDER BY created_at DESC LIMIT 50');
  return json(res,200,{ok:true,configured:whatsappConfigured(),recipientConfigured:!!WHATSAPP_RECIPIENT,log:q.rows,logText:q.rows.map(r=>[new Date(Number(r.created_at)).toLocaleString('en-GH',{timeZone:'Africa/Accra'}),r.event_type,r.invoice_no||'-',r.status,r.error_message||''].join(' · ')).join('\\n')||'No WhatsApp notifications yet.'});
}



function adminApiAuthorized(req) {
  const expected = String(process.env.FBI_ADMIN_SHARED_TOKEN || '').trim();
  const supplied = String(req.headers['x-fbi-admin-token'] || '').trim();
  return !!expected && !!supplied && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function handleAdminSnapshot(req, res) {
  if (!adminApiAuthorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized.' });
  try {
    const stateResult = await pool.query('SELECT version,saved_at,state_json,draft_saved_at,draft_json FROM app_state WHERE id=1');
    let state = stateResult.rows[0]?.state_json || null;
    if (typeof state === 'string') { try { state = JSON.parse(state); } catch { state = null; } }
    return json(res, 200, {
      ok: true,
      source: 'FBI Invoice Studio Cloud',
      savedAt: Number(stateResult.rows[0]?.saved_at) || null,
      version: Number(stateResult.rows[0]?.version) || null,
      state,
      draftSavedAt: Number(stateResult.rows[0]?.draft_saved_at) || null,
      hasDraft: !!stateResult.rows[0]?.draft_json
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || 'Unable to load invoice data.' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true'
      });
      return res.end();
    }

    if (req.method === 'GET' && sendStatic(res, url.pathname)) return;
    if (req.method === 'GET' && url.pathname === '/business') return sendPublicBusinessPage(res, 'business');
    if (req.method === 'GET' && url.pathname === '/privacy') return sendPublicBusinessPage(res, 'privacy');
    if (req.method === 'GET' && url.pathname === '/terms') return sendPublicBusinessPage(res, 'terms');
    
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const dbResult = await pool.query('SELECT 1 AS ok');
      const state = await pool.query('SELECT saved_at FROM app_state WHERE id=1');
      return json(res, 200, {
        ok: dbResult.rows[0]?.ok === 1,
        application: 'FBI Invoice Studio Cloud',
        database: 'PostgreSQL',
        savedAt: state.rows[0]?.saved_at || null,
        accountExists: !!(await getAccount())
      });
    }

    if (url.pathname === '/api/auth/status' && req.method === 'GET') return handleAuthStatus(req, res);
    if (url.pathname === '/api/auth/me' && req.method === 'GET') return handleAuthMe(req, res);
    if (url.pathname === '/api/auth/recovery-questions' && req.method === 'GET') return handleAuthRecoveryQuestions(res);
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') return handleAuthSetup(req, res);
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return handleAuthLogin(req, res);
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') return handleAuthLogout(req, res);
    if (url.pathname === '/api/auth/reset' && req.method === 'POST') return handleAuthReset(req, res);

    if (url.pathname === '/api/payroll-state') {
      if (req.method === 'GET') return handlePayrollStateGet(req, res);
      if (req.method === 'PUT' || req.method === 'POST') return handlePayrollStateWrite(req, res);
      return json(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    if (url.pathname === '/api/payroll/import-pdf' && (req.method === 'POST' || req.method === 'PUT')) {
      return handlePayrollPdfImport(req, res);
    }

    if (url.pathname === '/api/payroll/registrations' && req.method === 'GET') return handlePayrollRegistrationsList(req, res);
    if (/^\/api\/payroll\/registrations\/\d+\/approve$/.test(url.pathname) && req.method === 'POST') return handlePayrollRegistrationApprove(req, res);
    if (/^\/api\/payroll\/registrations\/\d+\/reject$/.test(url.pathname) && req.method === 'POST') return handlePayrollRegistrationReject(req, res);
    if (url.pathname === '/api/payroll-staff/register' && req.method === 'POST') return handlePayrollStaffRegister(req, res);
    if (url.pathname === '/api/payroll-staff/login' && req.method === 'POST') return handlePayrollStaffLogin(req, res);
    if (url.pathname === '/api/payroll-staff/logout' && req.method === 'POST') return handlePayrollStaffLogout(req, res);
    if (url.pathname === '/api/payroll-staff/me' && req.method === 'GET') return handlePayrollStaffMe(req, res);
    if (url.pathname === '/api/payroll-staff/payslips' && req.method === 'GET') return handlePayrollStaffPayslips(req, res);
    if (url.pathname === '/api/payroll-staff/payslips' && req.method === 'POST') return handlePayrollStaffGeneratePayslip(req, res);
    if (url.pathname === '/api/payroll-staff/payslip-pdf' && req.method === 'GET') return handlePayrollStaffPayslipPdf(req, res);

    if (url.pathname === '/api/draft') {
      if (req.method === 'GET') return handleDraftGet(req, res);
      if (req.method === 'PUT' || req.method === 'POST') return handleDraftWrite(req, res);
      if (req.method === 'DELETE') return handleDraftDelete(req, res);
      return json(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    if (url.pathname === '/api/admin/snapshot' && req.method === 'GET') return handleAdminSnapshot(req, res);

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return handleStateGet(req, res);
      if (req.method === 'PUT' || req.method === 'POST') return handleStateWrite(req, res);
      return json(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    if (url.pathname === '/api/sms/status' && req.method === 'GET') return handleSmsStatus(req, res);
    if (url.pathname === '/api/sms/clients' && req.method === 'GET') return handleSmsClients(req, res);
    if (url.pathname === '/api/sms/campaigns' && req.method === 'GET') return handleSmsCampaigns(req, res);
    if (url.pathname === '/api/sms/balance' && req.method === 'GET') return handleSmsBalance(req, res);
    if (url.pathname === '/api/sms/send' && req.method === 'POST') return handleSmsSend(req, res);
    if (url.pathname === '/api/sms/test' && req.method === 'POST') return handleSmsTest(req, res);
    if (url.pathname === '/api/sms/opt-out' && req.method === 'POST') return handleSmsOptOut(req, res);
    if (url.pathname === '/api/sms/gateway/pair-bootstrap' && req.method === 'GET') return handleSmsGatewayPairBootstrap(req, res);
    if (url.pathname === '/api/sms/gateway/pair-exchange' && req.method === 'GET') return handleSmsGatewayPairExchange(req, res);
    if (url.pathname === '/sms-gateway-pair' && req.method === 'GET') { if (String(req.headers['x-fbi-pair-code'] || '').trim()) return handleSmsGatewayPair(req, res); return handleSmsGatewayPairPage(req, res); }
    if (url.pathname === '/api/sms/gateway/pair' && req.method === 'POST') return handleSmsGatewayPair(req, res);
    // Dedicated Android pairing route. Kept separate from the legacy route so the mobile gateway can use a clean edge path without changing the pairing engine.
    if (url.pathname === '/api/sms/gateway/pair-v2' && (req.method === 'GET' || req.method === 'POST')) return handleSmsGatewayPair(req, res);
    if (url.pathname === '/api/sms/gateway/heartbeat' && req.method === 'POST') return handleSmsGatewayHeartbeat(req, res);
    if (url.pathname === '/api/sms/gateway/next' && req.method === 'GET') return handleSmsGatewayNext(req, res);
    if (url.pathname === '/api/sms/gateway/result' && req.method === 'POST') return handleSmsGatewayResult(req, res);
    if (url.pathname === '/api/sms/webhook' && (req.method === 'GET' || req.method === 'POST')) return handleSmsWebhook(req, res);

    if (url.pathname === '/api/whatsapp/embedded-config' && req.method === 'GET') return json(res, 200, {ok:true, appId:WHATSAPP_APP_ID, configId:WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, featureType:'whatsapp_business_app_onboarding'});
    if (url.pathname === '/api/whatsapp/test' && req.method === 'GET') return handleWhatsAppTest(req, res);
    if (url.pathname === '/api/whatsapp/invoice-created' && req.method === 'POST') { const b = await parseJsonBody(req); const out = await sendWhatsAppInvoiceAlert(String(b.eventType || 'invoice-created'), b.invoice || {}, String(b.source || 'API')); return json(res, out.ok ? 200 : 502, out); }
    if (url.pathname === '/api/whatsapp/debug-log' && req.method === 'GET') return handleWhatsAppDebugLog(req, res);

    if (req.method === 'GET') return await sendIndex(res);
    return json(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || 'Server error.' });
  }
});

initDb().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('FBI Invoice Studio Cloud server');
    console.log(`Local: http://127.0.0.1:${PORT}`);
    console.log(`Public/Cloud port: ${PORT}`);
    console.log('Database: PostgreSQL');
  });
}).catch(err => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});

async function shutdown() {
  try { await pool.end(); } catch {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);