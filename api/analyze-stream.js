// api/analyze-stream.js — Streaming with EDINET financials + Claude for non-financial data
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
import { getYahooQuote, formatChangePercent, formatChangeAmount } from "../lib/yahoo-finance.js";
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

/**
 * Cache key combines code + memo version. When the user adds/edits/deletes
 * a memo, the version changes and we miss the cache, ensuring the new memo
 * is reflected in Phase 4 of the next analysis.
 */
function cacheKey(code, memoVersion) {
  return `${code}::${memoVersion || "0"}`;
}

function getCached(code, memoVersion) {
  const key = cacheKey(code, memoVersion);
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function setCached(code, memoVersion, data) {
  const key = cacheKey(code, memoVersion);
  cache.set(key, { data, t: Date.now() });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
}

async function streamPhase(client, send, label, prompt, maxUses) {
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }]
  });

  let searchCount = 0, textLength = 0, lastReported = 0;

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "server_tool_use" && block.name === "web_search") {
        searchCount++;
        send("search", { phase: label, stage: searchCount, query: block.input?.query || "..." });
      } else if (block?.type === "web_search_tool_result") {
        send("search_result", { phase: label, stage: searchCount });
      } else if (block?.type === "text") {
        send("text_start", { phase: label });
      }
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && delta.text) {
        textLength += delta.text.length;
        if (textLength - lastReported >= 300) {
          lastReported = textLength;
          send("text_progress", { phase: label, length: textLength });
        }
      }
    }
  }

  const finalMessage = await stream.finalMessage();
  const textBlocks = (finalMessage.content || []).filter(b => b.type === "text");
  const text = textBlocks.map(b => b.text).join("\n").trim();
  if (!text) throw new Error(`Phase ${label}: AI 応答が空でした`);

  const { data, repaired } = parseResponseJson(text);
  if (data?.error) throw new Error(data.message || data.error);
  return { data, repaired, searchCount, textLength };
}

/* Format EDINET financials as a context string for Phase 2 prompt */
function formatFinancialsForPrompt(financialsAnnual) {
  if (!Array.isArray(financialsAnnual) || !financialsAnnual.length) return "";
  const lines = financialsAnnual.map(y => {
    const fmt = n => n != null ? n.toLocaleString("en-US") + " 百万円" : "—";
    return `${y.fy}: 売上高 ${fmt(y.revenue)}, 営業利益 ${fmt(y.operating_profit)} (${y.op_margin ?? "—"}%), 経常利益 ${fmt(y.ordinary_profit)}, 純利益 ${fmt(y.net_profit)}`;
  });
  return lines.join("\n");
}

