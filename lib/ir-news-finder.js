// lib/ir-news-finder.js — Search company IR site for 8 specific disclosure categories
// Uses Claude Haiku 4.5 + web_search, anchored on the company name from EDINET
// and the verified company_ir_url, to fetch actually-existing IR documents.
//
// Target categories (機関投資家が重視するイベント駆動材料):
//   1. 業務提携        — Business alliance / partnership
//   2. 資本業務提携    — Capital & business alliance
//   3. 株式取得        — Share acquisition
//   4. 子会社化        — Subsidiarization / acquisition
//   5. 業績予想        — Earnings forecast / revision
//   6. 成長可能性資料  — Growth potential materials (especially required for Growth-listed)
//   7. 事業計画        — Business plan
//   8. 中期経営計画    — Mid-term management plan

export const IR_NEWS_CATEGORIES = [
  { id: "business_alliance",    jp: "業務提携",        cat: "ma",   label: "業務提携" },
  { id: "capital_alliance",     jp: "資本業務提携",    cat: "cap",  label: "資本業務提携" },
  { id: "share_acquisition",    jp: "株式取得",        cat: "ma",   label: "株式取得" },
  { id: "subsidiarization",     jp: "子会社化",        cat: "ma",   label: "子会社化" },
  { id: "earnings_forecast",    jp: "業績予想",        cat: "fcst", label: "業績予想" },
  { id: "growth_potential",     jp: "成長可能性資料",  cat: "other",label: "成長可能性" },
  { id: "business_plan",        jp: "事業計画",        cat: "other",label: "事業計画" },
  { id: "midterm_plan",         jp: "中期経営計画",    cat: "other",label: "中期経営計画" },
];

const CATEGORY_BY_JP = Object.fromEntries(IR_NEWS_CATEGORIES.map(c => [c.jp, c]));

/**
 * Find IR news from the company's IR site for the 8 target categories.
 * Returns an array shaped like the existing merged.ir_news entries.
 *
 * Strategy:
 *   - Build a single prompt that instructs Claude to use web_search to look up
 *     the company IR site (and shortcut paths like /ir/news, /ir/library/) for
 *     each target category.
 *   - Constrain output to JSON list of {date, category, title, summary, source_url, impact_pct}.
 *   - Prefer items from the past ~24 months; up to 12 items total.
 */
