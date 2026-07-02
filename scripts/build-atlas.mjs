#!/usr/bin/env node
// scripts/build-atlas.mjs
// =======================================================================
// ARGOS Atlas バッチ — 全上場企業の有報を EDINET から巡回し、
// 企業レコード(companies.json)と業種×規模帯統計(stats.json)を生成する。
//
// 使い方:
//   EDINET_API_KEY=xxx node scripts/build-atlas.mjs [options]
//
// Options:
//   --months <N>       何ヶ月分の日次一覧を遡るか (default 14 — 全社の有報を1周捕捉)
//   --limit <N>        処理する企業数の上限 (段階投入・試運転用)
//   --industries <csv> 東証33業種名でフィルタ (例: "情報・通信業,サービス業")
//   --cache <dir>      キャッシュディレクトリ (default .atlas-cache) — 再実行時はスキップ
//   --out <dir>        出力先 (default public/atlas)
//   --sleep <ms>       EDINET APIコール間隔 (default 700ms — 負荷配慮)
//
// 所要時間目安: 全上場(~3,900社)で 60〜90分。キャッシュにより再実行は差分のみ。
// 定期運用: 月次でローカル or GitHub Actions 実行 → public/atlas をコミット。
// =======================================================================

import fs from "node:fs";
import path from "node:path";
import { listDocsForDate, downloadDocumentCSV } from "../lib/edinet.js";
import { buildCompanyRecord } from "../lib/atlas/record.js";
import { buildStats } from "../lib/atlas/stats.js";

const API_KEY = process.env.EDINET_API_KEY;
if (!API_KEY) { console.error("EDINET_API_KEY が未設定です"); process.exit(1); }

// ---- args ----
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const MONTHS = Number(opt("months", 14));
const LIMIT = Number(opt("limit", Infinity)) || Infinity;
const INDUSTRIES = opt("industries", "") ? opt("industries", "").split(",").map((s) => s.trim()) : null;
const CACHE = opt("cache", ".atlas-cache");
const OUT = opt("out", "public/atlas");
const SLEEP = Number(opt("sleep", 700));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
ensureDir(CACHE); ensureDir(path.join(CACHE, "lists")); ensureDir(path.join(CACHE, "records")); ensureDir(OUT);

// ---- 1. JPXマスタ (東証33業種) ----
// data_j.xls: https://www.jpx.co.jp/markets/statistics-equities/misc/01.html
const JPX_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls";

