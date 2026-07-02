// lib/memos.js — Persistent memo storage for ARGOS
// Backend: Upstash Redis via REST API (also Vercel KV-compatible)
// Required env vars: KV_REST_API_URL, KV_REST_API_TOKEN

import crypto from "crypto";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const KV_AVAILABLE = !!(KV_URL && KV_TOKEN);

/* ─────────────────────────────────────────────────────────
   Validation & schema
   ───────────────────────────────────────────────────────── */

export const MEMO_SECTIONS = [
  "listing",      // §01 Listing Profile
  "financial",    // §02 Financial Trajectory
  "competitive",  // §03 Competitive Landscape
  "risks",        // §04 Material Risks
  "ir_news",      // §05 IR Pulse (per-news memos use subject_id)
  "thesis",       // §06 Investment Thesis
  "general",      // catch-all (no specific section)
];

export const MEMO_PRESET_TAGS = [
  "accounting", "management", "customer", "competition",
  "regulatory", "tech", "esg", "macro", "audit", "tailwind", "headwind",
];

const MAX_BODY_LENGTH = 2000;
const MAX_TAGS_PER_MEMO = 6;
const MAX_TAG_LENGTH = 30;
const MAX_AUTHOR_LENGTH = 60;
const MAX_MEMOS_PER_CODE = 100;

/**
 * Validate and normalize a memo object before save.
 * Throws on invalid input. Returns a clean memo with normalized fields.
 */
export function validateMemo(input, { isUpdate = false } = {}) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid memo: must be object");
  }

  const out = {};

  // section (required on create, optional on update)
  if (input.section !== undefined) {
    if (!MEMO_SECTIONS.includes(input.section)) {
      throw new Error(`Invalid section: must be one of ${MEMO_SECTIONS.join(", ")}`);
    }
    out.section = input.section;
  } else if (!isUpdate) {
    out.section = "general";
  }

  // subject_id (optional, for per-news / per-risk memos)
  if (input.subject_id !== undefined) {
    if (input.subject_id !== null && typeof input.subject_id !== "string") {
      throw new Error("Invalid subject_id: must be string or null");
    }
    if (typeof input.subject_id === "string" && input.subject_id.length > 100) {
      throw new Error("subject_id too long (max 100 chars)");
    }
    out.subject_id = input.subject_id || null;
  }

  // body — required, sanitized
  if (input.body !== undefined) {
    if (typeof input.body !== "string") throw new Error("Invalid body: must be string");
    const trimmed = input.body.trim();
    if (trimmed.length === 0) throw new Error("Memo body cannot be empty");
    if (trimmed.length > MAX_BODY_LENGTH) {
      throw new Error(`Memo body too long (${trimmed.length} > ${MAX_BODY_LENGTH} chars)`);
    }
    out.body = trimmed;
  } else if (!isUpdate) {
    throw new Error("body is required");
  }

  // author
  if (input.author !== undefined) {
    if (typeof input.author !== "string") throw new Error("Invalid author");
    out.author = input.author.trim().slice(0, MAX_AUTHOR_LENGTH) || "anonymous";
  } else if (!isUpdate) {
    out.author = "anonymous";
  }

  // tags
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw new Error("tags must be array");
    if (input.tags.length > MAX_TAGS_PER_MEMO) {
      throw new Error(`Too many tags (max ${MAX_TAGS_PER_MEMO})`);
    }
    out.tags = input.tags
      .filter(t => typeof t === "string")
      .map(t => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
      .filter(t => t.length > 0 && t.length <= MAX_TAG_LENGTH)
      .slice(0, MAX_TAGS_PER_MEMO);
  } else if (!isUpdate) {
    out.tags = [];
  }

  // importance (1-3, default 2)
  if (input.importance !== undefined) {
    const n = Number(input.importance);
    if (!Number.isInteger(n) || n < 1 || n > 3) {
      throw new Error("importance must be 1, 2, or 3");
    }
    out.importance = n;
  } else if (!isUpdate) {
    out.importance = 2;
  }

  return out;
}

