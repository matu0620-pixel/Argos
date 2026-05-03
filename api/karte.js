// api/karte.js — REST endpoint for ARGOS stock karte (analyst dossier)
//
// Routes:
//   GET    /api/karte?code=XXXX                 → load full karte (meta + entries + stats)
//   POST   /api/karte?code=XXXX&op=entry        → add new entry
//   PATCH  /api/karte?code=XXXX&op=entry&id=YY  → update entry
//   DELETE /api/karte?code=XXXX&op=entry&id=YY  → delete entry
//   PATCH  /api/karte?code=XXXX&op=meta         → update meta (coverage_status, conviction, thesis)
//   POST   /api/karte?code=XXXX&op=migrate      → migrate legacy memos into karte

import {
  getKarte,
  addEntry,
  updateEntry,
  deleteEntry,
  updateMeta,
  computeStats,
  migrateMemosToKarte,
  KV_AVAILABLE,
  ENTRY_KINDS,
  VERDICT_OPTIONS,
  LESSON_CATEGORIES,
  HORIZON_OPTIONS,
  COVERAGE_STATUS,
  CONVICTION_LEVELS,
} from "../lib/karte.js";
import { listMemos } from "../lib/memos.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (!KV_AVAILABLE) {
    return res.status(503).json({
      error: "Karte storage is not configured.",
      hint: "Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel env.",
      code: "KV_NOT_CONFIGURED",
    });
  }

  const code = String(req.query.code || "").trim();
  if (!/^\d{4,5}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code: must be 4-5 digit string" });
  }
  const op = String(req.query.op || "").trim();

  try {
    switch (req.method) {
      case "GET": {
        const karte = await getKarte(code);
        const stats = computeStats(karte);
        return res.status(200).json({
          code,
          karte,
          stats,
          meta_options: {
            entry_kinds: ENTRY_KINDS,
            verdicts: VERDICT_OPTIONS,
            lesson_categories: LESSON_CATEGORIES,
            horizons: HORIZON_OPTIONS,
            coverage_statuses: COVERAGE_STATUS,
            conviction_levels: CONVICTION_LEVELS,
          },
        });
      }

      case "POST": {
        const body = await readBody(req);
        if (op === "migrate") {
          const memos = await listMemos(code);
          const result = await migrateMemosToKarte(code, memos);
          return res.status(200).json({ ok: true, ...result });
        }
        // Default: add entry
        const entry = await addEntry(code, body);
        return res.status(201).json({ entry });
      }

      case "PATCH": {
        const body = await readBody(req);
        if (op === "meta") {
          const meta = await updateMeta(code, body);
          return res.status(200).json({ meta });
        }
        // Default: update entry
        const id = String(req.query.id || "").trim();
        if (!id) return res.status(400).json({ error: "id query param required" });
        const entry = await updateEntry(code, id, body);
        return res.status(200).json({ entry });
      }

      case "DELETE": {
        const id = String(req.query.id || "").trim();
        if (!id) return res.status(400).json({ error: "id query param required" });
        const result = await deleteEntry(code, id);
        return res.status(200).json(result);
      }

      default:
        res.setHeader("Allow", "GET, POST, PATCH, DELETE");
        return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (err) {
    console.error(`[ARGOS karte] ${req.method} ${req.url}:`, err.message, err.code || "");
    const errCode = err.code || "";
    let status = 400;
    let payload = { error: err.message, code: errCode };
    if (err.message.includes("not found")) status = 404;
    else if (errCode === "KV_NOT_CONFIGURED" || errCode === "KV_URL_INVALID") {
      status = 503;
      payload.hint = "Check Vercel env: KV_REST_API_URL / KV_REST_API_TOKEN.";
    } else if (errCode === "KV_AUTH_FAILED") {
      status = 503;
      payload.hint = "Token invalid/rotated. Reset in Upstash and update Vercel.";
    } else if (errCode === "KV_TIMEOUT" || errCode === "KV_NETWORK_ERROR") {
      status = 503;
      payload.hint = "Cannot reach Upstash. Check URL/connectivity.";
    }
    return res.status(status).json(payload);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 1e6) reject(new Error("Body too large")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
