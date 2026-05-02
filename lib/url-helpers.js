// lib/url-helpers.js — Authoritative URL builders + validators for IR / disclosure links
// Goal: prevent AI from emitting fabricated URLs by either
//   (1) supplying authoritative search-hub URLs ourselves, or
//   (2) validating AI-supplied URLs and falling back when they look wrong.

/**
 * Build authoritative source-chip URLs for a given securities code.
 * These are SEARCH HUB URLs (not direct article URLs) that always work.
 */
export function buildAuthoritativeSourceUrls(code) {
  const c = String(code).slice(0, 4); // Yahoo / kabutan use 4-digit
  return {
    // Stock data hubs
    yahoo:        `https://finance.yahoo.co.jp/quote/${c}.T`,
    kabutan:      `https://kabutan.jp/stock/?code=${c}`,
    buffett_code: `https://www.buffett-code.com/company/${c}/`,
    shikiho:      `https://shikiho.toyokeizai.net/stocks/${c}`,
    minkabu:      `https://minkabu.jp/stock/${c}`,

    // Disclosure hubs
    // EDINET — direct fuzzy code search via E-NET 文字列検索
    edinet_search: `https://disclosure2.edinet-fsa.go.jp/WEEK0010.aspx?bIsNewUI=1&mul=${c}`,
    edinet_root:   `https://disclosure2.edinet-fsa.go.jp/`,

    // TDnet 適時開示閲覧 (only past 31 days, no per-stock filter — but it's the canonical hub)
    tdnet_main:    `https://www.release.tdnet.info/inbs/I_main_00.html`,

    // 東証上場会社情報サービス (10-year archive — no direct deep-link, only search form)
    tse_company_search: `https://www2.jpx.co.jp/tseHpFront/JJK010010Action.do?Show=Show`,

    // JPX market segment / criteria
    jpx_listing_criteria: `https://www.jpx.co.jp/equities/listing/continue/index.html`,

    // Quick disclosure search aggregators (third-party but reliable)
    minkabu_disclosure: `https://minkabu.jp/stock/${c}/disclosure`,
    moneyworld_disclosure: `https://moneyworld.jp/stocks/${c}/disclosure`,
  };
}

/**
 * Predicate: is this string a syntactically valid http(s) URL?
 */
export function isValidHttpUrl(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Predicate: detect URLs that are very likely fabricated by an LLM.
 * Returns true if URL passes minimum quality bar.
 */
export function isPlausibleIrUrl(s) {
  if (!isValidHttpUrl(s)) return false;
  const url = s.trim();
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();

  // 1) Reject obvious LLM hallucination patterns
  const hallucinationPatterns = [
    /\/example\.com\b/i,
    /\/example\.co\.jp\b/i,
    /\/foo\b/i,
    /\/bar\b/i,
    /\/placeholder\b/i,
    /\/dummy\b/i,
    /\/sample\b/i,
    /\/xxxxx+/i,
    /\/12345\b/,
    /\/00000+\b/,
  ];
  if (hallucinationPatterns.some(re => re.test(url))) return false;

  // 2) Reject URLs that contain Japanese chars in path (LLMs often emit
  //    these because they "translate" placeholder names into Japanese).
  //    Check both the raw input string AND the decoded path — Node's URL parser
  //    percent-encodes non-ASCII chars, so we have to inspect both.
  const rawInput = String(s);
  let decodedHref = "";
  try { decodedHref = decodeURI(u.href); } catch { decodedHref = u.href; }
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(rawInput) || /[\u3040-\u30ff\u4e00-\u9fff]/.test(decodedHref)) {
    return false;
  }

  // 3) Reject TDnet "deep links" — TDnet does NOT have stable per-doc URLs
  //    that LLMs can know. Only the main page is reliable.
  if (host === "www.release.tdnet.info" && path !== "/inbs/i_main_00.html" && path !== "/") {
    return false;
  }

  // 4) Reject EDINET deep links to specific docID — LLMs guess these wrong.
  //    Allow only the search-hub URL.
  if (host.includes("disclosure2.edinet-fsa.go.jp") || host.includes("disclosure.edinet-fsa.go.jp")) {
    if (path.includes("/week0040") || path.includes("/week0050")) {
      // Direct doc URLs — likely fabricated
      return false;
    }
  }

  return true;
}

/**
 * For an AI-supplied IR news item, return a guaranteed-good URL.
 * Strategy:
 *   1. If the AI URL is plausible → keep it
 *   2. Otherwise → fall back to a code-specific search hub
 *      that points the user toward the correct disclosure
 */
export function resolveIrNewsUrl(aiUrl, code, opts = {}) {
  const hubs = buildAuthoritativeSourceUrls(code);
  if (isPlausibleIrUrl(aiUrl)) {
    return { url: aiUrl, source: "ai", verified: false };
  }
  // Fallback: a search hub the user can click to find the actual disclosure
  return {
    url: opts.preferTdnet ? hubs.tdnet_main : hubs.minkabu_disclosure,
    source: "fallback",
    verified: true,
  };
}

/**
 * Sanitize an array of source-chip objects.
 * Replaces invalid/fabricated URLs with authoritative hub URLs.
 */
export function sanitizeSourceChips(chips, code) {
  if (!Array.isArray(chips)) return [];
  const hubs = buildAuthoritativeSourceUrls(code);

  return chips
    .filter(c => c && (c.label || c.url))
    .map(c => {
      const label = String(c.label || "").trim();
      let url = String(c.url || "").trim();

      // 1) If URL is invalid/fabricated, swap for a hub by label heuristic
      if (!isPlausibleIrUrl(url)) {
        url = pickHubByLabel(label, hubs);
      }

      // 2) Special-case: if label says "EDINET" / "TDnet" / "JPX", force the hub URL
      //    (regardless of what AI emitted) — these are well-known canonical URLs
      const lower = label.toLowerCase();
      if (/edinet/i.test(label)) url = hubs.edinet_search;
      else if (/tdnet|適時開示/i.test(label)) url = hubs.tdnet_main;
      else if (/jpx 上場会社|tse 上場会社|東証上場会社/i.test(label)) url = hubs.tse_company_search;
      else if (/上場維持基準/i.test(label)) url = hubs.jpx_listing_criteria;
      else if (/yahoo/i.test(label)) url = hubs.yahoo;
      else if (/kabutan|株探/i.test(label)) url = hubs.kabutan;
      else if (/buffett[\s_]?code|バフェット/i.test(label)) url = hubs.buffett_code;
      else if (/会社四季報|shikiho/i.test(label)) url = hubs.shikiho;
      else if (/みんかぶ|minkabu/i.test(label)) url = hubs.minkabu;

      return { ...c, label, url };
    })
    .filter(c => isValidHttpUrl(c.url));
}

function pickHubByLabel(label, hubs) {
  const l = label.toLowerCase();
  if (/edinet|有報|有価証券報告書/i.test(label)) return hubs.edinet_search;
  if (/tdnet|適時開示/i.test(label)) return hubs.tdnet_main;
  if (/jpx|tse|上場/i.test(label)) return hubs.tse_company_search;
  if (/yahoo/i.test(label)) return hubs.yahoo;
  if (/kabutan|株探/i.test(label)) return hubs.kabutan;
  if (/buffett|バフェット/i.test(label)) return hubs.buffett_code;
  if (/四季報|shikiho/i.test(label)) return hubs.shikiho;
  if (/みんかぶ|minkabu/i.test(label)) return hubs.minkabu;
  // Default: minkabu disclosure page (works for any code)
  return hubs.minkabu_disclosure;
}
