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
    : `会社 IR ページ: 不明 — 会社名でまず Google 検索して IR トップを特定してから探す`;
  const enHint = name_en ? `\n英文社名: ${name_en}` : "";

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `あなたは日本株のリサーチアナリストです。以下の上場企業について、**会社 IR サイトに掲載されている資料** を調査し、機関投資家が重視する 8 カテゴリの IR 資料を最大 12 件抽出してください。

【対象企業】
証券コード: ${code}
社名: ${name_jp}${enHint}
${irHint}

【調査手順】
1. ${company_ir_url ? `まず ${company_ir_url} および同サイトの "/ir/news/", "/ir/library/", "/ir/", "/news/" などの IR ニュース一覧ページを直接 web_search で調査` : "まず会社名で Google 検索して IR トップを特定"}
2. **TDnet (release.tdnet.info)** や **kabutan.jp/disclosures** で「${name_jp}」+ 各カテゴリのキーワードを検索
3. 過去 24 ヶ月以内 (${today} から遡って 2 年) の資料を優先
4. 8 カテゴリ全てが存在しない場合は、ある分だけで OK (空配列でも可)

【対象 8 カテゴリ】
1. **業務提携**: 単純な業務提携 (資本関与なし) のお知らせ
2. **資本業務提携**: 出資を伴う業務提携・株式持ち合い等
3. **株式取得**: 他社株式の取得 (連結化を伴わないもの)
4. **子会社化**: 株式の追加取得や TOB により対象会社を子会社化
5. **業績予想**: 通期/四半期業績予想の発表・修正・配当予想
6. **成長可能性資料**: グロース市場上場会社が継続的に開示する成長可能性資料 (上場時を除く再開示分のみ)
7. **事業計画**: 単年度の事業計画・経営方針
8. **中期経営計画**: 3〜5 年の中期経営計画 (新規策定・改定・進捗開示)

【出力形式】 JSON 1 行のみ。前置き・コードブロック禁止:

{"items":[
  {
    "date": "YYYY-MM-DD",
    "category": "業務提携|資本業務提携|株式取得|子会社化|業績予想|成長可能性資料|事業計画|中期経営計画",
    "title": "開示資料の正式タイトル (PDF 等のファイル名から取れる範囲で)",
    "summary": "120文字以内の要約 — 相手企業名、取得株式数、金額、対象事業、業績予想数値などの具体情報を含める",
    "source_url": "実際に該当する PDF or ページの URL (確認できないなら \"\")",
    "impact_pct": null
  }
]}

【重要な制約】
- ★ **存在しない資料を捏造しない**。確認できた資料のみ列挙する
- 古い資料 (24ヶ月以上前) は除外
- 上場時の成長可能性資料は除外 (継続開示分のみ)
- 日付は YYYY-MM-DD ハイフン区切りで統一
- カテゴリ名は上記 8 つの中から正確に選ぶ (それ以外は出力しない)
- impact_pct は基本的に null。業績予想で前年比が明示されている場合のみ数値 (+11.3 等) を入れる
- 同じ資料が複数カテゴリに該当する場合は、最も中核的な 1 カテゴリのみで出力 (重複なし)
- 最大 12 件。新しい順にソート
`;

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.warn(`[IR news finder] API call failed for ${code}: ${e.message}`);
    return [];
  }

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  // Extract JSON object from response
  let parsed = null;
  // Try direct JSON parse first, then extract from text
  const jsonMatch = text.match(/\{[\s\S]*"items"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch {}
  }
  if (!parsed) {
    try { parsed = JSON.parse(text); } catch {}
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    console.warn(`[IR news finder] no parseable JSON for ${code}; got ${text.length} chars`);
    return [];
  }

  // Validate, normalize, dedupe, sort
  const seen = new Set();
  const items = [];
  for (const raw of parsed.items.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;

    const date = normalizeDate(raw.date);
    if (!date) continue;

    const categoryJp = String(raw.category || "").trim();
    const catMeta = CATEGORY_BY_JP[categoryJp];
    if (!catMeta) continue;  // Reject unknown categories

    const title = String(raw.title || "").trim().slice(0, 200);
    if (!title) continue;

    // Dedupe key: title + date
    const dedupeKey = `${title}::${date}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const summary = String(raw.summary || "").trim().slice(0, 240);
    const sourceUrl = String(raw.source_url || "").trim();
    const validUrl = /^https?:\/\//.test(sourceUrl) ? sourceUrl : "";

    let impactPct = null;
    if (raw.impact_pct != null) {
      const n = Number(raw.impact_pct);
      if (Number.isFinite(n) && Math.abs(n) < 200) impactPct = n;
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
