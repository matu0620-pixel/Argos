// lib/gemini-client.js
// =======================================================================
// Compatibility shim: exposes an "Anthropic-like" interface backed by the
// Google Gemini API. This lets the existing analyze.js / analyze-stream.js
// code remain largely unchanged after migrating from Claude to Gemini.
//
// Usage:
//   import GeminiClient from "../lib/gemini-client.js";
//   const client = new GeminiClient({ apiKey: process.env.GEMINI_API_KEY });
//   const r = await client.messages.create({
//     model: "gemini-2.5-flash",
//     max_tokens: 8000,
//     messages: [{ role: "user", content: "..." }],
//     tools: [{ type: "google_search" }],
//   });
//   // r.content is in Anthropic-style: [{ type: "text", text: "..." }]
//
// Web search:
//   Anthropic style → tools: [{ type: "web_search_20250305", name: "web_search", max_uses: N }]
//   We translate this to Gemini's built-in `googleSearch` tool. The
//   `max_uses` parameter has no Gemini equivalent (it's auto-managed),
//   but we preserve the call shape.
// =======================================================================

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Translate an Anthropic-style request to a Gemini request.
 */
function translateToGemini({ model, max_tokens, messages, tools, system }) {
  // 1. messages → contents
  // Anthropic: [{role: "user", content: "text"}] OR
  //            [{role: "user", content: [{type:"text", text:"..."}]}]
  // Gemini:    [{role: "user", parts: [{text: "..."}]}]
  const contents = (messages || []).map(m => {
    let parts;
    if (typeof m.content === "string") {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map(c => {
        if (c.type === "text") return { text: c.text };
        return { text: String(c?.text || "") };
      });
    } else {
      parts = [{ text: String(m.content || "") }];
    }
    return {
      // Gemini uses "user" / "model" (not "assistant")
      role: m.role === "assistant" ? "model" : "user",
      parts,
    };
  });

  // 2. tools → translate Anthropic web_search to Gemini googleSearch
  let geminiTools = undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    const hasWebSearch = tools.some(t =>
      t.type === "web_search_20250305" ||
      t.type === "google_search" ||
      t.name === "web_search"
    );
    if (hasWebSearch) {
      // Gemini 2.5 uses "google_search" (snake_case) for the built-in tool
      geminiTools = [{ google_search: {} }];
    }
  }

  // 3. generationConfig
  const generationConfig = {
    maxOutputTokens: max_tokens || 8000,
    temperature: 0.3, // analytical work — keep determinism reasonable
  };

  const body = {
    contents,
    generationConfig,
  };

  if (geminiTools) body.tools = geminiTools;
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  return body;
}

/**
 * Translate a Gemini response back to Anthropic-style.
 * We collect all text parts into a single `{type:"text", text:"..."}` block.
 * Web search citation URIs are appended as a final markdown block so prompts
 * that look for source URLs (e.g. ir_url, kabutan ↗) can still find them.
 */
