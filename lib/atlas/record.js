// lib/atlas/record.js
// =======================================================================
// ARGOS Atlas — XBRL CSV行 + 書類メタ + JPXマスタ → 企業1社のAtlasレコード
// getFinancialsByCode() と同じ抽出部品を使うが、書類検索を伴わない
// (バッチは日次一覧から docID を既に持っているため)。
// =======================================================================

import { extractFinancials, extractCompanyInfo, extractBenchExtras } from "../edinet.js";
import { extractAtlasBS } from "./bs-extract.js";
import { computeMetrics, sizeBand } from "./metrics.js";

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/**
 * @param {Array<object>} rows - EDINET CSV 行
 * @param {object} doc - 日次一覧の書類メタ {docID, secCode, filerName, periodEnd, submitDateTime, edinetCode}
 * @param {object|null} jpx - JPXマスタ {name, industry33, industry33_code, market} (無ければ null)
 * @returns {object|null} Atlasレコード。財務が抽出できない場合 null
 */
export function buildCompanyRecord(rows, doc, jpx) {
  const { byYear, isConsolidated } = extractFinancials(rows, { preferConsolidated: true });
  if (!Object.keys(byYear).length) return null;

  const info = extractCompanyInfo(rows) || {};
  const extras = (() => { try { return extractBenchExtras(rows); } catch { return { byYear: {}, average_salary: null }; } })();
  const bs = (() => { try { return extractAtlasBS(rows); } catch { return {}; } })();

  // 年度配列 (oldest→newest)。Atlasに必要な最小フィールドのみ
  const offsets = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const periodEnd = doc.periodEnd || doc.docPeriodEnd || null;
  const fyEndYear = periodEnd ? Number(periodEnd.slice(0, 4)) : new Date().getFullYear();
  const annual = offsets.map((off) => {
    const y = byYear[off];
    const ex = extras.byYear?.[off] || {};
    const gp = y.gross_profit ?? (y.revenue != null && y.cost_of_sales != null ? y.revenue - y.cost_of_sales : null);
    const ocf = ex.operating_cf ?? null, icf = ex.investing_cf ?? null;
    return {
      fy: `FY${String((fyEndYear - off) % 100).padStart(2, "0")}`,
      revenue: r1(y.revenue), cost_of_sales: r1(y.cost_of_sales), gross_profit: r1(gp),
      sga: r1(y.sga), operating_profit: r1(y.operating_profit),
      ordinary_profit: r1(y.ordinary_profit), net_profit: r1(y.net_profit),
      operating_cf: r1(ocf), investing_cf: r1(icf),
      free_cash_flow: ocf != null && icf != null ? r1(ocf + icf) : null,
    };
  });

  const latest = annual[annual.length - 1] || {};
  const latestExtras = extras.byYear?.[0] || {};
  const code4 = String(doc.secCode || "").slice(0, 4);

  const rec = {
    code: code4,
    name: jpx?.name || info.name_jp || doc.filerName || null,
    edinet_code: doc.edinetCode || null,
    industry33: jpx?.industry33 || null,
    industry33_code: jpx?.industry33_code || null,
    market: jpx?.market || null,
    fy: latest.fy || null,
    period_end: periodEnd,
    basis: isConsolidated ? "連結" : "単体",
    unit: "百万円",
    doc_id: doc.docID,
    submitted: doc.submitDateTime || null,
    employees: info.employees ?? null,
    average_salary: extras.average_salary ?? null, // 円
    business_summary: info.business_summary || null,
    // 最新期スナップショット + BS
    revenue: latest.revenue ?? null,
    operating_profit: latest.operating_profit ?? null,
    cash: r1(latestExtras.cash),
    interest_bearing_debt: r1(latestExtras.interest_bearing_debt),
    total_assets: bs.total_assets ?? null,
    net_assets: bs.net_assets ?? null,
    receivables: bs.receivables ?? null,
    inventories: bs.inventories ?? null,
    payables: bs.payables ?? null,
    annual,
  };
  rec.size_band = sizeBand(rec.revenue);
  rec.metrics = computeMetrics({
    annual,
    employees: rec.employees,
    average_salary: rec.average_salary,
    total_assets: rec.total_assets,
    net_assets: rec.net_assets,
    receivables: rec.receivables,
    inventories: rec.inventories,
    payables: rec.payables,
    cash: rec.cash,
    interest_bearing_debt: rec.interest_bearing_debt,
  });
  return rec;
}
