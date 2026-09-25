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
  '/sw.js': { file: path.join(ROOT, 'sw.js'), type: 'application/javascript; charset=utf-8' },
  '/icons/icon-192.svg': { file: path.join(ROOT, 'icons', 'icon-192.svg'), type: 'image/svg+xml' },
  '/icons/icon-512.svg': { file: path.join(ROOT, 'icons', 'icon-512.svg'), type: 'image/svg+xml' },
  '/icons/icon-maskable-512.svg': { file: path.join(ROOT, 'icons', 'icon-maskable-512.svg'), type: 'image/svg+xml' },
  '/calendar.js': { file: path.join(ROOT, 'calendar.js'), type: 'application/javascript; charset=utf-8' },
  '/assets/fbi-brand-logo.svg': { file: path.join(ROOT, 'assets', 'fbi-brand-logo.svg'), type: 'image/svg+xml' },
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
    'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400',
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
    invoiceMap.set(key, item);
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

async function handleWhatsAppNotConfigured(req, res) {
  return json(res, 503, {
    ok: false,
    error: 'WhatsApp server integration is not configured in the cloud deployment yet.',
    meta: { configure: ['META_WHATSAPP_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID'] }
  });
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

    if (url.pathname === '/api/whatsapp/test' && req.method === 'GET') return handleWhatsAppNotConfigured(req, res);
    if (url.pathname === '/api/whatsapp/invoice-created' && req.method === 'POST') return handleWhatsAppNotConfigured(req, res);
    if (url.pathname === '/api/whatsapp/debug-log' && req.method === 'GET') return json(res, 200, { ok: true, log: 'Cloud WhatsApp integration is not configured.' });

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