// api/export-pdf.js — Generate institutional research PDF for a merged analysis
//
// POST /api/export-pdf
// Body: { merged: <full analysis object> }  OR  { code: "9218", deviceId: "dev_..." }
//   - If `merged` is provided, use it directly
//   - Otherwise try to fetch the snapshot from history (deviceId required)
//
// Returns: application/pdf binary

import { generateReportPdf } from "../lib/pdf-generator.js";
import { getEntry, isValidDeviceId } from "../lib/history.js";

export const config = {
  maxDuration: 60,  // PDF generation should be fast (~1-3s) but allow margin
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let merged = body?.merged || body?.snapshot;

  // Fallback: load from history snapshot
  if (!merged && body?.code && body?.deviceId) {
    if (!isValidDeviceId(body.deviceId)) {
      return res.status(400).json({ error: "Invalid deviceId" });
    }
    try {
      const entry = await getEntry(body.deviceId, body.code);
      if (!entry || !entry.snapshot) {
        return res.status(404).json({ error: "No snapshot in history for this code" });
      }
      merged = entry.snapshot;
    } catch (err) {
      return res.status(500).json({ error: `History fetch failed: ${err.message}` });
    }
  }

  if (!merged || !merged.code) {
    return res.status(400).json({ error: "merged analysis (with .code) is required" });
  }

  try {
    const pdfBuffer = await generateReportPdf(merged);

    const today = new Date().toISOString().slice(0, 10);
    const filename = `ARGOS_${merged.code}_${today}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    // Use both filename (ASCII fallback) and filename* (RFC 5987 UTF-8) for broad client support
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("[ARGOS pdf] generation failed:", err);
    return res.status(500).json({
      error: `PDF generation failed: ${err.message}`,
      hint: "Check server logs for details. The font file may be missing.",
    });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 5e6) {
        reject(new Error("Body too large (5MB max)"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
