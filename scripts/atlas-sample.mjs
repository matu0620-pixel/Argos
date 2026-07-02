#!/usr/bin/env node
// scripts/atlas-sample.mjs — 開発用の合成Atlasデータ生成 (実クロール前のBench/Model接続開発用)
//   node scripts/atlas-sample.mjs [--out public/atlas]
// 出力ファイルは本番と同スキーマ。meta.json に sample:true を立てる。
import fs from "node:fs";
import path from "node:path";
import { computeMetrics, sizeBand } from "../lib/atlas/metrics.js";
import { buildStats } from "../lib/atlas/stats.js";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "public/atlas"; })();
fs.mkdirSync(OUT, { recursive: true });

// 決定的乱数 (再現性のため)
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2; // 擬似正規 [-1,1]

// 業種プロファイル: [粗利率%, 営利率%, 一人当たり売上(百万), 平均年収(百万), 売上中央値(百万)]
const PROFILES = {
  "情報・通信業": [45, 10, 35, 6.5, 15000],
  "サービス業": [40, 8, 25, 5.5, 12000],
  "小売業": [30, 4, 45, 5.0, 30000],
  "卸売業": [15, 3, 120, 6.0, 50000],
  "食料品": [35, 6, 60, 5.8, 40000],
  "化学": [32, 9, 70, 6.8, 60000],
  "機械": [28, 8, 55, 6.5, 45000],
  "電気機器": [30, 8, 50, 6.8, 55000],
  "輸送用機器": [18, 6, 65, 6.6, 80000],
  "建設業": [12, 5, 90, 7.0, 60000],
};

const records = [];
let codeSeq = 1301;
for (const [ind, [gpm, opm, perEmp, salary, revMed]] of Object.entries(PROFILES)) {
  for (let i = 0; i < 40; i++) {
    const rev = Math.max(800, Math.round(revMed * Math.exp(gauss() * 1.4)));
    const gpMargin = Math.max(5, gpm + gauss() * 10);
    const opMargin = Math.max(-5, opm + gauss() * 5);
    const cogs = Math.round(rev * (1 - gpMargin / 100));
    const op = Math.round(rev * opMargin / 100);
    const employees = Math.max(20, Math.round(rev / Math.max(5, perEmp + gauss() * 10)));
    const growth = 1 + (0.03 + gauss() * 0.08);
    const annual = [3, 2, 1, 0].map((off) => {
      const r = Math.round(rev / Math.pow(growth, off));
      const c = Math.round(r * (1 - gpMargin / 100));
      const o = Math.round(r * opMargin / 100);
      return {
        fy: `FY${25 - off}`, revenue: r, cost_of_sales: c, gross_profit: r - c,
        sga: r - c - o, operating_profit: o, ordinary_profit: Math.round(o * 1.02),
        net_profit: Math.round(o * 0.65), operating_cf: Math.round(o * 1.1),
        investing_cf: -Math.round(r * 0.03), free_cash_flow: Math.round(o * 1.1 - r * 0.03),
      };
    });
    const totalAssets = Math.round(rev * (0.7 + rand() * 0.8));
    const netAssets = Math.round(totalAssets * (0.3 + rand() * 0.4));
    const code = String(codeSeq++);
    const rec = {
      code, name: `サンプル${ind.slice(0, 2)}${i + 1}`, edinet_code: `E${code}0`,
      industry33: ind, industry33_code: null, market: rand() > 0.5 ? "プライム" : "スタンダード",
      fy: "FY25", period_end: "2026-03-31", basis: "連結", unit: "百万円",
      doc_id: `SAMPLE${code}`, submitted: "2026-06-25",
      employees, average_salary: Math.round((salary + gauss()) * 1e6),
      business_summary: `${ind}の合成サンプル企業`,
      revenue: annual[3].revenue, operating_profit: annual[3].operating_profit,
      cash: Math.round(totalAssets * 0.15), interest_bearing_debt: Math.round(totalAssets * (0.1 + rand() * 0.25)),
      total_assets: totalAssets, net_assets: netAssets,
      receivables: Math.round(rev * (0.08 + rand() * 0.12)),
      inventories: Math.round(cogs * (0.05 + rand() * 0.2)),
      payables: Math.round(cogs * (0.06 + rand() * 0.12)),
      annual,
    };
    rec.size_band = sizeBand(rec.revenue);
    rec.metrics = computeMetrics(rec);
    records.push(rec);
  }
}

const stats = buildStats(records);
const lite = records.map(({ annual, business_summary, ...rest }) => rest);
fs.writeFileSync(path.join(OUT, "companies.json"), JSON.stringify(records));
fs.writeFileSync(path.join(OUT, "companies-lite.json"), JSON.stringify(lite));
fs.writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 1));
fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
  generated_at: new Date().toISOString(), sample: true,
  companies: records.length, industries: stats.universe.industries,
  source: "SYNTHETIC — 開発用。本番は scripts/build-atlas.mjs で生成",
}, null, 2));
console.log(`[SAMPLE] ${records.length} 社 / ${stats.universe.industries} 業種 → ${OUT}`);
