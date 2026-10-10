'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * ربط مباشر بمحول خارجي (يُستخدم في الاختبارات مع pg-mem)
 */
function connectAdapter(adapter) {
  pool = adapter;
}

/**
 * الربط بقاعدة PostgreSQL حقيقية عبر DATABASE_URL.
 * يتجاهل خيار ssl تلقائيًا عند وجود sslmode في الوصلة (Render يضع sslmode=require).
 */
function connect(url) {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error('يجب تعريف DATABASE_URL للاتصال بقاعدة البيانات');
  }
  const opts = { connectionString: url, max: 10 };
  if (!/\bsslmode=/.test(url)) {
    opts.ssl = process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false;
  }
  pool = new Pool(opts);
  pool.on('error', () => {});
  return pool;
}

function q(text, params = []) {
  if (!pool) throw new Error('قاعدة البيانات غير متصلة');
  return pool.query(text, params);
}

/* ------------------------------------------------------------------ */
/* الإعدادات                                                           */
/* ------------------------------------------------------------------ */

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DEFAULT_SETTINGS = {
  campaign_title: 'معًا لتوفير سيارة إسعاف لمدينة الظاهرية',
  campaign_subtitle: 'حملة تبرعات لتجهيز سيارة إسعاف تخدم أهالي مدينة الظاهرية',
  goal_amount: '100000',
  goal_currency: 'ILS',
  start_date: today(),
  end_date: today(),
  admin_username: 'admin',
  admin_password_hash: '',
  must_change_password: '1',
};

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);

  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );`);

  await q(`CREATE TABLE IF NOT EXISTS donations (
    id         SERIAL PRIMARY KEY,
    amount     DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    currency   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    created_by TEXT NOT NULL
  );`);

  await q(`CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations (created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_donations_currency ON donations (currency);`);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO NOTHING`,
      [key, value]
    );
  }
}

async function getSetting(key) {
  const { rows } = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : undefined;
}

async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function allSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function campaignInfo() {
  const s = await allSettings();
  return {
    title: s.campaign_title,
    subtitle: s.campaign_subtitle,
    goalAmount: parseFloat(s.goal_amount) || 0,
    goalCurrency: s.goal_currency,
    startDate: s.start_date,
    endDate: s.end_date,
    mustChangePassword: s.must_change_password === '1',
  };
}

/* ------------------------------------------------------------------ */
/* الجلسات                                                             */
/* ------------------------------------------------------------------ */

async function createSession(token, ttlMs) {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await q(
    'INSERT INTO sessions (token, created_at, expires_at) VALUES ($1, $2, $3)',
    [token, new Date().toISOString(), expires]
  );
}

async function getSession(token) {
  if (!token) return null;
  const { rows } = await q(
    'SELECT * FROM sessions WHERE token = $1 AND expires_at > $2',
    [token, new Date().toISOString()]
  );
  if (!rows.length) {
    await q('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return rows[0];
}

async function destroySession(token) {
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
}

async function cleanupSessions() {
  await q('DELETE FROM sessions WHERE expires_at <= $1', [new Date().toISOString()]);
}

/* ------------------------------------------------------------------ */
/* التبرعات                                                            */
/* ------------------------------------------------------------------ */

function normalizeDatetime(value) {
  if (!value) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const s = String(value).trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const err = new Error('صيغة التاريخ والوقت غير صحيحة');
    err.status = 400;
    throw err;
  }
  return s.length === 16 ? `${s}:00` : s;
}

function validateDonationInput({ amount, currency, note, created_at }) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    const err = new Error('المبلغ يجب أن يكون رقمًا أكبر من صفر');
    err.status = 400;
    throw err;
  }
  const cur = String(currency || '').trim().toUpperCase();
  if (!cur || cur.length > 24) {
    const err = new Error('اسم العملة مطلوب (بحد أقصى 24 حرفًا)');
    err.status = 400;
    throw err;
  }
  const cleanNote = String(note || '').trim().slice(0, 300);
  return { amount: num, currency: cur, note: cleanNote, created_at: normalizeDatetime(created_at) };
}