export default async function handler(req, res) {
  const code = String(req.query?.code || "").trim();
  const force = String(req.query?.force || "") === "1";

  if (!/^\d{4,5}$/.test(code)) {
    res.status(400).json({ error: "invalid_code", message: "証券コードは 4-5 桁の数字" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "config_error", message: "ANTHROPIC_API_KEY 未設定" });
    return;
  }
  const edinetKey = process.env.EDINET_API_KEY;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("start", { code, t: Date.now() });

  // Compute memo version BEFORE cache check — invalidates cache when memos change
  let memoVersion = "0";
  if (KV_AVAILABLE) {
    try { memoVersion = await getMemoVersion(code); } catch {}
  }

  if (!force) {
    const cached = getCached(code, memoVersion);
    if (cached) {
      send("complete", { ...cached, _cached: true });
      return res.end();
    }
  }

  const client = new Anthropic({ apiKey });
  const startTime = Date.now();
  const jstNow = getJstNow();

  try {
    /* Kick off Yahoo Finance fetch IN PARALLEL with Phase 1 — independent + fast */
    const yahooPromise = getYahooQuote(code).catch(err => {
      console.warn(`[Yahoo] ${code}:`, err.message);
      return { _error: err.message };
    });

    /* ─── PHASE 1: Profile + Price + Listing + IR News (Claude + Web) ─── */
    send("phase", {
      num: 1, total: 4,
      label: "Phase 1: 企業概要・株価・上場情報・IR ニュース",
      sources: "kabutan / Yahoo!ファイナンス / 会社四季報 / TDnet"
    });

    const industryEnumText = formatIndustryEnumForPrompt();
    const p1 = await streamPhase(client, send, "phase1", buildPromptPhase1(code, jstNow, industryEnumText), 10);
    if (!p1.data?.company?.name_jp) {
      send("error", { error: "no_data", message: `${code} の企業情報が見つかりませんでした` });
      return res.end();
    }
    p1.data = postProcessPhase1(p1.data);

    /* Industry detection: prefer AI-returned key, fall back to keyword matching */
    let industryKey = p1.data.industry_key;
    let industryProfile = getIndustryProfile(industryKey);
    if (!industryKey || industryProfile.label === "その他") {
      const fallbackKey = detectIndustryByKeywords(p1.data);
      if (fallbackKey && fallbackKey !== "other") {
        industryKey = fallbackKey;
        industryProfile = getIndustryProfile(fallbackKey);
        p1.data.industry_key = fallbackKey;
        p1.data.industry_detection_method = "keyword_fallback";
      } else {
        p1.data.industry_detection_method = "ai_or_default";
      }
    } else {
      p1.data.industry_detection_method = "ai";
    }
    p1.data.industry_label = industryProfile.label;
    console.log(`[Industry] code=${code} → ${industryKey} (${industryProfile.label}) via ${p1.data.industry_detection_method}`);

    send("phase1_complete", p1.data);

    /* ─── PHASE 2: EDINET Financials ─── */
    let edinetFinancials = null;
    let edinetMeta = null;
    let edinetCompanyInfo = null;
    let edinetDataBasis = "連結"; // default; will be overridden from EDINET response
    let edinetErrorMessage = null;
    if (edinetKey) {
      send("phase", {
        num: 2, total: 4,
        label: "Phase 2: EDINET から財務データを取得",
        sources: "金融庁 EDINET API / 有価証券報告書 (XBRL/CSV)"
      });
      send("edinet_start", { code });

      try {
        const fin = await getFinancialsByCode(edinetKey, code);
        edinetFinancials = fin.financials_annual;
        edinetMeta = fin.edinet_meta;
        edinetCompanyInfo = fin.company_info || null;
        edinetDataBasis = fin.data_basis || "連結";
        send("edinet_success", {
          docID: fin.edinet_meta.docID,
          docDescription: fin.edinet_meta.docDescription,
          submitDateTime: fin.edinet_meta.submitDateTime,
          dataBasis: fin.data_basis,
          yearsCount: edinetFinancials.length,
          companyName: edinetCompanyInfo?.name_jp || fin.edinet_meta.filerName || null
        });
      } catch (edinetErr) {
        edinetErrorMessage = edinetErr.message;
        console.warn(`[EDINET] Failed for ${code}:`, edinetErr.message);
        send("edinet_failed", { message: edinetErr.message });
      }
    } else {
      edinetErrorMessage = "EDINET_API_KEY が Vercel の環境変数に設定されていません";
      send("edinet_skipped", { message: edinetErrorMessage });
    }

    /* ─── PHASE 2.5: Resolve Yahoo Finance promise ─── */
    const yahooQuote = await yahooPromise;
    const yahooOk = yahooQuote && !yahooQuote._error && yahooQuote.price != null;
    if (yahooOk) {
      send("yahoo_success", {
        price: yahooQuote.price,
        previous_close: yahooQuote.previous_close,
        change_percent: yahooQuote.change_percent,
        as_of: yahooQuote.as_of_date,
        market_state: yahooQuote.market_state,
      });
    } else {
      send("yahoo_failed", { message: yahooQuote?._error || "Yahoo Finance unavailable" });
    }

    /* ─── PHASE 3: Risks + Competitive Landscape (Claude + Web) ─── */
    send("phase", {
      num: 3, total: 4,
      label: "Phase 3: 事業リスク・競争環境分析",
      sources: "EDINET 有報 / 業界レポート / IR 資料"
    });

    const finCtx = formatFinancialsForPrompt(edinetFinancials);
    const indCtxStr = formatIndustryContext(industryProfile);
    // Use EDINET's authoritative company name when available — overrides AI's guess
    const authoritativeName = edinetCompanyInfo?.name_jp || p1.data.company.name_jp;
    const p2 = await streamPhase(
      client, send, "phase2",
      buildPromptPhase2(code, authoritativeName, finCtx, indCtxStr),
      8
    );
    p2.data = postProcessPhase2(p2.data);

    /* ─── MERGE Phase 1-3 (financial override happens here) ─── */
    const merged = mergeResults(p1.data, p2.data);

    /* ─── OVERRIDE 1: Company name from EDINET (authoritative) ─── */
    if (edinetCompanyInfo?.name_jp) {
      merged.company = merged.company || {};
      merged.company.name_jp = edinetCompanyInfo.name_jp;
      merged._name_source = "EDINET";
    }
    if (edinetCompanyInfo?.name_en) {
      merged.company = merged.company || {};
      merged.company.name_en = edinetCompanyInfo.name_en;
    }
    // Inject EDINET facts into company tags (employees / capital) when present
    if (edinetCompanyInfo) {
      merged.company = merged.company || {};
      merged.company._edinet_facts = {
        employees: edinetCompanyInfo.employees ?? null,
        capital_stock: edinetCompanyInfo.capital_stock ?? null,
        shares_issued: edinetCompanyInfo.shares_issued ?? null,
        head_office: edinetCompanyInfo.head_office ?? null,
      };
    }

    /* ─── OVERRIDE 2: Stock price from Yahoo Finance (前日終値ベース) ─── */
    if (yahooOk) {
      merged.price = merged.price || {};
      merged.price.last = yahooQuote.price;
      merged.price.previous_close = yahooQuote.previous_close;
      merged.price.change_amount = yahooQuote.change != null ? Math.round(yahooQuote.change) : null;
      merged.price.change_pct = yahooQuote.change_percent != null
        ? Math.round(yahooQuote.change_percent * 100) / 100 : null;
      merged.price.as_of = yahooQuote.as_of_date;
      merged.price.currency = yahooQuote.currency === "JPY" ? "円" : yahooQuote.currency;
      merged.price.data_freshness = yahooQuote.market_state === "REGULAR"
        ? "ザラ場中 (Yahoo)"
        : "前営業日終値 (Yahoo)";
      // Replace AI's spark with Yahoo's actual closing series
      if (Array.isArray(yahooQuote.spark) && yahooQuote.spark.length > 0) {
        merged.price.spark = yahooQuote.spark;
      }
      // 52w high/low if not already set or AI value seems wrong
      if (yahooQuote.fifty_two_week_high != null) {
        merged.price._52w_high = yahooQuote.fifty_two_week_high;
        merged.price._52w_low = yahooQuote.fifty_two_week_low;
      }
      merged._price_source = "Yahoo Finance";
    } else {
      merged._price_source = merged.price?.last != null ? "AI/Web (Yahoo unavailable)" : null;
      merged._yahoo_error = yahooQuote?._error || null;
    }

    if (edinetFinancials) {
      // EDINET-derived data is authoritative — override anything from AI/web search
      merged.financials_annual = edinetFinancials;
      // Clear any AI-generated quarterly data — only EDINET-sourced financials allowed
      merged.financials_quarterly = [];
      merged.data_basis = `${edinetDataBasis} (EDINET)`;
      merged.fy_unit = "百万円";
      merged.edinet_meta = edinetMeta;
    } else {
      // EDINET failed — clear ALL financial-related AI output to avoid misleading users
      merged.financials_annual = [];
      merged.financials_quarterly = [];
      merged.kpis = []; // KPIs are derived from financial data
      merged.read_note = ""; // Financial trend commentary
      merged.fin_footnote = `<span style="color:var(--warn);">⚠ EDINET 取得不可: ${escapeForHtml(edinetErrorMessage || "理由不明")}</span>`;
      merged._edinet_unavailable = true;
      merged._edinet_error = edinetErrorMessage;
    }

    /* ─── PHASE 4: Institutional Investment Thesis (synthesis) ─── */
    let p4SearchCount = 0;
    if (edinetFinancials && edinetFinancials.length >= 3) {
      // Only run Phase 4 if we have solid financial data to anchor the thesis
      send("phase", {
        num: 4, total: 4,
        label: "Phase 4: 機関投資家向け投資テーゼ作成",
        sources: "Phase 1-3 集約 / 業種中央値 / 過去バリュエーションレンジ"
      });

      // Load user memos and build sanitized context for prompt injection
      let memoContextStr = null;
      let memoCount = 0;
      try {
        if (KV_AVAILABLE) {
          const memos = await listMemos(code);
          memoCount = memos.length;
          memoContextStr = buildMemoContextForPrompt(memos, { maxMemos: 12, maxDays: 90 });
          if (memoContextStr) {
            send("memo_context_loaded", { count: memoCount, used: Math.min(memoCount, 12) });
          }
        }
      } catch (memoErr) {
        console.warn(`[ARGOS memos] load failed for ${code}:`, memoErr.message);
        // Non-fatal — continue without memos
      }

      try {
        const ctxSummary = buildPhase4Context(merged);
        const p4 = await streamPhase(
          client, send, "phase4",
          buildPromptPhase4(code, authoritativeName, ctxSummary, indCtxStr, memoContextStr),
          5
        );
        p4.data = postProcessPhase4(p4.data);

        if (p4.data?.investment_thesis) {
          merged.investment_thesis = p4.data.investment_thesis;
          if (p4.data.investment_thesis.sources && Array.isArray(p4.data.investment_thesis.sources)) {
            merged.sources = merged.sources || {};
            merged.sources.thesis = p4.data.investment_thesis.sources;
          }
          // Tag the thesis with memo influence flag for UI badge
          if (memoContextStr) {
            merged.investment_thesis._memo_influenced = true;
            merged.investment_thesis._memo_count = memoCount;
          }
        }
        p4SearchCount = p4.searchCount || 0;
        if (p4.repaired) merged._truncated = true;
      } catch (p4Err) {
        console.warn(`[Phase4] Failed for ${code}:`, p4Err.message);
        // If Phase 4 fails, mark thesis as unavailable but don't fail the whole request
        merged.investment_thesis = {
          available: false,
          reason: `投資テーゼ作成中にエラーが発生しました: ${p4Err.message}`
        };
        send("phase4_failed", { message: p4Err.message });
      }
    } else {
      // No EDINET data → no thesis (would be based on hallucinated numbers)
      merged.investment_thesis = {
        available: false,
        reason: edinetFinancials
          ? "EDINET 財務データが 3 期未満のため、投資テーゼ作成に必要な比較データが不足しています"
          : "EDINET 財務データを取得できなかったため、投資テーゼを作成できません"
      };
      send("phase4_skipped", {
        message: "投資テーゼは EDINET 財務データが必要です — スキップしました"
      });
    }

    merged._elapsed_ms = Date.now() - startTime;
    merged._search_count = p1.searchCount + p2.searchCount + p4SearchCount;
    merged._edinet_used = !!edinetFinancials;

    setCached(code, memoVersion, merged);
    send("complete", merged);
    res.end();
  } catch (err) {
    console.error(`[analyze-stream] code=${code} error:`, err);
    send("error", { error: "api_error", message: err?.message || "Unknown" });
    res.end();
  }
}

