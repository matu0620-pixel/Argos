// api/bench-financials.js — ARGOS Bench 用 EDINET 実数取得エンドポイント
//   GET /api/bench-financials?codes=2492,7203,4751   （または POST {codes:[...]}）
// 各社の最新有報から、売上高・営業利益は最大4期分（業績推移表）、
// 売上原価・売上総利益・販管費は直近2期分（詳細P/L）を取得し、比率・3か年CAGRを算定する。
// EDINET_API_KEY が必要。ポータル(別オリジン)から呼べるよう CORS を許可。
import { getFinancialsByCode } from "../lib/edinet.js";
import { getYahooQuote } from "../lib/yahoo-finance.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const avg = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// 直近4期に整形し、比率平均・3か年CAGR・人的生産性・CF/BS を算定
function summarize(fin) {
  const all = (fin.financials_annual || []).slice(); // oldest→newest
  const years = all.slice(-4); // 直近4期
  const latest = years[years.length - 1] || {};
  // 3か年CAGR（4期そろえば最古→最新の3期、足りなければ取得期間で）
  let cagr3 = null;
  const revValid = years.filter((y) => y.revenue != null && y.revenue > 0);
  if (revValid.length >= 2) {
    const first = revValid[0].revenue, last = revValid[revValid.length - 1].revenue;
    const periods = revValid.length - 1;
    cagr3 = round1((Math.pow(last / first, 1 / periods) - 1) * 100);
  }
  // 人的生産性（最新期 × 従業員数）
  const ci = fin.company_info || {};
  const employees = (ci.employees != null && ci.employees > 0) ? ci.employees : null;
  const avgSalaryYen = ci.average_salary != null ? ci.average_salary : null;
  const revL = latest.revenue, opL = latest.operating_profit;
  const per_emp_revenue = (revL != null && employees) ? round1(revL / employees) : null; // 百万円/人
  const per_emp_op = (opL != null && employees) ? round1(opL / employees) : null;
  // 人件費率 ≈ 平均年収(百万円) × 従業員数 / 売上
  const personnel_cost_ratio = (avgSalaryYen != null && employees && revL) ? round1(((avgSalaryYen / 1e6) * employees) / revL * 100) : null;

  return {
    fy_labels: years.map((y) => y.fy),
    annual: years.map((y) => ({
      fy: y.fy,
      revenue: y.revenue ?? null,
      cost_of_sales: y.cost_of_sales ?? null,
      gross_profit: y.gross_profit ?? null,
      sga: y.sga ?? null,
      operating_profit: y.operating_profit ?? null,
      operating_cf: y.operating_cf ?? null,
      free_cash_flow: y.free_cash_flow ?? null,
      cash: y.cash ?? null,
      interest_bearing_debt: y.interest_bearing_debt ?? null,
      net_cash: y.net_cash ?? null,
      cogs_ratio: y.cogs_ratio ?? null,
      gp_margin: y.gp_margin ?? null,
      sga_ratio: y.sga_ratio ?? null,
      op_margin: y.op_margin ?? null,
    })),
    company: {
      employees,
      average_salary_yen: avgSalaryYen,
      per_emp_revenue,        // 百万円/人
      per_emp_op,             // 百万円/人
      personnel_cost_ratio,   // %
      operating_cf: latest.operating_cf ?? null,
      free_cash_flow: latest.free_cash_flow ?? null,
      cash: latest.cash ?? null,
      interest_bearing_debt: latest.interest_bearing_debt ?? null,
      net_cash: latest.net_cash ?? null,
    },
    averages: {
      cagr3_revenue: cagr3,
      cogs_ratio: round1(avg(years.map((y) => y.cogs_ratio))),
      gp_margin: round1(avg(years.map((y) => y.gp_margin))),
      sga_ratio: round1(avg(years.map((y) => y.sga_ratio))),
      op_margin: round1(avg(years.map((y) => y.op_margin))),
      per_emp_revenue,
      per_emp_op,
      personnel_cost_ratio,
      cogs_periods: years.filter((y) => y.cogs_ratio != null).length, // 原価系の有効期数（通常2）
      op_periods: years.filter((y) => y.op_margin != null).length,
    },
    data_basis: fin.data_basis || "連結",
    edinet_meta: fin.edinet_meta || null,
  };
}

// バリュエーション倍率（Yahoo株価 × EDINET株数）。Yahoo 失敗時は null で継続。
async function computeValuation(code, fin) {
  try {
    const q = await getYahooQuote(code);
    const price = q && q.price;
    const shares = fin.company_info?.shares_issued;
    if (!price || !shares) return null;
    const latest = (fin.financials_annual || []).slice(-1)[0] || {};
    const mcap = Math.round((shares * price) / 1e6); // 百万円
    const ni = latest.net_profit, op = latest.operating_profit;
    const ibd = latest.interest_bearing_debt, cash = latest.cash;
    const ev = (ibd != null && cash != null) ? mcap + ibd - cash : mcap;
    return {
      price,
      market_cap: mcap,
      per: (ni && ni > 0) ? round1(mcap / ni) : null,
      ev,
      ev_ebit: (op && op > 0) ? round1(ev / op) : null,
      net_debt: (ibd != null && cash != null) ? ibd - cash : null,
    };
  } catch (_) {
    return null;
  }
}

// 同時実行を抑えつつ順に取得（EDINET レート制限対策）
async function fetchAll(apiKey, codes, concurrency = 2) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const i = idx++;
      const code = codes[i];
      try {
        const fin = await getFinancialsByCode(apiKey, code);
        const name = fin.company_info?.name_jp || fin.edinet_meta?.filerName || "";
        const valuation = await computeValuation(code, fin);
        results[i] = { code, name, ok: true, ...summarize(fin), valuation };
      } catch (e) {
        results[i] = { code, ok: false, error: String(e.message || e) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, codes.length) }, worker);
  await Promise.all(workers);
  return results;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.end();
  }

  const apiKey = process.env.EDINET_API_KEY;
  if (!apiKey) return json(res, 500, { error: "EDINET_API_KEY が設定されていません" });

  // codes をクエリ or ボディから取得
  let codes = [];
  try {
    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      codes = body.codes || [];
    } else {
      const url = new URL(req.url, "http://localhost");
      codes = (url.searchParams.get("codes") || "").split(",");
    }
  } catch (_) {
    return json(res, 400, { error: "codes の解析に失敗しました" });
  }

  codes = codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean).slice(0, 8);
  if (!codes.length) return json(res, 400, { error: "codes が空です（例: ?codes=2492,7203）" });

  try {
    const companies = await fetchAll(apiKey, codes, 2);
    return json(res, 200, { companies });
  } catch (e) {
    return json(res, 502, { error: String(e.message || e) });
  }
}
