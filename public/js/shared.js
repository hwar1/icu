/* أدوات مشتركة: تنسيق الأرقام، SSE، استدعاء الواجهات */
"use strict";

const App = (() => {
  const CURRENCIES = {
    ILS: "شيكل",
    JOD: "دينار أردني",
    USD: "دولار أمريكي",
    EUR: "يورو",
    GBP: "جنيه إسترليني",
    SAR: "ريال سعودي",
    AED: "درهم إماراتي",
    EGP: "جنيه مصري",
    CAD: "دولار كندي",
    KWD: "دينار كويتي",
    QAR: "ريال قطري",
  };

  const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  function formatNumber(value, maxFrac = 2) {
    const n = Number(value) || 0;
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: maxFrac,
      minimumFractionDigits: 0,
    }).format(n);
  }

  function currencyName(code) {
    return CURRENCIES[code] || code;
  }

  function fmtMoney(value, code) {
    return `${formatNumber(value)} ${code}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function localDate(value) {
    if (!value) return "—";
    const s = String(value).replace(" ", "T");
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" });
  }

  function localTime(value) {
    if (!value) return "";
    const s = String(value).replace(" ", "T");
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
  }

  function toLocalInputValue(value) {
    const s = String(value || "").replace(" ", "T");
    return s.slice(0, 16);
  }

  /* عدّاد متحرك */
  function animateValue(el, from, to, duration = 1300) {
    if (el.dataset.anim === "1") {
      cancelAnimationFrame(Number(el._raf || 0));
    }
    if (from === to) {
      el.textContent = formatNumber(to);
      return;
    }
    el.dataset.anim = "1";
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = formatNumber(from + (to - from) * ease(t));
      if (t < 1) {
        el._raf = requestAnimationFrame(step);
      } else {
        el.dataset.anim = "0";
        el.textContent = formatNumber(to);
      }
    };
    el._raf = requestAnimationFrame(step);
  }

  /* طلب HTTP متوافق: fetch إن توفر، وإلا XMLHttpRequest (لمتصفحات التلفاز القديمة) */
  function httpRequest(path, options = {}) {
    const opts = { ...options };
    opts.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);

    if (typeof window.fetch === "function") {
      return fetch(path, opts).then(async (res) => {
        let data = null;
        try {
          data = await res.json();
        } catch (_e) {}
        if (!res.ok) {
          const err = new Error((data && data.error) || "حدث خطأ غير متوقع");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method || "GET", path, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (_e) {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error((data && data.error) || "حدث خطأ غير متوقع");
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => reject(new Error("تعذر الاتصال بالخادم"));
      xhr.send(opts.body);
    });
  }

  /* استدعاء API مع رسائل خطأ عربية */
  async function api(path, options = {}) {
    try {
      return await httpRequest(path, options);
    } catch (err) {
      if (err.status === 401 && !path.endsWith("/api/login")) {
        window.location.href = "/login?next=" + encodeURIComponent(location.pathname);
      }
      throw err;
    }
  }

  /* التحديث المباشر: SSE إن توفر، وإلا تحديث دوري كل 4 ثوانٍ */
  function stream({ onSnapshot, onCelebrate, onStatus } = {}) {
    if (typeof window.EventSource === "undefined") {
      const wrap = { mode: "poll", closed: false };
      let lastId = null;
      const tick = async () => {
        try {
          const s = await httpRequest("/api/campaign");
          if (wrap.closed) return;
          onStatus && onStatus(true);
          if (lastId !== null && s.totals.latest && s.totals.latest.id !== lastId) {
            onCelebrate && onCelebrate({ donation: s.totals.latest });
          }
          lastId = s.totals.latest ? s.totals.latest.id : null;
          onSnapshot && onSnapshot(s);
        } catch (_e) {
          onStatus && onStatus(false);
        }
      };
      tick();
      wrap._timer = setInterval(tick, 4000);
      wrap.close = () => {
        wrap.closed = true;
        clearInterval(wrap._timer);
      };
      return wrap;
    }

    let es;
    try {
      es = new EventSource("/api/stream");
    } catch (_e) {
      onStatus && onStatus(false);
      return { mode: "sse", close() {} };
    }
    es.mode = "sse";
    es.addEventListener("open", () => onStatus && onStatus(true));
    es.addEventListener("snapshot", (e) => {
      try {
        onSnapshot && onSnapshot(JSON.parse(e.data));
      } catch (_e) {}
    });
    es.addEventListener("celebrate", (e) => {
      try {
        onCelebrate && onCelebrate(JSON.parse(e.data));
      } catch (_e) {}
    });
    es.onerror = () => onStatus && onStatus(false);
    return es;
  }

  function setLive(el, ok) {
    if (!el) return;
    el.classList.toggle("off", !ok);
    el.querySelector(".label").textContent = ok ? "مباشر" : "جارٍ الاتصال…";
  }

  function alertBox(el, type, message) {
    if (!el) return;
    el.className = `alert ${type} show`;
    el.textContent = message;
  }

  function hideAlert(el) {
    if (!el) return;
    el.className = "alert";
  }

  function daysLeft(endDate) {
    if (!endDate) return null;
    const end = new Date(`${endDate}T23:59:59`);
    const diff = end.getTime() - Date.now();
    return Math.ceil(diff / 86400000);
  }

  return {
    CURRENCIES,
    WEEKDAYS,
    formatNumber,
    currencyName,
    fmtMoney,
    escapeHtml,
    localDate,
    localTime,
    toLocalInputValue,
    animateValue,
    api,
    stream,
    setLive,
    alertBox,
    hideAlert,
    daysLeft,
  };
})();
