// lib/atlas/stats.js
// =======================================================================
// ARGOS Atlas — 業種(東証33)×規模帯の分位統計を生成(純関数)
// 入力: 企業レコード配列(metrics.js の computeMetrics 済み)
// 出力: stats.json の中身。n>=MIN_N の場合のみ統計を公開する。
// =======================================================================

import { STAT_METRICS, sizeBand } from "./metrics.js";

export const MIN_N = 5; // これ未満のグループは統計を出さない(識別リスク+頑健性)

/** 線形補間パーセンタイル。values はソート済み前提 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/** 1グループ(企業レコード配列)→ 指標ごとの {n, p10, q1, med, q3, p90} */
export function summarizeGroup(records) {
  const out = {};
  for (const m of STAT_METRICS) {
    const vals = records
      .map((r) => r.metrics?.[m])
      .filter((v) => v != null && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vals.length < MIN_N) continue;
    out[m] = {
      n: vals.length,
      p10: r1(percentile(vals, 0.10)),
      q1: r1(percentile(vals, 0.25)),
      med: r1(percentile(vals, 0.50)),
      q3: r1(percentile(vals, 0.75)),
      p90: r1(percentile(vals, 0.90)),
    };
  }
  return out;
}

/**
 * 全企業レコード → stats.json 構造
 * {
 *   generated_at, universe: { n, industries: k },
 *   industries: {
 *     "<業種名>": {
 *       n, metrics: {...},                    // 業種全体
 *       bands: { "S3": { n, metrics: {...} } } // 規模帯別 (n>=MIN_N のみ)
 *     }
 *   }
 * }
 */
export function buildStats(records) {
  const byInd = new Map();
  for (const r of records) {
    const ind = r.industry33 || "その他";
    if (!byInd.has(ind)) byInd.set(ind, []);
    byInd.get(ind).push(r);
  }

  const industries = {};
  for (const [ind, recs] of byInd) {
    const bands = {};
    const byBand = new Map();
    for (const r of recs) {
      const b = sizeBand(r.revenue);
      if (!b) continue;
      if (!byBand.has(b)) byBand.set(b, []);
      byBand.get(b).push(r);
    }
    for (const [b, brecs] of byBand) {
      if (brecs.length < MIN_N) continue;
      const m = summarizeGroup(brecs);
      if (Object.keys(m).length) bands[b] = { n: brecs.length, metrics: m };
    }
    industries[ind] = {
      n: recs.length,
      metrics: summarizeGroup(recs),
      ...(Object.keys(bands).length ? { bands } : {}),
    };
  }

  return {
    generated_at: new Date().toISOString(),
    universe: { n: records.length, industries: byInd.size },
    min_n: MIN_N,
    industries,
  };
}

/**
 * ピア候補選定: 同業種で売上規模が近い順に最大 limit 社。
 * (S2 で embedding 類似度に置換予定。契約は「codeの配列を返す」で不変)
 */
export function pickPeers(records, code, limit = 10) {
  const self = records.find((r) => r.code === code);
  if (!self || self.revenue == null) return [];
  return records
    .filter((r) => r.code !== code && r.industry33 === self.industry33 && r.revenue > 0)
    .sort((a, b) => Math.abs(Math.log(a.revenue / self.revenue)) - Math.abs(Math.log(b.revenue / self.revenue)))
    .slice(0, limit)
    .map((r) => ({ code: r.code, name: r.name, revenue: r.revenue }));
}