function translateFromGemini(geminiResponse) {
  const candidate = geminiResponse?.candidates?.[0];
  if (!candidate) {
    return { content: [{ type: "text", text: "" }], stop_reason: "error" };
  }
  const parts = candidate.content?.parts || [];
  const textBlocks = parts
    .filter(p => typeof p.text === "string")
    .map(p => p.text);
  let combined = textBlocks.join("\n").trim();

  // Append grounding citations as markdown links if present.
  // Gemini's groundingMetadata.groundingChunks gives URIs the model used.
  // We append them as `<!-- sources: ... -->` so the JSON parser ignores them
  // but downstream code can extract if needed.
  const groundingChunks = candidate.groundingMetadata?.groundingChunks;
  if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
    const urls = groundingChunks
      .map(c => c?.web?.uri)
      .filter(u => typeof u === "string" && u.length > 0)
      .slice(0, 10);
    if (urls.length > 0) {
      combined += `\n\n<!-- _grounding_sources: ${JSON.stringify(urls)} -->`;
    }
  }

  return {
    content: [{ type: "text", text: combined }],
    stop_reason: candidate.finishReason || "end_turn",
    usage: {
      input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

/**
 * Model defaults (v4 — Gemini 3 world, 2026-04 以降 Pro は有料化のため Flash 系のみ).
 * 環境変数で差し替え可能:
 *   GEMINI_MODEL       … 重い推論 (default: gemini-3-flash)
 *   GEMINI_MODEL_LITE  … 分類・整形などの軽量呼び出し (default: gemini-3.1-flash-lite)
 * モデルIDが未提供リージョン等で 404 の場合は LEGACY_FALLBACK へ自動リトライ。
 */
export const MODEL_FLASH = process.env.GEMINI_MODEL || "gemini-3-flash";
export const MODEL_LITE = process.env.GEMINI_MODEL_LITE || "gemini-3.1-flash-lite";
const LEGACY_FALLBACK = {
  [MODEL_FLASH]: "gemini-2.5-flash",
  [MODEL_LITE]: "gemini-2.5-flash-lite",
};

/**
 * Resolve a model name. Accepts Anthropic-style names (legacy callers),
 * legacy Gemini 2.5 names (→ current defaults), and explicit gemini-* names.
 */
function resolveModel(model) {
  if (!model || typeof model !== "string") return MODEL_FLASH;
  if (model === "gemini-2.5-flash-lite" || model.includes("haiku") || model.includes("lite")) return MODEL_LITE;
  if (model === "gemini-2.5-flash") return MODEL_FLASH;
  if (model.startsWith("gemini-")) return model;
  // sonnet, opus, or anything else → flash
  return MODEL_FLASH;
}

// =======================================================================
//   PUBLIC API
// =======================================================================

class GeminiClient {
  constructor({ apiKey, baseUrl } = {}) {
    if (!apiKey) throw new Error("GeminiClient: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || GEMINI_API_BASE;

    // Anthropic-style nested namespace
    this.messages = {
      create: this._messagesCreate.bind(this),
      stream: this._messagesStream.bind(this),
    };
  }

  async _messagesCreate(opts) {
    const model = resolveModel(opts.model);
    const body = translateToGemini(opts);

    const doFetch = (m) => fetch(
      `${this.baseUrl}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );

    let resp = await doFetch(model);
    // モデルID未提供 (404) は旧世代へ自動フォールバック
    if (resp.status === 404 && LEGACY_FALLBACK[model]) {
      console.warn(`[Gemini] ${model} が 404 — ${LEGACY_FALLBACK[model]} へフォールバック`);
      resp = await doFetch(LEGACY_FALLBACK[model]);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      const err = new Error(`Gemini API ${resp.status}: ${errBody.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    return translateFromGemini(data);
  }

  /**
   * Streaming variant. Returns an async-iterable similar to Anthropic's
   * stream() but emits events shaped like the existing analyze-stream.js
   * expects, so we can keep its consumer code minimally changed.
   *
   * Yields events of the form:
   *   { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
   *   { type: "content_block_stop" }
   *   { type: "message_stop" }
   */
  _messagesStream(opts) {
    const model = resolveModel(opts.model);
    const body = translateToGemini(opts);
    const baseUrl = this.baseUrl;
    const apiKey = this.apiKey;
    const mkUrl = (m) => `${baseUrl}/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    // Track final text + grounding metadata across the stream
    const state = { fullText: "", groundingUrls: [], hasSearched: false };

    async function* iterator() {
      const doFetch = (m) => fetch(mkUrl(m), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let resp = await doFetch(model);
      // モデルID未提供 (404) は旧世代へ自動フォールバック
      if (resp.status === 404 && LEGACY_FALLBACK[model]) {
        console.warn(`[Gemini] ${model} が 404 — ${LEGACY_FALLBACK[model]} へフォールバック (stream)`);
        resp = await doFetch(LEGACY_FALLBACK[model]);
      }
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Gemini stream ${resp.status}: ${errBody.slice(0, 300)}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE: lines like "data: {...}\n\n"
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep last partial line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }
          const cand = parsed?.candidates?.[0];
          if (!cand) continue;
          const parts = cand.content?.parts || [];
          for (const p of parts) {
            if (typeof p.text === "string" && p.text.length > 0) {
              state.fullText += p.text;
              yield {
                type: "content_block_delta",
                delta: { type: "text_delta", text: p.text },
              };
            }
          }
          // Capture grounding metadata if present
          const gm = cand.groundingMetadata;
          if (gm?.groundingChunks && Array.isArray(gm.groundingChunks)) {
            for (const c of gm.groundingChunks) {
              if (c?.web?.uri && !state.groundingUrls.includes(c.web.uri)) {
                state.groundingUrls.push(c.web.uri);
              }
            }
            state.hasSearched = true;
          }
          if (gm?.webSearchQueries && gm.webSearchQueries.length > 0) {
            state.hasSearched = true;
          }
        }
      }

      // Emit grounding citations as a synthetic delta if any were collected.
      // This lets downstream code that scans the full text for source URLs
      // still find them after the stream completes.
      if (state.groundingUrls.length > 0) {
        const sourceComment = `\n\n<!-- _grounding_sources: ${JSON.stringify(state.groundingUrls.slice(0, 10))} -->`;
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: sourceComment },
        };
      }

      yield { type: "content_block_stop" };
      yield { type: "message_stop" };
    }

    return {
      [Symbol.asyncIterator]: iterator,
      // Provide finalMessage() like Anthropic's stream does
      async finalMessage() {
        // Drain if not already drained — caller may have iterated separately.
        // If they did iterate, fullText/groundingUrls are already populated.
        if (!state.fullText) {
          // Caller didn't iterate — drain ourselves
          for await (const _ of iterator()) { /* drain */ }
        }
        let text = state.fullText;
        if (state.groundingUrls.length > 0 && !text.includes("_grounding_sources")) {
          text += `\n\n<!-- _grounding_sources: ${JSON.stringify(state.groundingUrls.slice(0, 10))} -->`;
        }
        return {
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
        };
      },
    };
  }
}

export default GeminiClient;
