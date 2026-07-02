// api/atlas.js — ARGOS Atlas 配信エンドポイント
//   GET /api/atlas                      → meta (生成日時・社数)
//   GET /api/atlas?stats=1              → 全業種統計
//   GET /api/atlas?stats=1&industry=情報・通信業&band=S3 → 業種(×規模帯)統計
//   GET /api/atlas?code=7203            → 企業レコード(5期annual含む)
//   GET /api/atlas?peers=7203&limit=10  → 同業ピア(軽量レコード)
// Portal / Bench / Model から別オリジンで呼べるよう CORS 許可。
// データは scripts/build-atlas.mjs が生成する public/atlas/*.json (ビルド成果物)。

import fs from "node:fs";
import path from "node:path";
import { pickPeers } from "../lib/atlas/stats.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const cache = {}; // モジュールスコープでプロセス内キャッシュ
function load(name) {
  if (cache[name] !== undefined) return cache[name];
  const p = path.join(process.cwd(), "public", "atlas", name);
  try { cache[name] = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { cache[name] = null; }
  return cache[name];
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.statusCode = 204; for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); return res.end(); }
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  const url = new URL(req.url, "http://x");
  const q = url.searchParams;
  const meta = load("meta.json");
  if (!meta) return json(res, 503, { error: "Atlas データ未生成です。scripts/build-atlas.mjs を実行し public/atlas をデプロイしてください" });

  // 企業レコード
  const code = q.get("code");
  if (code) {
    const companies = load("companies.json") || [];
    const rec = companies.find((c) => c.code === String(code).slice(0, 4));
    return rec ? json(res, 200, rec) : json(res, 404, { error: `code ${code} は Atlas 未収載です` });
  }

  // ピア選定
  const peersOf = q.get("peers");
  if (peersOf) {
    const companies = load("companies.json") || [];
    const limit = Math.min(Number(q.get("limit") || 10), 30);
    const peers = pickPeers(companies, String(peersOf).slice(0, 4), limit);
    const byCode = new Map(companies.map((c) => [c.code, c]));
    const detail = peers.map((p) => {
      const { annual, business_summary, ...lite } = byCode.get(p.code) || {};
      return lite;
    });
    return json(res, 200, { code: peersOf, peers: detail, method: "industry33 × revenue-proximity" });
  }

  // 統計
  if (q.get("stats")) {
    const stats = load("stats.json");
    if (!stats) return json(res, 503, { error: "stats.json 未生成" });
    const ind = q.get("industry");
    if (!ind) return json(res, 200, stats);
    const indStats = stats.industries[ind];
    if (!indStats) return json(res, 404, { error: `業種 "${ind}" は未収載`, available: Object.keys(stats.industries) });
    const band = q.get("band");
    if (band) {
      const b = indStats.bands?.[band];
      // 規模帯の n が薄い場合は業種全体へフォールバック(呼び出し側契約: fallback フラグで通知)
      return json(res, 200, b
        ? { industry: ind, band, ...b }
        : { industry: ind, band, fallback: "industry", n: indStats.n, metrics: indStats.metrics });
    }
    return json(res, 200, { industry: ind, ...indStats });
  }

  return json(res, 200, meta);
}
