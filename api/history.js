// api/history.js — REST endpoint for ARGOS analysis history
//
// Routes:
//   GET    /api/history?deviceId=XXX                       → list metadata only (no snapshots)
//   GET    /api/history?deviceId=XXX&code=YYY              → get snapshot for code
//   GET    /api/history?deviceId=XXX&op=full               → list with all snapshots (heavy)
//   POST   /api/history?deviceId=XXX&code=YYY              → upsert entry (used by analyze on completion)
//   DELETE /api/history?deviceId=XXX&code=YYY              → delete one entry
//   DELETE /api/history?deviceId=XXX&op=clear              → clear all
//
// Note: The deviceId is supplied by the client (browser localStorage) and must be a
// stable UUID-like string. There is no auth — the deviceId acts as both identifier
// and access token. Anyone with the deviceId can access that history.

import {
  listHistory,
  getEntry,
  saveEntry,
  deleteEntry,
  clearHistory,
  isValidDeviceId,
  KV_AVAILABLE,
} from "../lib/history.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (!KV_AVAILABLE) {
    return res.status(503).json({
      error: "History storage is not configured.",
      hint: "Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel env.",
      code: "KV_NOT_CONFIGURED",
    });
  }

  const deviceId = String(req.query.deviceId || "").trim();
  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({
      error: "Invalid deviceId. Must be 8-64 alphanumeric characters (with dashes/underscores).",
      code: "INVALID_DEVICE_ID",
    });
  }

  const code = req.query.code ? String(req.query.code).trim() : null;
  const op = String(req.query.op || "").trim();

  try {
    switch (req.method) {
      case "GET": {
        if (code) {
          const entry = await getEntry(deviceId, code);
          if (!entry) return res.status(404).json({ error: "No history for this code" });
          return res.status(200).json({ entry });
        }
        const withSnapshots = op === "full";
        const history = await listHistory(deviceId, { withSnapshots });
        return res.status(200).json({
          deviceId,
          count: history.length,
          history,
        });
      }

      case "POST": {
        if (!code) return res.status(400).json({ error: "code query param required" });
        const body = await readBody(req);
        const merged = body.merged || body.snapshot || body;
        const extra = {
          conviction: body.conviction || null,
          verdict_at_time: body.verdict_at_time || null,
        };
        const entry = await saveEntry(deviceId, code, merged, extra);
        return res.status(201).json({ entry });
      }

      case "DELETE": {
        if (op === "clear") {
          await clearHistory(deviceId);
          return res.status(200).json({ ok: true, cleared: true });
        }
        if (!code) return res.status(400).json({ error: "code query param required" });
        const result = await deleteEntry(deviceId, code);
        return res.status(200).json(result);
      }

      default:
        res.setHeader("Allow", "GET, POST, DELETE");
        return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (err) {
    console.error(`[ARGOS history] ${req.method} ${req.url}:`, err.message, err.code || "");
    const errCode = err.code || "";
    let status = 400;
    let payload = { error: err.message, code: errCode };
    if (errCode === "KV_NOT_CONFIGURED" || errCode === "KV_URL_INVALID") {
      status = 503;
      payload.hint = "Check Vercel env: KV_REST_API_URL / KV_REST_API_TOKEN.";
    } else if (errCode === "KV_AUTH_FAILED") {
      status = 503;
      payload.hint = "Token invalid/rotated. Reset in Upstash and update Vercel.";
    } else if (errCode === "KV_TIMEOUT" || errCode === "KV_NETWORK_ERROR") {
      status = 503;
      payload.hint = "Cannot reach Upstash.";
    }
    return res.status(status).json(payload);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 5e6) reject(new Error("Body too large")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
