// api/memos-diagnostic.js — Quick health check for KV (Upstash) connectivity
// GET /api/memos-diagnostic — returns {status, details} so users can debug fetch failed errors

import { KV_AVAILABLE } from "../lib/memos.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const out = {
    timestamp: new Date().toISOString(),
    kv_available: KV_AVAILABLE,
    env: {
      KV_REST_API_URL_set: !!KV_URL,
      KV_REST_API_URL_length: KV_URL ? KV_URL.length : 0,
      KV_REST_API_URL_protocol: KV_URL ? (KV_URL.startsWith("https://") ? "https" : KV_URL.startsWith("http://") ? "http" : "invalid") : null,
      KV_REST_API_URL_host: null,
      KV_REST_API_TOKEN_set: !!KV_TOKEN,
      KV_REST_API_TOKEN_length: KV_TOKEN ? KV_TOKEN.length : 0,
    },
    connectivity: null,
  };

  // Parse and report URL host
  if (KV_URL) {
    try {
      const u = new URL(KV_URL.trim().replace(/\/+$/, ""));
      out.env.KV_REST_API_URL_host = u.hostname;
    } catch {
      out.env.KV_REST_API_URL_host = "PARSE_ERROR";
    }
  }

  if (!KV_AVAILABLE) {
    return res.status(503).json({ ...out, status: "KV_NOT_CONFIGURED" });
  }

  // Attempt a PING command
  const cleanUrl = KV_URL.trim().replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const t0 = Date.now();
    const r = await fetch(cleanUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["PING"]),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const elapsed_ms = Date.now() - t0;
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    out.connectivity = {
      http_status: r.status,
      ok: r.ok,
      elapsed_ms,
      response_preview: text.slice(0, 200),
      parsed_result: parsed?.result || null,
    };

    if (r.ok && parsed?.result === "PONG") {
      return res.status(200).json({ ...out, status: "OK" });
    }
    if (r.status === 401 || r.status === 403) {
      return res.status(503).json({ ...out, status: "AUTH_FAILED",
        hint: "Token may be invalid or rotated. Generate a new token in Upstash dashboard." });
    }
    return res.status(503).json({ ...out, status: "UNEXPECTED_RESPONSE" });

  } catch (err) {
    clearTimeout(timer);
    out.connectivity = {
      error: err.message,
      error_name: err.name,
      cause: err.cause ? { code: err.cause.code, message: err.cause.message } : null,
    };
    if (err.name === "AbortError") {
      return res.status(503).json({ ...out, status: "TIMEOUT",
        hint: "Upstash did not respond within 5 seconds. Check that the URL points to an active database." });
    }
    return res.status(503).json({ ...out, status: "NETWORK_ERROR",
      hint: "Cannot reach Upstash. Verify KV_REST_API_URL is correct (e.g., https://xxx.upstash.io)." });
  }
}