/** تحويل القيمة الزمنية التي يعيدها pg إلى سلسلة 'YYYY-MM-DD HH:MM:SS' بالتوقيت المحلي */
function localTS(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** تنسيق صف التبرع كما كانت تُنتجه SQLite سابقًا */
function normDonation(row) {
  if (!row) return row;
  return { ...row, amount: Number(row.amount), created_at: localTS(row.created_at) };
}

async function listDonations(limit = 50, offset = 0) {
  const { rows } = await q(
    'SELECT * FROM donations ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return rows.map(normDonation);
}

async function countDonations() {
  const { rows } = await q('SELECT COUNT(*)::int AS c FROM donations');
  return Number(rows[0].c);
}

async function getDonation(id) {
  const { rows } = await q('SELECT * FROM donations WHERE id = $1', [Number(id)]);
  if (!rows.length) {
    const err = new Error('العملية غير موجودة');
    err.status = 404;
    throw err;
  }
  return normDonation(rows[0]);
}

async function createDonation(input, username) {
  const data = validateDonationInput(input);
  const { rows } = await q(
    `INSERT INTO donations (amount, currency, note, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.amount, data.currency, data.note, new Date(data.created_at).toISOString(), username]
  );
  return normDonation(rows[0]);
}

async function updateDonation(id, input) {
  const existing = await getDonation(id);
  const merged = {
    amount: input.amount ?? existing.amount,
    currency: input.currency ?? existing.currency,
    note: input.note ?? existing.note,
    created_at: input.created_at ?? existing.created_at,
  };
  const data = validateDonationInput(merged);
  const { rows } = await q(
    `UPDATE donations SET amount = $1, currency = $2, note = $3, created_at = $4
     WHERE id = $5 RETURNING *`,
    [data.amount, data.currency, data.note, new Date(data.created_at).toISOString(), existing.id]
  );
  return normDonation(rows[0]);
}

async function deleteDonation(id) {
  const existing = await getDonation(id);
  await q('DELETE FROM donations WHERE id = $1', [existing.id]);
  return existing;
}

/* ------------------------------------------------------------------ */
/* الإجماليات                                                          */
/* ------------------------------------------------------------------ */

async function currencyTotals() {
  const { rows } = await q(
    `SELECT currency, COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
     FROM donations GROUP BY currency ORDER BY currency`
  );
  return rows.map((r) => ({ currency: r.currency, total: Number(r.total), count: Number(r.count) }));
}

async function totals() {
  const byCurrency = await currencyTotals();
  const operations = byCurrency.reduce((s, r) => s + r.count, 0);
  const { rows } = await q(
    'SELECT * FROM donations ORDER BY created_at DESC, id DESC LIMIT 1'
  );
  return { byCurrency, operations, latest: rows.length ? normDonation(rows[0]) : null };
}

/* ------------------------------------------------------------------ */
/* الإحصائيات (تُستعلم لعملة واحدة — تجميع في SQL حيث أمكن، وفي JS      */
/* للفترات الزمنية الصغيرة لتجنّب اختلافات المناطق الزمنية)             */
/* ------------------------------------------------------------------ */

function scopeParams(currency, from, to) {
  const clauses = [];
  const params = [];
  if (currency) {
    clauses.push(`currency = $${params.length + 1}`);
    params.push(currency);
  }
  if (from) {
    clauses.push(`created_at >= $${params.length + 1}::timestamptz`);
    params.push(from.length === 10 ? `${from} 00:00:00` : from);
  }
  if (to) {
    clauses.push(`created_at <= $${params.length + 1}::timestamptz`);
    params.push(to.length === 10 ? `${to} 23:59:59` : to);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function statsSummary(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  const { rows } = await q(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
     FROM donations ${where}`,
    params
  );
  return { total: Number(rows[0].total), count: Number(rows[0].count) };
}

async function statsBuckets(currency, from, to, keyFn) {
  const { where, params } = scopeParams(currency, from, to);
  const { rows } = await q(
    `SELECT created_at, amount FROM donations ${where} ORDER BY created_at ASC`,
    params
  );
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r.created_at);
    const cur = map.get(key) || { total: 0, count: 0 };
    cur.total += Number(r.amount);
    cur.count += 1;
    map.set(key, cur);
  }
  return map;
}

async function statsByHour(currency, from, to) {
  const map = await statsBuckets(currency, from, to, (v) => localTS(v).slice(11, 13));
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, count: 0 }));
  for (const [hour, rec] of map) out[Number(hour)] = { hour: Number(hour), total: rec.total, count: rec.count };
  return out;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = الأحد

async function statsByWeekday(currency, from, to) {
  const map = await statsBuckets(currency, from, to, (v) => {
    const d = v instanceof Date ? v : new Date(v);
    return String(d.getDay());
  });
  return WEEKDAYS.map((wd) => {
    const rec = map.get(String(wd));
    return { weekday: wd, total: rec ? rec.total : 0, count: rec ? rec.count : 0 };
  });
}

async function statsByDate(currency, from, to) {
  const map = await statsBuckets(currency, from, to, (v) => localTS(v).slice(0, 10));
  const out = [];
  for (const [day, rec] of [...map.entries()].sort()) out.push({ day, ...rec });
  return out;
}

async function statsCumulative(currency, from, to) {
  const days = await statsByDate(currency, from, to);
  let run = 0;
  return days.map((d) => {
    run += d.total;
    return { day: d.day, dayTotal: d.total, cumulative: run, count: d.count };
  });
}

async function statsByMinute(currency, from, to) {
  const map = await statsBuckets(currency, from, to, (v) => localTS(v).slice(0, 16));
  const out = [];
  for (const [minute, rec] of [...map.entries()].sort()) out.push({ minute, ...rec });
  return out;
}

module.exports = {
  connect,
  connectAdapter,
  init,
  getSetting,
  setSetting,
  allSettings,
  campaignInfo,
  createSession,
  getSession,
  destroySession,
  cleanupSessions,
  listDonations,
  countDonations,
  getDonation,
  createDonation,
  updateDonation,
  deleteDonation,
  currencyTotals,
  totals,
  statsSummary,
  statsByHour,
  statsByWeekday,
  statsByDate,
  statsCumulative,
  statsByMinute,
};