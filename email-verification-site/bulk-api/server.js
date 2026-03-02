import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.DATA_DIR || "/data";
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const DEFAULT_REACHER_URL = (process.env.REACHER_URL || "http://reacher:8080").replace(/\/+$/, "");
const DEFAULT_AUTH_MODE = process.env.DEFAULT_AUTH_MODE || "none";
const DEFAULT_API_KEY = process.env.DEFAULT_API_KEY || "";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
const ALLOWED_AUTH_MODES = new Set(["none", "secret", "authorization"]);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 }
});

const jobs = new Map();
const queue = [];
let workerActive = false;

function nowIso() {
  return new Date().toISOString();
}

function toDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function ensureDirs() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

function uniqueEmails(list) {
  const set = new Set();
  for (const item of list) {
    const clean = String(item || "").trim().toLowerCase();
    if (!clean) continue;
    set.add(clean);
  }
  return Array.from(set);
}

function extractEmailsFromText(text) {
  const matches = String(text || "").match(EMAIL_REGEX) || [];
  return matches.map((item) => item.toLowerCase());
}

function parseEmailsFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const collected = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: false
    });

    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const value = String(cell == null ? "" : cell);
        const found = value.match(EMAIL_REGEX);
        if (!found || !found.length) continue;
        for (const email of found) collected.push(email.toLowerCase());
      }
    }
  }

  return collected;
}

function parseEmailsFromUpload(file) {
  const lower = String(file.originalname || "").toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return extractEmailsFromText(file.buffer.toString("utf8"));
  }

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseEmailsFromWorkbook(file.buffer);
  }

  throw new Error("Unsupported format. Use CSV, TXT, XLSX or XLS.");
}

function sanitizeConfig(input = {}) {
  const baseUrl = String(input.baseUrl || DEFAULT_REACHER_URL).trim().replace(/\/+$/, "") || DEFAULT_REACHER_URL;
  const mode = String(input.authMode || DEFAULT_AUTH_MODE).trim().toLowerCase();
  const authMode = ALLOWED_AUTH_MODES.has(mode) ? mode : "none";
  const apiKey = String(input.apiKey || DEFAULT_API_KEY || "");
  return { baseUrl, authMode, apiKey };
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
    email,
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
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n");
}

function buildHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config.authMode === "secret" && config.apiKey) {
    headers["x-reacher-secret"] = config.apiKey;
  } else if (config.authMode === "authorization" && config.apiKey) {
    headers.Authorization = config.apiKey;
  }
  return headers;
}

async function verifyEmail(config, email) {
  const headers = buildHeaders(config);

  async function request(url) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ to_email: email })
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = null;
    }

    return { response, payload, text };
  }

  const v1 = await request(config.baseUrl + "/v1/check_email");
  if (v1.response.status === 404) {
    const v0 = await request(config.baseUrl + "/v0/check_email");
    if (!v0.response.ok) {
      throw new Error((v0.payload && (v0.payload.error || v0.payload.message)) || v0.text || ("HTTP " + v0.response.status));
    }
    return v0.payload || {};
  }

  if (!v1.response.ok) {
    throw new Error((v1.payload && (v1.payload.error || v1.payload.message)) || v1.text || ("HTTP " + v1.response.status));
  }
  return v1.payload || {};
}

function serializeJob(job) {
  return {
    id: job.id,
    fileName: job.fileName,
    status: job.status,
    total: job.total,
    processed: job.processed,
    safe: job.safe,
    risky: job.risky,
    invalid: job.invalid,
    unknown: job.unknown,
    cancelRequested: Boolean(job.cancelRequested),
    error: job.error || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    dailyCounts: job.dailyCounts || {},
    config: {
      baseUrl: job.config.baseUrl,
      authMode: job.config.authMode
    }
  };
}

function summary(job) {
  return {
    id: job.id,
    fileName: job.fileName,
    status: job.status,
    total: job.total,
    processed: job.processed,
    safe: job.safe,
    risky: job.risky,
    invalid: job.invalid,
    unknown: job.unknown,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || "",
    downloadsReady: Boolean(job.downloadsReady)
  };
}

async function persistJob(job) {
  job.updatedAt = nowIso();
  await fs.mkdir(job.jobDir, { recursive: true });
  await fs.writeFile(path.join(job.jobDir, "job.json"), JSON.stringify(serializeJob(job), null, 2), "utf8");
}

async function loadEmails(job) {
  if (Array.isArray(job.emails)) return job.emails;
  const raw = await fs.readFile(job.emailsPath, "utf8");
  const parsed = JSON.parse(raw);
  job.emails = Array.isArray(parsed) ? parsed : [];
  return job.emails;
}