export async function findIrNews(client, { code, name_jp, name_en, company_ir_url }) {
  if (!client || !code || !name_jp) return [];

  const irHint = company_ir_url
    ? `会社 IR ページ: ${company_ir_url}`
    : `会社 IR ページ: 不明`;
  const enHint = name_en ? `\n英文社名: ${name_en}` : "";

  const today = new Date().toISOString().slice(0, 10);
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 24);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const prompt = `あなたは日本株のリサーチアナリストです。下記の上場企業について、**過去 24 ヶ月以内 (${cutoffStr} 以降)** に開示された IR 資料を網羅的に調査してください。

【対象企業】
証券コード: ${code}
社名: ${name_jp}${enHint}
${irHint}

【必須の検索手順】
1. **TDnet 適時開示** で「${name_jp}」を検索する:
   - https://www.release.tdnet.info/inbs/I_main_00.html
   - 直近のすべての適時開示資料を確認
2. **会社の IR ニュースページ** ${company_ir_url ? `(${company_ir_url}) ` : "(検索で特定)"}を直接確認
3. **kabutan の開示一覧** で確認: https://kabutan.jp/disclosures/?code=${code}
4. 過去 24 ヶ月以内 (${cutoffStr} 〜 ${today}) のものに **必ず** 限定する

【抽出対象 (8 カテゴリ)】
以下のキーワードを **タイトルや本文に含む資料のみ** を抽出してください:

| カテゴリ | 含まれるキーワード例 |
|---|---|
| 業務提携 | 「業務提携」「業務協力」「アライアンス契約」 (※資本関与なし) |
| 資本業務提携 | 「資本業務提携」「第三者割当」「業務提携及び資本提携」 |
| 株式取得 | 「株式取得」「株式譲受」「持分取得」 (子会社化未満) |
| 子会社化 | 「子会社化」「連結子会社化」「TOB」「公開買付」「完全子会社」 |
| 業績予想 | 「業績予想」「業績修正」「通期予想」「決算短信」「四半期決算」「配当予想」 |
| 成長可能性資料 | 「成長可能性に関する説明資料」「事業計画及び成長可能性」 (グロース市場限定) |
| 事業計画 | 「事業計画」「経営方針」「年度計画」 |
| 中期経営計画 | 「中期経営計画」「中計」「中期戦略」「3カ年計画」 |

【出力形式】 JSON 1 行のみ、コードブロック禁止:

{"items":[
  {
    "date": "YYYY-MM-DD",
    "category": "業務提携|資本業務提携|株式取得|子会社化|業績予想|成長可能性資料|事業計画|中期経営計画",
    "title": "資料の正式タイトル (タイトルに会社名やコードが入っていても残す)",
    "summary": "120字以内の要約。具体情報を必ず含める: 相手企業名、取得株数、取得金額、議決権比率、出資比率、対象事業、業績予想数値 (前年比%付き) 等",
    "source_url": "確認できた PDF/ページの URL (https://...)。確認できないなら空文字 \"\""
  }
]}

【厳守事項】
★ **存在しない資料を捏造することは絶対禁止**。Web 検索で確認できなかったものは出力しない
★ ${cutoffStr} より古い資料は除外
★ 上場時に提出した「成長可能性資料」(初回開示) は除外。継続開示・更新版のみ対象
★ 同じ資料が複数カテゴリに該当する場合は、最も中核的な 1 カテゴリのみで出力 (重複排除)
★ TDnet の URL (release.tdnet.info の inb1.com 形式) は時間経過で消える可能性が高いので、なるべく会社 IR サイトの恒久 URL を優先
★ カテゴリ名は上記 8 つの正確な日本語表記を使う。それ以外の名称は出力しない
★ 抽出件数は 6〜12 件。少なすぎる場合は通常の決算短信 (業績予想カテゴリ) を最低 4 件含める
★ 日付昇順ではなく **新しい順** にソート

【期待する出力例】 (架空のサンプル):
{"items":[
  {"date":"2026-02-13","category":"業績予想","title":"2025年12月期 決算短信〔日本基準〕(連結)","summary":"通期売上高191.3億円(前年比+11.3%)、営業利益32.8億円(+18.5%)、当期純利益22.0億円(+22.4%)。年間配当17円(前年比+1円)","source_url":"https://www.example.com/ir/library/2026/202602_q4_kessan.pdf"},
  {"date":"2025-08-15","category":"中期経営計画","title":"中期経営計画 2026-2028 の策定について","summary":"3カ年で売上倍増 (200億→400億)、営業利益率 20% 達成を目標。重点施策は M&A 加速、海外展開、AI 活用","source_url":"https://www.example.com/ir/management/midterm2026.pdf"}
]}`;

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.warn(`[IR news finder] API call failed for ${code}: ${e.message}`);
    return [];
  }

  // Check if any web searches were actually performed
  const toolUses = (response.content || []).filter(c => c.type === "server_tool_use" || c.type === "tool_use");
  console.log(`[IR news finder] ${code}: ${toolUses.length} web searches performed`);

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  console.log(`[IR news finder] ${code}: response text length = ${text.length}`);

  // Extract JSON object from response — try multiple strategies
  let parsed = null;

  // Strategy 1: Look for ```json ... ``` code block
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try { parsed = JSON.parse(codeBlockMatch[1]); } catch {}
  }

  // Strategy 2: Look for explicit {"items":[...]} pattern
  if (!parsed) {
    const itemsMatch = text.match(/\{\s*"items"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (itemsMatch) {
      try { parsed = JSON.parse(itemsMatch[0]); } catch {}
    }
  }

  // Strategy 3: Find the largest balanced JSON object
  if (!parsed) {
    const start = text.indexOf("{");
    if (start >= 0) {
      let depth = 0, end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
      }
    }
  }

  // Strategy 4: Just try to parse the whole text
  if (!parsed) {
    try { parsed = JSON.parse(text); } catch {}
  }

  if (!parsed || !Array.isArray(parsed.items)) {
    console.warn(`[IR news finder] no parseable JSON for ${code}; got ${text.length} chars, first 300: ${text.slice(0, 300)}`);
    return [];
  }

  console.log(`[IR news finder] ${code}: parsed ${parsed.items.length} raw items`);

  // Validate, normalize, dedupe, sort
  const seen = new Set();
  const items = [];
  const rejectStats = { invalidDate: 0, unknownCategory: 0, noTitle: 0, dupe: 0, tooOld: 0 };

  for (const raw of parsed.items.slice(0, 25)) {
    if (!raw || typeof raw !== "object") continue;

    const date = normalizeDate(raw.date);
    if (!date) { rejectStats.invalidDate++; continue; }

    // Reject items older than 24 months
    const dateMs = Date.parse(date);
    const cutoffMs = Date.now() - 24 * 30 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(dateMs) && dateMs < cutoffMs) {
      rejectStats.tooOld++;
      continue;
    }

    const categoryJp = String(raw.category || "").trim();
    const catMeta = CATEGORY_BY_JP[categoryJp];
    if (!catMeta) { rejectStats.unknownCategory++; continue; }

    const title = String(raw.title || "").trim().slice(0, 200);
    if (!title) { rejectStats.noTitle++; continue; }

    // Dedupe key: title + date
    const dedupeKey = `${title}::${date}`;
    if (seen.has(dedupeKey)) { rejectStats.dupe++; continue; }
    seen.add(dedupeKey);

    const summary = String(raw.summary || "").trim().slice(0, 240);
    const sourceUrl = String(raw.source_url || "").trim();
    const validUrl = /^https?:\/\//.test(sourceUrl) ? sourceUrl : "";

    // Try multiple sources for impact_pct: explicit field, or extract from summary
    let impactPct = null;
    if (raw.impact_pct != null) {
      const n = Number(raw.impact_pct);
      if (Number.isFinite(n) && Math.abs(n) < 200) impactPct = n;
    }
    // Fallback: extract first "+X.X%" or "-X.X%" from summary if it looks like growth/forecast
    if (impactPct == null && (catMeta.id === "earnings_forecast" || catMeta.cat === "fcst")) {
      const m = summary.match(/[+\-]\s*(\d+(?:\.\d+)?)\s*%/);
      if (m) {
        const sign = m[0].trim().startsWith("-") ? -1 : 1;
        const n = sign * parseFloat(m[1]);
        if (Number.isFinite(n) && Math.abs(n) < 200) impactPct = n;
      }
    }

    items.push({
      date,
      cat: catMeta.cat,
      label: catMeta.label,
      title,
      summary,
      source_url: validUrl,
      impact_pct: impactPct,
      _category_jp: catMeta.jp,
    });
  }

  // Sort newest first
  items.sort((a, b) => b.date.localeCompare(a.date));

  console.log(`[IR news finder] ${code}: kept ${items.length}, rejected: ${JSON.stringify(rejectStats)}`);

  return items.slice(0, 12);
}

function normalizeDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  // Accept YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const yyyy = m[1];
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  const dd = String(parseInt(m[3], 10)).padStart(2, "0");
  // Reject obviously bogus dates
  const yearNum = parseInt(yyyy, 10);
  const monNum = parseInt(mm, 10);
  const dayNum = parseInt(dd, 10);
  if (yearNum < 2018 || yearNum > 2030) return null;
  if (monNum < 1 || monNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert items from findIrNews() to the merged.ir_news shape used by the existing UI.
 * The frontend renderNews expects: { date, fy, cat, label, title, meta, impact, impact_cls }
 */
export function toMergedIrNewsShape(items) {
  return items.map(it => {
    let impactStr = "N/A";
    let impactCls = "flat";
    if (it.impact_pct != null) {
      const sign = it.impact_pct > 0 ? "+" : "";
      impactStr = `${sign}${it.impact_pct.toFixed(1)}%`;
      impactCls = it.impact_pct > 0 ? "up" : it.impact_pct < 0 ? "dn" : "flat";
    }

    // Convert YYYY-MM-DD -> YYYY.MM.DD for display consistency with existing UI
    const dateDot = it.date.replace(/-/g, ".");

    return {
      date: dateDot,
      fy: "",  // We don't have FY info from this source
      cat: it.cat,
      label: it.label,
      title: it.title,
      meta: it.summary,
      impact: impactStr,
      impact_cls: impactCls,
      _source_url: it.source_url,  // Preserved for future use (currently UI doesn't show per-item URLs)
    };
  });
}
