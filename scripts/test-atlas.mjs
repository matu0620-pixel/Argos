#!/usr/bin/env node
// scripts/test-atlas.mjs — Atlas 純関数層の単体テスト (ネットワーク不要)
//   node scripts/test-atlas.mjs
import assert from "node:assert/strict";
import { computeMetrics, sizeBand, revCagr, roic, STAT_METRICS } from "../lib/atlas/metrics.js";
import { percentile, summarizeGroup, buildStats, pickPeers, MIN_N } from "../lib/atlas/stats.js";
import { extractAtlasBS } from "../lib/atlas/bs-extract.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

console.log("metrics.js");
t("computeMetrics: 基本ケース", () => {
  const m = computeMetrics({
    annual: [
      { revenue: 8000, cost_of_sales: 4800, operating_profit: 560 },
      { revenue: 10000, cost_of_sales: 6000, gross_profit: 4000, sga: 3000, operating_profit: 1000, net_profit: 600, free_cash_flow: 800 },
    ],
    employees: 100, average_salary: 6_000_000,
    total_assets: 12000, net_assets: 6000,
    receivables: 1644, inventories: 986, payables: 822,
    cash: 2000, interest_bearing_debt: 3000,
  });
  assert.equal(m.gp_margin, 40);
  assert.equal(m.op_margin, 10);
  assert.equal(m.net_margin, 6);
  assert.equal(m.fcf_margin, 8);
  assert.equal(m.per_emp_revenue, 100);
  assert.equal(m.equity_ratio, 50);
  assert.equal(m.net_de, 0.2); // (3000-2000)/6000 ≈ 0.17 → 0.2
  assert.equal(m.roic, Math.round((1000 * 0.7) / 9000 * 1000) / 10); // 7.8
  assert.equal(m.dso, 60); // 1644/10000*365
  assert.equal(m.dio, 60); // 986/6000*365
  assert.equal(m.dpo, 50); // 822/6000*365
  assert.equal(m.ccc, 70);
  assert.equal(m.labor_share, 15); // 600/4000
  assert.equal(m.rev_cagr3, 25); // 8000→10000, 1期
});
t("computeMetrics: 欠損は null (NaN/Infinity を返さない)", () => {
  const m = computeMetrics({ annual: [{ revenue: null }] });
  for (const k of STAT_METRICS) assert.ok(m[k] === null || Number.isFinite(m[k]), `${k}=${m[k]}`);
});
t("revCagr: 4期", () => {
  const a = [{ revenue: 1000 }, { revenue: 1100 }, { revenue: 1210 }, { revenue: 1331 }];
  assert.equal(revCagr(a), 10);
});
t("roic: 投下資本<=0 は null", () => assert.equal(roic(100, -50, 20), null));
t("sizeBand", () => {
  assert.equal(sizeBand(4999), "S1");
  assert.equal(sizeBand(5000), "S2");
  assert.equal(sizeBand(49999), "S3");
  assert.equal(sizeBand(200000), "S5");
  assert.equal(sizeBand(null), null);
});

console.log("stats.js");
t("percentile: 補間", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.9), 10);
  assert.equal(percentile([], 0.5), null);
});
t("summarizeGroup: MIN_N 未満は出さない", () => {
  const recs = Array.from({ length: MIN_N - 1 }, () => ({ metrics: { op_margin: 5 } }));
  assert.deepEqual(summarizeGroup(recs), {});
});
t("buildStats: 業種×規模帯", () => {
  const recs = [];
  for (let i = 0; i < 20; i++) {
    recs.push({ code: String(1000 + i), industry33: "情報・通信業", revenue: 8000, metrics: { op_margin: i + 1 } });
  }
  for (let i = 0; i < 3; i++) {
    recs.push({ code: String(2000 + i), industry33: "小売業", revenue: 3000, metrics: { op_margin: 2 } });
  }
  const s = buildStats(recs);
  assert.equal(s.universe.n, 23);
  const it = s.industries["情報・通信業"];
  assert.equal(it.n, 20);
  assert.equal(it.metrics.op_margin.med, 10.5);
  assert.equal(it.bands.S2.n, 20); // 8000百万 → S2
  assert.equal(s.industries["小売業"].metrics.op_margin, undefined); // n=3 < MIN_N
});
t("pickPeers: 同業・規模近接順", () => {
  const recs = [
    { code: "1001", name: "自社", industry33: "小売業", revenue: 10000 },
    { code: "1002", name: "近い", industry33: "小売業", revenue: 12000 },
    { code: "1003", name: "遠い", industry33: "小売業", revenue: 100000 },
    { code: "1004", name: "他業種", industry33: "銀行業", revenue: 10000 },
  ];
  const p = pickPeers(recs, "1001", 5);
  assert.deepEqual(p.map((x) => x.code), ["1002", "1003"]);
});

console.log("bs-extract.js");
t("extractAtlasBS: 連結優先 + 棚卸フォールバック", () => {
  const row = (el, ctx, v) => ({ "要素ID": el, "コンテキストID": ctx, "値": String(v) });
  const rows = [
    row("jppfs_cor:Assets", "CurrentYearInstant", 12_000_000_000),
    row("jppfs_cor:Assets", "CurrentYearInstant_NonConsolidatedMember", 9_000_000_000),
    row("jppfs_cor:NetAssets", "CurrentYearInstant", 6_000_000_000),
    row("jppfs_cor:NotesAndAccountsReceivableTrade", "CurrentYearInstant", 1_644_000_000),
    row("jppfs_cor:MerchandiseAndFinishedGoods", "CurrentYearInstant", 500_000_000),
    row("jppfs_cor:WorkInProcess", "CurrentYearInstant", 300_000_000),
    row("jppfs_cor:NotesAndAccountsPayableTrade", "CurrentYearInstant", 822_000_000),
    row("jppfs_cor:Assets", "Prior1YearInstant", 999_999), // 過年度は無視
  ];
  const bs = extractAtlasBS(rows);
  assert.equal(bs.total_assets, 12000);
  assert.equal(bs.net_assets, 6000);
  assert.equal(bs.receivables, 1644);
  assert.equal(bs.inventories, 800); // 500+300 (集約科目なし→合算)
  assert.equal(bs.payables, 822);
});
t("extractAtlasBS: 単体のみの会社は単体値を採用", () => {
  const rows = [{ "要素ID": "jppfs_cor:Assets", "コンテキストID": "CurrentYearInstant_NonConsolidatedMember", "値": "5000000000" }];
  assert.equal(extractAtlasBS(rows).total_assets, 5000);
});

console.log(`\n${n} tests passed`);
