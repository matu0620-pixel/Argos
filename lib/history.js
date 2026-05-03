// lib/history.js — Per-device search history with full analysis snapshots
// Storage backend: Upstash Redis (same as karte)
// Key: argos:history:${deviceId}
//
// Concept: When a user analyzes a stock, we save:
//   - lightweight metadata (code, name, timestamp, verdict at time)
//   - the FULL analysis snapshot (merged JSON) so the user can recall
//     the report instantly without re-running the AI pipeline
//
// Each device has its own history (deviceId = client-generated UUID stored in localStorage)
// Devices can opt-in to share by using the same deviceId — this is a future
// enhancement (team sharing); MVP keeps each browser separate but stores
// server-side so the same user can recall from any device with the same id.

import crypto from "crypto";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
export const KV_AVAILABLE = !!(KV_URL && KV_TOKEN);

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
    const err = new Error("History storage is not configured.");
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

const historyKey = (deviceId) => `argos:history:${String(deviceId)}`;

const MAX_HISTORY_ENTRIES = 100;
const MAX_SNAPSHOT_KB = 200;          // Per-snapshot size cap (truncate huge analyses)
const SNAPSHOT_RETENTION_DAYS = 90;   // Trim snapshots older than this (keep meta)

/**
 * Validate a deviceId — must be a UUID-like string (alphanumeric + dashes, 8-64 chars)
 */
export function isValidDeviceId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

/**
 * Generate a deviceId on the server side (rarely used — clients should generate their own)
 */
export function generateDeviceId() {
  return "dev_" + crypto.randomBytes(12).toString("hex");
}

/* ─────────────────────────────────────────────────────────
   Schema (history entry)
   ─────────────────────────────────────────────────────────
{
  code: "9218",
  name_jp: "株式会社メンタルヘルステクノロジーズ",
  market_segment: "growth",
  analyzed_at: "2026-05-02T22:30:00Z",
  price: 749,
  change_pct: 0.94,
  conviction: "high",         // copied from karte at analysis time (best-effort)
  verdict_at_time: "buy",     // copied from karte's last judgment at analysis time
  snapshot_size_bytes: 12345, // size of the JSON snapshot (for transparency)
  snapshot: { ... }            // full merged analysis result (may be omitted on list endpoint)
}
   ───────────────────────────────────────────────────────── */

function summarizeForHistory(merged, code) {
  if (!merged) return null;
  return {
    code: String(code),
    name_jp: merged.company?.name_jp || merged.company?.name_en || null,
    market_segment: merged._market_segment || null,
    price: merged.price?.value ?? null,
    change_pct: merged.price?.change_percent ?? null,
    industry_key: merged.industry_key || null,
    // verdict / conviction will be filled in from karte by API caller (we have access there)
  };
}

/**
 * List all history entries for a device, newest first. Returns metadata only by default
 * (snapshot omitted to keep payload small). Use getEntry(deviceId, code) for full snapshot.
 */
export async function listHistory(deviceId, { withSnapshots = false } = {}) {
  if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
  const raw = await kvCommand(["GET", historyKey(deviceId)]);
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  // Sort newest first
  arr.sort((a, b) => (b.analyzed_at || "").localeCompare(a.analyzed_at || ""));
  if (!withSnapshots) {
    return arr.map(({ snapshot, ...meta }) => meta);
  }
  return arr;
}

/**
 * Get a single history entry by code (returns the most recent snapshot for that code).
 */
export async function getEntry(deviceId, code) {
  if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
  const raw = await kvCommand(["GET", historyKey(deviceId)]);
  if (!raw) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  // Find the newest entry for this code
  const matches = arr.filter(e => String(e.code) === String(code));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.analyzed_at || "").localeCompare(a.analyzed_at || ""));
  return matches[0];
}

/**
 * Save (or upsert) a history entry. If an entry for the same code exists, it's replaced
 * with the new snapshot. Older entries are trimmed if we exceed MAX_HISTORY_ENTRIES.
 */
export async function saveEntry(deviceId, code, merged, extra = {}) {
  if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
  if (!/^\d{4,5}$/.test(String(code))) throw new Error("Invalid code");

  const summary = summarizeForHistory(merged, code) || { code: String(code) };

  // Truncate snapshot if it's very large
  let snapshotJson = null;
  let snapshotSize = 0;
  try {
    snapshotJson = JSON.stringify(merged);
    snapshotSize = snapshotJson.length;
    if (snapshotSize > MAX_SNAPSHOT_KB * 1024) {
      // Strip non-essential fields to fit
      const pruned = { ...merged };
      delete pruned.industry_topics;
      delete pruned.competitive_analysis;
      snapshotJson = JSON.stringify(pruned);
      snapshotSize = snapshotJson.length;
    }
  } catch {}

  const entry = {
    code: String(code),
    name_jp: summary.name_jp,
    market_segment: summary.market_segment,
    industry_key: summary.industry_key,
    price: summary.price,
    change_pct: summary.change_pct,
    analyzed_at: new Date().toISOString(),
    conviction: extra.conviction || null,
    verdict_at_time: extra.verdict_at_time || null,
    snapshot_size_bytes: snapshotSize,
    snapshot: snapshotJson ? JSON.parse(snapshotJson) : null,
  };

  // Load current history
  const raw = await kvCommand(["GET", historyKey(deviceId)]);
  let arr = [];
  if (raw) {
    try { arr = JSON.parse(raw); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }

  // Remove any existing entry for this code (we'll add the fresh one)
  arr = arr.filter(e => String(e.code) !== String(code));

  // Add the new entry at the front
  arr.unshift(entry);

  // Trim very old snapshots (keep meta but strip snapshot)
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  arr = arr.map(e => {
    const t = Date.parse(e.analyzed_at || "");
    if (Number.isFinite(t) && t < cutoff && e.snapshot) {
      return { ...e, snapshot: null, _snapshot_expired: true };
    }
    return e;
  });

  // Cap total entries
  if (arr.length > MAX_HISTORY_ENTRIES) {
    arr = arr.slice(0, MAX_HISTORY_ENTRIES);
  }

  await kvCommand(["SET", historyKey(deviceId), JSON.stringify(arr)]);
  return entry;
}

/**
 * Delete a single history entry by code.
 */
export async function deleteEntry(deviceId, code) {
  if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
  const raw = await kvCommand(["GET", historyKey(deviceId)]);
  if (!raw) return { deleted: 0 };
  let arr;
  try { arr = JSON.parse(raw); } catch { return { deleted: 0 }; }
  if (!Array.isArray(arr)) return { deleted: 0 };
  const before = arr.length;
  arr = arr.filter(e => String(e.code) !== String(code));
  const deleted = before - arr.length;
  if (deleted > 0) {
    await kvCommand(["SET", historyKey(deviceId), JSON.stringify(arr)]);
  }
  return { deleted };
}

/**
 * Clear all history for a device.
 */
export async function clearHistory(deviceId) {
  if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
  await kvCommand(["DEL", historyKey(deviceId)]);
  return { ok: true };
}
