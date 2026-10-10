'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'donations.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL NOT NULL CHECK (amount > 0),
  currency   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations (created_at);
CREATE INDEX IF NOT EXISTS idx_donations_currency    ON donations (currency);
`);

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

const insertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);

function seedSettings() {
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, value);
    }
  });
  tx();
}
seedSettings();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function allSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return out;
}

function campaignInfo() {
  const s = allSettings();
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

const insertSession = db.prepare(
  'INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)'
);
const findSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

function createSession(token, ttlMs) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  insertSession.run(token, now.toISOString(), expires.toISOString());
}

function getSession(token) {
  if (!token) return null;
  const row = findSession.get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession.run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) deleteSession.run(token);
}

function cleanupSessions() {
  deleteExpiredSessions.run(new Date().toISOString());
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

const listDonationsStmt = db.prepare(
  `SELECT * FROM donations ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
);
const countDonationsStmt = db.prepare('SELECT COUNT(*) AS c FROM donations');
const getDonationStmt = db.prepare('SELECT * FROM donations WHERE id = ?');
const insertDonationStmt = db.prepare(
  `INSERT INTO donations (amount, currency, note, created_at, created_by)
   VALUES (@amount, @currency, @note, @created_at, @created_by)`
);
const updateDonationStmt = db.prepare(
  `UPDATE donations SET amount = @amount, currency = @currency, note = @note,
   created_at = @created_at WHERE id = @id`
);
const deleteDonationStmt = db.prepare('DELETE FROM donations WHERE id = ?');

function listDonations(limit = 50, offset = 0) {
  return listDonationsStmt.all(limit, offset);
}

function countDonations() {
  return countDonationsStmt.get().c;
}

function getDonation(id) {
  const row = getDonationStmt.get(Number(id));
  if (!row) {
    const err = new Error('العملية غير موجودة');
    err.status = 404;
    throw err;
  }
  return row;
}

function createDonation(input, username) {
  const data = validateDonationInput(input);
  const info = insertDonationStmt.run({ ...data, created_by: username });
  return getDonationStmt.get(info.lastInsertRowid);
}

function updateDonation(id, input) {
  const existing = getDonation(id);
  const merged = {
    amount: input.amount ?? existing.amount,
    currency: input.currency ?? existing.currency,
    note: input.note ?? existing.note,
    created_at: input.created_at ?? existing.created_at,
  };
  const data = validateDonationInput(merged);
  updateDonationStmt.run({ id: existing.id, ...data });
  return getDonationStmt.get(existing.id);
}

function deleteDonation(id) {
  const existing = getDonation(id);
  deleteDonationStmt.run(existing.id);
  return existing;
}

/* ------------------------------------------------------------------ */
/* الإجماليات                                                          */
/* ------------------------------------------------------------------ */

function currencyTotals() {
  return db
    .prepare(
      `SELECT currency, SUM(amount) AS total, COUNT(*) AS count
       FROM donations GROUP BY currency ORDER BY currency`
    )
    .all();
}

function totals() {
  const byCurrency = currencyTotals();
  const operations = byCurrency.reduce((s, r) => s + r.count, 0);
  return { byCurrency, operations };
}

/* ------------------------------------------------------------------ */
/* الإحصائيات (تُستعلم دائمًا لعملة واحدة — لا خلط بين العملات)          */
/* ------------------------------------------------------------------ */

function scopeParams(currency, from, to) {
  const clauses = [];
  const params = {};
  if (currency) {
    clauses.push('currency = @currency');
    params.currency = currency;
  }
  if (from) {
    clauses.push('created_at >= @from');
    params.from = from.length === 10 ? `${from} 00:00:00` : from;
  }
  if (to) {
    clauses.push('created_at <= @to');
    params.to = to.length === 10 ? `${to} 23:59:59` : to;
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function statsSummary(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM donations ${where}`
    )
    .get(params);
  return { total: row.total, count: row.count };
}

function statsByHour(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM donations ${where}
       GROUP BY hour ORDER BY hour`
    )
    .all(params);
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, count: 0 }));
  for (const r of rows) out[r.hour] = { hour: r.hour, total: r.total, count: r.count };
  return out;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = الأحد في SQLite

function statsByWeekday(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS wd,
              COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM donations ${where}
       GROUP BY wd ORDER BY wd`
    )
    .all(params);
  const map = new Map(rows.map((r) => [r.wd, r]));
  return WEEKDAYS.map((wd) => {
    const r = map.get(wd);
    return { weekday: wd, total: r ? r.total : 0, count: r ? r.count : 0 };
  });
}

function statsByDate(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM donations ${where}
       GROUP BY day ORDER BY day`
    )
    .all(params);
  return rows;
}

function statsCumulative(currency, from, to) {
  const days = statsByDate(currency, from, to);
  let run = 0;
  return days.map((d) => {
    run += d.total;
    return { day: d.day, dayTotal: d.total, cumulative: run, count: d.count };
  });
}

function statsByMinute(currency, from, to) {
  const { where, params } = scopeParams(currency, from, to);
  return db
    .prepare(
      `SELECT substr(created_at, 1, 16) AS minute,
              COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM donations ${where}
       GROUP BY minute ORDER BY minute`
    )
    .all(params);
}

module.exports = {
  db,
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
