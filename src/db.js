const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/hodigos';

// Render's *internal* database URL needs no SSL; the *external* one (…render.com) does.
const needsSsl = process.env.DATABASE_SSL === 'true' || /render\.com|neon\.tech|supabase/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getSetting(key, fallback = null) {
  const r = await query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
async function setSetting(key, value, client = pool) {
  await client.query(
    'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [key, value == null ? null : String(value)]
  );
}
async function audit(actor, action, detail = '', client = pool) {
  await client.query('INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)', [actor, action, detail]);
}

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
}

module.exports = { pool, query, tx, getSetting, setSetting, audit, init };
