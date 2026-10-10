/* لوحة الإدارة */
(() => {
  const $ = (id) => document.getElementById(id);

  let editingId = null;
  let rowsById = new Map();
  let refreshTimer = null;

  function nowInput() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const ok = (msg) => App.alertBox($("alert"), "ok", msg);
  const fail = (err) => App.alertBox($("alert"), "err", err.message || String(err));
  const clear = () => App.hideAlert($("alert"));

  /* ---------- جلب وإعرض العمليات ---------- */

  async function loadDonations() {
    const data = await App.api("/api/donations?limit=200");
    rowsById = new Map(data.items.map((d) => [d.id, d]));
    $("listCount").textContent = `(${App.formatNumber(data.total, 0)} عملية)`;

    const body = $("donationsBody");
    if (!data.items.length) {
      body.innerHTML = "";
      $("emptyState").classList.remove("hidden");
      return;
    }
    $("emptyState").classList.add("hidden");
    body.innerHTML = data.items
      .map(
        (d) => `
      <tr>
        <td class="num muted">${d.id}</td>
        <td class="num gold" style="font-weight:700">${App.formatNumber(d.amount)}</td>
        <td>${App.escapeHtml(d.currency)}</td>
        <td class="muted">${App.escapeHtml(d.note) || "—"}</td>
        <td>${App.localDate(d.created_at)}</td>
        <td class="num">${App.localTime(d.created_at)}</td>
        <td>
          <div class="actions">
            <button class="btn btn-ghost btn-sm" data-edit="${d.id}">تعديل</button>
            <button class="btn btn-danger btn-sm" data-del="${d.id}">حذف</button>
          </div>
        </td>
      </tr>`
      )
      .join("");
  }

  /* ---------- نموذج الإضافة/التعديل ---------- */

  function selectedCurrency() {
    const sel = $("currency").value;
    if (sel === "OTHER") return $("customCurrency").value.trim();
    return sel;
  }

  function fillForm(d) {
    editingId = d.id;
    $("amount").value = d.amount;
    const known = Array.from($("currency").options).some((o) => o.value === d.currency);
    if (known) {
      $("currency").value = d.currency;
      $("customWrap").classList.add("hidden");
    } else {
      $("currency").value = "OTHER";
      $("customCurrency").value = d.currency;
      $("customWrap").classList.remove("hidden");
    }
    $("donatedAt").value = App.toLocalInputValue(d.created_at);
    $("note").value = d.note || "";
    $("formTitle").textContent = `تعديل العملية رقم ${d.id}`;
    $("submitBtn").textContent = "حفظ التعديل";
    $("cancelEdit").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    editingId = null;
    $("donationForm").reset();
    $("donatedAt").value = nowInput();
    $("customWrap").classList.add("hidden");
    $("formTitle").textContent = "تسجيل تبرع جديد";
    $("submitBtn").textContent = "إضافة التبرع";
    $("cancelEdit").classList.add("hidden");
  }

  $("currency").addEventListener("change", () => {
    const other = $("currency").value === "OTHER";
    $("customWrap").classList.toggle("hidden", !other);
    if (other) $("customCurrency").focus();
  });

  $("donationForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    try {
      const currency = selectedCurrency();
      if (!currency) throw new Error("أدخل اسم العملة");
      const body = {
        amount: $("amount").value,
        currency,
        note: $("note").value,
        created_at: $("donatedAt").value,
      };
      if (editingId) {
        await App.api(`/api/donations/${editingId}`, { method: "PUT", body });
        ok("تم حفظ التعديل");
      } else {
        await App.api("/api/donations", { method: "POST", body });
        ok("تم تسجيل التبرع بنجاح");
      }
      resetForm();
      await loadDonations();
    } catch (err) {
      fail(err);
    }
  });

  $("cancelEdit").addEventListener("click", resetForm);

  $("donationsBody").addEventListener("click", async (e) => {
    const editId = e.target.dataset?.edit;
    const delId = e.target.dataset?.del;
    if (editId) {
      const d = rowsById.get(Number(editId));
      if (d) fillForm(d);
      return;
    }
    if (delId) {
      const d = rowsById.get(Number(delId));
      if (!d) return;
      const sure = confirm(
        `حذف العملية رقم ${d.id} بمبلغ ${App.formatNumber(d.amount)} ${d.currency}؟`
      );
      if (!sure) return;
      clear();
      try {
        await App.api(`/api/donations/${delId}`, { method: "DELETE" });
        ok("تم حذف العملية");
        if (editingId === Number(delId)) resetForm();
        await loadDonations();
      } catch (err) {
        fail(err);
      }
    }
  });

  /* ---------- إعدادات الحملة ---------- */

  async function loadSettings() {
    const s = await App.api("/api/settings");
    $("goalAmount").value = s.goal_amount;
    $("goalCurrency").value = s.goal_currency;
    $("startDate").value = s.start_date;
    $("endDate").value = s.end_date;
    $("campaignTitle").value = s.campaign_title;
    $("pwWarn").classList.toggle("hidden", s.must_change_password !== "1");
  }

  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    try {
      await App.api("/api/settings", {
        method: "PUT",
        body: {
          goal_amount: $("goalAmount").value,
          goal_currency: $("goalCurrency").value.trim().toUpperCase(),
          start_date: $("startDate").value,
          end_date: $("endDate").value,
          campaign_title: $("campaignTitle").value.trim(),
        },
      });
      ok("تم حفظ إعدادات الحملة");
    } catch (err) {
      fail(err);
    }
  });

  /* ---------- تغيير كلمة المرور ---------- */

  $("passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    try {
      await App.api("/api/change-password", {
        method: "POST",
        body: {
          oldPassword: $("oldPassword").value,
          newPassword: $("newPassword").value,
        },
      });
      $("passwordForm").reset();
      $("pwWarn").classList.add("hidden");
      ok("تم تغيير كلمة المرور بنجاح");
    } catch (err) {
      fail(err);
    }
  });

  /* ---------- خروج ---------- */

  $("logoutBtn").addEventListener("click", async () => {
    try {
      await App.api("/api/logout", { method: "POST" });
    } finally {
      location.href = "/";
    }
  });

  /* ---------- التحديث المباشر ---------- */

  App.stream({
    onSnapshot: () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadDonations().catch(() => {}), 400);
    },
    onStatus: (s) => App.setLive($("live"), s),
  });

  /* ---------- بدء التشغيل ---------- */

  $("donatedAt").value = nowInput();
  loadDonations().catch(fail);
  loadSettings().catch(() => {});
})();
