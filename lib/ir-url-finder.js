// lib/ir-url-finder.js — Verify / discover company IR URL from EDINET-extracted name
// Strategy:
//   1. Cheap heuristic: check whether AI's URL hostname relates to the company name
//   2. If heuristic fails (or no AI URL): make a focused Claude+web_search call to find the real URL

import { isPlausibleIrUrl } from "./url-helpers.js";

// Words to strip when extracting "meaningful tokens" from a company name
const NOISE_TOKENS = new Set([
  // English
  "corporation", "corp", "company", "co", "ltd", "inc", "incorporated",
  "kabushiki", "kaisha", "kk", "holdings", "holding", "group",
  "the", "and", "of", "japan", "japanese",
  // Japanese
  "株式会社", "(株)", "（株）", "ホールディングス",
]);

/**
 * Extract meaningful name tokens from English name (≥4 chars, drop noise words).
 * Used to validate URL hostnames against the company name.
 */
export function extractNameTokens(name_en) {
  if (!name_en) return [];
  return String(name_en)
    .replace(/[,.()\[\]/&]/g, " ")
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 4)
    .filter(t => !NOISE_TOKENS.has(t));
}

/**
 * Predicate: does the hostname appear to relate to the company?
 * Returns true if any meaningful name token (≥4 chars) appears in the hostname.
 */
export function urlMatchesCompany(url, name_en, name_jp) {
  if (!url) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return false; }

  // Strip leading "www." for matching
  host = host.replace(/^www\./, "");

  // 1) Try English name tokens
  const enTokens = extractNameTokens(name_en);
  for (const t of enTokens) {
    if (host.includes(t)) return true;
  }

  // 2) Also try Japanese name romanization heuristic — for katakana-only names like インフォマート
  //    we transliterate to a rough latin form and try those.
  // Simple: look for ASCII letters in the company JP name (some have e.g. "SBI" or "ABC")
  if (name_jp) {
    const asciiBits = String(name_jp).match(/[A-Za-z]{3,}/g) || [];
    for (const a of asciiBits) {
      if (host.includes(a.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * Use Claude with web search to find the official IR URL for the EDINET-extracted company.
 * Returns: { url } | null
 */
export async function findCompanyIrUrl(client, { name_jp, name_en, code }) {
  if (!name_jp || !client) return null;

  const enLine = name_en ? `\n会社名 (英語): ${name_en}` : "";
  const prompt = `日本の上場企業の **公式 IR ページの URL を 1 つだけ** 返してください。

会社名 (日本語): ${name_jp}${enLine}
証券コード: ${code}

【手順】
1. 会社名で Web 検索して、その会社の公式コーポレートサイトを特定
2. そのサイト内の「IR トップ」「投資家情報」「株主・投資家の皆様へ」等のページの URL を 1 つ選ぶ
3. 公式ドメインのトップディレクトリの IR ページを優先 (例: https://www.example.co.jp/ir/)

【絶対ルール】
- 会社の公式ドメインのみ。第三者サイト (kabutan / Yahoo / minkabu / 業界紙 等) は禁止
- ニュース記事の URL は禁止
- パスに日本語/カナ/会社名英字を含む URL は推測の可能性が高いので返さない
- 確信が持てない場合は url を "" (空文字列) にする
- インフォマート (infomart.co.jp) を返すのは、会社名が「株式会社インフォマート」または「Infomart」の場合のみ

【出力形式】 JSON 1 行のみ:
{"url": "https://..."}
`;

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.warn(`[IR URL finder] API call failed for ${code}: ${e.message}`);
    return null;
  }

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  // Extract URL from JSON in response
  const jsonMatch = text.match(/\{[^}]*"url"\s*:\s*"([^"]*)"[^}]*\}/);
  if (!jsonMatch) return null;
  const url = jsonMatch[1].trim();

  if (!url) return null;
  if (!isPlausibleIrUrl(url)) return null;

  // Note: We deliberately do NOT apply urlMatchesCompany() here as a strict gate.
  // The focused search uses the EDINET name as its explicit anchor, so its result is
  // already grounded. Some legitimate companies have non-obvious domains (e.g. 7&i
  // Holdings → 7andi.com, Recruit Holdings → recruit-holdings.co.jp not "recruit").
  // The isPlausibleIrUrl check above already filters out fabricated/example URLs.
  return url;
}
