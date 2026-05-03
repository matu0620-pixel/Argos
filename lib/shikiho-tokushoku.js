// lib/shikiho-tokushoku.js — Fetch the "特色" (business profile) field from
// 会社四季報 (Shikiho) for a given stock code, via Haiku + web_search.
//
// Why this exists: Phase 1 has the AI generate a free-form blurb, which tends
// to be long, AI-interpreted, and sometimes embellished. Shikiho's 特色 column
// is the gold standard short business description used by Japanese institutional
// investors. We fetch it directly via web_search and use it to override the AI's
// generated blurb when available.
//
// Sources we look at (in order of preference):
//   1. shikiho.toyokeizai.net (official, but often paywalled)
//   2. kabutan.jp/stock/?code=XXXX (republishes 特色 with attribution)
//   3. minkabu.jp/stock/XXXX (republishes 特色)
//
// Returns a clean string (≤120 chars) or empty string if not found.

const SHIKIHO_PROMPT = (code, nameJp) => `あなたは日本株のリサーチアシスタントです。証券コード ${code}${nameJp ? ` (${nameJp})` : ""} について、**会社四季報の「特色」欄**に書かれている事業概要を Web 検索で見つけて抽出してください。

【検索手順】
1. \`${code} 四季報 特色\` で検索 — kabutan / minkabu / shikiho.jp が上位に来る
2. 「特色」「事業特色」セクションのテキストを確認
3. 同じ意味の文がある場合は最も簡潔な表現を採用

【特色欄の典型例】
- 「建築図面・現場施工等の管理アプリ『SPIDER+』を開発販売。建設業者が主要顧客」
- 「産業医・産業保健領域の SaaS『M3 産業医』を法人向けに展開。労働安全衛生法改正で需要拡大」
- 「機械式駐車装置で国内首位級。海外展開とメンテナンス収益を強化」

このように **80-150 字、改行なし、体言止め多め、簡潔・factual** な書き方が四季報スタイルです。

【厳守事項】
- 四季報の「特色」欄に書かれている内容**のみ**を抽出。一般的な企業説明や AI 生成文は禁止
- 原文に忠実に。意訳や創作は禁止
- 確認できなかった場合は空文字列 "" で返す
- 150 字以内、改行なし

【出力形式】 JSON 1 行のみ、コードブロック・前置き禁止:

{"tokushoku":"特色欄のテキスト or 空文字列","source":"kabutan|minkabu|shikiho|other","confidence":"high|mid|low"}

【判定基準】
- confidence high: 「特色」「事業特色」と明示されたセクションから取得
- confidence mid: 関連セクションから推測 (会社概要等)
- confidence low: 取得できず、Phase 1 の web_search 結果からの大まかな抽出
`;

/**
 * Fetch the Shikiho 特色 description for a stock.
 *
 * @param {Anthropic} client - Anthropic client instance
 * @param {object} opts - { code: string, name_jp: string }
 * @returns {Promise<{ tokushoku: string, source: string, confidence: string }>}
 */
export async function fetchShikihoTokushoku(client, { code, name_jp } = {}) {
  if (!client) {
    return { tokushoku: "", source: "no-client", confidence: "low" };
  }
  if (!code) {
    return { tokushoku: "", source: "no-code", confidence: "low" };
  }

  const prompt = SHIKIHO_PROMPT(code, name_jp);

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    console.warn(`[shikiho 特色] API call failed for ${code}: ${e.message}`);
    return { tokushoku: "", source: "api-error", confidence: "low" };
  }

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  // Try multiple JSON extraction strategies
  let parsed = null;

  // Strategy 1: ```json ... ``` block
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try { parsed = JSON.parse(codeBlockMatch[1]); } catch {}
  }

  // Strategy 2: Largest balanced object
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

  // Strategy 3: Whole text
  if (!parsed) {
    try { parsed = JSON.parse(text); } catch {}
  }

  if (!parsed || typeof parsed !== "object") {
    console.log(`[shikiho 特色] ${code}: no parseable JSON, raw text length=${text.length}`);
    return { tokushoku: "", source: "parse-error", confidence: "low" };
  }

  // Sanitize result
  let tokushoku = String(parsed.tokushoku || "").trim();
  // Remove newlines and excessive whitespace
  tokushoku = tokushoku.replace(/[\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  // Strip wrapping quotes if AI added them
  tokushoku = tokushoku.replace(/^["「『](.*)["」』]$/, "$1").trim();
  // Cap at 150 chars
  if (tokushoku.length > 150) tokushoku = tokushoku.slice(0, 148) + "…";

  const source = String(parsed.source || "unknown").trim().slice(0, 20);
  const confidence = ["high", "mid", "low"].includes(parsed.confidence) ? parsed.confidence : "low";

  // Validation: reject obviously wrong outputs
  if (tokushoku.length > 0 && tokushoku.length < 10) {
    console.log(`[shikiho 特色] ${code}: rejected too-short result: "${tokushoku}"`);
    return { tokushoku: "", source: "too-short", confidence: "low" };
  }

  console.log(`[shikiho 特色] ${code}: extracted ${tokushoku.length} chars from ${source} (${confidence})`);

  return { tokushoku, source, confidence };
}