async function loadJpxMaster() {
  const cachePath = path.join(CACHE, "jpx-master.json");
  if (fs.existsSync(cachePath)) {
    const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    console.log(`[JPX] master from cache: ${Object.keys(j).length} 社`);
    return j;
  }
  let XLSX;
  try { XLSX = (await import("xlsx")).default ?? (await import("xlsx")); }
  catch { console.error("xlsx パッケージが必要です: npm i -D xlsx"); process.exit(1); }

  console.log("[JPX] downloading data_j.xls ...");
  const resp = await fetch(JPX_URL, { headers: { "User-Agent": "ARGOS-Atlas/1.0" } });
  if (!resp.ok) throw new Error(`JPX master DL 失敗: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false });

  const master = {};
  for (const r of rows) {
    const code = String(r["コード"] || "").trim().slice(0, 4);
    if (!/^\d{4}$/.test(code)) continue;
    const market = String(r["市場・商品区分"] || "");
    if (!/プライム|スタンダード|グロース/.test(market)) continue; // ETF/REIT等を除外
    master[code] = {
      name: String(r["銘柄名"] || ""),
      industry33: String(r["33業種区分"] || "") || null,
      industry33_code: String(r["33業種コード"] || "") || null,
      market: market.replace(/（.*/, "").replace(/\(内国株式\)|内国株式/g, "").trim(),
    };
  }
  fs.writeFileSync(cachePath, JSON.stringify(master));
  console.log(`[JPX] master: ${Object.keys(master).length} 社`);
  return master;
}

// ---- 2. 日次一覧の巡回 → 最新有報 doc を secCode ごとに確定 ----
function* businessDays(months) {
  const d = new Date();
  const end = new Date(); end.setMonth(end.getMonth() - months);
  while (d > end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) yield d.toISOString().slice(0, 10);
    d.setDate(d.getDate() - 1);
  }
}

async function collectAnnualReportDocs() {
  const byCode = {}; // code4 → doc (最新 submitDateTime を採用)
  let dayCount = 0;
  for (const dateStr of businessDays(MONTHS)) {
    const cachePath = path.join(CACHE, "lists", `${dateStr}.json`);
    let docs;
    if (fs.existsSync(cachePath)) {
      docs = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } else {
      try {
        docs = await listDocsForDate(API_KEY, dateStr);
      } catch (e) {
        console.warn(`[LIST] ${dateStr} 失敗: ${e.message}`); docs = [];
      }
      fs.writeFileSync(cachePath, JSON.stringify(docs));
      await sleep(SLEEP);
    }
    for (const doc of docs) {
      // 有報 (docTypeCode 120) のみ。訂正有報(130)は除外(初版優先で簡素化)
      if (String(doc.docTypeCode) !== "120" || !doc.secCode) continue;
      const code4 = String(doc.secCode).slice(0, 4);
      const cur = byCode[code4];
      if (!cur || String(doc.submitDateTime) > String(cur.submitDateTime)) byCode[code4] = doc;
    }
    if (++dayCount % 20 === 0) console.log(`[LIST] ${dateStr} まで走査 — 有報 ${Object.keys(byCode).length} 社`);
  }
  console.log(`[LIST] 走査完了: 有報 ${Object.keys(byCode).length} 社`);
  return byCode;
}

// ---- 3. 各社 CSV → Atlasレコード ----
async function buildRecords(docsByCode, jpx) {
  let codes = Object.keys(docsByCode).sort();
  if (INDUSTRIES) codes = codes.filter((c) => jpx[c] && INDUSTRIES.includes(jpx[c].industry33));
  if (codes.length > LIMIT) codes = codes.slice(0, LIMIT);
  console.log(`[BUILD] 対象 ${codes.length} 社`);

  const records = [];
  let done = 0, failed = 0;
  for (const code of codes) {
    const doc = docsByCode[code];
    const cachePath = path.join(CACHE, "records", `${doc.docID}.json`);
    let rec = null;
    if (fs.existsSync(cachePath)) {
      rec = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } else {
      try {
        const { rows } = await downloadDocumentCSV(API_KEY, doc.docID);
        rec = buildCompanyRecord(rows, doc, jpx[code] || null);
      } catch (e) {
        console.warn(`[BUILD] ${code} (${doc.docID}) 失敗: ${e.message}`);
      }
      fs.writeFileSync(cachePath, JSON.stringify(rec)); // 失敗(null)もキャッシュし再叩き防止
      await sleep(SLEEP);
    }
    if (rec) records.push(rec); else failed++;
    if (++done % 50 === 0) console.log(`[BUILD] ${done}/${codes.length} (失敗 ${failed})`);
  }
  console.log(`[BUILD] 完了: ${records.length} 社 (失敗 ${failed})`);
  return records;
}

// ---- 4. 出力 ----
async function main() {
  const t0 = Date.now();
  const jpx = await loadJpxMaster();
  const docsByCode = await collectAnnualReportDocs();
  const records = await buildRecords(docsByCode, jpx);
  if (!records.length) { console.error("レコード0件 — 出力を中止"); process.exit(1); }

  const stats = buildStats(records);
  // companies.json は annual を含むフル版と、一覧用の軽量版の2本
  const lite = records.map(({ annual, business_summary, ...rest }) => rest);

  fs.writeFileSync(path.join(OUT, "companies.json"), JSON.stringify(records));
  fs.writeFileSync(path.join(OUT, "companies-lite.json"), JSON.stringify(lite));
  fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 1));
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    companies: records.length,
    industries: stats.universe.industries,
    months_scanned: MONTHS,
    source: "EDINET API v2 (有価証券報告書) + JPX 東証上場銘柄一覧",
    build_minutes: Math.round((Date.now() - t0) / 60000),
  }, null, 2));

  console.log(`[OUT] ${OUT}/companies.json (${records.length}社), stats.json (${stats.universe.industries}業種)`);
  console.log(`[DONE] ${Math.round((Date.now() - t0) / 60000)} 分`);
}

main().catch((e) => { console.error(e); process.exit(1); });
