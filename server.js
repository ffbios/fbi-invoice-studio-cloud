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
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? String(process.env.COOKIE_SECURE).toLowerCase() === 'true'
  : IS_PRODUCTION;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Create a PostgreSQL database and set DATABASE_URL before starting FBI Invoice Studio.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

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

function sendIndex(res) {
  const stat = fs.statSync(INDEX_FILE);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(INDEX_FILE).pipe(res);
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
  const session = await currentSession(req);
  if (!session) {
    json(res, 401, { ok: false, error: 'Authentication required.' });
    return null;
  }
  return session;
}

async function handleAuthStatus(res) {
  return json(res, 200, { ok: true, accountExists: !!(await getAccount()) });
}

async function handleAuthMe(req, res) {
  const session = await currentSession(req);
  return json(res, 200, { ok: true, authenticated: !!session, username: session?.username || null });
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

async function handleStateWrite(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  try {
    const raw = await readBody(req);
    const state = JSON.parse(raw || '{}');
    if (!state || !state.data || !Array.isArray(state.data.data) || !Array.isArray(state.data.clients) || !state.data.settings) {
      return json(res, 400, { ok: false, error: 'Invalid Invoice Studio state.' });
    }
    const savedAt = Number(state.savedAt) || Date.now();
    const version = Number(state.version) || 1;
    await pool.query(
      `INSERT INTO app_state (id,version,saved_at,state_json) VALUES (1,$1,$2,$3::jsonb)
       ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state_json=EXCLUDED.state_json`,
      [version, savedAt, JSON.stringify(state)]
    );
    return json(res, 200, { ok: true, savedAt });
  } catch (err) {
    console.error('Database write failed:', err);
    return json(res, 500, { ok: false, error: err.message || 'Database write failed.' });
  }
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

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return handleStateGet(req, res);
      if (req.method === 'PUT' || req.method === 'POST') return handleStateWrite(req, res);
      return json(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    if (url.pathname === '/api/whatsapp/test' && req.method === 'GET') return handleWhatsAppNotConfigured(req, res);
    if (url.pathname === '/api/whatsapp/invoice-created' && req.method === 'POST') return handleWhatsAppNotConfigured(req, res);
    if (url.pathname === '/api/whatsapp/debug-log' && req.method === 'GET') return json(res, 200, { ok: true, log: 'Cloud WhatsApp integration is not configured.' });

    if (req.method === 'GET') return sendIndex(res);
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