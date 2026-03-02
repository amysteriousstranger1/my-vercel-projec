(function () {
  "use strict";

  const STORAGE_KEYS = {
    settings: "df_reacher_settings_v3",
    events: "df_reacher_events_v3"
  };

  const BULK_API_BASE = "/bulk-api";
  const EMAIL_SIMPLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_EVENTS = 80000;

  const DEFAULT_BASE_URL =
    window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin
      : "https://reacher.dealfactory.pro";

  const state = {
    settings: {
      baseUrl: DEFAULT_BASE_URL,
      authMode: "secret",
      apiKey: ""
    },
    events: [],
    selectedFile: null,
    runs: [],
    activeRunId: null,
    pollTimer: null,
    runCountersSnapshot: new Map(),
    snapshotReady: false,
    charts: {
      week: null,
      month: null,
      year: null
    }
  };

  function q(id) {
    return document.getElementById(id);
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_error) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  }

  function statusInfo(status) {
    const value = String(status || "unknown").toLowerCase();
    if (value === "safe") return { key: "safe", text: "Email is safe and deliverable." };
    if (value === "risky") return { key: "risky", text: "Email is risky. Use with caution." };
    if (value === "invalid") return { key: "invalid", text: "Email appears invalid." };
    return { key: "unknown", text: "Reachability is unknown." };
  }

  function boolText(value) {
    if (value === true) return "YES";
    if (value === false) return "NO";
    return "-";
  }

  function durationMs(duration) {
    if (!duration || typeof duration !== "object") return "";
    const secs = Number(duration.secs || 0);
    const nanos = Number(duration.nanos || 0);
    return String(Math.round((secs * 1000) + (nanos / 1000000)));
  }

  function flattenResponse(email, payload, errorMessage) {
    if (errorMessage) {
      return {
        email,
        normalized_email: "",
        is_reachable: "unknown",
        safe_to_send: "NO",
        syntax_valid: "-",
        mx_accepts_mail: "-",
        smtp_can_connect: "-",
        smtp_is_deliverable: "-",
        smtp_is_catch_all: "-",
        misc_role_account: "-",
        misc_disposable: "-",
        misc_b2c: "-",
        duration_ms: "",
        error: String(errorMessage)
      };
    }

    const syntax = payload && payload.syntax ? payload.syntax : {};
    const mx = payload && payload.mx ? payload.mx : {};
    const smtp = payload && payload.smtp ? payload.smtp : {};
    const misc = payload && payload.misc ? payload.misc : {};
    const debug = payload && payload.debug ? payload.debug : {};

    return {
      email,
      normalized_email: syntax.normalized_email || "",
      is_reachable: (payload && payload.is_reachable) || "unknown",
      safe_to_send: ((payload && payload.is_reachable) === "safe") ? "YES" : "NO",
      syntax_valid: boolText(syntax.is_valid_syntax),
      mx_accepts_mail: boolText(mx.accepts_mail),
      smtp_can_connect: boolText(smtp.can_connect_smtp),
      smtp_is_deliverable: boolText(smtp.is_deliverable),
      smtp_is_catch_all: boolText(smtp.is_catch_all),
      misc_role_account: boolText(misc.is_role_account),
      misc_disposable: boolText(misc.is_disposable),
      misc_b2c: boolText(misc.is_b2c),
      duration_ms: durationMs(debug.duration),
      error: ""
    };
  }

  function saveEvents() {
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }
    saveJSON(STORAGE_KEYS.events, state.events);
  }

  function addEvent(source, status, count = 1) {
    const safeCount = Number(count || 0);
    if (!safeCount || safeCount < 0) return;

    state.events.push({
      ts: Date.now(),
      source,
      status: String(status || "unknown").toLowerCase(),
      count: safeCount
    });
    saveEvents();
    renderAnalytics();
  }

  function setNavActive() {
    const page = document.body.getAttribute("data-page") || "verification";
    document.querySelectorAll("[data-nav-target]").forEach((link) => {
      const target = link.getAttribute("data-nav-target");
      link.classList.toggle("active", target === page);
    });
  }

  function initMobileMenu() {
    const sidebar = q("sidebar");
    const menuBtn = q("mobileMenuBtn");
    if (!sidebar || !menuBtn) return;

    menuBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    document.querySelectorAll("[data-nav-target]").forEach((link) => {
      link.addEventListener("click", () => {
        sidebar.classList.remove("open");
      });
    });
  }

  function getHeaders() {
    const headers = { "Content-Type": "application/json" };
    const key = String(state.settings.apiKey || "").trim();

    if (state.settings.authMode === "secret" && key) {
      headers["x-reacher-secret"] = key;
    } else if (state.settings.authMode === "authorization" && key) {
      headers.Authorization = key;
    }

    return headers;
  }

  async function verifySingleEmail(email) {
    const response = await fetch(normalizeUrl(state.settings.baseUrl) + "/v1/check_email", {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ to_email: email })
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      const message =
        (payload && (payload.error || payload.message)) ||
        text ||
        ("Request failed with HTTP " + response.status);
      throw new Error(message);
    }

    return payload || {};
  }

  function applyApiSettingsToUi() {
    const baseInput = q("apiBaseUrlInput");
    const modeInput = q("apiAuthModeInput");
    const keyInput = q("apiKeyInput");
    if (!baseInput || !modeInput || !keyInput) return;

    baseInput.value = state.settings.baseUrl;
    modeInput.value = state.settings.authMode;
    keyInput.value = state.settings.apiKey;
  }

  function readApiSettingsFromUi() {
    const baseInput = q("apiBaseUrlInput");
    const modeInput = q("apiAuthModeInput");
    const keyInput = q("apiKeyInput");
    if (!baseInput || !modeInput || !keyInput) return;

    state.settings = {
      baseUrl: normalizeUrl(baseInput.value || DEFAULT_BASE_URL),
      authMode: String(modeInput.value || "none"),
      apiKey: String(keyInput.value || "")
    };

    saveJSON(STORAGE_KEYS.settings, state.settings);
  }

  function initApiPage() {
    const saveBtn = q("apiSaveBtn");
    const testBtn = q("apiTestBtn");
    const statusBox = q("apiStatusBox");
    if (!saveBtn || !testBtn || !statusBox) return;

    applyApiSettingsToUi();

    saveBtn.addEventListener("click", () => {
      readApiSettingsFromUi();
      statusBox.textContent = "Saved. Settings are stored in browser memory.";
    });

    testBtn.addEventListener("click", async () => {
      readApiSettingsFromUi();
      testBtn.disabled = true;
      testBtn.textContent = "Testing...";
      statusBox.textContent = "Testing API connection...";

      try {
        const payload = await verifySingleEmail("test@gmail.com");
        statusBox.textContent = "Success. API response status: " + String(payload.is_reachable || "unknown") + ".";
      } catch (error) {
        statusBox.textContent = "Failed. " + (error instanceof Error ? error.message : String(error));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test API";
      }
    });
  }

  async function bulkRequest(path, options = {}) {
    const response = await fetch(BULK_API_BASE + path, options);
    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      const message =
        (payload && (payload.error || payload.message)) ||
        text ||
        ("Request failed with HTTP " + response.status);
      throw new Error(message);
    }

    return payload || {};
  }

  function statusTagClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "completed") return "completed";
    if (value === "cancelled") return "cancelled";
    return "running";
  }

  function setBulkMeta(data) {
    const meta = q("bulkMeta");
    const progress = q("bulkProgressBar");
    if (!meta || !progress) return;

    const total = Number(data.total || 0);
    const processed = Number(data.processed || 0);

    const rows = [
      "<div><strong>File:</strong> " + escapeHtml(data.fileName || "-") + "</div>",
      "<div><strong>Unique emails:</strong> " + String(total) + "</div>",
      "<div><strong>Processed:</strong> " + String(processed) + " / " + String(total) + "</div>",
      "<div><strong>Status:</strong> " + escapeHtml(data.status || "idle") + "</div>"
    ];

    if (total > 0) {
      rows.push(
        "<div class=\"stack\">" +
          "<span class=\"pill safe\">safe " + String(data.safe || 0) + "</span>" +
          "<span class=\"pill risky\">risky " + String(data.risky || 0) + "</span>" +
          "<span class=\"pill invalid\">invalid " + String(data.invalid || 0) + "</span>" +
          "<span class=\"pill unknown\">unknown " + String(data.unknown || 0) + "</span>" +
        "</div>"
      );
    }

    meta.innerHTML = rows.join("");
    progress.style.width = total > 0 ? String(Math.round((processed / total) * 100)) + "%" : "0%";
  }

  function renderRunsTable() {
    const tbody = q("runsTableBody");
    const wrap = q("runsWrap");
    const empty = q("runsEmpty");
    const searchInput = q("runsSearchInput");
    const sortInput = q("runsSortInput");
    if (!tbody || !wrap || !empty || !searchInput || !sortInput) return;

    const query = String(searchInput.value || "").trim().toLowerCase();
    const sortBy = String(sortInput.value || "newest");

    let rows = state.runs.slice();
    if (query) {
      rows = rows.filter((run) => String(run.fileName || "").toLowerCase().includes(query));
    }

    rows.sort((a, b) => {
      if (sortBy === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sortBy === "name") return String(a.fileName || "").localeCompare(String(b.fileName || ""));
      if (sortBy === "safeRate") {
        const rateA = a.total ? Number(a.safe || 0) / Number(a.total || 1) : 0;
        const rateB = b.total ? Number(b.safe || 0) / Number(b.total || 1) : 0;
        return rateB - rateA;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    if (!rows.length) {
      empty.style.display = "block";
      wrap.style.display = "none";
      return;
    }

    empty.style.display = "none";
    wrap.style.display = "block";

    tbody.innerHTML = rows.map((run) => {
      const safeRate = run.total ? Math.round((Number(run.safe || 0) / Number(run.total || 1)) * 100) : 0;
      const ready = Boolean(run.downloadsReady);
      return (
        "<tr>" +
          "<td>" + escapeHtml(run.fileName || "-") + "<br><span class=\"small-muted\">" + new Date(run.createdAt).toLocaleString() + "</span></td>" +
          "<td>" + String(run.total || 0) + "</td>" +
          "<td>" + String(run.safe || 0) + " (" + String(safeRate) + "%)</td>" +
          "<td>" + String(run.risky || 0) + "</td>" +
          "<td>" + String(run.invalid || 0) + "</td>" +
          "<td>" + String(run.unknown || 0) + "</td>" +
          "<td>" + String(run.processed || 0) + "</td>" +
          "<td><span class=\"tag " + statusTagClass(run.status) + "\">" + escapeHtml(run.status || "-") + "</span></td>" +
          "<td>" + (ready
            ? "<span class=\"inline-actions\"><a href=\"" + BULK_API_BASE + "/jobs/" + run.id + "/download.csv\">CSV</a><a href=\"" + BULK_API_BASE + "/jobs/" + run.id + "/download.json\">JSON</a></span>"
            : "<span class=\"small-muted\">processing...</span>") + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function applyRunsDeltaToAnalytics(runs, baseline = false) {
    if (baseline || !state.snapshotReady) {
      state.runCountersSnapshot.clear();
      for (const run of runs) {
        state.runCountersSnapshot.set(run.id, {
          safe: Number(run.safe || 0),
          risky: Number(run.risky || 0),
          invalid: Number(run.invalid || 0),
          unknown: Number(run.unknown || 0)
        });
      }
      state.snapshotReady = true;
      return;
    }

    for (const run of runs) {
      const prev = state.runCountersSnapshot.get(run.id) || { safe: 0, risky: 0, invalid: 0, unknown: 0 };
      const next = {
        safe: Number(run.safe || 0),
        risky: Number(run.risky || 0),
        invalid: Number(run.invalid || 0),
        unknown: Number(run.unknown || 0)
      };

      const deltaSafe = next.safe - prev.safe;
      const deltaRisky = next.risky - prev.risky;
      const deltaInvalid = next.invalid - prev.invalid;
      const deltaUnknown = next.unknown - prev.unknown;

      if (deltaSafe > 0) addEvent("bulk", "safe", deltaSafe);
      if (deltaRisky > 0) addEvent("bulk", "risky", deltaRisky);
      if (deltaInvalid > 0) addEvent("bulk", "invalid", deltaInvalid);
      if (deltaUnknown > 0) addEvent("bulk", "unknown", deltaUnknown);

      state.runCountersSnapshot.set(run.id, next);
    }
  }

  function hasRunningJobs() {
    return state.runs.some((run) => ["queued", "running", "cancelling"].includes(String(run.status || "")));
  }

  function syncActiveRunUi() {
    const startBtn = q("bulkStartBtn");
    const cancelBtn = q("bulkCancelBtn");

    const active = state.runs.find((run) => run.id === state.activeRunId) ||
      state.runs.find((run) => ["queued", "running", "cancelling"].includes(String(run.status || "")));

    if (active) {
      state.activeRunId = active.id;
      setBulkMeta(active);
      if (cancelBtn) cancelBtn.disabled = !["queued", "running", "cancelling"].includes(String(active.status || ""));
    } else {
      if (state.selectedFile) {
        setBulkMeta({
          fileName: state.selectedFile.name,
          total: 0,
          processed: 0,
          status: "Ready to upload"
        });
      } else {
        setBulkMeta({ fileName: "-", total: 0, processed: 0, status: "idle" });
      }
      if (cancelBtn) cancelBtn.disabled = true;
      state.activeRunId = null;
    }

    if (startBtn) startBtn.disabled = !state.selectedFile;
  }

  async function refreshRunsFromServer(options = {}) {
    const payload = await bulkRequest("/jobs");
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    applyRunsDeltaToAnalytics(jobs, Boolean(options.baseline));
    state.runs = jobs;
    renderRunsTable();
    syncActiveRunUi();

    if (hasRunningJobs()) {
      startPollingRuns();
    } else {
      stopPollingRuns();
    }
  }

  function startPollingRuns() {
    if (state.pollTimer) return;
    state.pollTimer = window.setInterval(() => {
      refreshRunsFromServer().catch(() => {
        // keep silent and retry on next tick
      });
    }, 2200);
  }

  function stopPollingRuns() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function setSingleResult(email, payload, errorMessage) {
    const empty = q("singleEmpty");
    const panel = q("singleResult");
    const emailEl = q("singleEmailValue");
    const statusEl = q("singleStatus");
    const descEl = q("singleDesc");
    const detailEl = q("singleDetailGrid");
    if (!empty || !panel || !emailEl || !statusEl || !descEl || !detailEl) return;

    empty.style.display = "none";
    panel.style.display = "block";

    const flat = flattenResponse(email, payload, errorMessage || "");
    const info = statusInfo(flat.is_reachable);

    emailEl.textContent = email;
    statusEl.className = "pill " + info.key;
    statusEl.textContent = info.key;
    descEl.textContent = errorMessage ? String(errorMessage) : info.text;

    const details = [
      ["Normalized", flat.normalized_email || "-"],
      ["Reachability", flat.is_reachable],
      ["Safe to send", flat.safe_to_send],
      ["Syntax valid", flat.syntax_valid],
      ["MX accepts mail", flat.mx_accepts_mail],
      ["SMTP connect", flat.smtp_can_connect],
      ["SMTP deliverable", flat.smtp_is_deliverable],
      ["Catch-all", flat.smtp_is_catch_all],
      ["Role account", flat.misc_role_account],
      ["Disposable", flat.misc_disposable],
      ["B2C", flat.misc_b2c],
      ["Duration ms", flat.duration_ms || "-"]
    ];

    detailEl.innerHTML = details
      .map(([k, v]) => "<div class=\"detail-row\"><span>" + escapeHtml(k) + "</span><span>" + escapeHtml(v) + "</span></div>")
      .join("");
  }

  function initVerificationPage() {
    const singleInput = q("singleEmailInput");
    const singleBtn = q("singleVerifyBtn");
    const fileInput = q("bulkFileInput");
    const startBtn = q("bulkStartBtn");
    const cancelBtn = q("bulkCancelBtn");
    const searchInput = q("runsSearchInput");
    const sortInput = q("runsSortInput");
    if (!singleInput || !singleBtn || !fileInput || !startBtn || !cancelBtn || !searchInput || !sortInput) return;

    setBulkMeta({ fileName: "-", total: 0, processed: 0, status: "idle" });

    singleBtn.addEventListener("click", async () => {
      const email = String(singleInput.value || "").trim().toLowerCase();
      if (!EMAIL_SIMPLE.test(email)) {
        setSingleResult(email || "-", null, "Invalid email format.");
        return;
      }

      singleBtn.disabled = true;
      singleBtn.textContent = "Checking...";
      try {
        const payload = await verifySingleEmail(email);
        setSingleResult(email, payload, "");
        addEvent("single", payload.is_reachable || "unknown", 1);
      } catch (error) {
        setSingleResult(email, null, error instanceof Error ? error.message : String(error));
        addEvent("single", "unknown", 1);
      } finally {
        singleBtn.disabled = false;
        singleBtn.textContent = "Verify";
      }
    });

    singleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        singleBtn.click();
      }
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      state.selectedFile = file || null;

      if (state.selectedFile) {
        setBulkMeta({
          fileName: state.selectedFile.name,
          total: 0,
          processed: 0,
          status: "File selected. Click Start bulk verification."
        });
      } else {
        setBulkMeta({ fileName: "-", total: 0, processed: 0, status: "idle" });
      }
      startBtn.disabled = !state.selectedFile;
    });

    startBtn.addEventListener("click", async () => {
      if (!state.selectedFile) return;

      startBtn.disabled = true;
      startBtn.textContent = "Uploading...";

      try {
        const data = new FormData();
        data.append("file", state.selectedFile);
        data.append("baseUrl", state.settings.baseUrl);
        data.append("authMode", state.settings.authMode);
        data.append("apiKey", state.settings.apiKey);

        const payload = await bulkRequest("/jobs", {
          method: "POST",
          body: data
        });

        if (payload && payload.job) {
          state.activeRunId = payload.job.id;
          setBulkMeta(payload.job);
        }

        await refreshRunsFromServer();
      } catch (error) {
        setBulkMeta({
          fileName: state.selectedFile.name,
          total: 0,
          processed: 0,
          status: "Upload failed: " + (error instanceof Error ? error.message : String(error))
        });
      } finally {
        startBtn.disabled = !state.selectedFile;
        startBtn.textContent = "Start bulk verification";
      }
    });

    cancelBtn.addEventListener("click", async () => {
      const running = state.runs.find((run) => run.id === state.activeRunId) ||
        state.runs.find((run) => ["queued", "running", "cancelling"].includes(String(run.status || "")));
      if (!running) return;

      cancelBtn.disabled = true;
      try {
        await bulkRequest("/jobs/" + running.id + "/cancel", { method: "POST" });
        await refreshRunsFromServer();
      } catch (_error) {
        // ignore ui error and wait for next poll
      }
    });

    searchInput.addEventListener("input", renderRunsTable);
    sortInput.addEventListener("change", renderRunsTable);

    refreshRunsFromServer({ baseline: true }).catch(() => {
      setBulkMeta({ fileName: "-", total: 0, processed: 0, status: "Cannot connect to bulk-api" });
    });
  }

  function totalEventsCount(events) {
    return events.reduce((sum, item) => sum + Number(item.count || 1), 0);
  }

  function countByDay(events, key) {
    return events.reduce((sum, item) => {
      const eventKey = new Date(item.ts).toISOString().slice(0, 10);
      if (eventKey === key) {
        return sum + Number(item.count || 1);
      }
      return sum;
    }, 0);
  }

  function createChart(canvas, oldChart, type, labels, data, color) {
    if (!canvas || !window.Chart) return null;
    if (oldChart) oldChart.destroy();

    return new window.Chart(canvas, {
      type,
      data: {
        labels,
        datasets: [{
          data,
          borderColor: color,
          backgroundColor: color + "2e",
          borderWidth: 2,
          fill: type === "line",
          tension: 0.25,
          pointRadius: type === "line" ? 2 : 0
        }]
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { maxRotation: 0, autoSkip: true } }
        }
      }
    });
  }

  function renderAnalytics() {
    const metricWeek = q("metricWeek");
    const metricMonth = q("metricMonth");
    const metricYear = q("metricYear");
    const weekCanvas = q("weekChart");
    const monthCanvas = q("monthChart");
    const yearCanvas = q("yearChart");
    if (!metricWeek || !metricMonth || !metricYear || !weekCanvas || !monthCanvas || !yearCanvas) return;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const last7 = state.events.filter((item) => item.ts >= now - (7 * dayMs));
    const last30 = state.events.filter((item) => item.ts >= now - (30 * dayMs));
    const last365 = state.events.filter((item) => item.ts >= now - (365 * dayMs));

    metricWeek.textContent = String(totalEventsCount(last7));
    metricMonth.textContent = String(totalEventsCount(last30));
    metricYear.textContent = String(totalEventsCount(last365));

    const weekLabels = [];
    const weekData = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      weekLabels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
      weekData.push(countByDay(last7, key));
    }

    const monthLabels = [];
    const monthData = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      monthLabels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      monthData.push(countByDay(last30, key));
    }

    const yearLabels = [];
    const yearData = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date();
      d.setMonth(d.getMonth() - i, 1);
      const month = d.getMonth();
      const year = d.getFullYear();
      yearLabels.push(d.toLocaleDateString(undefined, { month: "short", year: "numeric" }));
      const count = last365.reduce((sum, item) => {
        const t = new Date(item.ts);
        if (t.getMonth() === month && t.getFullYear() === year) {
          return sum + Number(item.count || 1);
        }
        return sum;
      }, 0);
      yearData.push(count);
    }

    state.charts.week = createChart(weekCanvas, state.charts.week, "bar", weekLabels, weekData, "#fe5906");
    state.charts.month = createChart(monthCanvas, state.charts.month, "line", monthLabels, monthData, "#1f49d8");
    state.charts.year = createChart(yearCanvas, state.charts.year, "bar", yearLabels, yearData, "#f27a3b");
  }

  function initAnalyticsPage() {
    renderAnalytics();
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEYS.events) return;
      state.events = loadJSON(STORAGE_KEYS.events, []);
      renderAnalytics();
    });
  }

  function loadState() {
    const savedSettings = loadJSON(STORAGE_KEYS.settings, null);
    if (savedSettings && typeof savedSettings === "object") {
      state.settings = {
        baseUrl: normalizeUrl(savedSettings.baseUrl || DEFAULT_BASE_URL),
        authMode: savedSettings.authMode || "secret",
        apiKey: savedSettings.apiKey || ""
      };
    }

    const savedEvents = loadJSON(STORAGE_KEYS.events, []);
    if (Array.isArray(savedEvents)) {
      state.events = savedEvents
        .filter((item) => item && typeof item.ts === "number")
        .map((item) => ({
          ts: item.ts,
          source: item.source || "single",
          status: item.status || "unknown",
          count: Number(item.count || 1)
        }))
        .slice(-MAX_EVENTS);
    }
  }

  function init() {
    loadState();
    setNavActive();
    initMobileMenu();
    initApiPage();
    initVerificationPage();
    initAnalyticsPage();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
