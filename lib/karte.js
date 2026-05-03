// lib/karte.js — Persistent stock karte (analyst dossier) for ARGOS
//
// Storage backend: same Upstash Redis as memos.js
// Key: argos:karte:${code}
//
// Concept: A "karte" (カルテ) is a per-stock dossier with:
//   - meta: coverage status, conviction level, position thesis
//   - entries: timeline of judgments / lessons / predictions / earnings reactions
//   - stats: derived counts and accuracy
//
// MVP entry kinds:
//   - judgment       : Buy/Hold/Sell + rationale + target_price + horizon
//   - lesson         : Learning tag (industry/pattern/teaching/mistake)
//   - prediction     : Forecast (later compared to actual)
//   - earnings_react : Reaction to a specific earnings release

import crypto from "crypto";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const KV_AVAILABLE = !!(KV_URL && KV_TOKEN);

// Reuse the hardened kvCommand from memos.js — keep them in sync
function sanitizeKvUrl(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return u;
  } catch { return null; }
}
const KV_URL_CLEAN = sanitizeKvUrl(KV_URL);
const KV_TIMEOUT_MS = 8000;
const KV_MAX_RETRIES = 2;

async function kvCommand(args) {
  if (!KV_AVAILABLE) {
    const err = new Error("Karte storage is not configured.");
    err.code = "KV_NOT_CONFIGURED";
    throw err;
  }
  if (!KV_URL_CLEAN) {
    const err = new Error("KV_REST_API_URL is malformed.");
    err.code = "KV_URL_INVALID";
    throw err;
  }
  let lastError = null;
  for (let attempt = 0; attempt <= KV_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), KV_TIMEOUT_MS);
    try {
      const res = await fetch(KV_URL_CLEAN, {
        method: "POST",
        headers: { "Authorization": `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`KV authentication failed (HTTP ${res.status})`);
        err.code = "KV_AUTH_FAILED";
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`KV HTTP ${res.status}`);
        if (res.status >= 500 && attempt < KV_MAX_RETRIES) {
          lastError = err;
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(`KV error: ${json.error}`);
        err.code = "KV_REMOTE_ERROR";
        throw err;
      }
      return json.result;
    } catch (err) {
      clearTimeout(timer);
      const isRetryable = err.name === "AbortError" || err.name === "TypeError";
      if (isRetryable && attempt < KV_MAX_RETRIES) {
        lastError = err;
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      if (err.name === "AbortError") {
        const e = new Error(`KV request timeout after ${KV_TIMEOUT_MS}ms`);
        e.code = "KV_TIMEOUT";
        throw e;
      }
      if (err.name === "TypeError") {
        const e = new Error(`KV network error: ${err.cause?.code || "unknown"}`);
        e.code = "KV_NETWORK_ERROR";
        throw e;
      }
      throw err;
    }
  }
  throw lastError || new Error("KV command failed");
}

const karteKey = (code) => `argos:karte:${String(code)}`;

/* ─────────────────────────────────────────────────────────
   Schema
   ───────────────────────────────────────────────────────── */

export const ENTRY_KINDS = ["judgment", "lesson", "prediction", "earnings_react", "ai_thesis_snapshot"];

export const VERDICT_OPTIONS = ["buy", "accumulate", "hold", "trim", "sell", "watch", "pass"];

export const LESSON_CATEGORIES = [
  "industry",   // 業界に関する学び
  "pattern",    // パターン認識 (この業種ではよくある等)
  "teaching",   // 教訓 (次回似た銘柄で活かしたい)
  "mistake",   // 自分の判断ミス
  "success",   // 自分の判断が当たった
  "framework", // 分析フレーム
];

export const HORIZON_OPTIONS = ["1M", "3M", "6M", "1Y", "2Y+"];

export const COVERAGE_STATUS = ["active", "watching", "passed", "exited"];

export const CONVICTION_LEVELS = ["high", "medium", "low", "none"];

const MAX_BODY_LENGTH = 3000;
const MAX_TAGS_PER_ENTRY = 8;
const MAX_ENTRIES_PER_KARTE = 200;

/* ─────────────────────────────────────────────────────────
   Validation
   ───────────────────────────────────────────────────────── */

export function validateEntry(input, { isUpdate = false } = {}) {
  if (!input || typeof input !== "object") throw new Error("Entry must be object");
  const out = {};

  // kind (required on create)
  if (input.kind !== undefined) {
    if (!ENTRY_KINDS.includes(input.kind)) {
      throw new Error(`Invalid kind: must be one of ${ENTRY_KINDS.join(", ")}`);
    }
    out.kind = input.kind;
  } else if (!isUpdate) {
    throw new Error("kind is required");
  }

  // body (required on create)
  if (input.body !== undefined) {
    if (typeof input.body !== "string") throw new Error("body must be string");
    const trimmed = input.body.trim();
    if (trimmed.length === 0) throw new Error("body cannot be empty");
    if (trimmed.length > MAX_BODY_LENGTH) {
      throw new Error(`body too long (${trimmed.length} > ${MAX_BODY_LENGTH})`);
    }
    out.body = trimmed;
  } else if (!isUpdate) {
    throw new Error("body is required");
  }

  // judgment-specific fields
  if (input.verdict !== undefined) {
    if (input.verdict !== null && !VERDICT_OPTIONS.includes(input.verdict)) {
      throw new Error(`Invalid verdict: must be one of ${VERDICT_OPTIONS.join(", ")}`);
    }
    out.verdict = input.verdict || null;
  }
  if (input.target_price !== undefined) {
    const n = Number(input.target_price);
    out.target_price = Number.isFinite(n) && n > 0 ? n : null;
  }
  if (input.horizon !== undefined) {
    if (input.horizon !== null && !HORIZON_OPTIONS.includes(input.horizon)) {
      throw new Error(`Invalid horizon: must be one of ${HORIZON_OPTIONS.join(", ")}`);
    }
    out.horizon = input.horizon || null;
  }

  // lesson-specific fields
  if (input.category !== undefined) {
    if (input.category !== null && !LESSON_CATEGORIES.includes(input.category)) {
      throw new Error(`Invalid category: must be one of ${LESSON_CATEGORIES.join(", ")}`);
    }
    out.category = input.category || null;
  }

  // prediction-specific fields
  if (input.predicted !== undefined) {
    if (input.predicted !== null && typeof input.predicted !== "object") {
      throw new Error("predicted must be object or null");
    }
    out.predicted = input.predicted || null;
  }
  if (input.actual !== undefined) {
    if (input.actual !== null && typeof input.actual !== "object") {
      throw new Error("actual must be object or null");
    }
    out.actual = input.actual || null;
  }
  if (input.accuracy !== undefined) {
    if (input.accuracy !== null) {
      const n = Number(input.accuracy);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("accuracy must be 0-1");
      out.accuracy = n;
    } else {
      out.accuracy = null;
    }
  }

  // earnings_react-specific fields
  if (input.fy_quarter !== undefined) {
    out.fy_quarter = input.fy_quarter ? String(input.fy_quarter).trim().slice(0, 20) : null;
  }
  if (input.surprise !== undefined) {
    out.surprise = input.surprise ? String(input.surprise).trim().slice(0, 20) : null;
  }

  // common fields
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw new Error("tags must be array");
    out.tags = input.tags
      .filter(t => typeof t === "string")
      .map(t => t.trim().slice(0, 30))
      .filter(t => t.length > 0)
      .slice(0, MAX_TAGS_PER_ENTRY);
  } else if (!isUpdate) {
    out.tags = [];
  }

  if (input.author !== undefined) {
    out.author = String(input.author || "anonymous").trim().slice(0, 60) || "anonymous";
  } else if (!isUpdate) {
    out.author = "anonymous";
  }

  // Auto-captured price context (frontend supplies)
  if (input.price_at_entry !== undefined) {
    const n = Number(input.price_at_entry);
    out.price_at_entry = Number.isFinite(n) && n > 0 ? n : null;
  }
  if (input.price_change_pct !== undefined) {
    const n = Number(input.price_change_pct);
    out.price_change_pct = Number.isFinite(n) ? n : null;
  }

  // AI thesis snapshot data (only valid for ai_thesis_snapshot kind)
  if (input._thesis_data !== undefined) {
    if (input._thesis_data !== null && typeof input._thesis_data !== "object") {
      throw new Error("_thesis_data must be object or null");
    }
    out._thesis_data = input._thesis_data || null;
  }

  return out;
}

/* ─────────────────────────────────────────────────────────
   CRUD
   ───────────────────────────────────────────────────────── */

const EMPTY_KARTE = (code) => ({
  code: String(code),
  meta: {
    coverage_status: "watching",
    conviction: "none",
    position_thesis: "",
    first_seen: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
  entries: [],
});

export async function getKarte(code) {
  const raw = await kvCommand(["GET", karteKey(code)]);
  if (!raw) return EMPTY_KARTE(code);
  let karte;
  try { karte = JSON.parse(raw); } catch { return EMPTY_KARTE(code); }
  if (!karte || typeof karte !== "object") return EMPTY_KARTE(code);
  // Sort entries newest first
  if (Array.isArray(karte.entries)) {
    karte.entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  } else {
    karte.entries = [];
  }
  if (!karte.meta) karte.meta = EMPTY_KARTE(code).meta;
  return karte;
}

export async function addEntry(code, input) {
  const clean = validateEntry(input, { isUpdate: false });
  const karte = await getKarte(code);
  if (karte.entries.length >= MAX_ENTRIES_PER_KARTE) {
    throw new Error(`Entry limit reached (${MAX_ENTRIES_PER_KARTE}). Delete old entries first.`);
  }
  const entry = {
    id: "entry_" + crypto.randomBytes(6).toString("hex"),
    ts: new Date().toISOString(),
    ts_updated: null,
    ...clean,
  };
  karte.entries.unshift(entry);
  karte.meta.last_updated = entry.ts;
  if (!karte.meta.first_seen) karte.meta.first_seen = entry.ts;
  await kvCommand(["SET", karteKey(code), JSON.stringify(karte)]);
  return entry;
}

export async function updateEntry(code, id, input) {
  const clean = validateEntry(input, { isUpdate: true });
  const karte = await getKarte(code);
  const idx = karte.entries.findIndex(e => e.id === id);
  if (idx < 0) throw new Error(`Entry ${id} not found`);
  karte.entries[idx] = {
    ...karte.entries[idx],
    ...clean,
    ts_updated: new Date().toISOString(),
  };
  karte.meta.last_updated = karte.entries[idx].ts_updated;
  await kvCommand(["SET", karteKey(code), JSON.stringify(karte)]);
  return karte.entries[idx];
}

export async function deleteEntry(code, id) {
  const karte = await getKarte(code);
  const before = karte.entries.length;
  karte.entries = karte.entries.filter(e => e.id !== id);
  if (karte.entries.length === before) throw new Error(`Entry ${id} not found`);
  karte.meta.last_updated = new Date().toISOString();
  await kvCommand(["SET", karteKey(code), JSON.stringify(karte)]);
  return { id, deleted: true };
}

export async function updateMeta(code, metaInput) {
  const karte = await getKarte(code);
  const meta = { ...karte.meta };

  if (metaInput.coverage_status !== undefined) {
    if (!COVERAGE_STATUS.includes(metaInput.coverage_status)) {
      throw new Error(`Invalid coverage_status: must be one of ${COVERAGE_STATUS.join(", ")}`);
    }
    meta.coverage_status = metaInput.coverage_status;
  }
  if (metaInput.conviction !== undefined) {
    if (!CONVICTION_LEVELS.includes(metaInput.conviction)) {
      throw new Error(`Invalid conviction: must be one of ${CONVICTION_LEVELS.join(", ")}`);
    }
    meta.conviction = metaInput.conviction;
  }
  if (metaInput.position_thesis !== undefined) {
    meta.position_thesis = String(metaInput.position_thesis || "").trim().slice(0, 500);
  }
  meta.last_updated = new Date().toISOString();
  karte.meta = meta;
  await kvCommand(["SET", karteKey(code), JSON.stringify(karte)]);
  return meta;
}

/* ─────────────────────────────────────────────────────────
   Stats (computed on read)
   ───────────────────────────────────────────────────────── */

export function computeStats(karte) {
  const entries = karte.entries || [];
  const stats = {
    total_entries: entries.length,
    by_kind: {},
    judgments: 0,
    lessons: 0,
    predictions: 0,
    predictions_validated: 0,
    earnings_reacts: 0,
    accuracy: null,            // mean accuracy of validated predictions
    last_judgment: null,        // most recent judgment entry
    first_seen: karte.meta?.first_seen || null,
    last_updated: karte.meta?.last_updated || null,
  };

  let accSum = 0, accCount = 0;
  for (const e of entries) {
    stats.by_kind[e.kind] = (stats.by_kind[e.kind] || 0) + 1;
    if (e.kind === "judgment") {
      stats.judgments++;
      if (!stats.last_judgment) stats.last_judgment = e;
    }
    if (e.kind === "lesson") stats.lessons++;
    if (e.kind === "prediction") {
      stats.predictions++;
      if (e.actual && e.accuracy != null) {
        stats.predictions_validated++;
        accSum += e.accuracy;
        accCount++;
      }
    }
    if (e.kind === "earnings_react") stats.earnings_reacts++;
  }
  if (accCount > 0) stats.accuracy = accSum / accCount;
  return stats;
}

/* ─────────────────────────────────────────────────────────
   Versioning (used by analyze cache)
   ───────────────────────────────────────────────────────── */

export async function getKarteVersion(code) {
  if (!KV_AVAILABLE) return "0";
  try {
    const karte = await getKarte(code);
    if (!karte.entries || karte.entries.length === 0) return "0";
    return `${karte.entries.length}-${karte.meta?.last_updated || ""}`;
  } catch {
    return "0";
  }
}

/* ─────────────────────────────────────────────────────────
   AI prompt context builder (Phase 4 injection)
   ───────────────────────────────────────────────────────── */

export function buildKarteContextForPrompt(karte, { maxEntries = 15 } = {}) {
  if (!karte || !Array.isArray(karte.entries) || karte.entries.length === 0) return null;

  const entries = karte.entries
    .slice() // already sorted newest-first
    .slice(0, maxEntries);

  if (entries.length === 0) return null;

  const sanitize = (s) =>
    String(s || "")
      .replace(/<\/?(memo|karte|entry|user_note|system|instruction|prompt)\b[^>]*>/gi, "[tag-removed]")
      .slice(0, 1500);

  const lines = [];

  // Meta header
  if (karte.meta) {
    const m = karte.meta;
    lines.push(`<karte_meta coverage="${m.coverage_status || "watching"}" conviction="${m.conviction || "none"}">`);
    if (m.position_thesis) lines.push(sanitize(m.position_thesis));
    lines.push(`</karte_meta>`);
  }

  for (const e of entries) {
    const date = (e.ts || "").slice(0, 10);
    const tags = (e.tags || []).join(",");
    const attrs = [`id="${e.id}"`, `kind="${e.kind}"`, `date="${date}"`];
    if (e.verdict) attrs.push(`verdict="${e.verdict}"`);
    if (e.target_price) attrs.push(`target="${e.target_price}"`);
    if (e.horizon) attrs.push(`horizon="${e.horizon}"`);
    if (e.category) attrs.push(`category="${e.category}"`);
    if (e.fy_quarter) attrs.push(`quarter="${e.fy_quarter}"`);
    if (e.price_at_entry) attrs.push(`price_at_entry="${e.price_at_entry}"`);
    if (e.accuracy != null) attrs.push(`accuracy="${e.accuracy.toFixed(2)}"`);
    if (tags) attrs.push(`tags="${tags}"`);

    let body = sanitize(e.body);
    if (e.kind === "prediction" && e.predicted) {
      body += `\n  予測: ${JSON.stringify(e.predicted).slice(0, 200)}`;
      if (e.actual) body += `\n  実績: ${JSON.stringify(e.actual).slice(0, 200)}`;
    }

    lines.push(`<entry ${attrs.join(" ")}>`);
    lines.push(body);
    lines.push(`</entry>`);
  }

  return lines.join("\n");
}

/* ─────────────────────────────────────────────────────────
   Migration: convert legacy memos to karte entries
   ───────────────────────────────────────────────────────── */

export async function migrateMemosToKarte(code, memos) {
  if (!Array.isArray(memos) || memos.length === 0) return { migrated: 0 };
  const karte = await getKarte(code);
  let migrated = 0;
  for (const m of memos) {
    // Skip if already migrated (we add a marker)
    if (m._migrated_to_karte) continue;
    const entry = {
      id: "entry_" + crypto.randomBytes(6).toString("hex"),
      ts: m.ts || new Date().toISOString(),
      ts_updated: m.ts_updated || null,
      kind: "lesson",  // default kind for migrated memos
      body: m.body || "",
      tags: Array.isArray(m.tags) ? m.tags : [],
      author: m.author || "anonymous",
      category: null,
      verdict: null, target_price: null, horizon: null,
      predicted: null, actual: null, accuracy: null,
      fy_quarter: null, surprise: null,
      price_at_entry: null, price_change_pct: null,
      _migrated_from_memo: m.id || null,
    };
    karte.entries.unshift(entry);
    migrated++;
  }
  if (migrated > 0) {
    karte.entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    karte.meta.last_updated = new Date().toISOString();
    if (!karte.meta.first_seen) karte.meta.first_seen = karte.entries[karte.entries.length - 1]?.ts || new Date().toISOString();
    await kvCommand(["SET", karteKey(code), JSON.stringify(karte)]);
  }
  return { migrated };
}

/* ─────────────────────────────────────────────────────────
   Helpers for Phase 4 thesis generation
   ───────────────────────────────────────────────────────── */

// Count entries that contain user judgment (excluding AI-generated thesis snapshots)
// Used to decide if karte has enough user content to be a primary source for Thesis.
export function countUserAuthoredEntries(karte) {
  if (!karte || !Array.isArray(karte.entries)) return 0;
  return karte.entries.filter(e =>
    e.kind === "judgment" ||
    e.kind === "lesson" ||
    e.kind === "prediction" ||
    e.kind === "earnings_react"
  ).length;
}

// Build an AI thesis snapshot entry from a generated investment_thesis
// for automatic insertion into karte history.
export function buildThesisSnapshotEntry(thesis, { code, price, generatedAt } = {}) {
  if (!thesis || !thesis.scenarios) return null;

  const scenarios = thesis.scenarios;
  const bull = scenarios.bull || {};
  const base = scenarios.base || {};
  const bear = scenarios.bear || {};

  const bodyParts = [];
  if (bull.probability != null) bodyParts.push(`Bull ${(bull.probability * 100).toFixed(0)}% (${bull.implied_return || ""})`);
  if (base.probability != null) bodyParts.push(`Base ${(base.probability * 100).toFixed(0)}% (${base.implied_return || ""})`);
  if (bear.probability != null) bodyParts.push(`Bear ${(bear.probability * 100).toFixed(0)}% (${bear.implied_return || ""})`);

  const bullDrivers = (bull.drivers || []).slice(0, 2).join(" / ");
  const bearDrivers = (bear.drivers || []).slice(0, 2).join(" / ");

  const summary = [
    bodyParts.join(" | "),
    bullDrivers ? `↑ ${bullDrivers}` : null,
    bearDrivers ? `↓ ${bearDrivers}` : null,
  ].filter(Boolean).join("\n");

  return {
    kind: "ai_thesis_snapshot",
    body: summary || "AI Thesis snapshot (no scenario data)",
    tags: ["ai-generated", "thesis"],
    price_at_entry: price?.value || null,
    // Custom fields for thesis snapshots
    _thesis_data: {
      bull_p: bull.probability,
      base_p: base.probability,
      bear_p: bear.probability,
      thesis_source: thesis._source || "edinet+karte",
      generated_at: generatedAt || new Date().toISOString(),
    },
  };
}

/* ─────────────────────────────────────────────────────────
   Thesis regeneration rate limit
   ───────────────────────────────────────────────────────── */

// 24h window, max 3 regenerations per stock
const REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const REGEN_MAX_PER_WINDOW = 3;

function regenKey(code) {
  return `argos:thesis_regen:${code}`;
}

// Check if a thesis regeneration is allowed for this code right now.
// Returns { allowed: bool, count: number, resets_at: ISO string, reason?: string }
export async function checkThesisRegenAllowed(code) {
  if (!KV_AVAILABLE) {
    // Without KV we can't track — allow but warn
    return { allowed: true, count: 0, resets_at: null, reason: "no-kv" };
  }
  try {
    const raw = await kvCommand(["GET", regenKey(code)]);
    if (!raw) {
      return { allowed: true, count: 0, resets_at: null };
    }
    const data = JSON.parse(raw);
    const now = Date.now();
    // Filter timestamps within window
    const recentTs = (data.timestamps || []).filter(ts => now - ts < REGEN_WINDOW_MS);
    if (recentTs.length >= REGEN_MAX_PER_WINDOW) {
      const oldest = Math.min(...recentTs);
      const resetsAt = new Date(oldest + REGEN_WINDOW_MS).toISOString();
      return {
        allowed: false,
        count: recentTs.length,
        resets_at: resetsAt,
        reason: `Rate limit: 24h で ${REGEN_MAX_PER_WINDOW} 回までです。最も古いリクエストから 24 時間後 (${resetsAt}) にリセットされます。`,
      };
    }
    return { allowed: true, count: recentTs.length, resets_at: null };
  } catch (e) {
    console.warn(`[karte regen check] ${code}: ${e.message}`);
    return { allowed: true, count: 0, resets_at: null, reason: "error" };
  }
}

// Record a thesis regeneration timestamp.
export async function recordThesisRegen(code) {
  if (!KV_AVAILABLE) return;
  try {
    const raw = await kvCommand(["GET", regenKey(code)]);
    let data = { timestamps: [] };
    if (raw) {
      try { data = JSON.parse(raw); } catch {}
    }
    const now = Date.now();
    // Keep only timestamps within the window + current
    data.timestamps = (data.timestamps || []).filter(ts => now - ts < REGEN_WINDOW_MS);
    data.timestamps.push(now);
    // TTL: 25h to ensure it gets cleaned up
    await kvCommand(["SET", regenKey(code), JSON.stringify(data), "EX", String(25 * 60 * 60)]);
  } catch (e) {
    console.warn(`[karte regen record] ${code}: ${e.message}`);
  }
}
