// api/analyze.js — Non-streaming with EDINET financials + Phase 4 thesis
import Anthropic from "@anthropic-ai/sdk";
import {
  buildPromptPhase1,
  buildPromptPhase2,
  buildPromptPhase4,
  parseResponseJson,
  mergeResults,
  postProcessPhase1,
  postProcessPhase2,
  postProcessPhase4,
  getJstNow
} from "../lib/prompt.js";
import { getFinancialsByCode } from "../lib/edinet.js";
import {
  getIndustryProfile,
  detectIndustryByKeywords,
  formatIndustryContext,
  formatIndustryEnumForPrompt
} from "../lib/industry.js";
import {
  listMemos,
  buildMemoContextForPrompt,
  getMemoVersion,
  KV_AVAILABLE,
} from "../lib/memos.js";

const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const cacheKey = (c, mv) => `${c}::${mv || "0"}`;
const getC = (c, mv) => { const k = cacheKey(c, mv); const e = cache.get(k); if (!e) return null; if (Date.now()-e.t > CACHE_TTL_MS){cache.delete(k);return null;} return e.data; };
const setC = (c, mv, d) => { cache.set(cacheKey(c, mv), {data:d, t:Date.now()}); if (cache.size>100) cache.delete(cache.keys().next().value); };

async function fetchPhase(client, prompt, maxUses) {
  const r = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }]
  });
  const tb = (r.content||[]).filter(b => b.type === "text" && typeof b.text === "string");
  const t = tb.map(b => b.text).join("\n").trim();
  if (!t) throw new Error("AI 応答が空でした");
  const { data, repaired } = parseResponseJson(t);
  if (data?.error) throw new Error(data.message || data.error);
  return { data, repaired };
}

function formatFinancialsForPrompt(financialsAnnual) {
  if (!Array.isArray(financialsAnnual) || !financialsAnnual.length) return "";
  return financialsAnnual.map(y => {
    const fmt = n => n != null ? n.toLocaleString("en-US") + " 百万円" : "—";
    return `${y.fy}: 売上高 ${fmt(y.revenue)}, 営業利益 ${fmt(y.operating_profit)} (${y.op_margin ?? "—"}%), 経常利益 ${fmt(y.ordinary_profit)}, 純利益 ${fmt(y.net_profit)}`;
  }).join("\n");
}

function buildPhase4Context(merged) {
  const lines = [];
  if (merged.company?.name_jp) {
    lines.push(`■ 企業: ${merged.company.name_jp} (${merged.code})`);
    lines.push(`  事業: ${merged.company.blurb || ""}`);
  }
  if (merged.price) {
    lines.push(`■ 株価: ${merged.price.last}円 (${merged.price.as_of}) / 時価総額 ${merged.price.market_cap || "—"} / PER ${merged.price.per || "—"}`);
  }
  if (Array.isArray(merged.financials_annual) && merged.financials_annual.length > 0) {
    lines.push(`■ EDINET 5 期財務 (連結, 百万円):`);
    merged.financials_annual.forEach(y => {
      const fmt = n => n != null ? n.toLocaleString("en-US") : "—";
      lines.push(`  ${y.fy}: 売上 ${fmt(y.revenue)} / 営業益 ${fmt(y.operating_profit)} (${y.op_margin ?? "—"}%) / 純利 ${fmt(y.net_profit)}`);
    });
  }
  const ca = merged.competitive_analysis;
  if (ca?.available === true) {
    lines.push(`■ 競争環境ポジション: ${stripHtmlTags(ca.company_position || "")}`);
    if (Array.isArray(ca.moats)) lines.push(`  Moat: ${ca.moats.map(m => m.label).join(", ")}`);
    if (Array.isArray(ca.threats)) lines.push(`  脅威: ${ca.threats.map(t => `${t.label}(${t.sev})`).join(", ")}`);
  }
  if (Array.isArray(merged.risks) && merged.risks.length > 0) {
    lines.push(`■ 重要リスク: ${merged.risks.slice(0, 5).map(r => `[${r.sev?.toUpperCase()}] ${r.title}`).join(" / ")}`);
  }
  return lines.join("\n");
}

