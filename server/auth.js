'use strict';

const crypto = require('crypto');
const store = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const COOKIE_NAME = 'sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 64) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(candidate, expected);
}

async function ensureAdminPassword() {
  const existing = await store.getSetting('admin_password_hash');
  if (!existing) {
    await store.setSetting('admin_password_hash', hashPassword('admin'));
    await store.setSetting('must_change_password', '1');
  }
}

async function login(username, password) {
  const user = await store.getSetting('admin_username');
  const hash = await store.getSetting('admin_password_hash');
  if (String(username || '').trim() !== user) return null;
  if (!verifyPassword(password, hash)) return null;

  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(token, SESSION_TTL_MS);
  const mustChangePassword = (await store.getSetting('must_change_password')) === '1';
  return { token, mustChangePassword };
}

async function logout(token) {
  await store.destroySession(token);
}

async function changePassword(oldPassword, newPassword) {
  const hash = await store.getSetting('admin_password_hash');
  if (!verifyPassword(oldPassword, hash)) {
    const err = new Error('كلمة المرور الحالية غير صحيحة');
    err.status = 401;
    throw err;
  }
  const pw = String(newPassword || '');
  if (pw.length < 6) {
    const err = new Error('كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف');
    err.status = 400;
    throw err;
  }
  await store.setSetting('admin_password_hash', hashPassword(pw));
  await store.setSetting('must_change_password', '0');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

async function sessionFromRequest(req) {
  return store.getSession(getSessionToken(req));
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

async function requireAuth(req, res, next) {
  const session = await sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذه الصفحة' });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  ensureAdminPassword,
  login,
  logout,
  changePassword,
  parseCookies,
  getSessionToken,
  sessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
};
