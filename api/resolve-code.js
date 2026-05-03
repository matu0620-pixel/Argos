// api/resolve-code.js — Resolve a company name (or partial match) to a stock code.
//
// GET /api/resolve-code?q=<company name>
// Returns: { code, name_jp, name_en, market, confidence, candidates }

import Anthropic from "@anthropic-ai/sdk";
import { resolveCompanyToCode } from "../lib/code-resolver.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Missing query parameter 'q'" });
  }

  if (q.length > 100) {
    return res.status(400).json({ error: "Query too long (max 100 chars)" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const client = new Anthropic({ apiKey });

  try {
    const result = await resolveCompanyToCode(client, q);
    return res.status(200).json(result);
  } catch (e) {
    console.error(`[resolve-code] Error: ${e.message}`);
    return res.status(500).json({
      error: e.message || "Internal server error",
      code: null,
      confidence: "low",
      candidates: [],
    });
  }
}