function stripHtmlTags(s) { return String(s ?? "").replace(/<[^>]+>/g, "").trim(); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "config_error", message: "ANTHROPIC_API_KEY 未設定" });
  const edinetKey = process.env.EDINET_API_KEY;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const code = String(body?.code || "").trim();
  const force = Boolean(body?.force);
  if (!/^\d{4,5}$/.test(code)) return res.status(400).json({ error: "invalid_code" });

  // Memo version invalidates cache when memos change
  let memoVersion = "0";
  if (KV_AVAILABLE) {
    try { memoVersion = await getMemoVersion(code); } catch {}
  }

  if (!force) {
    const c = getC(code, memoVersion);
    if (c) { res.setHeader("X-Cache", "HIT"); return res.status(200).json({ ...c, _cached: true }); }
  }

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const jstNow = getJstNow();

  try {
    // Phase 1
    const industryEnumText = formatIndustryEnumForPrompt();
    const p1 = await fetchPhase(client, buildPromptPhase1(code, jstNow, industryEnumText), 10);
    if (!p1.data?.company?.name_jp) {
      return res.status(404).json({ error: "no_data", message: `${code} の企業情報が見つかりません` });
    }
    p1.data = postProcessPhase1(p1.data);

    // Industry detection
    let industryKey = p1.data.industry_key;
    let industryProfile = getIndustryProfile(industryKey);
    if (!industryKey || industryProfile.label === "その他") {
      const fallbackKey = detectIndustryByKeywords(p1.data);
      if (fallbackKey && fallbackKey !== "other") {
        industryKey = fallbackKey;
        industryProfile = getIndustryProfile(fallbackKey);
        p1.data.industry_key = fallbackKey;
      }
    }
    p1.data.industry_label = industryProfile.label;
    const indCtxStr = formatIndustryContext(industryProfile);

    // EDINET fetch
    let edinetFinancials = null;
    let edinetMeta = null;
    let edinetDataBasis = "連結";
    let edinetErrorMessage = null;
    if (edinetKey) {
      try {
        const fin = await getFinancialsByCode(edinetKey, code);
        edinetFinancials = fin.financials_annual;
        edinetMeta = fin.edinet_meta;
        edinetDataBasis = fin.data_basis || "連結";
      } catch (e) {
        edinetErrorMessage = e.message;
        console.warn(`[EDINET] ${code}:`, e.message);
      }
    } else {
      edinetErrorMessage = "EDINET_API_KEY 未設定";
    }

    // Phase 2 (Risks + Competitive)
    const finCtx = formatFinancialsForPrompt(edinetFinancials);
    const p2 = await fetchPhase(client, buildPromptPhase2(code, p1.data.company.name_jp, finCtx, indCtxStr), 8);
    p2.data = postProcessPhase2(p2.data);

    const merged = mergeResults(p1.data, p2.data);
    if (edinetFinancials) {
      merged.financials_annual = edinetFinancials;
      merged.financials_quarterly = [];
      merged.data_basis = `${edinetDataBasis} (EDINET)`;
      merged.fy_unit = "百万円";
      merged.edinet_meta = edinetMeta;
    } else {
      merged.financials_annual = [];
      merged.financials_quarterly = [];
      merged.kpis = [];
      merged.read_note = "";
      merged.fin_footnote = `<span style="color:var(--warn);">⚠ EDINET 取得不可: ${escapeForHtml(edinetErrorMessage || "理由不明")}</span>`;
      merged._edinet_unavailable = true;
      merged._edinet_error = edinetErrorMessage;
    }

    // Phase 4 (Investment Thesis) — only if EDINET data is solid
    if (edinetFinancials && edinetFinancials.length >= 3) {
      // Load user memos (best-effort)
      let memoContextStr = null;
      let memoCount = 0;
      try {
        if (KV_AVAILABLE) {
          const memos = await listMemos(code);
          memoCount = memos.length;
          memoContextStr = buildMemoContextForPrompt(memos, { maxMemos: 12, maxDays: 90 });
        }
      } catch (memoErr) {
        console.warn(`[ARGOS memos] non-stream load failed for ${code}:`, memoErr.message);
      }

      try {
        const ctxSummary = buildPhase4Context(merged);
        const p4 = await fetchPhase(client, buildPromptPhase4(code, p1.data.company.name_jp, ctxSummary, indCtxStr, memoContextStr), 5);
        p4.data = postProcessPhase4(p4.data);
        if (p4.data?.investment_thesis) {
          merged.investment_thesis = p4.data.investment_thesis;
          if (p4.data.investment_thesis.sources && Array.isArray(p4.data.investment_thesis.sources)) {
            merged.sources = merged.sources || {};
            merged.sources.thesis = p4.data.investment_thesis.sources;
          }
          if (memoContextStr) {
            merged.investment_thesis._memo_influenced = true;
            merged.investment_thesis._memo_count = memoCount;
          }
        }
        if (p4.repaired) merged._truncated = true;
      } catch (p4Err) {
        console.warn(`[Phase4] Failed for ${code}:`, p4Err.message);
        merged.investment_thesis = { available: false, reason: `Phase 4 エラー: ${p4Err.message}` };
      }
    } else {
      merged.investment_thesis = {
        available: false,
        reason: edinetFinancials
          ? "EDINET 財務 3 期未満で投資テーゼ作成不可"
          : "EDINET 財務取得不可で投資テーゼ作成不可"
      };
    }

    merged._elapsed_ms = Date.now() - t0;
    merged._edinet_used = !!edinetFinancials;
    if (p1.repaired || p2.repaired) merged._truncated = true;

    setC(code, memoVersion, merged);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(merged);
  } catch (err) {
    console.error(`[analyze] code=${code} error:`, err.message);
    return res.status(502).json({ error: "api_error", message: err.message || "Unknown" });
  }
}

function escapeForHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[c]);
}
