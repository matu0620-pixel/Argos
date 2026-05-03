// lib/code-resolver.js — Resolve a company name (or partial match) to a Japanese
// stock code via Haiku + web_search. This allows users to search by company name
// (e.g., "メンタルヘルステクノロジーズ", "ソフトバンクグループ", "Toyota") instead of
// requiring the 4-5 digit code.
//
// Strategy:
//   1. If input is already a 4-5 digit code → return as-is (no API call)
//   2. Otherwise, ask Haiku with web_search to find the canonical TSE listed code
//   3. Return { code, name_jp, name_en, market, confidence, candidates }
//      where candidates is a list of plausible alternatives (for ambiguous queries)
//
// Cost: ~¥0.005-0.01 per name resolution (Haiku + 1-2 web searches).

const RESOLVER_PROMPT = (input) => `あなたは日本株のリサーチアシスタントです。以下の入力から、**東京証券取引所に上場している企業** の証券コードを 1 つ特定してください。

【入力】
"${input}"

【判断ルール】
- 入力は会社名・略称・カナ・ひらがな・英語名・サービス名・ティッカー名のいずれかの可能性があります
- 候補が 1 社しかなければ最も確からしい 1 社を特定
- 候補が複数あり、明確な絞り込みが難しい場合は、最も時価総額が大きい / 最も知名度が高い 1 社を primary とし、他を candidates に含める
- 上場していない会社の場合は code を null にする
- 持株会社と事業会社が両方ある場合 (例: ソフトバンク = 9434 vs ソフトバンクグループ = 9984) は両方を candidates に含めて、ユーザーが意図した可能性が高い方を primary に

【検索方針】
- 必要に応じて Web 検索で「${input} 証券コード」「${input} 上場」を検索
- kabutan / minkabu / Yahoo!ファイナンス / 会社四季報 等で確認

【出力形式】
JSON 1 行のみ、コードブロック・前置き禁止:

{
  "code": "9218",
  "name_jp": "株式会社メンタルヘルステクノロジーズ",
  "name_en": "Mental Health Technologies Co.,Ltd.",
  "market": "TSE GROWTH",
  "confidence": "high|mid|low",
  "candidates": [
    {"code":"9434","name":"ソフトバンク","note":"通信子会社"},
    {"code":"9984","name":"ソフトバンクグループ","note":"持株会社"}
  ]
}

【confidence の判断】
- high: 入力が一意に特定できる (略称や正式名称、名前が完全一致)
- mid: 候補は絞れたが類似企業あり (candidates に他社も入れる)
- low: 推測ベース (上場していない or 入力が曖昧すぎる)

【特別ルール】
- 入力が既に 4-5 桁の数字のみなら、それを code として返す (確認のみで OK)
- 入力が空白・記号のみなら code: null, confidence: "low"
- 上場していない有名企業 (例: 任天堂 → 7974、上場済み | サントリーHD → 上場前 = code: null)
`;

/**
 * Resolve a company name (or partial match) to a stock code.
 *
 * @param {Anthropic} client - Anthropic client instance
 * @param {string} input - User input (company name, code, or partial match)
 * @returns {Promise<{
 *   code: string|null,
 *   name_jp: string,
 *   name_en: string,
 *   market: string,
 *   confidence: "high"|"mid"|"low",
 *   candidates: Array<{code:string,name:string,note:string}>,
 *   error?: string,
 * }>}
 */
export async function resolveCompanyToCode(client, input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    return { code: null, name_jp: "", name_en: "", market: "", confidence: "low", candidates: [], error: "empty input" };
  }

  // Fast path: already a code
  if (/^\d{4,5}$/.test(trimmed)) {
    return { code: trimmed, name_jp: "", name_en: "", market: "", confidence: "high", candidates: [] };
  }

  if (!client) {
    return { code: null, name_jp: "", name_en: "", market: "", confidence: "low", candidates: [], error: "no-client" };
  }

  let response;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: RESOLVER_PROMPT(trimmed) }],
    });
  } catch (e) {
    console.warn(`[code-resolver] API call failed for "${trimmed}": ${e.message}`);
    return { code: null, name_jp: "", name_en: "", market: "", confidence: "low", candidates: [], error: e.message };
  }

  const text = (response.content || [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  // Extract JSON from response
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
    console.log(`[code-resolver] "${trimmed}": no parseable JSON, raw="${text.slice(0, 200)}"`);
    return { code: null, name_jp: "", name_en: "", market: "", confidence: "low", candidates: [], error: "parse-error" };
  }

  // Validate code format
  let code = parsed.code ? String(parsed.code).trim() : null;
  if (code && !/^\d{4,5}$/.test(code)) {
    console.log(`[code-resolver] "${trimmed}": invalid code format "${code}"`);
    code = null;
  }

  const confidence = ["high", "mid", "low"].includes(parsed.confidence) ? parsed.confidence : "low";

  // Sanitize candidates list
  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .filter(c => c && c.code && /^\d{4,5}$/.test(String(c.code).trim()))
        .map(c => ({
          code: String(c.code).trim(),
          name: String(c.name || "").trim().slice(0, 100),
          note: String(c.note || "").trim().slice(0, 100),
        }))
        .slice(0, 5)
    : [];

  console.log(`[code-resolver] "${trimmed}" → ${code} (${parsed.name_jp || "—"}) ${confidence}, ${candidates.length} candidates`);

  return {
    code,
    name_jp: String(parsed.name_jp || "").trim().slice(0, 100),
    name_en: String(parsed.name_en || "").trim().slice(0, 100),
    market: String(parsed.market || "").trim().slice(0, 30),
    confidence,
    candidates,
  };
}
