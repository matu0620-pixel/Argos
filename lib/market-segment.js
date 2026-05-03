// lib/market-segment.js — Verify market segment via 会社四季報 (and other public sources)
// Returns one of: "prime" | "standard" | "growth" | "other" | null

const SEGMENT_LABELS = {
  prime:    { tag: "TSE PRIME",    jp: "東証プライム" },
  standard: { tag: "TSE STANDARD", jp: "東証スタンダード" },
  growth:   { tag: "TSE GROWTH",   jp: "東証グロース" },
  other:    { tag: "TSE OTHER",    jp: "その他" },
};

/**
 * Convert internal segment code to display label objects.
 */
export function getMarketSegmentTag(segment) {
  return SEGMENT_LABELS[segment] || null;
}

/**
 * Use Claude with web search to determine the current market segment from
 * authoritative sources (会社四季報 first, kabutan / Yahoo as fallback).
 *
 * Returns: "prime" | "standard" | "growth" | "other" | null
 */
export async function findMarketSegment(client, { name_jp, code }) {
  if (!code || !client) return null;

  const nameLine = name_jp ? `\n会社名: ${name_jp}` : "";
  const prompt = `日本の上場企業の **現在の市場区分** を判定してください。${nameLine}
証券コード: ${code}

【調査手順】
1. 会社四季報 (shikiho.toyokeizai.net/stocks/${code}) で市場区分を確認するのが最優先
2. それで分からない場合は kabutan.jp/stock/?code=${code} または finance.yahoo.co.jp/quote/${code}.T を確認
3. JPX (jpx.co.jp) の上場会社情報も補助的に利用

【市場区分の選択肢】
- "prime"    — 東証プライム (Prime)
- "standard" — 東証スタンダード (Standard)
- "growth"   — 東証グロース (Growth)
- "other"    — その他 (TOKYO PRO Market, 上場廃止, 名証/福証/札証 のみ等)

【重要な注意】
- 2022 年 4 月 4 日以降は新市場区分。「東証一部」「マザーズ」「JASDAQ」「東証二部」は廃止済み
  → これらの旧区分しか出てこない情報源は古いので無視。新市場区分を必ず確認する
- 旧東証一部 → プライムまたはスタンダードに移行 (各社の判断で異なる)
- 旧マザーズ → グロースに移行
- 旧 JASDAQ スタンダード → スタンダードに移行
- 旧 JASDAQ グロース → グロースに移行
- 確信が持てない場合は "other" を返す

【出力形式】 JSON 1 行のみ:
{"segment": "prime|standard|growth|other"}
`;

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.warn(`[Market segment finder] API call failed for ${code}: ${e.message}`);
    return null;
  }

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  const match = text.match(/\{[^}]*"segment"\s*:\s*"(prime|standard|growth|other)"[^}]*\}/i);
  if (!match) return null;

  const seg = match[1].toLowerCase();
  if (!["prime", "standard", "growth", "other"].includes(seg)) return null;
  return seg;
}

/**
 * Apply the verified market segment across the merged result:
 * - merged._market_segment: code (prime/standard/growth/other)
 * - merged.market_tags: ensure the first tag reflects the verified segment
 * - merged.listing.market_card / aside are already set elsewhere via getMarketCard/getMarketAside
 *
 * Returns the modified merged object (mutates in place too).
 */
export function applyMarketSegmentToMerged(merged, segment) {
  if (!merged || !segment) return merged;

  merged._market_segment = segment;
  const labels = getMarketSegmentTag(segment);
  if (!labels) return merged;

  // Update / replace the market segment tag in merged.market_tags
  if (!Array.isArray(merged.market_tags)) merged.market_tags = [];

  // Class for the chip color
  const cls = segment === "prime" ? "prime"
            : segment === "standard" ? "standard"
            : segment === "growth" ? "growth"
            : "";

  // Find the existing market segment tag (first one matching PRIME/STANDARD/GROWTH/プライム etc.)
  const segRe = /(PRIME|STANDARD|GROWTH|プライム|スタンダード|グロース|TSE)/i;
  const existingIdx = merged.market_tags.findIndex(t => segRe.test(String(t?.label || "")));

  const newTag = { label: labels.tag, cls };
  if (existingIdx >= 0) {
    merged.market_tags[existingIdx] = newTag;
  } else {
    // No existing market segment tag — prepend the new one
    merged.market_tags.unshift(newTag);
  }

  return merged;
}
