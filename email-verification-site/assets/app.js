(function () {
  "use strict";

  const STORAGE_KEYS = {
    settings: "df_reacher_settings_v2",
    events: "df_reacher_events_v2",
    runs: "df_reacher_runs_v2"
  };

  const MAX_RUNS = 80;
  const MAX_EVENTS = 60000;
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
  const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    runs: [],
    artifacts: new Map(),
    parsedEmails: [],
    selectedFileName: "",
    isBulkRunning: false,
    cancelBulkRun: false,
    activeRun: null,
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

  function statusInfo(status) {
    const value = String(status || "unknown").toLowerCase();
    if (value === "safe") {
      return { key: "safe", text: "Email is safe and deliverable." };
    }
    if (value === "risky") {
      return { key: "risky", text: "Email is risky. Review before sending." };
    }
    if (value === "invalid") {
      return { key: "invalid", text: "Email appears invalid." };
    }
    return { key: "unknown", text: "Reachability is unknown." };
  }

  function flattenResponse(email, payload, errorMessage) {
    if (errorMessage) {
      return {
        email: email,
        normalized_email: "",
        is_reachable: "unknown",
        safe_to_send: "NO",
        syntax_valid: "-",
        mx_accepts_mail: "-",
        mx_records: "",
        smtp_can_connect: "-",
        smtp_is_deliverable: "-",
        smtp_is_catch_all: "-",
        smtp_full_inbox: "-",
        smtp_is_disabled: "-",
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
      email: email,
      normalized_email: syntax.normalized_email || "",
      is_reachable: (payload && payload.is_reachable) || "unknown",
      safe_to_send: ((payload && payload.is_reachable) === "safe") ? "YES" : "NO",
      syntax_valid: boolText(syntax.is_valid_syntax),
      mx_accepts_mail: boolText(mx.accepts_mail),
      mx_records: Array.isArray(mx.records) ? mx.records.join(" | ") : "",
      smtp_can_connect: boolText(smtp.can_connect_smtp),
      smtp_is_deliverable: boolText(smtp.is_deliverable),
      smtp_is_catch_all: boolText(smtp.is_catch_all),
      smtp_full_inbox: boolText(smtp.has_full_inbox),
      smtp_is_disabled: boolText(smtp.is_disabled),
      misc_role_account: boolText(misc.is_role_account),
      misc_disposable: boolText(misc.is_disposable),
      misc_b2c: boolText(misc.is_b2c),
      duration_ms: durationMs(debug.duration),
      error: ""
    };
  }

  function csvEscape(value) {
    const str = String(value == null ? "" : value);
    if (!/[\",\n]/.test(str)) return str;
    return '"' + str.replace(/\"/g, '""') + '"';
  }

  function rowsToCSV(rows) {
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((key) => csvEscape(row[key])).join(","));
    }
    return lines.join("\n");
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

  async function verifyEmail(email) {
    const url = normalizeUrl(state.settings.baseUrl) + "/v1/check_email";
    const response = await fetch(url, {
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
        (payload && (payload.message || payload.error)) ||
        text ||
        ("Request failed with HTTP " + String(response.status));
      throw new Error(message);
    }

    return payload || {};
  }

  function addEvent(source, status) {
    state.events.push({
      ts: Date.now(),
      source: source,
      status: String(status || "unknown").toLowerCase()
    });

    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }

    saveJSON(STORAGE_KEYS.events, state.events);
    renderAnalyticsPage();
  }

  function extractEmails(text) {
    const found = String(text || "").match(EMAIL_REGEX) || [];
    return found.map((item) => item.trim().toLowerCase());
  }

  function uniqueEmails(list) {
    const unique = new Set();
    for (const item of list) {
      const clean = String(item || "").trim().toLowerCase();
      if (!clean) continue;
      unique.add(clean);
    }
    return Array.from(unique);
  }

  async function parseFileEmails(file) {
    const lower = file.name.toLowerCase();

    if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
      const text = await file.text();
      return extractEmails(text);
    }

    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      if (!window.XLSX) {
        throw new Error("XLSX parser is not loaded. Refresh page and retry.");
      }

      const buffer = await file.arrayBuffer();
      const workbook = window.XLSX.read(buffer, { type: "array" });
      const collected = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = window.XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          blankrows: false
        });

        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            const value = String(cell == null ? "" : cell);
            const matches = value.match(EMAIL_REGEX);
            if (!matches) continue;
            for (const match of matches) {
              collected.push(match.toLowerCase());
            }
          }
        }
      }

      return collected;
    }

    throw new Error("Unsupported file format. Use CSV, TXT, XLSX or XLS.");
  }

  function statusClass(status) {
    const key = String(status || "unknown").toLowerCase();
    if (key === "safe") return "safe";
    if (key === "risky") return "risky";
    if (key === "invalid") return "invalid";
    return "unknown";
  }

  function setNavActive() {
    const page = document.body.getAttribute("data-page") || "verification";
    const links = document.querySelectorAll("[data-nav-target]");
    links.forEach((link) => {
      const target = link.getAttribute("data-nav-target");
      link.classList.toggle("active", target === page);
    });
  }

  function initMobileMenu() {
    const sidebar = q("sidebar");
    const toggle = q("mobileMenuBtn");
    if (!sidebar || !toggle) return;

    toggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    document.querySelectorAll("[data-nav-target]").forEach((link) => {
      link.addEventListener("click", () => {
        sidebar.classList.remove("open");
      });
    });
  }

  function saveSettingsFromApiPage() {
    const baseInput = q("apiBaseUrlInput");
    const modeInput = q("apiAuthModeInput");
    const keyInput = q("apiKeyInput");
    if (!baseInput || !modeInput || !keyInput) return;

    state.settings = {
      baseUrl: normalizeUrl(baseInput.value || DEFAULT_BASE_URL),
      authMode: modeInput.value || "none",
      apiKey: keyInput.value || ""
    };

    saveJSON(STORAGE_KEYS.settings, state.settings);
  }

  function applySettingsToApiPage() {
    const baseInput = q("apiBaseUrlInput");
    const modeInput = q("apiAuthModeInput");
    const keyInput = q("apiKeyInput");
    if (!baseInput || !modeInput || !keyInput) return;

    baseInput.value = state.settings.baseUrl;
    modeInput.value = state.settings.authMode;
    keyInput.value = state.settings.apiKey;
  }

  function initApiPage() {
    const saveBtn = q("apiSaveBtn");
    const testBtn = q("apiTestBtn");
    const statusBox = q("apiStatusBox");
    if (!saveBtn || !testBtn || !statusBox) return;

    applySettingsToApiPage();

    saveBtn.addEventListener("click", () => {
      saveSettingsFromApiPage();
      statusBox.textContent = "Saved. Settings are stored in this browser memory.";
    });

    testBtn.addEventListener("click", async () => {
      saveSettingsFromApiPage();
      testBtn.disabled = true;
      testBtn.textContent = "Testing...";
      statusBox.textContent = "Testing API connection...";

      try {
        const payload = await verifyEmail("test@gmail.com");
        statusBox.textContent = "Success. API is reachable, response status: " + String(payload.is_reachable || "unknown") + ".";
      } catch (error) {
        statusBox.textContent = "Failed. " + (error instanceof Error ? error.message : String(error));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test API";
      }
    });
  }

  function registerArtifact(runId, rows) {
    const csvBlob = new Blob([rowsToCSV(rows)], { type: "text/csv;charset=utf-8" });
    const jsonBlob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });

    const prev = state.artifacts.get(runId);
    if (prev) {
      URL.revokeObjectURL(prev.csv);
      URL.revokeObjectURL(prev.json);
    }

    state.artifacts.set(runId, {
      csv: URL.createObjectURL(csvBlob),
      json: URL.createObjectURL(jsonBlob)
    });
  }

  function downloadArtifact(runId, format) {
    const artifact = state.artifacts.get(runId);
    if (!artifact) return;

    const run = state.runs.find((item) => item.id === runId);
    const base = run ? run.fileName.replace(/\.[^.]+$/, "") : "verified_emails";

    const link = document.createElement("a");
    link.href = format === "json" ? artifact.json : artifact.csv;
    link.download = base + (format === "json" ? "_verified.json" : "_verified.csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function saveRuns() {
    saveJSON(STORAGE_KEYS.runs, state.runs.slice(0, MAX_RUNS));
  }

  function renderRunTable() {
    const tbody = q("runsTableBody");
    const empty = q("runsEmpty");
    const wrap = q("runsWrap");
    const searchInput = q("runsSearchInput");
    const sortInput = q("runsSortInput");
    if (!tbody || !empty || !wrap || !searchInput || !sortInput) return;

    const query = String(searchInput.value || "").trim().toLowerCase();
    const sortBy = sortInput.value || "newest";

    let rows = state.runs.slice();
    if (query) {
      rows = rows.filter((run) => String(run.fileName || "").toLowerCase().includes(query));
    }

    rows.sort((a, b) => {
      if (sortBy === "oldest") return (a.startedAt || 0) - (b.startedAt || 0);
      if (sortBy === "name") return String(a.fileName || "").localeCompare(String(b.fileName || ""));
      if (sortBy === "safeRate") {
        const rateA = a.total ? a.safe / a.total : 0;
        const rateB = b.total ? b.safe / b.total : 0;
        return rateB - rateA;
      }
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    if (!rows.length) {
      empty.style.display = "block";
      wrap.style.display = "none";
      return;
    }

    empty.style.display = "none";
    wrap.style.display = "block";

    tbody.innerHTML = rows.map((run) => {
      const artifact = state.artifacts.get(run.id);
      const rate = run.total ? Math.round((run.safe / run.total) * 100) : 0;
      const status = String(run.status || "running");
      return (
        "<tr>" +
          "<td>" + escapeHtml(run.fileName || "-") + "<br><span class=\"small-muted\">" + new Date(run.startedAt || Date.now()).toLocaleString() + "</span></td>" +
          "<td>" + String(run.total || 0) + "</td>" +
          "<td>" + String(run.safe || 0) + " (" + String(rate) + "%)</td>" +
          "<td>" + String(run.risky || 0) + "</td>" +
          "<td>" + String(run.invalid || 0) + "</td>" +
          "<td>" + String(run.unknown || 0) + "</td>" +
          "<td>" + String(run.processed || 0) + "</td>" +
          "<td><span class=\"tag " + escapeHtml(status) + "\">" + escapeHtml(status) + "</span></td>" +
          "<td>" +
            (artifact
              ? "<span class=\"inline-actions\"><button data-run-id=\"" + run.id + "\" data-format=\"csv\">CSV</button><button data-run-id=\"" + run.id + "\" data-format=\"json\">JSON</button></span>"
              : "<span class=\"small-muted\">session files only</span>") +
          "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function setBulkMeta(data) {
    const box = q("bulkMeta");
    const progress = q("bulkProgressBar");
    if (!box || !progress) return;

    const safe = Number(data.safe || 0);
    const risky = Number(data.risky || 0);
    const invalid = Number(data.invalid || 0);
    const unknown = Number(data.unknown || 0);
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
          "<span class=\"pill safe\">safe " + String(safe) + "</span>" +
          "<span class=\"pill risky\">risky " + String(risky) + "</span>" +
          "<span class=\"pill invalid\">invalid " + String(invalid) + "</span>" +
          "<span class=\"pill unknown\">unknown " + String(unknown) + "</span>" +
        "</div>"
      );
    }

    box.innerHTML = rows.join("");

    const percent = total ? Math.round((processed / total) * 100) : 0;
    progress.style.width = String(percent) + "%";
  }

  function setSingleResult(email, payload, error) {
    const empty = q("singleEmpty");
    const panel = q("singleResult");
    const emailEl = q("singleEmailValue");
    const statusEl = q("singleStatus");
    const descEl = q("singleDesc");
    const detailEl = q("singleDetailGrid");

    if (!empty || !panel || !emailEl || !statusEl || !descEl || !detailEl) return;

    empty.style.display = "none";
    panel.style.display = "block";

    const flat = flattenResponse(email, payload, error || "");
    const info = statusInfo(flat.is_reachable);

    emailEl.textContent = email;
    statusEl.className = "pill " + info.key;
    statusEl.textContent = info.key;
    descEl.textContent = error ? String(error) : info.text;

    const pairs = [
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

    detailEl.innerHTML = pairs
      .map(([k, v]) => "<div class=\"detail-row\"><span>" + escapeHtml(k) + "</span><span>" + escapeHtml(v) + "</span></div>")
      .join("");
  }

  async function startBulkRun() {
    if (!state.parsedEmails.length || state.isBulkRunning) return;

    const run = {
      id: "run_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      fileName: state.selectedFileName || "uploaded_list",
      total: state.parsedEmails.length,
      processed: 0,
      safe: 0,
      risky: 0,
      invalid: 0,
      unknown: 0,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null
    };

    const startBtn = q("bulkStartBtn");
    const cancelBtn = q("bulkCancelBtn");
    const fileInput = q("bulkFileInput");

    state.isBulkRunning = true;
    state.cancelBulkRun = false;
    state.activeRun = run;

    if (startBtn) startBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;
    if (fileInput) fileInput.disabled = true;

    setBulkMeta(run);

    const rows = [];
    const queue = state.parsedEmails.slice();
    const workersCount = Math.min(3, queue.length);
    let index = 0;

    const workers = Array.from({ length: workersCount }, async function worker() {
      while (!state.cancelBulkRun && index < queue.length) {
        const current = index;
        index += 1;
        const email = queue[current];

        let payload = null;
        let error = "";
        try {
          payload = await verifyEmail(email);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const row = flattenResponse(email, payload, error);
        rows.push(row);

        if (row.is_reachable === "safe") run.safe += 1;
        else if (row.is_reachable === "risky") run.risky += 1;
        else if (row.is_reachable === "invalid") run.invalid += 1;
        else run.unknown += 1;

        run.processed += 1;
        addEvent("bulk", row.is_reachable);
        setBulkMeta(run);
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      run.status = state.cancelBulkRun ? "cancelled" : "completed";
      run.finishedAt = Date.now();

      registerArtifact(run.id, rows);
      state.runs.unshift(run);

      if (state.runs.length > MAX_RUNS) {
        const dropped = state.runs.splice(MAX_RUNS);
        dropped.forEach((item) => {
          const artifact = state.artifacts.get(item.id);
          if (artifact) {
            URL.revokeObjectURL(artifact.csv);
            URL.revokeObjectURL(artifact.json);
            state.artifacts.delete(item.id);
          }
        });
      }

      saveRuns();

      state.isBulkRunning = false;
      state.cancelBulkRun = false;
      state.activeRun = null;

      if (startBtn) startBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
      if (fileInput) fileInput.disabled = false;

      setBulkMeta(run);
      renderRunTable();
    }
  }

  function initVerificationPage() {
    const emailInput = q("singleEmailInput");
    const verifyBtn = q("singleVerifyBtn");
    const fileInput = q("bulkFileInput");
    const startBtn = q("bulkStartBtn");
    const cancelBtn = q("bulkCancelBtn");
    const searchInput = q("runsSearchInput");
    const sortInput = q("runsSortInput");
    const tableBody = q("runsTableBody");

    if (!emailInput || !verifyBtn || !fileInput || !startBtn || !cancelBtn || !searchInput || !sortInput || !tableBody) {
      return;
    }

    setBulkMeta({ fileName: "-", total: 0, processed: 0, status: "idle" });
    renderRunTable();

    verifyBtn.addEventListener("click", async () => {
      const email = String(emailInput.value || "").trim().toLowerCase();
      if (!SIMPLE_EMAIL_REGEX.test(email)) {
        setSingleResult(email || "-", null, "Invalid email format.");
        return;
      }

      verifyBtn.disabled = true;
      verifyBtn.textContent = "Checking...";

      try {
        const payload = await verifyEmail(email);
        setSingleResult(email, payload, "");
        addEvent("single", payload.is_reachable || "unknown");
      } catch (error) {
        setSingleResult(email, null, error instanceof Error ? error.message : String(error));
        addEvent("single", "unknown");
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify";
      }
    });

    emailInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        verifyBtn.click();
      }
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      startBtn.disabled = true;
      setBulkMeta({ fileName: file.name, total: 0, processed: 0, status: "Parsing file..." });

      try {
        const emails = await parseFileEmails(file);
        const unique = uniqueEmails(emails);

        state.selectedFileName = file.name;
        state.parsedEmails = unique;

        setBulkMeta({
          fileName: file.name,
          total: unique.length,
          processed: 0,
          status: unique.length ? "Ready to start" : "No valid emails found"
        });
        startBtn.disabled = unique.length === 0;
      } catch (error) {
        state.selectedFileName = file.name;
        state.parsedEmails = [];
        setBulkMeta({
          fileName: file.name,
          total: 0,
          processed: 0,
          status: "Parse error: " + (error instanceof Error ? error.message : String(error))
        });
        startBtn.disabled = true;
      }
    });

    startBtn.addEventListener("click", startBulkRun);

    cancelBtn.addEventListener("click", () => {
      if (!state.isBulkRunning) return;
      state.cancelBulkRun = true;
      cancelBtn.disabled = true;
      const run = state.activeRun;
      setBulkMeta({
        fileName: run ? run.fileName : state.selectedFileName,
        total: run ? run.total : state.parsedEmails.length,
        processed: run ? run.processed : 0,
        safe: run ? run.safe : 0,
        risky: run ? run.risky : 0,
        invalid: run ? run.invalid : 0,
        unknown: run ? run.unknown : 0,
        status: "Cancelling..."
      });
    });

    searchInput.addEventListener("input", renderRunTable);
    sortInput.addEventListener("change", renderRunTable);

    tableBody.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const runId = target.getAttribute("data-run-id");
      const format = target.getAttribute("data-format");
      if (!runId || !format) return;
      downloadArtifact(runId, format);
    });

    window.addEventListener("beforeunload", (event) => {
      if (!state.isBulkRunning) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  function chart(canvas, oldChart, type, labels, data, color) {
    if (!canvas || !window.Chart) return null;
    if (oldChart) oldChart.destroy();

    return new window.Chart(canvas, {
      type: type,
      data: {
        labels: labels,
        datasets: [{
          label: "Analyzed",
          data: data,
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
          y: {
            beginAtZero: true,
            ticks: { precision: 0 }
          },
          x: {
            ticks: { maxRotation: 0, autoSkip: true }
          }
        }
      }
    });
  }

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function renderAnalyticsPage() {
    const weekMetric = q("metricWeek");
    const monthMetric = q("metricMonth");
    const yearMetric = q("metricYear");
    const weekCanvas = q("weekChart");
    const monthCanvas = q("monthChart");
    const yearCanvas = q("yearChart");
    if (!weekMetric || !monthMetric || !yearMetric || !weekCanvas || !monthCanvas || !yearCanvas) return;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const last7 = state.events.filter((item) => item.ts >= now - (7 * dayMs));
    const last30 = state.events.filter((item) => item.ts >= now - (30 * dayMs));
    const last365 = state.events.filter((item) => item.ts >= now - (365 * dayMs));

    weekMetric.textContent = String(last7.length);
    monthMetric.textContent = String(last30.length);
    yearMetric.textContent = String(last365.length);

    const weekLabels = [];
    const weekData = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      weekLabels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
      weekData.push(last7.filter((item) => dayKey(item.ts) === key).length);
    }

    const monthLabels = [];
    const monthData = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      monthLabels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      monthData.push(last30.filter((item) => dayKey(item.ts) === key).length);
    }

    const yearLabels = [];
    const yearData = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date();
      d.setMonth(d.getMonth() - i, 1);
      const month = d.getMonth();
      const year = d.getFullYear();
      yearLabels.push(d.toLocaleDateString(undefined, { month: "short", year: "numeric" }));
      yearData.push(last365.filter((item) => {
        const t = new Date(item.ts);
        return t.getMonth() === month && t.getFullYear() === year;
      }).length);
    }

    state.charts.week = chart(weekCanvas, state.charts.week, "bar", weekLabels, weekData, "#fe5906");
    state.charts.month = chart(monthCanvas, state.charts.month, "line", monthLabels, monthData, "#1f49d8");
    state.charts.year = chart(yearCanvas, state.charts.year, "bar", yearLabels, yearData, "#f27a3b");
  }

  function initAnalyticsPage() {
    renderAnalyticsPage();

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEYS.events) return;
      state.events = loadJSON(STORAGE_KEYS.events, []);
      renderAnalyticsPage();
    });
  }

  function loadInitialState() {
    const settings = loadJSON(STORAGE_KEYS.settings, null);
    if (settings && typeof settings === "object") {
      state.settings = {
        baseUrl: normalizeUrl(settings.baseUrl || DEFAULT_BASE_URL),
        authMode: settings.authMode || "secret",
        apiKey: settings.apiKey || ""
      };
    }

    const events = loadJSON(STORAGE_KEYS.events, []);
    if (Array.isArray(events)) {
      state.events = events.filter((item) => item && typeof item.ts === "number").slice(-MAX_EVENTS);
    }

    const runs = loadJSON(STORAGE_KEYS.runs, []);
    if (Array.isArray(runs)) {
      state.runs = runs
        .filter((item) => item && typeof item === "object")
        .slice(0, MAX_RUNS)
        .map((run) => ({
          id: run.id || ("run_" + Math.random().toString(36).slice(2, 8)),
          fileName: run.fileName || "uploaded_list",
          total: Number(run.total || 0),
          processed: Number(run.processed || 0),
          safe: Number(run.safe || 0),
          risky: Number(run.risky || 0),
          invalid: Number(run.invalid || 0),
          unknown: Number(run.unknown || 0),
          status: run.status || "completed",
          startedAt: Number(run.startedAt || Date.now()),
          finishedAt: run.finishedAt ? Number(run.finishedAt) : null
        }));
    }
  }

  function init() {
    loadInitialState();
    setNavActive();
    initMobileMenu();
    initApiPage();
    initVerificationPage();
    initAnalyticsPage();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
EOF