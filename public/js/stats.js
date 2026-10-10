/* صفحة الإحصائيات */
(() => {
  const $ = (id) => document.getElementById(id);

  let currency = "";
  let period = "all";
  let charts = {};
  let refreshTimer = null;
  let lastStats = null;

  if (window.Chart) {
    Chart.defaults.font.family = "'Tajawal', sans-serif";
    Chart.defaults.color = "#9fb0c7";
  }

  function ymd(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function range() {
    if (period === "today") return { from: ymd(), to: ymd() };
    if (period === "week") return { from: ymd(-6), to: ymd() };
    if (period === "month") return { from: ymd(-29), to: ymd() };
    if (period === "custom") {
      return { from: $("fromDate").value, to: $("toDate").value };
    }
    return { from: "", to: "" };
  }

  /* ---------- عناصر رسم بياني ---------- */

  const baseScales = () => ({
    x: {
      grid: { color: "rgba(255,255,255,0.05)" },
      ticks: { maxRotation: 0, autoSkip: true },
    },
    y: {
      beginAtZero: true,
      grid: { color: "rgba(255,255,255,0.07)" },
      ticks: {
        callback: (v) => App.formatNumber(v, 0),
      },
    },
  });

  const baseOptions = (title) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 900 },
    plugins: {
      legend: { display: false },
      title: { display: false },
      tooltip: {
        rtl: true,
        textDirection: "rtl",
        callbacks: {
          label: (ctx) => ` ${App.formatNumber(ctx.parsed.y ?? ctx.parsed)} ${currency}`,
        },
      },
    },
    scales: baseScales(),
  });

  function makeChart(id, config) {
    if (!window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  }

  /* ---------- الرسوم ---------- */

  function drawCumulative(s) {
    let labels = [];
    let values = [];

    if (s.cumulative.length > 1) {
      labels = s.cumulative.map((r) => App.localDate(r.day));
      values = s.cumulative.map((r) => r.cumulative);
    } else {
      let run = 0;
      labels = s.byHour.map((h) => `${String(h.hour).padStart(2, "0")}:00`);
      values = s.byHour.map((h) => {
        run += h.total;
        return run;
      });
    }

    makeChart("chartCumulative", {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: "#d4af37",
            backgroundColor: "rgba(212,175,55,0.14)",
            fill: true,
            tension: 0.35,
            pointRadius: values.length > 30 ? 0 : 4,
            pointBackgroundColor: "#d4af37",
            borderWidth: 3,
          },
        ],
      },
      options: baseOptions(),
    });
  }

  function drawHour(s) {
    makeChart("chartHour", {
      type: "bar",
      data: {
        labels: s.byHour.map((h) => String(h.hour).padStart(2, "0")),
        datasets: [
          {
            data: s.byHour.map((h) => h.total),
            backgroundColor: "rgba(212,175,55,0.7)",
            hoverBackgroundColor: "#d4af37",
            borderRadius: 6,
          },
        ],
      },
      options: baseOptions(),
    });
  }

  function drawWeekday(s) {
    makeChart("chartWeekday", {
      type: "bar",
      data: {
        labels: App.WEEKDAYS,
        datasets: [
          {
            data: s.byWeekday.map((w) => w.total),
            backgroundColor: "rgba(212,175,55,0.7)",
            hoverBackgroundColor: "#d4af37",
            borderRadius: 6,
          },
        ],
      },
      options: baseOptions(),
    });
  }

  function drawDate(s) {
    const card = $("dateCard");
    if (s.byDate.length <= 1) {
      card.classList.add("hidden");
      if (charts.chartDate) {
        charts.chartDate.destroy();
        delete charts.chartDate;
      }
      return;
    }
    card.classList.remove("hidden");
    makeChart("chartDate", {
      type: "bar",
      data: {
        labels: s.byDate.map((r) => App.localDate(r.day)),
        datasets: [
          {
            data: s.byDate.map((r) => r.total),
            backgroundColor: "rgba(212,175,55,0.7)",
            hoverBackgroundColor: "#d4af37",
            borderRadius: 6,
          },
        ],
      },
      options: baseOptions(),
    });
  }

  /* ---------- بطاقات وأرقام ---------- */

  function renderKpis(s) {
    const name = `${App.currencyName(s.currency)} (${s.currency})`;
    $("kpiTotal").textContent = App.formatNumber(s.summary.total);
    $("kpiCurrency").textContent = name;
    $("kpiCount").textContent = App.formatNumber(s.summary.count, 0);
    const avg = s.summary.count ? s.summary.total / s.summary.count : 0;
    $("kpiAvg").textContent = App.formatNumber(avg);
    $("kpiAvgCurrency").textContent = name;
    $("kpiAllOps").textContent = App.formatNumber(s.allTotals.operations, 0);
  }

  function renderCurrencyTable(s) {
    const rows = s.allTotals.byCurrency;
    const body = $("currencyBody");
    if (!rows.length) {
      body.innerHTML = "";
      $("currencyEmpty").classList.remove("hidden");
      return;
    }
    $("currencyEmpty").classList.add("hidden");
    body.innerHTML = rows
      .map((r) => {
        const active = r.currency === s.currency ? ' style="background: rgba(212,175,55,0.07)"' : "";
        return `<tr${active}>
          <td>${App.escapeHtml(App.currencyName(r.currency))} <span class="muted">(${App.escapeHtml(r.currency)})</span></td>
          <td class="num gold" style="font-weight:700">${App.formatNumber(r.total)}</td>
          <td class="num">${App.formatNumber(r.count, 0)}</td>
        </tr>`;
      })
      .join("");
  }

  function renderCurrencySeg(s) {
    const list = [];
    const goal = s.campaign.goalCurrency;
    if (goal) list.push(goal);
    for (const r of s.allTotals.byCurrency) {
      if (!list.includes(r.currency)) list.push(r.currency);
    }
    if (currency && !list.includes(currency)) list.push(currency);

    $("currencySeg").innerHTML = list
      .map(
        (c) =>
          `<button type="button" data-cur="${App.escapeHtml(c)}"` +
          `${c === currency ? ' class="active"' : ""}>${App.escapeHtml(c)}</button>`
      )
      .join("");
  }

  function render(s) {
    lastStats = s;
    renderKpis(s);
    renderCurrencySeg(s);
    renderCurrencyTable(s);
    drawCumulative(s);
    drawHour(s);
    drawWeekday(s);
    drawDate(s);
  }

  async function load() {
    try {
      const { from, to } = range();
      const q = new URLSearchParams({ currency, from, to });
      const s = await App.api("/api/stats?" + q.toString());
      render(s);
    } catch (err) {
      App.alertBox($("alert"), "err", err.message);
    }
  }

  /* ---------- عناصر التحكم ---------- */

  $("currencySeg").addEventListener("click", (e) => {
    const code = e.target.dataset?.cur;
    if (!code || code === currency) return;
    currency = code;
    load();
  });

  $("periodSeg").addEventListener("click", (e) => {
    const p = e.target.dataset?.period;
    if (!p) return;
    period = p;
    for (const b of $("periodSeg").querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.period === p);
    }
    $("customDates").classList.toggle("hidden", p !== "custom");
    if (p !== "custom") load();
  });

  $("applyDates").addEventListener("click", load);

  /* ---------- التحديث المباشر ---------- */

  App.stream({
    onSnapshot: () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(load, 500);
    },
    onStatus: (ok) => App.setLive($("live"), ok),
  });

  /* ---------- بدء التشغيل ---------- */

  (async () => {
    try {
      const data = await App.api("/api/campaign");
      currency = data.campaign.goalCurrency;
      $("fromDate").value = data.campaign.startDate;
      $("toDate").value = data.campaign.endDate;
      await load();
    } catch (err) {
      App.alertBox($("alert"), "err", err.message);
    }
  })();
})();
