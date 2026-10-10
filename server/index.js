'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const store = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* SSE — التحديث المباشر                                               */
/* ------------------------------------------------------------------ */

const clients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (_e) {
      clients.delete(res);
    }
  }
}

async function snapshot() {
  const campaign = await store.campaignInfo();
  const totals = await store.totals();
  const goalRow = totals.byCurrency.find((r) => r.currency === campaign.goalCurrency);
  const goalTotal = goalRow ? goalRow.total : 0;
  const others = totals.byCurrency.filter((r) => r.currency !== campaign.goalCurrency);
  const progress =
    campaign.goalAmount > 0
      ? Math.min(100, (goalTotal / campaign.goalAmount) * 100)
      : 0;
  return {
    campaign,
    totals,
    goalTotal,
    others,
    progress,
    serverTime: new Date().toISOString(),
  };
}

app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);
  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify(await snapshot())}\n\n`);
  } catch (_e) {
    /* تبقى بلا لقطة أوّلية */
  }

  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      /* يُغلق لاحقًا */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

/* ------------------------------------------------------------------ */
/* المصادقة                                                            */
/* ------------------------------------------------------------------ */

const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function loginThrottle(req, res, next) {
  const ip = req.ip || 'local';
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    return res
      .status(429)
      .json({ error: 'محاولات كثيرة، حاول بعد دقائق' });
  }
  next();
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function registerFailedLogin(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.lockedUntil = Date.now() + 5 * 60 * 1000;
    rec.count = 0;
  }
  loginAttempts.set(ip, rec);
}

app.post('/api/login', loginThrottle, async (req, res) => {
  const { username, password } = req.body || {};
  const result = await auth.login(username, password);
  if (!result) {
    registerFailedLogin(req.ip || 'local');
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  clearLoginAttempts(req.ip || 'local');
  auth.setSessionCookie(res, result.token);
  res.json({ ok: true, mustChangePassword: result.mustChangePassword });
});

app.post('/api/logout', async (req, res) => {
  await auth.logout(auth.getSessionToken(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const session = await auth.sessionFromRequest(req);
  res.json({
    authenticated: Boolean(session),
    mustChangePassword: (await store.getSetting('must_change_password')) === '1',
    username: await store.getSetting('admin_username'),
  });
});

app.post('/api/change-password', auth.requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  await auth.changePassword(oldPassword, newPassword);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* واجهات عامة                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/campaign', async (_req, res) => {
  res.json(await snapshot());
});

app.get('/api/totals', async (_req, res) => {
  res.json(await snapshot());
});

/* ------------------------------------------------------------------ */
/* التبرعات (محمية)                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/donations', auth.requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json({
    items: await store.listDonations(limit, offset),
    total: await store.countDonations(),
  });
});

app.post('/api/donations', auth.requireAuth, async (req, res) => {
  const donation = await store.createDonation(
    req.body || {},
    await store.getSetting('admin_username')
  );
  broadcast('celebrate', { donation });
  broadcast('snapshot', await snapshot());
  res.status(201).json({ ok: true, donation });
});

app.put('/api/donations/:id', auth.requireAuth, async (req, res) => {
  const donation = await store.updateDonation(Number(req.params.id), req.body || {});
  broadcast('snapshot', await snapshot());
  res.json({ ok: true, donation });
});

app.delete('/api/donations', auth.requireAuth, async (_req, res) => {
  const deleted = await store.deleteAllDonations();
  broadcast('snapshot', await snapshot());
  res.json({ ok: true, deleted });
});

app.delete('/api/donations/:id', auth.requireAuth, async (req, res) => {
  const donation = await store.deleteDonation(Number(req.params.id));
  broadcast('snapshot', await snapshot());
  res.json({ ok: true, donation });
});

/* ------------------------------------------------------------------ */
/* الإحصائيات (محمية)                                                  */
/* ------------------------------------------------------------------ */

app.get('/api/stats', auth.requireAuth, async (req, res) => {
  const campaign = await store.campaignInfo();
  const currency = (req.query.currency || campaign.goalCurrency).trim().toUpperCase();
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();

  res.json({
    currency,
    from,
    to,
    campaign,
    allTotals: await store.totals(),
    summary: await store.statsSummary(currency, from, to),
    byHour: await store.statsByHour(currency, from, to),
    byWeekday: await store.statsByWeekday(currency, from, to),
    byDate: await store.statsByDate(currency, from, to),
    cumulative: await store.statsCumulative(currency, from, to),
  });
});

/* ------------------------------------------------------------------ */
/* الإعدادات (محمية)                                                   */
/* ------------------------------------------------------------------ */

const EDITABLE_SETTINGS = [
  'campaign_title',
  'campaign_subtitle',
  'goal_amount',
  'goal_currency',
  'start_date',
  'end_date',
];

app.get('/api/settings', auth.requireAuth, async (_req, res) => {
  const s = await store.allSettings();
  const out = {};
  for (const key of EDITABLE_SETTINGS) out[key] = s[key];
  out.must_change_password = s.must_change_password;
  out.admin_username = s.admin_username;
  res.json(out);
});

app.put('/api/settings', auth.requireAuth, async (req, res) => {
  const body = req.body || {};
  const errors = [];

  if (body.goal_amount !== undefined) {
    const g = Number(body.goal_amount);
    if (!Number.isFinite(g) || g < 0) errors.push('الهدف المالي يجب أن يكون رقمًا صحيحًا');
    else await store.setSetting('goal_amount', String(g));
  }
  if (body.goal_currency !== undefined) {
    const c = String(body.goal_currency).trim().toUpperCase();
    if (!c || c.length > 24) errors.push('عملة الهدف غير صحيحة');
    else await store.setSetting('goal_currency', c);
  }
  for (const key of ['start_date', 'end_date']) {
    if (body[key] !== undefined) {
      const v = String(body[key]).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push('التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
      else await store.setSetting(key, v);
    }
  }
  for (const key of ['campaign_title', 'campaign_subtitle']) {
    if (body[key] !== undefined) {
      const v = String(body[key]).trim();
      if (v.length > 160) errors.push('النص طويل جدًا');
      else await store.setSetting(key, v);
    }
  }

  if (errors.length) return res.status(400).json({ error: errors.join(' — ') });

  broadcast('snapshot', await snapshot());
  const values = {};
  for (const k of EDITABLE_SETTINGS) values[k] = await store.getSetting(k);
  res.json({ ok: true, settings: values });
});

/* ------------------------------------------------------------------ */
/* الصفحات                                                             */
/* ------------------------------------------------------------------ */

function pageGuard(redirect) {
  return async (req, res, next) => {
    if (await auth.sessionFromRequest(req)) return next();
    res.redirect(`/login?next=${redirect}`);
  };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/login', async (req, res) => {
  if (await auth.sessionFromRequest(req)) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin', pageGuard('admin'), (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/stats', pageGuard('stats'), (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'stats.html'));
});

app.use(
  '/vendor/chart.js',
  express.static(path.join(ROOT_DIR, 'node_modules', 'chart.js'))
);
app.use(
  '/vendor/canvas-confetti',
  express.static(path.join(ROOT_DIR, 'node_modules', 'canvas-confetti'))
);
app.use(express.static(PUBLIC_DIR));

/* ------------------------------------------------------------------ */
/* الأخطاء                                                             */
/* ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'خطأ في الخادم' });
});

/* ------------------------------------------------------------------ */
/* الإقلاع                                                             */
/* ------------------------------------------------------------------ */

async function start() {
  await store.init();
  await auth.ensureAdminPassword();
  await store.cleanupSessions();
  setInterval(() => store.cleanupSessions(), 60 * 60 * 1000).unref();

  return app.listen(PORT, HOST, () => {
    try {
      fs.writeFileSync(path.join(ROOT_DIR, 'data', 'server.pid'), String(process.pid));
    } catch (_e) {}
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────┐');
    console.log('  │  حملة سيارة إسعاف الظاهرية — الخادم يعمل        │');
    console.log('  ├──────────────────────────────────────────────────┤');
    console.log(`  │  الشاشة العامة : http://localhost:${PORT}/          │`);
    console.log(`  │  الإدارة       : http://localhost:${PORT}/admin      │`);
    console.log(`  │  الإحصائيات    : http://localhost:${PORT}/stats      │`);
    console.log('  └──────────────────────────────────────────────────┘');
    console.log('');
  });
}

if (require.main === module) {
  store.connect(process.env.DATABASE_URL);
  start().catch((err) => {
    console.error('فشل الإقلاع:', err);
    process.exit(1);
  });
}

module.exports = { app, start };