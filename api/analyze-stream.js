// api/analyze-stream.js — Streaming with EDINET financials + Claude for non-financial data
import Anthropic from "@anthropic-ai/sdk";
import {
  buildPromptPhase1,
  buildPromptPhase2,
  buildPromptPhase4,
  buildPromptPhase5,
  parseResponseJson,
  mergeResults,
  postProcessPhase1,
  postProcessPhase2,
  postProcessPhase4,
  postProcessPhase5,
  getJstNow
} from "../lib/prompt.js";
import { getFinancialsByCode, buildEdinetListingRows } from "../lib/edinet.js";
import {
  getYahooQuote,
  formatChangePercent,
  formatChangeAmount,
  computeMarketCap,
  computePER,
  formatVolume,
} from "../lib/yahoo-finance.js";
import { getMarketCard, getMarketAside, detectMarketSegment } from "../lib/jpx-listing-criteria.js";
import { findCompanyIrUrl, urlMatchesCompany } from "../lib/ir-url-finder.js";
import { fetchShikihoTokushoku } from "../lib/shikiho-tokushoku.js";
import { findMarketSegment, applyMarketSegmentToMerged } from "../lib/market-segment.js";
import {
  getIndustryProfile,
  detectIndustryByKeywords,
  formatIndustryContext,
  formatIndustryEnumForPrompt
} from "../lib/industry.js";
import {
  KV_AVAILABLE,
} from "../lib/memos.js";
import {
  getKarte,
  buildKarteContextForPrompt,
  getKarteVersion,
  countUserAuthoredEntries,
  buildThesisSnapshotEntry,
  addEntry,
  recordThesisRegen,
} from "../lib/karte.js";

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

  // Compute karte version BEFORE cache check — invalidates cache when karte changes
  let karteVersion = "0";
  if (KV_AVAILABLE) {
    try { karteVersion = await getKarteVersion(code); } catch {}
  }
  const cacheVersion = karteVersion;

  if (!force) {
    const cached = getCached(code, cacheVersion);
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
    p2.data._code = code;
    p2.data = postProcessPhase2(p2.data);

    /* ─── MERGE Phase 1-3 (financial override happens here) ─── */
    const merged = mergeResults(p1.data, p2.data);

    /* ─── OVERRIDE 1: Company name + blurb from EDINET (authoritative) ─── */
    if (edinetCompanyInfo?.name_jp) {
      merged.company = merged.company || {};
      merged.company.name_jp = edinetCompanyInfo.name_jp;
      merged._name_source = "EDINET";
    }
    if (edinetCompanyInfo?.name_en) {
      merged.company = merged.company || {};
      merged.company.name_en = edinetCompanyInfo.name_en;
    }
    // Override blurb with EDINET 有報の事業概要 (when extracted)
    if (edinetCompanyInfo?.business_summary) {
      merged.company = merged.company || {};
      merged.company.blurb = edinetCompanyInfo.business_summary;
      merged._blurb_source = "EDINET";
    }
    // Save the FULL EDINET 事業の内容 text (untruncated) for the UI expandable section
    if (edinetCompanyInfo?.business_description) {
      merged.company = merged.company || {};
      merged.company._edinet_business_full = edinetCompanyInfo.business_description;
    }
    // EDINET facts hint for tags
    if (edinetCompanyInfo) {
      merged.company = merged.company || {};
      merged.company._edinet_facts = {
        employees: edinetCompanyInfo.employees ?? null,
        capital_stock: edinetCompanyInfo.capital_stock ?? null,
        shares_issued: edinetCompanyInfo.shares_issued ?? null,
        head_office: edinetCompanyInfo.head_office ?? null,
      };
    }

    /* ─── OVERRIDE 1.5b: Fetch Shikiho 特色 — preferred blurb source ───
       会社四季報の「特色」欄は、機関投資家が標準で参照する銘柄概要。
       AI 生成の長い説明より、短く factual な四季報スタイルを優先する。
       ────────────────────────────────────────────────────────────── */
    send("shikiho_searching", { code });
    try {
      const shikihoResult = await fetchShikihoTokushoku(client, {
        code,
        name_jp: edinetCompanyInfo?.name_jp || merged.company?.name_jp,
      });
      if (shikihoResult.tokushoku && shikihoResult.tokushoku.length >= 20) {
        // Override with Shikiho 特色 (preferred over EDINET 有報の事業概要)
        merged.company = merged.company || {};
        merged.company.blurb = shikihoResult.tokushoku;
        merged._blurb_source = `Shikiho (${shikihoResult.source})`;
        merged.company._shikiho_tokushoku = shikihoResult.tokushoku;
        send("shikiho_found", {
          length: shikihoResult.tokushoku.length,
          source: shikihoResult.source,
          confidence: shikihoResult.confidence,
        });
      } else {
        send("shikiho_not_found", { reason: "no-tokushoku-extracted" });
      }
    } catch (shikihoErr) {
      console.warn(`[Shikiho] fetch failed for ${code}: ${shikihoErr.message}`);
      send("shikiho_not_found", { reason: shikihoErr.message });
    }

    /* ─── OVERRIDE 1.6: Verify / discover company IR URL using EDINET-extracted name ─── */
    // Prevents Phase 1 AI from defaulting to a hardcoded URL (e.g. Infomart) for the wrong company.
    // Strategy:
    //   1. If Phase 1's URL hostname matches the EDINET name → keep it (cheap path)
    //   2. Otherwise → focused web search using EDINET's authoritative name to find the real URL
    if (edinetCompanyInfo?.name_jp) {
      const aiUrl = merged.company_ir_url || null;
      const matchesAi = aiUrl && urlMatchesCompany(aiUrl, edinetCompanyInfo.name_en, edinetCompanyInfo.name_jp);

      if (matchesAi) {
        // Phase 1's URL passes the heuristic — keep it
        merged._ir_url_source = "phase1-verified";
        send("ir_url_verified", { url: aiUrl, source: "phase1-heuristic" });
      } else {
        // Phase 1's URL doesn't match the EDINET company → run focused search
        send("ir_url_searching", { name: edinetCompanyInfo.name_jp });
        const verifiedUrl = await findCompanyIrUrl(client, {
          name_jp: edinetCompanyInfo.name_jp,
          name_en: edinetCompanyInfo.name_en,
          code,
        });
        if (verifiedUrl) {
          merged.company_ir_url = verifiedUrl;
          merged._ir_url_source = "edinet-verified-search";
          send("ir_url_verified", { url: verifiedUrl, source: "edinet-verified-search" });
        } else {
          // Search couldn't verify — drop the URL so frontend uses the minkabu fallback
          merged.company_ir_url = null;
          merged._ir_url_source = "fallback-needed";
          send("ir_url_unverified", { reason: "no-verified-url-found" });
        }
      }

      // Sync the "会社 IR" chip across ALL source arrays (hero, news, etc.)
      // — also rename any legacy "会社開示一覧" labels to "会社 IR" for consistency
      if (merged.sources && typeof merged.sources === "object") {
        for (const key of Object.keys(merged.sources)) {
          const arr = merged.sources[key];
          if (!Array.isArray(arr)) continue;
          // Find any chip whose label is "会社 IR" or the legacy "会社開示一覧"
          for (let i = arr.length - 1; i >= 0; i--) {
            const c = arr[i];
            if (!c || typeof c !== "object") continue;
            const label = String(c.label || "");
            if (/会社 ?IR|会社開示一覧/.test(label)) {
              if (merged.company_ir_url) {
                // Update label to canonical "会社 IR" and use verified URL
                c.label = "会社 IR";
                c.url = merged.company_ir_url;
              } else {
                // No verified URL → drop the chip entirely (frontend handles fallback)
                arr.splice(i, 1);
              }
            }
          }
        }
      }

      // IR news section removed — was unreliable. Replaced by richer Phase 5 report content.
      delete merged.ir_news;
    }

    /* ─── OVERRIDE 1.5: §01 Listing Profile — EDINET 6 fields ONLY + JPX criteria ─── */
    // User spec: rows = ONLY 決算期, 資本金, 発行済株式数, 従業員数, 代表者, 本店所在地 (all EDINET)
    // market_card = static JPX 上場維持基準 template (not AI-generated)

    // Step 1: cheap heuristic from Phase 1 AI output (fallback if shikiho lookup fails)
    let segment = detectMarketSegment(merged);

    // Step 2: verified lookup via 会社四季報 + others (authoritative for new market segments)
    send("market_segment_searching", { name: edinetCompanyInfo?.name_jp || merged.company?.name_jp || null });
    try {
      const verifiedSegment = await findMarketSegment(client, {
        name_jp: edinetCompanyInfo?.name_jp || merged.company?.name_jp,
        code,
      });
      if (verifiedSegment) {
        segment = verifiedSegment;
        merged._market_segment_source = "shikiho-verified";
        send("market_segment_verified", { segment });
      } else {
        merged._market_segment_source = "phase1-heuristic";
      }
    } catch (segErr) {
      console.warn(`[Market segment] lookup failed for ${code}: ${segErr.message}`);
      merged._market_segment_source = "phase1-heuristic";
    }

    // Step 3: apply verified segment everywhere (market_tags, listing.market_card, listing.aside)
    applyMarketSegmentToMerged(merged, segment);

    const edinetListingRows = edinetCompanyInfo ? buildEdinetListingRows(edinetCompanyInfo) : [];

    merged.listing = merged.listing || {};
    merged.listing.rows = edinetListingRows;  // EDINET-only, 6 fields max
    merged.listing.market_card = getMarketCard(segment);
    merged.listing.aside = getMarketAside(segment);
    merged._listing_source = "EDINET + JPX 上場維持基準";
    merged._market_segment = segment;

    /* ─── OVERRIDE 2: Stock price + market cap + PER + volume from Yahoo + EDINET ─── */
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
      if (Array.isArray(yahooQuote.spark) && yahooQuote.spark.length > 0) {
        merged.price.spark = yahooQuote.spark;
      }
      if (yahooQuote.fifty_two_week_high != null) {
        merged.price._52w_high = yahooQuote.fifty_two_week_high;
        merged.price._52w_low = yahooQuote.fifty_two_week_low;
      }

      // Compute market cap from EDINET shares × Yahoo price
      if (edinetCompanyInfo?.shares_issued && yahooQuote.price) {
        const cap = computeMarketCap(edinetCompanyInfo.shares_issued, yahooQuote.price);
        if (cap) {
          merged.price.market_cap = cap;
          merged.price.market_cap_change = null; // will be hidden when null
        }
      }

      // Compute PER from EDINET net profit ÷ EDINET shares × Yahoo price
      const latestFy = edinetFinancials?.[edinetFinancials.length - 1];
      if (latestFy?.net_profit != null && edinetCompanyInfo?.shares_issued && yahooQuote.price) {
        const per = computePER(latestFy.net_profit, edinetCompanyInfo.shares_issued, yahooQuote.price);
        if (per) {
          merged.price.per = per;
          merged.price.per_note = `${latestFy.fy} 純利益ベース (実績)`;
          merged.price.per_dn = false;
        }
      }

      // Volume from Yahoo
      if (yahooQuote.volume != null) {
        merged.price.volume = formatVolume(yahooQuote.volume);
      }
      if (yahooQuote.avg_volume_5d != null) {
        merged.price.volume_note = `5日平均 ${formatVolume(yahooQuote.avg_volume_5d)}`;
      }

      merged._price_source = "Yahoo Finance + EDINET";
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

    /* ─── PHASE 4: Institutional Investment Thesis (synthesis) ───
       Sources: EDINET financials (≥3 years) AND/OR Karte user entries (≥3)
       At least ONE of these must be available.
       ──────────────────────────────────────────────────────────── */
    let p4SearchCount = 0;
    let karteContextStr = null;
    let karteEntryCount = 0;
    let userAuthoredKarteCount = 0;
    let karteForSnapshot = null;  // Hold karte object to add thesis snapshot after generation

    // Always try to load karte (even when EDINET succeeds, karte enriches the thesis)
    try {
      if (KV_AVAILABLE) {
        karteForSnapshot = await getKarte(code);
        karteEntryCount = karteForSnapshot.entries?.length || 0;
        userAuthoredKarteCount = countUserAuthoredEntries(karteForSnapshot);
        karteContextStr = buildKarteContextForPrompt(karteForSnapshot, { maxEntries: 15 });
        if (karteContextStr) {
          send("karte_context_loaded", {
            count: karteEntryCount,
            user_authored: userAuthoredKarteCount,
            used: Math.min(karteEntryCount, 15)
          });
        }
      }
    } catch (kErr) {
      console.warn(`[ARGOS karte] load failed for ${code}:`, kErr.message);
    }

    // ─── Coverage tier classification ───
    // Determines confidence label and badge displayed in UI/PDF.
    // Tiers:
    //   "full"        — EDINET ≥ 3 期 + カルテ ≥ 3 件   → 🏆 FULL COVERAGE
    //   "edinet"      — EDINET ≥ 3 期 のみ              → 🟢 EDINET-VERIFIED
    //   "karte"       — カルテ ≥ 3 件 のみ              → 🔵 KARTE-INFORMED
    //   "limited"     — EDINET 1-2 期 OR カルテ 1-2 件   → 🟡 LIMITED DATA
    //   "draft"       — どちらも無し                     → 🟡 INITIAL DRAFT
    const hasFullEdinet = edinetFinancials && edinetFinancials.length >= 3;
    const hasPartialEdinet = edinetFinancials && edinetFinancials.length >= 1 && edinetFinancials.length < 3;
    const hasFullKarte = userAuthoredKarteCount >= 3;
    const hasPartialKarte = userAuthoredKarteCount >= 1 && userAuthoredKarteCount < 3;

    let coverageTier;
    if (hasFullEdinet && hasFullKarte) coverageTier = "full";
    else if (hasFullEdinet) coverageTier = "edinet";
    else if (hasFullKarte) coverageTier = "karte";
    else if (hasPartialEdinet || hasPartialKarte) coverageTier = "limited";
    else coverageTier = "draft";

    // Conviction defaults by tier (the AI can override with its own assessment)
    const defaultConviction = {
      full: "high",
      edinet: "high",
      karte: "medium",
      limited: "medium",
      draft: "low",
    }[coverageTier];

    // For backward compat
    const thesisSource = ({
      full: "edinet+karte", edinet: "edinet", karte: "karte",
      limited: "limited", draft: "draft",
    })[coverageTier];

    // Always run Phase 4 — even with no data we generate an "initial draft" thesis
    {
      const tierLabels = {
        full:    "Phase 4: 投資テーゼ作成 (FULL COVERAGE)",
        edinet:  "Phase 4: 投資テーゼ作成 (EDINET-VERIFIED)",
        karte:   "Phase 4: 投資テーゼ作成 (KARTE-INFORMED)",
        limited: "Phase 4: 投資テーゼ作成 (LIMITED DATA)",
        draft:   "Phase 4: 投資テーゼ初期仮説作成 (INITIAL DRAFT)",
      };
      const tierSources = {
        full:    `EDINET ${edinetFinancials.length} 期 + カルテ ${userAuthoredKarteCount} 件 + 業種中央値`,
        edinet:  `EDINET ${edinetFinancials.length} 期 + 業種中央値 + 過去バリュエーション`,
        karte:   `カルテ ${userAuthoredKarteCount} 件 + 業種中央値`,
        limited: `EDINET ${edinetFinancials?.length || 0} 期 / カルテ ${userAuthoredKarteCount} 件 + 業界知識`,
        draft:   "Phase 1-3 + 業界知識 + Web 検索 (★ 初期仮説)",
      };
      send("phase", {
        num: 4, total: 5,
        label: tierLabels[coverageTier],
        sources: tierSources[coverageTier],
        coverage_tier: coverageTier,
      });

      try {
        const ctxSummary = buildPhase4Context(merged);
        const p4 = await streamPhase(
          client, send, "phase4",
          buildPromptPhase4(code, authoritativeName, ctxSummary, indCtxStr, null, karteContextStr, {
            coverageTier,
            edinetYears: edinetFinancials?.length || 0,
            karteEntries: userAuthoredKarteCount,
            defaultConviction,
          }),
          5
        );
        p4.data._code = code;
        p4.data = postProcessPhase4(p4.data);

        if (p4.data?.investment_thesis) {
          merged.investment_thesis = p4.data.investment_thesis;
          merged.investment_thesis._source = thesisSource;
          merged.investment_thesis._coverage_tier = coverageTier;
          merged.investment_thesis._edinet_years = edinetFinancials?.length || 0;
          merged.investment_thesis._karte_count = userAuthoredKarteCount;
          merged.investment_thesis.available = true;

          // For draft tier, force probability to 25/50/25 if AI deviated
          if (coverageTier === "draft" && merged.investment_thesis.scenarios) {
            const sc = merged.investment_thesis.scenarios;
            if (sc.bull) sc.bull.probability = sc.bull.probability ?? 25;
            if (sc.base) sc.base.probability = sc.base.probability ?? 50;
            if (sc.bear) sc.bear.probability = sc.bear.probability ?? 25;
          }

          if (p4.data.investment_thesis.sources && Array.isArray(p4.data.investment_thesis.sources)) {
            merged.sources = merged.sources || {};
            merged.sources.thesis = p4.data.investment_thesis.sources;
          }
          if (karteContextStr) {
            merged.investment_thesis._karte_influenced = true;
          }
        }
        p4SearchCount = p4.searchCount || 0;
        if (p4.repaired) merged._truncated = true;

        // Record this thesis regeneration for rate limiting (24h, max 3)
        if (KV_AVAILABLE) {
          try { await recordThesisRegen(code); } catch (e) { /* non-fatal */ }
        }

        // ─── Auto-save Thesis to Karte (history) ───
        if (KV_AVAILABLE && merged.investment_thesis?.scenarios && karteForSnapshot) {
          try {
            const snapshotEntry = buildThesisSnapshotEntry(merged.investment_thesis, {
              code,
              price: merged.price,
              generatedAt: new Date().toISOString(),
              coverageTier,
            });
            if (snapshotEntry) {
              await addEntry(code, snapshotEntry);
              send("thesis_saved_to_karte", { kind: "ai_thesis_snapshot", coverage_tier: coverageTier });
            }
          } catch (snapErr) {
            console.warn(`[ARGOS karte] thesis snapshot save failed for ${code}:`, snapErr.message);
          }
        }
      } catch (p4Err) {
        console.warn(`[Phase4] Failed for ${code}:`, p4Err.message);
        // Even on AI error, provide a minimal fallback thesis structure
        merged.investment_thesis = {
          available: true,
          _source: thesisSource,
          _coverage_tier: "draft",
          _generation_error: p4Err.message,
          summary: {
            conviction: "low",
            thesis_one_liner: `${authoritativeName || code} の投資テーゼ生成中にエラーが発生しました。Phase 1-3 のデータを参照してください。`,
          },
          scenarios: {
            bull: { probability: 25, summary: "上昇シナリオ", drivers: ["業界成長", "Web 検索ベース"], implied_return: "—" },
            base: { probability: 50, summary: "中立シナリオ", drivers: ["業界平均"], implied_return: "—" },
            bear: { probability: 25, summary: "下落シナリオ", drivers: ["景気低迷"], implied_return: "—" },
          },
        };
        send("phase4_failed", { message: p4Err.message });
      }
    }

    // ─── Phase 5: Report Authoring (PDF レポート用追加コメント生成) ───
    // 機関投資家レポート PDF に掲載する Executive Summary / Recommendation /
    // Key Drivers / Valuation Take / Analyst Take を生成する。Web 検索なし、
    // Phase 1-4 の結果を踏まえた純粋なアナリスト所感。
    send("phase", {
      num: 5, total: 5, label: "Phase 5: Report Authoring (機関投資家レポート用追加コメント生成)",
      sources: "Phase 1-4 の結果 + カルテ"
    });
    try {
      const ctxForP5 = buildPhase4Context(merged);
      const p5Prompt = buildPromptPhase5(
        code,
        authoritativeName,
        ctxForP5,
        karteContextStr || null
      );
      const p5Response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: p5Prompt }],
      });
      const p5Text = (p5Response.content || [])
        .filter(c => c.type === "text")
        .map(c => c.text).join("");
      // Extract JSON
      let p5Data = null;
      const jsonMatch = p5Text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { p5Data = JSON.parse(jsonMatch[0]); } catch {}
      }
      if (p5Data) {
        merged.report_authoring = postProcessPhase5(p5Data);
        send("phase5_complete", {
          rating: merged.report_authoring.recommendation?.rating || null,
          target: merged.report_authoring.recommendation?.target_price_jpy || null,
        });
      } else {
        console.warn(`[Phase5] no parseable JSON for ${code}`);
        merged.report_authoring = postProcessPhase5({});  // empty defaults
      }
    } catch (p5Err) {
      console.warn(`[Phase5] failed for ${code}:`, p5Err.message);
      merged.report_authoring = postProcessPhase5({});
    }

    merged._elapsed_ms = Date.now() - startTime;
    merged._search_count = p1.searchCount + p2.searchCount + p4SearchCount;
    merged._edinet_used = !!edinetFinancials;

    setCached(code, cacheVersion, merged);
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
