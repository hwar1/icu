/* الشاشة العامة — التبرعات لحظيًا */
(() => {
  const $ = (id) => document.getElementById(id);

  let shownTotal = 0;
  let closeTimer = null;

  function renderTitle(title) {
    document.title = title;
    const safe = App.escapeHtml(title);
    $("campaignTitle").innerHTML = safe.replace(/الظاهرية/g, "<span>الظاهرية</span>");
  }

  function render(s) {
    const c = s.campaign;

    renderTitle(c.title);
    const sub = $("campaignSubtitle");
    if (sub) sub.textContent = c.subtitle || "";

    App.animateValue($("totalValue"), shownTotal, s.goalTotal);
    shownTotal = s.goalTotal;
    $("totalCurrency").textContent =
      `${App.currencyName(c.goalCurrency)} (${c.goalCurrency})`;

    $("others").innerHTML = s.others
      .map(
        (r) =>
          `<div class="chip">${App.escapeHtml(App.currencyName(r.currency))}` +
          ` <b class="num">${App.formatNumber(r.total)}</b> ${App.escapeHtml(r.currency)}</div>`
      )
      .join("");

    const start = App.localDate(c.startDate);
    const end = App.localDate(c.endDate);
    const left = App.daysLeft(c.endDate);
    let leftText = "";
    if (left !== null) {
      if (left > 1) leftText = `المتبقي: <b class="num">${left}</b> يوم`;
      else if (left === 1) leftText = "آخر يوم للحملة";
      else if (left === 0) leftText = "اليوم الأخير";
      else leftText = "انتهت مدة الحملة";
    }
    $("campaignMeta").innerHTML =
      `<span>البداية: <b>${start}</b></span>` +
      `<span>النهاية: <b>${end}</b></span>` +
      (leftText ? `<span>${leftText}</span>` : "");

    $("opCount").textContent = App.formatNumber(s.totals.operations, 0);
  }

  function celebrate({ donation }) {
    if (!donation) return;
    $("celAmount").textContent = App.formatNumber(donation.amount);
    $("celCurrency").textContent =
      `${App.currencyName(donation.currency)} (${donation.currency})`;
    $("celNote").textContent = donation.note ? donation.note : "";
    $("celebrate").classList.add("show");

    if (typeof confetti === "function") {
      const colors = ["#d4af37", "#f0d478", "#ffffff", "#1c3350"];
      confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 }, colors });
      setTimeout(
        () => confetti({ particleCount: 90, angle: 60, spread: 70, origin: { x: 0 }, colors }),
        350
      );
      setTimeout(
        () => confetti({ particleCount: 90, angle: 120, spread: 70, origin: { x: 1 }, colors }),
        650
      );
    }

    clearTimeout(closeTimer);
    closeTimer = setTimeout(hide, 9000);
  }

  function hide() {
    clearTimeout(closeTimer);
    $("celebrate").classList.remove("show");
  }

  $("celClose").addEventListener("click", hide);
  $("celebrate").addEventListener("click", (e) => {
    if (e.target === $("celebrate")) hide();
  });

  App.stream({
    onSnapshot: render,
    onCelebrate: celebrate,
    onStatus: (ok) => App.setLive($("live"), ok),
  });
})();
