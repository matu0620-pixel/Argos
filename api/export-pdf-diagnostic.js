// api/export-pdf-diagnostic.js — Health check for PDF generation
// GET /api/export-pdf-diagnostic — verifies font availability and pdfkit is loadable
// without actually generating a PDF.

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const out = {
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    __dirname,
    node_version: process.version,
    font_check: {},
    pdfkit_check: {},
  };

  // Check font file existence at multiple candidate paths
  const candidates = [
    path.resolve(__dirname, "../lib/fonts/NotoSansJP.ttf"),
    path.resolve(__dirname, "fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "lib/fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "argos/lib/fonts/NotoSansJP.ttf"),
    "/var/task/lib/fonts/NotoSansJP.ttf",
  ];

  out.font_check.candidates = candidates.map(p => {
    try {
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : null;
      return { path: p, exists, size_bytes: size };
    } catch (e) {
      return { path: p, error: e.message };
    }
  });
  out.font_check.found = out.font_check.candidates.find(c => c.exists)?.path || null;

  // Try to import pdfkit
  try {
    const pdfkit = await import("pdfkit");
    out.pdfkit_check.imported = true;
    out.pdfkit_check.has_default = typeof pdfkit.default === "function";
  } catch (e) {
    out.pdfkit_check.imported = false;
    out.pdfkit_check.error = e.message;
  }

  // Try to import the generator
  try {
    const gen = await import("../lib/pdf-generator.js");
    out.generator_check = {
      imported: true,
      has_function: typeof gen.generateReportPdf === "function",
    };
  } catch (e) {
    out.generator_check = {
      imported: false,
      error: e.message,
      stack: e.stack ? e.stack.split("\n").slice(0, 5).join("\n") : null,
    };
  }

  // List a sample of files near __dirname for debugging
  try {
    const parent = path.resolve(__dirname, "..");
    const libDir = path.resolve(parent, "lib");
    if (fs.existsSync(libDir)) {
      out.lib_directory_contents = fs.readdirSync(libDir).slice(0, 30);
    }
    const fontsDir = path.resolve(libDir, "fonts");
    if (fs.existsSync(fontsDir)) {
      out.fonts_directory_contents = fs.readdirSync(fontsDir);
    }
  } catch (e) {
    out.directory_listing_error = e.message;
  }

  const status = (out.font_check.found && out.pdfkit_check.imported && out.generator_check?.imported)
    ? "OK"
    : "PROBLEMS_DETECTED";

  return res.status(status === "OK" ? 200 : 503).json({ status, ...out });
}
