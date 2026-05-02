// api/memos.js — REST endpoint for ARGOS user memos
// Routes:
//   GET    /api/memos?code=XXXX         → list memos for code
//   POST   /api/memos?code=XXXX         → create memo (body: {section, body, tags, ...})
//   PATCH  /api/memos?code=XXXX&id=YYY  → update memo
//   DELETE /api/memos?code=XXXX&id=YYY  → delete memo

import {
  listMemos,
  createMemo,
  updateMemo,
  deleteMemo,
  KV_AVAILABLE,
  MEMO_SECTIONS,
  MEMO_PRESET_TAGS,
} from "../lib/memos.js";

export default async function handler(req, res) {
  // CORS / preflight
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  // Storage availability check
  if (!KV_AVAILABLE) {
    return res.status(503).json({
      error: "Memo storage is not configured on this deployment.",
      hint: "Set KV_REST_API_URL and KV_REST_API_TOKEN environment variables. Free Upstash Redis instance works.",
      code: "KV_NOT_CONFIGURED",
    });
  }

  // Parse code parameter
  const code = String(req.query.code || "").trim();
  if (!/^\d{4,5}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code: must be 4-5 digit string" });
  }

  try {
    switch (req.method) {
      case "GET": {
        const memos = await listMemos(code);
        return res.status(200).json({
          code,
          count: memos.length,
          memos,
          meta: {
            sections: MEMO_SECTIONS,
            preset_tags: MEMO_PRESET_TAGS,
          },
        });
      }

      case "POST": {
        const body = await readBody(req);
        const memo = await createMemo(code, body);
        return res.status(201).json({ memo });
      }

      case "PATCH": {
        const id = String(req.query.id || "").trim();
        if (!id) return res.status(400).json({ error: "id query param required" });
        const body = await readBody(req);
        const memo = await updateMemo(code, id, body);
        return res.status(200).json({ memo });
      }

      case "DELETE": {
        const id = String(req.query.id || "").trim();
        if (!id) return res.status(400).json({ error: "id query param required" });
        const result = await deleteMemo(code, id);
        return res.status(200).json(result);
      }

      default:
        res.setHeader("Allow", "GET, POST, PATCH, DELETE");
        return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (err) {
    console.error(`[ARGOS memos] ${req.method} ${req.url}:`, err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    return res.status(status).json({ error: err.message });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 1e6) reject(new Error("Body too large")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