async function writeResults(job, rows) {
  const csv = rowsToCSV(rows);
  const json = JSON.stringify(rows, null, 2);
  await fs.writeFile(path.join(job.jobDir, "result.csv"), csv, "utf8");
  await fs.writeFile(path.join(job.jobDir, "result.json"), json, "utf8");
  job.downloadsReady = true;
}

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;

  const rows = [];
  const emails = await loadEmails(job);

  if (!job.startedAt) job.startedAt = nowIso();
  job.status = "running";
  job.error = "";
  await persistJob(job);

  try {
    for (let i = job.processed; i < emails.length; i += 1) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        break;
      }

      const email = emails[i];
      let payload = null;
      let error = "";

      try {
        payload = await verifyEmail(job.config, email);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const row = flattenResponse(email, payload, error);
      rows.push(row);

      if (row.is_reachable === "safe") job.safe += 1;
      else if (row.is_reachable === "risky") job.risky += 1;
      else if (row.is_reachable === "invalid") job.invalid += 1;
      else job.unknown += 1;

      job.processed = i + 1;
      const day = toDateKey();
      job.dailyCounts[day] = (job.dailyCounts[day] || 0) + 1;

      if (job.processed % 10 === 0 || job.processed === job.total) {
        await persistJob(job);
      }
    }

    if (job.status !== "cancelled") {
      job.status = "completed";
    }

    if (rows.length > 0) {
      await writeResults(job, rows);
    }

    job.finishedAt = nowIso();
    await persistJob(job);
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = nowIso();
    await persistJob(job);
  }
}

function enqueue(jobId) {
  if (!queue.includes(jobId)) queue.push(jobId);
  void runQueue();
}

async function runQueue() {
  if (workerActive) return;
  workerActive = true;
  while (queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) continue;
    await processJob(jobId);
  }
  workerActive = false;
}

async function loadJobsFromDisk() {
  await ensureDirs();
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(JOBS_DIR, entry.name);
    const jobFile = path.join(jobDir, "job.json");
    const emailsPath = path.join(jobDir, "emails.json");

    try {
      const raw = await fs.readFile(jobFile, "utf8");
      const parsed = JSON.parse(raw);

      const job = {
        id: parsed.id,
        fileName: parsed.fileName,
        status: parsed.status,
        total: Number(parsed.total || 0),
        processed: Number(parsed.processed || 0),
        safe: Number(parsed.safe || 0),
        risky: Number(parsed.risky || 0),
        invalid: Number(parsed.invalid || 0),
        unknown: Number(parsed.unknown || 0),
        cancelRequested: Boolean(parsed.cancelRequested),
        error: parsed.error || "",
        createdAt: parsed.createdAt || nowIso(),
        updatedAt: parsed.updatedAt || nowIso(),
        startedAt: parsed.startedAt || null,
        finishedAt: parsed.finishedAt || null,
        dailyCounts: parsed.dailyCounts || {},
        config: sanitizeConfig(parsed.config || {}),
        jobDir,
        emailsPath,
        downloadsReady: false,
        emails: null
      };

      try {
        await fs.access(path.join(jobDir, "result.csv"));
        await fs.access(path.join(jobDir, "result.json"));
        job.downloadsReady = true;
      } catch (_error) {
        job.downloadsReady = false;
      }

      jobs.set(job.id, job);

      if (job.status === "queued" || job.status === "running") {
        job.status = "queued";
        job.cancelRequested = false;
        await persistJob(job);
        enqueue(job.id);
      }
    } catch (_error) {
      // ignore broken job folder
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, jobs: jobs.size, queue: queue.length, workerActive });
});

app.get("/jobs", (_req, res) => {
  const list = Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(summary);

  res.json({ jobs: list });
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job: summary(job) });
});

app.post("/jobs", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "File is required" });
      return;
    }

    const parsed = parseEmailsFromUpload(req.file);
    const emails = uniqueEmails(parsed);

    if (!emails.length) {
      res.status(400).json({ error: "No valid emails found in file" });
      return;
    }

    const id = randomUUID();
    const createdAt = nowIso();
    const jobDir = path.join(JOBS_DIR, id);
    const emailsPath = path.join(jobDir, "emails.json");

    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(emailsPath, JSON.stringify(emails), "utf8");

    const job = {
      id,
      fileName: req.file.originalname,
      status: "queued",
      total: emails.length,
      processed: 0,
      safe: 0,
      risky: 0,
      invalid: 0,
      unknown: 0,
      cancelRequested: false,
      error: "",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      dailyCounts: {},
      config: sanitizeConfig(req.body || {}),
      jobDir,
      emailsPath,
      downloadsReady: false,
      emails
    };

    jobs.set(id, job);
    await persistJob(job);
    enqueue(id);

    res.status(201).json({ job: summary(job) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/jobs/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    res.json({ job: summary(job) });
    return;
  }

  job.cancelRequested = true;
  if (job.status === "queued") {
    job.status = "cancelled";
    job.finishedAt = nowIso();
  } else {
    job.status = "cancelling";
  }

  await persistJob(job);
  res.json({ job: summary(job) });
});

app.get("/jobs/:id/download.csv", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const filePath = path.join(job.jobDir, "result.csv");
  try {
    await fs.access(filePath);
    res.download(filePath, `${job.fileName.replace(/\.[^.]+$/, "")}_verified.csv`);
  } catch (_error) {
    res.status(409).json({ error: "Result file is not ready yet" });
  }
});

app.get("/jobs/:id/download.json", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const filePath = path.join(job.jobDir, "result.json");
  try {
    await fs.access(filePath);
    res.download(filePath, `${job.fileName.replace(/\.[^.]+$/, "")}_verified.json`);
  } catch (_error) {
    res.status(409).json({ error: "Result file is not ready yet" });
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

async function main() {
  await ensureDirs();
  await loadJobsFromDisk();
  app.listen(PORT, () => {
    console.log(`[bulk-api] listening on :${PORT}`);
    console.log(`[bulk-api] jobs dir: ${JOBS_DIR}`);
  });
}

main().catch((err) => {
  console.error("Failed to start bulk-api", err);
  process.exit(1);
});
