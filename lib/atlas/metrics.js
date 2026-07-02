// lib/atlas/metrics.js
// =======================================================================
// ARGOS Atlas — 企業1社分の派生指標計算(純関数・副作用なし)
// 入力: getFinancialsByCode() 互換の financials + 追加BS項目(bs-extract.js)
// 出力: Bench/Model/Synthesis が共通で参照する metrics オブジェクト
// 単位規約: 金額は百万円、比率は% (小数1桁)、日数は日、年収のみ salary_m (百万円)
// =======================================================================

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const pct = (num, den) => (num != null && den != null && den !== 0 ? r1((num / den) * 100) : null);

/** 実効税率30%の簡易NOPATによるROIC(%)。投下資本 = 純資産 + 有利子負債 */
export function roic(op, netAssets, debt) {
  if (op == null || netAssets == null) return null;
  const ic = netAssets + (debt || 0);
  if (ic <= 0) return null;
  return r1((op * 0.7) / ic * 100);
}

/** CCC = DSO + DIO - DPO (日) */
export function ccc({ revenue, cost_of_sales, receivables, inventories, payables }) {
  const dso = revenue > 0 && receivables != null ? (receivables / revenue) * 365 : null;
  const base = cost_of_sales > 0 ? cost_of_sales : null;
  const dio = base && inventories != null ? (inventories / base) * 365 : null;
  const dpo = base && payables != null ? (payables / base) * 365 : null;
  const cccVal = dso != null && dio != null && dpo != null ? dso + dio - dpo : null;
  return { dso: r1(dso), dio: r1(dio), dpo: r1(dpo), ccc: r1(cccVal) };
}

/** 直近N期の売上CAGR(%)。データが2期未満なら null */
export function revCagr(annual, maxPeriods = 4) {
  const v = (annual || []).filter((y) => y.revenue != null && y.revenue > 0).slice(-maxPeriods);
  if (v.length < 2) return null;
  const first = v[0].revenue, last = v[v.length - 1].revenue;
  return r1((Math.pow(last / first, 1 / (v.length - 1)) - 1) * 100);
}

/**
 * 企業レコードの派生指標を計算する。
 * @param {object} c - { annual: [...], employees, average_salary(円),
 *                       total_assets, net_assets, receivables, inventories, payables }
 *                     annual は oldest→newest。各要素は edinet.js の financials_annual 互換。
 */
export function computeMetrics(c) {
  const annual = c.annual || [];
  const L = annual[annual.length - 1] || {}; // 最新期
  const emp = c.employees > 0 ? c.employees : null;
  const salaryM = c.average_salary != null ? c.average_salary / 1e6 : null;

  const gp = L.gross_profit ?? (L.revenue != null && L.cost_of_sales != null ? L.revenue - L.cost_of_sales : null);
  const cccVals = ccc({
    revenue: L.revenue, cost_of_sales: L.cost_of_sales,
    receivables: c.receivables, inventories: c.inventories, payables: c.payables,
  });

  const laborCost = salaryM != null && emp ? salaryM * emp : null; // 百万円

  return {
    // 収益性
    gp_margin: pct(gp, L.revenue),
    op_margin: pct(L.operating_profit, L.revenue),
    net_margin: pct(L.net_profit, L.revenue),
    fcf_margin: pct(L.free_cash_flow, L.revenue),
    // 成長性
    rev_cagr3: revCagr(annual),
    // 人的生産性 (百万円/人)
    per_emp_revenue: emp && L.revenue != null ? r1(L.revenue / emp) : null,
    per_emp_gp: emp && gp != null ? r1(gp / emp) : null,
    per_emp_op: emp && L.operating_profit != null ? r1(L.operating_profit / emp) : null,
    // 人件費
    salary_m: r1(salaryM),
    labor_share: pct(laborCost, gp), // 労働分配率 ≈ 人件費/粗利
    personnel_cost_ratio: pct(laborCost, L.revenue),
    // 財務健全性・資本効率
    equity_ratio: pct(c.net_assets, c.total_assets),
    net_de: c.net_assets > 0 && c.interest_bearing_debt != null && c.cash != null
      ? r1((c.interest_bearing_debt - c.cash) / c.net_assets) : null, // 倍
    roic: roic(L.operating_profit, c.net_assets, c.interest_bearing_debt),
    // 回転
    ...cccVals,
  };
}

/** 売上規模帯 (百万円)。Bench の「同規模比較」の粒度 */
export const SIZE_BANDS = [
  { id: "S1", label: "〜50億", max: 5000 },
  { id: "S2", label: "50〜100億", max: 10000 },
  { id: "S3", label: "100〜500億", max: 50000 },
  { id: "S4", label: "500〜1000億", max: 100000 },
  { id: "S5", label: "1000億〜", max: Infinity },
];

export function sizeBand(revenue) {
  if (revenue == null || !(revenue > 0)) return null;
  return SIZE_BANDS.find((b) => revenue < b.max)?.id ?? "S5";
}

/** 統計対象とする指標キー(stats.js と ATLAS_SPEC.md の契約) */
export const STAT_METRICS = [
  "gp_margin", "op_margin", "net_margin", "fcf_margin",
  "rev_cagr3",
  "per_emp_revenue", "per_emp_gp", "per_emp_op",
  "salary_m", "labor_share", "personnel_cost_ratio",
  "equity_ratio", "net_de", "roic",
  "dso", "dio", "dpo", "ccc",
];
