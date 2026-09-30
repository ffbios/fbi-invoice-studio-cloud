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
    if (state && state.data && Array.isArray(state.data.data) && Array.isArray(state.data.clients)) {
      const safeState = JSON.stringify(state)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      const boot = '<script>window.__FBI_SERVER_STATE__=' + safeState + ';</script>';
      html = html.replace('</head>', boot + '</head>');
    }

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
  const { rows } = await pool.query('SELECT username,password_salt,password_hash,recovery_hash,created_at,updated_at FROM auth_account WHERE id=1');
  return rows[0] || null;
}

async function requireAuth(req, res) {
  // Invoice Studio is intentionally configured as a login-free private app.
  // Keep the legacy authentication tables/endpoints for compatibility, but do
  // not block the cloud state/draft APIs behind a session.
  return { username: 'local-user', tokenHash: null };
}

async function handleAuthStatus(res) {
  // Login is disabled for this Invoice Studio deployment.
  return json(res, 200, { ok: true, accountExists: false, loginRequired: false });
}

async function handleAuthMe(req, res) {
  // Login is disabled; the cloud app is available directly.
  return json(res, 200, { ok: true, authenticated: true, username: 'local-user' });
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
    const hp = hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const now = new Date().toISOString();
    await client.query(
      'INSERT INTO auth_account (id,username,password_salt,password_hash,recovery_hash,created_at,updated_at) VALUES (1,$1,$2,$3,$4,$5,$5)',
      [username, hp.salt, hp.hash, hashRecovery(recoveryCode), now]
    );
    await client.query('COMMIT');
    await createLoginSession(username, res);
    return json(res, 200, { ok: true, username, recoveryCode });
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

async function handleAuthReset(req, res) {
  try {
    const account = await getAccount();
    if (!account) return json(res, 404, { ok: false, error: 'No administrator account exists.' });
    const body = await parseJsonBody(req);
    const username = normalizeUsername(body.username);
    const code = String(body.recoveryCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const newPassword = String(body.newPassword || '');
    if (username.toLowerCase() !== String(account.username).toLowerCase() || hashRecovery(code) !== account.recovery_hash) {
      return json(res, 401, { ok: false, error: 'The username or recovery code is incorrect.' });
    }
    if (newPassword.length < 8) return json(res, 400, { ok: false, error: 'Password must contain at least 8 characters.' });
    const hp = hashPassword(newPassword);
    const newRecoveryCode = generateRecoveryCode();
    await pool.query(
      'UPDATE auth_account SET password_salt=$1,password_hash=$2,recovery_hash=$3,updated_at=$4 WHERE id=1',
      [hp.salt, hp.hash, hashRecovery(newRecoveryCode), new Date().toISOString()]
    );
    await createLoginSession(account.username, res);
    return json(res, 200, { ok: true, recoveryCode: newRecoveryCode });
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

const WHATSAPP_API_VERSION = process.env.META_WHATSAPP_API_VERSION || 'v23.0';
const WHATSAPP_TOKEN = String(process.env.META_WHATSAPP_TOKEN || '').trim();
const WHATSAPP_PHONE_NUMBER_ID = String(process.env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_BUSINESS_ACCOUNT_ID = String(process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
const WHATSAPP_RECIPIENT = String(process.env.META_WHATSAPP_RECIPIENT || '').trim();
const WHATSAPP_TEMPLATE = String(process.env.META_WHATSAPP_TEMPLATE || 'fbi_invoice_alert').trim();
const WHATSAPP_TEMPLATE_LANGUAGE = String(process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim();
const WHATSAPP_ENABLED = String(process.env.META_WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';

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

    if (url.pathname === '/api/auth/status' && req.method === 'GET') return handleAuthStatus(res);
    if (url.pathname === '/api/auth/me' && req.method === 'GET') return handleAuthMe(req, res);
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

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return handleStateGet(req, res);
      if (req.method === 'PUT' || req.method === 'POST') return handleStateWrite(req, res);
      return json(res, 405, { ok: false, error: 'Method not allowed.' });
    }

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