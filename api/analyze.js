// api/analyze.js — Non-streaming with EDINET financials + Phase 4 thesis
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

  // Karte version invalidates cache when karte changes
  let karteVersion = "0";
  if (KV_AVAILABLE) {
    try { karteVersion = await getKarteVersion(code); } catch {}
  }

  if (!force) {
    const c = getC(code, karteVersion);
    if (c) { res.setHeader("X-Cache", "HIT"); return res.status(200).json({ ...c, _cached: true }); }
  }

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const jstNow = getJstNow();

  try {
    // Kick off Yahoo Finance fetch in parallel
    const yahooPromise = getYahooQuote(code).catch(err => {
      console.warn(`[Yahoo] ${code}:`, err.message);
      return { _error: err.message };
    });

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
    let edinetCompanyInfo = null;
    let edinetDataBasis = "連結";
    let edinetErrorMessage = null;
    if (edinetKey) {
      try {
        const fin = await getFinancialsByCode(edinetKey, code);
        edinetFinancials = fin.financials_annual;
        edinetMeta = fin.edinet_meta;
        edinetCompanyInfo = fin.company_info || null;
        edinetDataBasis = fin.data_basis || "連結";
      } catch (e) {
        edinetErrorMessage = e.message;
        console.warn(`[EDINET] ${code}:`, e.message);
      }
    } else {
      edinetErrorMessage = "EDINET_API_KEY 未設定";
    }

    // Resolve Yahoo (parallel)
    const yahooQuote = await yahooPromise;
    const yahooOk = yahooQuote && !yahooQuote._error && yahooQuote.price != null;

    // Phase 2 (Risks + Competitive) — use authoritative EDINET name
    const finCtx = formatFinancialsForPrompt(edinetFinancials);
    const authoritativeName = edinetCompanyInfo?.name_jp || p1.data.company.name_jp;
    const p2 = await fetchPhase(client, buildPromptPhase2(code, authoritativeName, finCtx, indCtxStr), 8);
    p2.data._code = code;
    p2.data = postProcessPhase2(p2.data);

    const merged = mergeResults(p1.data, p2.data);

    /* OVERRIDE 1: Company name + blurb from EDINET */
    if (edinetCompanyInfo?.name_jp) {
      merged.company = merged.company || {};
      merged.company.name_jp = edinetCompanyInfo.name_jp;
      merged._name_source = "EDINET";
    }
    if (edinetCompanyInfo?.name_en) {
      merged.company = merged.company || {};
      merged.company.name_en = edinetCompanyInfo.name_en;
    }
    if (edinetCompanyInfo?.business_summary) {
      merged.company = merged.company || {};
      merged.company.blurb = edinetCompanyInfo.business_summary;
      merged._blurb_source = "EDINET";
    }
    if (edinetCompanyInfo) {
      merged.company = merged.company || {};
      merged.company._edinet_facts = {
        employees: edinetCompanyInfo.employees ?? null,
        capital_stock: edinetCompanyInfo.capital_stock ?? null,
        shares_issued: edinetCompanyInfo.shares_issued ?? null,
        head_office: edinetCompanyInfo.head_office ?? null,
      };
    }

    // Shikiho 特色 (preferred blurb source)
    try {
      const shikihoResult = await fetchShikihoTokushoku(client, {
        code,
        name_jp: edinetCompanyInfo?.name_jp || merged.company?.name_jp,
      });
      if (shikihoResult.tokushoku && shikihoResult.tokushoku.length >= 20) {
        merged.company = merged.company || {};
        merged.company.blurb = shikihoResult.tokushoku;
        merged._blurb_source = `Shikiho (${shikihoResult.source})`;
        merged.company._shikiho_tokushoku = shikihoResult.tokushoku;
      }
    } catch (shikihoErr) {
      console.warn(`[Shikiho] fetch failed for ${code}: ${shikihoErr.message}`);
    }

    /* OVERRIDE 1.6: Verify / discover company IR URL using EDINET-extracted name */
    if (edinetCompanyInfo?.name_jp) {
      const aiUrl = merged.company_ir_url || null;
      const matchesAi = aiUrl && urlMatchesCompany(aiUrl, edinetCompanyInfo.name_en, edinetCompanyInfo.name_jp);
      if (matchesAi) {
        merged._ir_url_source = "phase1-verified";
      } else {
        const verifiedUrl = await findCompanyIrUrl(client, {
          name_jp: edinetCompanyInfo.name_jp,
          name_en: edinetCompanyInfo.name_en,
          code,
        });
        if (verifiedUrl) {
          merged.company_ir_url = verifiedUrl;
          merged._ir_url_source = "edinet-verified-search";
        } else {
          merged.company_ir_url = null;
          merged._ir_url_source = "fallback-needed";
        }
      }
      // Sync "会社 IR" chips across ALL source arrays + rename legacy 会社開示一覧 → 会社 IR
      if (merged.sources && typeof merged.sources === "object") {
        for (const key of Object.keys(merged.sources)) {
          const arr = merged.sources[key];
          if (!Array.isArray(arr)) continue;
          for (let i = arr.length - 1; i >= 0; i--) {
            const c = arr[i];
            if (!c || typeof c !== "object") continue;
            const label = String(c.label || "");
            if (/会社 ?IR|会社開示一覧/.test(label)) {
              if (merged.company_ir_url) {
                c.label = "会社 IR";
                c.url = merged.company_ir_url;
              } else {
                arr.splice(i, 1);
              }
            }
          }
        }
      }

      // IR news section removed.
      delete merged.ir_news;
    }

    /* OVERRIDE 1.5: §01 Listing Profile — EDINET 6 fields ONLY + JPX criteria */
    let segment = detectMarketSegment(merged);
    try {
      const verifiedSegment = await findMarketSegment(client, {
        name_jp: edinetCompanyInfo?.name_jp || merged.company?.name_jp,
        code,
      });
      if (verifiedSegment) {
        segment = verifiedSegment;
        merged._market_segment_source = "shikiho-verified";
      } else {
        merged._market_segment_source = "phase1-heuristic";
      }
    } catch (segErr) {
      console.warn(`[Market segment] lookup failed for ${code}: ${segErr.message}`);
      merged._market_segment_source = "phase1-heuristic";
    }
    applyMarketSegmentToMerged(merged, segment);

    const edinetListingRows = edinetCompanyInfo ? buildEdinetListingRows(edinetCompanyInfo) : [];
    merged.listing = merged.listing || {};
    merged.listing.rows = edinetListingRows;
    merged.listing.market_card = getMarketCard(segment);
    merged.listing.aside = getMarketAside(segment);
    merged._listing_source = "EDINET + JPX 上場維持基準";
    merged._market_segment = segment;

    /* OVERRIDE 2: Stock price + computed market cap + PER + volume */
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
        ? "ザラ場中 (Yahoo)" : "前営業日終値 (Yahoo)";
      if (Array.isArray(yahooQuote.spark) && yahooQuote.spark.length > 0) {
        merged.price.spark = yahooQuote.spark;
      }
      if (yahooQuote.fifty_two_week_high != null) {
        merged.price._52w_high = yahooQuote.fifty_two_week_high;
        merged.price._52w_low = yahooQuote.fifty_two_week_low;
      }
      // Market cap = EDINET shares × Yahoo price
      if (edinetCompanyInfo?.shares_issued && yahooQuote.price) {
        const cap = computeMarketCap(edinetCompanyInfo.shares_issued, yahooQuote.price);
        if (cap) {
          merged.price.market_cap = cap;
          merged.price.market_cap_change = null;
        }
      }
      // PER = price / EPS where EPS = net_profit / shares
      const latestFy = edinetFinancials?.[edinetFinancials.length - 1];
      if (latestFy?.net_profit != null && edinetCompanyInfo?.shares_issued && yahooQuote.price) {
        const per = computePER(latestFy.net_profit, edinetCompanyInfo.shares_issued, yahooQuote.price);
        if (per) {
          merged.price.per = per;
          merged.price.per_note = `${latestFy.fy} 純利益ベース (実績)`;
          merged.price.per_dn = false;
        }
      }
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

    // Phase 4 (Investment Thesis) — sources: EDINET ≥3 期 OR karte ≥3 件
    let karteContextStr = null;
    let karteEntryCount = 0;
    let userAuthoredKarteCount = 0;
    let karteForSnapshot = null;

    try {
      if (KV_AVAILABLE) {
        karteForSnapshot = await getKarte(code);
        karteEntryCount = karteForSnapshot.entries?.length || 0;
        userAuthoredKarteCount = countUserAuthoredEntries(karteForSnapshot);
        karteContextStr = buildKarteContextForPrompt(karteForSnapshot, { maxEntries: 15 });
      }
    } catch (kErr) {
      console.warn(`[ARGOS karte] non-stream load failed for ${code}:`, kErr.message);
    }

    // Coverage tier classification (matches analyze-stream.js)
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

    const defaultConviction = {
      full: "high", edinet: "high", karte: "medium", limited: "medium", draft: "low",
    }[coverageTier];

    const thesisSource = ({
      full: "edinet+karte", edinet: "edinet", karte: "karte",
      limited: "limited", draft: "draft",
    })[coverageTier];

    // Always run Phase 4 — every stock gets a thesis (initial draft if no data)
    try {
      const ctxSummary = buildPhase4Context(merged);
      const p4 = await fetchPhase(client, buildPromptPhase4(code, authoritativeName, ctxSummary, indCtxStr, null, karteContextStr, {
        coverageTier,
        edinetYears: edinetFinancials?.length || 0,
        karteEntries: userAuthoredKarteCount,
        defaultConviction,
      }), 5);
      p4.data._code = code;
      p4.data = postProcessPhase4(p4.data);
      if (p4.data?.investment_thesis) {
        merged.investment_thesis = p4.data.investment_thesis;
        merged.investment_thesis._source = thesisSource;
        merged.investment_thesis._coverage_tier = coverageTier;
        merged.investment_thesis._edinet_years = edinetFinancials?.length || 0;
        merged.investment_thesis._karte_count = userAuthoredKarteCount;
        merged.investment_thesis.available = true;

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
      if (p4.repaired) merged._truncated = true;

      // Record thesis regeneration timestamp
      if (KV_AVAILABLE) {
        try { await recordThesisRegen(code); } catch (e) { /* non-fatal */ }
      }

      // Auto-save Thesis to Karte
      if (KV_AVAILABLE && merged.investment_thesis?.scenarios && karteForSnapshot) {
        try {
          const snapshotEntry = buildThesisSnapshotEntry(merged.investment_thesis, {
            code, price: merged.price,
            generatedAt: new Date().toISOString(),
            coverageTier,
          });
          if (snapshotEntry) await addEntry(code, snapshotEntry);
        } catch (snapErr) {
          console.warn(`[ARGOS karte] thesis snapshot save failed:`, snapErr.message);
        }
      }
    } catch (p4Err) {
      console.warn(`[Phase4] Failed for ${code}:`, p4Err.message);
      merged.investment_thesis = {
        available: true,
        _source: thesisSource,
        _coverage_tier: "draft",
        _generation_error: p4Err.message,
        summary: { conviction: "low", thesis_one_liner: `Phase 4 エラー: ${p4Err.message}` },
        scenarios: {
          bull: { probability: 25, summary: "上昇シナリオ", drivers: ["業界成長"], implied_return: "—" },
          base: { probability: 50, summary: "中立シナリオ", drivers: ["業界平均"], implied_return: "—" },
          bear: { probability: 25, summary: "下落シナリオ", drivers: ["景気低迷"], implied_return: "—" },
        },
      };
    }

    // Phase 5: Report Authoring
    try {
      const ctxForP5 = buildPhase4Context(merged);
      const p5Prompt = buildPromptPhase5(code, authoritativeName, ctxForP5, karteContextStr || null);
      const p5Response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: p5Prompt }],
      });
      const p5Text = (p5Response.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const jsonMatch = p5Text.match(/\{[\s\S]*\}/);
      let p5Data = null;
      if (jsonMatch) {
        try { p5Data = JSON.parse(jsonMatch[0]); } catch {}
      }
      merged.report_authoring = postProcessPhase5(p5Data || {});
    } catch (p5Err) {
      console.warn(`[Phase5] failed for ${code}:`, p5Err.message);
      merged.report_authoring = postProcessPhase5({});
    }

    merged._elapsed_ms = Date.now() - t0;
    merged._edinet_used = !!edinetFinancials;
    if (p1.repaired || p2.repaired) merged._truncated = true;

    setC(code, karteVersion, merged);
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