/* ─────────────────────────────────────────────────────────
   KV (Upstash REST) command runner
   ───────────────────────────────────────────────────────── */

// Sanitize KV URL once at startup — strip trailing slash and validate
function sanitizeKvUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  // Strip trailing slashes
  u = u.replace(/\/+$/, "");
  // Validate it's a proper https URL
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return u;
  } catch {
    return null;
  }
}

const KV_URL_CLEAN = sanitizeKvUrl(KV_URL);
const KV_TIMEOUT_MS = 8000;     // 8s per attempt
const KV_MAX_RETRIES = 2;       // 1 initial + 2 retries = 3 attempts

async function kvCommand(args) {
  if (!KV_AVAILABLE) {
    const err = new Error("Memo storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN environment variables.");
    err.code = "KV_NOT_CONFIGURED";
    throw err;
  }
  if (!KV_URL_CLEAN) {
    const err = new Error("KV_REST_API_URL is malformed. Expected a full https URL (e.g., https://xxx.upstash.io).");
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
        headers: {
          "Authorization": `Bearer ${KV_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        // Token issue — don't retry, fail fast
        const body = await res.text().catch(() => "");
        const err = new Error(`KV authentication failed (HTTP ${res.status}). The KV_REST_API_TOKEN may be invalid or rotated. ${body.slice(0, 200)}`);
        err.code = "KV_AUTH_FAILED";
        throw err;
      }

      if (!res.ok) {
        // 5xx — retry; 4xx other than auth — fail fast
        const body = await res.text().catch(() => "");
        const err = new Error(`KV HTTP ${res.status}: ${body.slice(0, 200)}`);
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

      // AbortError = timeout, TypeError = network error (DNS, connection refused, etc.)
      const isRetryable =
        err.name === "AbortError" ||
        err.name === "TypeError" ||
        (err.cause && (err.cause.code === "ECONNRESET" || err.cause.code === "ETIMEDOUT" || err.cause.code === "EAI_AGAIN"));

      if (isRetryable && attempt < KV_MAX_RETRIES) {
        lastError = err;
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }

      // Final failure — throw with a clearer message than "fetch failed"
      if (err.name === "AbortError") {
        const e = new Error(`KV request timeout after ${KV_TIMEOUT_MS}ms (Upstash unreachable from this region?)`);
        e.code = "KV_TIMEOUT";
        throw e;
      }
      if (err.name === "TypeError" && /fetch failed|network/i.test(err.message)) {
        const causeMsg = err.cause?.code || err.cause?.message || "unknown";
        const e = new Error(`KV network error: cannot reach Upstash (${causeMsg}). Check KV_REST_API_URL.`);
        e.code = "KV_NETWORK_ERROR";
        throw e;
      }
      throw err;
    }
  }
  throw lastError || new Error("KV command failed after retries");
}

const memoKey = (code) => `argos:memos:${String(code)}`;

/* ─────────────────────────────────────────────────────────
   CRUD operations
   ───────────────────────────────────────────────────────── */

/** List all memos for a stock code, sorted newest first */
export async function listMemos(code) {
  const raw = await kvCommand(["GET", memoKey(code)]);
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
}

/** Create a new memo for a stock code */
export async function createMemo(code, input) {
  const clean = validateMemo(input, { isUpdate: false });
  const memo = {
    id: "memo_" + crypto.randomBytes(6).toString("hex"),
    code: String(code),
    ts: new Date().toISOString(),
    ts_updated: null,
    ...clean,
  };
  const existing = await listMemos(code);
  if (existing.length >= MAX_MEMOS_PER_CODE) {
    throw new Error(`Memo limit reached (${MAX_MEMOS_PER_CODE}). Delete old memos first.`);
  }
  existing.push(memo);
  await kvCommand(["SET", memoKey(code), JSON.stringify(existing)]);
  return memo;
}

/** Update an existing memo by ID */
export async function updateMemo(code, id, input) {
  const clean = validateMemo(input, { isUpdate: true });
  const existing = await listMemos(code);
  const idx = existing.findIndex(m => m.id === id);
  if (idx < 0) throw new Error(`Memo ${id} not found`);
  existing[idx] = {
    ...existing[idx],
    ...clean,
    ts_updated: new Date().toISOString(),
  };
  await kvCommand(["SET", memoKey(code), JSON.stringify(existing)]);
  return existing[idx];
}

/** Delete a memo */
export async function deleteMemo(code, id) {
  const existing = await listMemos(code);
  const filtered = existing.filter(m => m.id !== id);
  if (filtered.length === existing.length) {
    throw new Error(`Memo ${id} not found`);
  }
  await kvCommand(["SET", memoKey(code), JSON.stringify(filtered)]);
  return { id, deleted: true };
}

/**
 * Compute a lightweight "version" hash for memos of a code.
 * Used by the analyze cache to invalidate when memos change.
 * Returns a short string (e.g., "0" if no memos, or "<count>-<maxTs>") that changes
 * whenever any memo is added/edited/deleted.
 *
 * Cheap: single KV GET (or returns "0" instantly if KV unavailable).
 */
export async function getMemoVersion(code) {
  if (!KV_AVAILABLE) return "0";
  try {
    const memos = await listMemos(code);
    if (memos.length === 0) return "0";
    // Use count + most recent ts (covers create/update/delete of any memo)
    const latestTs = memos.reduce((max, m) => {
      const t = m.ts_updated || m.ts || "";
      return t > max ? t : max;
    }, "");
    return `${memos.length}-${latestTs}`;
  } catch {
    return "0";
  }
}

/* ─────────────────────────────────────────────────────────
   Prompt-injection-safe context builder for AI
   ───────────────────────────────────────────────────────── */

/**
 * Build a sanitized memo context string for injection into Phase 4 prompt.
 * - Wraps each memo in <memo>...</memo> tags so the model can distinguish
 *   structural metadata from user content
 * - Filters to recent + high-importance memos to keep prompt size bounded
 * - Strips potentially dangerous instruction patterns from body
 *
 * Security notes:
 * - The model is told (via prompt) that memo content is REFERENCE, not commands
 * - We use distinct tag delimiters that the user cannot easily forge
 * - Body is escaped: any literal "</memo>" inside body is replaced
 */
export function buildMemoContextForPrompt(memos, { maxMemos = 12, maxDays = 90 } = {}) {
  if (!Array.isArray(memos) || memos.length === 0) return null;

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const filtered = memos
    .filter(m => {
      const t = Date.parse(m.ts || "");
      return Number.isFinite(t) && t >= cutoff;
    })
    // Sort: importance DESC, then ts DESC
    .sort((a, b) => {
      const impDiff = (b.importance || 2) - (a.importance || 2);
      if (impDiff !== 0) return impDiff;
      return (b.ts || "").localeCompare(a.ts || "");
    })
    .slice(0, maxMemos);

  if (filtered.length === 0) return null;

  const sanitize = (s) =>
    String(s || "")
      // Remove common prompt-injection patterns
      .replace(/<\/?(memo|user_note|system|instruction|prompt)\b[^>]*>/gi, "[tag-removed]")
      // Limit length per memo
      .slice(0, 1500);

  const lines = filtered.map((m, i) => {
    const date = (m.ts || "").slice(0, 10);
    const tags = (m.tags || []).join(", ");
    const imp = m.importance === 3 ? " [HIGH]" : (m.importance === 1 ? " [low]" : "");
    return `<memo id="${i + 1}" date="${date}" section="${m.section || "general"}"${imp}${tags ? ` tags="${tags}"` : ""}>
${sanitize(m.body)}
</memo>`;
  });

  return lines.join("\n\n");
}
