/* اختبار أتمتة لمشروع حملة سيارة إسعاف الظاهرية */
"use strict";

process.env.PORT = "3100";

const { newDb } = require("pg-mem");
const store = require("./server/db");
const { start } = require("./server/index");

const mem = newDb();
const { Pool: MemPool } = mem.adapters.createPg();
store.connectAdapter(new MemPool());

const BASE = "http://localhost:3100";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log("  \u2713 " + name);
  } else {
    failed++;
    console.log("  \u2717 " + name + (extra ? "  => " + extra : ""));
  }
}

async function req(path, { method = "GET", body, cookie, redirect = undefined } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_e) {}
  return { status: res.status, data, text, location: res.headers.get("location"), res };
}

function cookieOf(res) {
  if (!res || !res.headers) return null;
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const first = raw.split(",")[0].trim();
  return first.startsWith("sid=") ? first.split(";")[0] : null;
}

let sidCookie = null;
const created = [];

async function addDonation(amount, currency, at, note) {
  const r = await req("/api/donations", {
    method: "POST",
    cookie: sidCookie,
    body: { amount, currency, note: note || "", created_at: at || undefined },
  });
  if (r.status === 201 && r.data && r.data.donation) created.push(r.data.donation);
  return r;
}

async function main() {
  await start();
  console.log("1) فحص الحماية والمصادقة");
  const d0 = await req("/api/campaign");
  check("الشاشة العامة/public متاحة", d0.status === 200 && d0.data.campaign, `status=${d0.status}`);
  check("قاعدة المحصول والبيانات فارغة (لا تبرعات تجريبية)", d0.data.totals.operations === 0 && d0.data.totals.byCurrency.length === 0, JSON.stringify(d0.data.totals));

  const bad = await req("/api/login", { method: "POST", body: { username: "admin", password: "wrong" } });
  check("رفض تسجيل الدخول بكلمة مرور خاطئة", bad.status === 401, `status=${bad.status}`);

  const adminPage = await req("/admin", { redirect: "manual" });
  check("/admin بدون جلسة يعيد توجيه لتسجيل الدخول", adminPage.status === 302 && /\/login\?next=admin/.test(adminPage.location || ""), `status=${adminPage.status} loc=${adminPage.location}`);

  const statsNoAuth = await req("/api/stats");
  check("رفض /api/stats بدون جلسة", statsNoAuth.status === 401, `status=${statsNoAuth.status}`);
  const donationsNoAuth = await req("/api/donations");
  check("رفض /api/donations بدون جلسة", donationsNoAuth.status === 401, `status=${donationsNoAuth.status}`);
  const settingsNoAuth = await req("/api/settings");
  check("رفض /api/settings بدون جلسة", settingsNoAuth.status === 401, `status=${settingsNoAuth.status}`);

  const login = await req("/api/login", { method: "POST", body: { username: "admin", password: "admin" } });
  check("تسجيل الدخول الافتراضي (admin/admin) ناجح", login.status === 200 && login.data.ok === true, `status=${login.status}`);
  sidCookie = cookieOf(login.res);
  check("استلام كوكي الجلسة", Boolean(sidCookie), String(sidCookie));

  const adminPage2 = await req("/admin", { cookie: sidCookie });
  check("/admin بعد الدخول متاح", adminPage2.status === 200, `status=${adminPage2.status}`);

  console.log("2) إضافة التبرعات والإجماليات");
  const addInvalid = await addDonation(-5, "ILS");
  check("رفض مبلغ سالب", addInvalid.status === 400, `status=${addInvalid.status}`);
  const addNoCur = await addDonation(10, "");
  check("رفض عملية بدون عملة", addNoCur.status === 400, `status=${addNoCur.status}`);

  const a = await addDonation(100, "ILS", "2026-10-10T10:05:00", "تبرع دعم");
  const b = await addDonation(50, "JOD", "2026-10-10T11:00:00", "");
  const c = await addDonation(25, "USD", "2026-10-10T12:30:00", "أخرى");
  check("إضافة 3 تبرعات بعملات مختلفة", a.status === 201 && b.status === 201 && c.status === 201);

  const t1 = (await req("/api/campaign")).data;
  check("إجمالي عملة الهدف (ILS) = 100 فقط", t1.goalTotal === 100, JSON.stringify(t1.goalTotal));
  check("عملات أخرى منفصلة (JOD 50 و USD 25)", t1.others.length === 2 && t1.others.some((r) => r.currency === "JOD" && r.total === 50) && t1.others.some((r) => r.currency === "USD" && r.total === 25), JSON.stringify(t1.others));
  check("عدد العمليات الكلي = 3", t1.totals.operations === 3, JSON.stringify(t1.totals.operations));

  console.log("3) التعديل والحذف ينعكسان فورًا");
  const e = await req("/api/donations/" + a.data.donation.id, { method: "PUT", cookie: sidCookie, body: { amount: 250 } });
  check("تعديل 100 -> 250", e.status === 200 && e.data.donation.amount === 250, `status=${e.status}`);
  const t2 = (await req("/api/totals")).data;
  check("الإجمالي أصبح 250 بعد التعديل", t2.goalTotal === 250, JSON.stringify(t2.goalTotal));
  const p2 = await req("/api/settings", { method: "PUT", cookie: sidCookie, body: { goal_amount: 5000, goal_currency: "ILS" } });
  check("تعديل الهدف إلى 5000", p2.status === 200);
  const t3 = (await req("/api/totals")).data;
  check("نسبة التقدم = 250/5000 = 5%", Math.abs(t3.progress - 5) < 0.001, JSON.stringify(t3.progress));

  console.log("4) دقة الإحصائيات");
  const statsR = await req("/api/stats?currency=ILS&from=2026-10-10&to=2026-10-10", { cookie: sidCookie });
  const st = statsR.data;
  check("إجمالي ILS في الفترة = 250", st.summary.total === 250 && st.summary.count === 1, JSON.stringify(st.summary));
  check("رسم الساعة: الساعة 10 بها 250", st.byHour[10].total === 250 && st.byHour[11].total === 0 && st.byHour[12].total === 0, JSON.stringify(st.byHour.slice(9, 13)));
  const expectedWd = new Date("2026-10-10T00:00:00").getDay();
  const wdCheck = await req("/api/stats?currency=ILS", { cookie: sidCookie });
  check("أيام الأسبوع لا تخلط العملات", wdCheck.data.byWeekday[expectedWd].total === 250, `wd=${expectedWd} = ${JSON.stringify(wdCheck.data.byWeekday[expectedWd])}`);
  const jodStats = await req("/api/stats?currency=JOD", { cookie: sidCookie });
  check("إجمالي JOD منفصل = 50", jodStats.data.summary.total === 50, JSON.stringify(jodStats.data.summary));
  const usdStats = await req("/api/stats?currency=USD", { cookie: sidCookie });
  check("إجمالي USD منفصل = 25", usdStats.data.summary.total === 25, JSON.stringify(usdStats.data.summary));
  check("إجمالي ILS لا يتسرب إلى JOD", jodStats.data.summary.total === 50 && usdStats.data.summary.total === 25);

  console.log("5) التحديث المباشر (SSE)");
  const ac = new AbortController();
  const streamRes = await fetch(BASE + "/api/stream", { signal: ac.signal });
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawSnapshot = false;
  let sawCelebrate = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(sawSnapshot && sawCelebrate)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.slice(-20000);
    if (!sawSnapshot && buf.includes("event: snapshot") && buf.includes('"goalTotal"')) sawSnapshot = true;
    if (!sawCelebrate) {
      const idx = buf.lastIndexOf("event: celebrate");
      if (idx !== -1) {
        const dataIdx = buf.indexOf("data: ", idx);
        if (dataIdx !== -1) {
          const lineEnd = buf.indexOf("\n", dataIdx);
          const payload = buf.slice(dataIdx + 6, lineEnd);
          if (payload.includes("يذكر") || payload.length > 10) sawCelebrate = true;
        }
      }
    }
  }
  check("وصول لقطة أولية عبر SSE", sawSnapshot);
  const d2 = await addDonation(7, "ILS", "2026-10-10T13:00:00", "اختبار SSE");
  check("إضافة تبرع محفّز للاحتفال", d2.status === 201);
  const celDeadline = Date.now() + 5000;
  while (Date.now() < celDeadline && !sawCelebrate) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.slice(-20000);
    if (!sawCelebrate) {
      const idx = buf.lastIndexOf("event: celebrate");
      if (idx !== -1) {
        const dataIdx = buf.indexOf("data: ", idx);
        if (dataIdx !== -1) {
          const lineEnd = buf.indexOf("\n", dataIdx);
          const payload = buf.slice(dataIdx + 6, lineEnd);
          if (payload.length > 10) sawCelebrate = true;
        }
      }
    }
  }
  check("وصول حدث الاحتفال عبر SSE بعد الإضافة", sawCelebrate);
  ac.abort();

  console.log("6) تغيير كلمة المرور");
  const cp = await req("/api/change-password", { method: "POST", cookie: sidCookie, body: { oldPassword: "admin", newPassword: "test123" } });
  check("تغيير كلمة المرور ناجح", cp.status === 200, `status=${cp.status}`);
  const oldLogin = await req("/api/login", { method: "POST", body: { username: "admin", password: "admin" } });
  check("رفض كلمة المرور القديمة بعد التغيير", oldLogin.status === 401, `status=${oldLogin.status}`);
  const newLogin = await req("/api/login", { method: "POST", body: { username: "admin", password: "test123" } });
  check("نجاح تسجيل الدخول بكلمة المرور الجديدة", newLogin.status === 200, `status=${newLogin.status}`);
  const cpBad = await req("/api/change-password", { method: "POST", cookie: sidCookie, body: { oldPassword: "wrong", newPassword: "x12345" } });
  check("رفض تغيير كلمة المرور بممر قديم خاطئ", cpBad.status === 401, `status=${cpBad.status}`);

  console.log("7) التنظيف واستعادة الحالة");
  for (const d of created) {
    await req("/api/donations/" + d.id, { method: "DELETE", cookie: sidCookie });
  }
  const tFinal = (await req("/api/campaign")).data;
  check("القاعدة عادت فارغة تمامًا", tFinal.totals.operations === 0 && tFinal.totals.byCurrency.length === 0 && tFinal.goalTotal === 0, JSON.stringify(tFinal.totals));

  const { hashPassword } = require("./server/auth");
  await store.setSetting("admin_password_hash", hashPassword("admin"));
  await store.setSetting("must_change_password", "1");
  check("استعادة كلمة المرور إلى admin مع تفعيل تنبيه التغيير", (await store.getSetting("admin_password_hash")).startsWith("scrypt$") && (await store.getSetting("must_change_password")) === "1");

  const restoreSettings = await req("/api/settings", { method: "PUT", cookie: sidCookie, body: { goal_amount: 100000, goal_currency: "ILS" } });
  check("استعادة هدف الحملة الافتراضي", restoreSettings.status === 200, `status=${restoreSettings.status}`);

  console.log("");
  console.log(`النتيجة: ${passed} نجح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("خطأ في الاختبار:", err);
  process.exit(1);
});