/* Build context summary for Phase 4 from Phase 1-3 outputs */
function buildPhase4Context(merged) {
  const lines = [];

  // Company basics
  if (merged.company?.name_jp) {
    lines.push(`■ 企業: ${merged.company.name_jp} (${merged.code})`);
    lines.push(`  事業: ${merged.company.blurb || ""}`);
  }

  // Market info
  if (merged.price) {
    lines.push(`■ 株価情報:`);
    lines.push(`  終値: ${merged.price.last}円 (${merged.price.as_of || ""}, ${merged.price.data_freshness || ""})`);
    lines.push(`  時価総額: ${merged.price.market_cap || "—"}`);
    lines.push(`  PER: ${merged.price.per || "—"} (${merged.price.per_note || ""})`);
    lines.push(`  配当利回り: ${merged.price.div_yield || "—"}`);
  }

  // EDINET financials (5 years)
  if (Array.isArray(merged.financials_annual) && merged.financials_annual.length > 0) {
    lines.push(`■ EDINET 5 期財務 (連結, 百万円):`);
    merged.financials_annual.forEach(y => {
      const fmt = n => n != null ? n.toLocaleString("en-US") : "—";
      lines.push(`  ${y.fy}: 売上 ${fmt(y.revenue)} / 営業益 ${fmt(y.operating_profit)} (${y.op_margin ?? "—"}%) / 経常 ${fmt(y.ordinary_profit)} / 純利益 ${fmt(y.net_profit)}`);
      if (y.rev_yoy != null) {
        lines.push(`         YoY: 売上 ${y.rev_yoy>=0?"+":""}${y.rev_yoy}% / OP ${y.op_yoy>=0?"+":""}${y.op_yoy}% / 純利 ${y.np_yoy>=0?"+":""}${y.np_yoy}%`);
      }
    });
  }

  // Competitive analysis (if available)
  const ca = merged.competitive_analysis;
  if (ca?.available === true) {
    lines.push(`■ 競争環境:`);
    lines.push(`  業界構造: ${stripHtmlTags(ca.industry_structure || "")}`);
    lines.push(`  ポジション: ${stripHtmlTags(ca.company_position || "")}`);
    if (Array.isArray(ca.moats)) {
      lines.push(`  Moat: ${ca.moats.map(m => m.label).join(", ")}`);
    }
    if (Array.isArray(ca.threats)) {
      lines.push(`  脅威: ${ca.threats.map(t => `${t.label}(${t.sev})`).join(", ")}`);
    }
  }

  // Top risks
  if (Array.isArray(merged.risks) && merged.risks.length > 0) {
    lines.push(`■ 重要リスク (上位):`);
    merged.risks.slice(0, 5).forEach(r => {
      lines.push(`  [${r.sev?.toUpperCase()}] ${r.title} — ${r.desc?.slice(0, 80)}`);
    });
  }

  // Recent IR catalysts
  if (Array.isArray(merged.ir_news) && merged.ir_news.length > 0) {
    lines.push(`■ 直近 IR (時系列順):`);
    merged.ir_news.slice(0, 5).forEach(n => {
      lines.push(`  ${n.date}: [${n.label}] ${n.title} — ${n.meta?.slice(0, 60)}`);
    });
  }

  return lines.join("\n");
}

function stripHtmlTags(s) {
  return String(s ?? "").replace(/<[^>]+>/g, "").trim();
}

function escapeForHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[c]);
}
