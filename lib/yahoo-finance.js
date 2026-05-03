// lib/yahoo-finance.js — Yahoo Finance Japan price fetcher
// Uses the public chart endpoint (no API key needed)
// Returns previous-close based price for Japanese listed stocks

const YF_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com", // fallback
];

// Browser-like headers — Yahoo's edge sometimes 403s requests with
// minimal/non-browser User-Agents. These match a real Chrome session.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};

/**
 * Fetch latest market data for a Japanese listed stock.
 * @param {string} code 4-5 digit Japanese securities code
 * @returns {Promise<Object>} Quote object (see schema below)
 */
export async function getYahooQuote(code) {
  if (!/^\d{4,5}$/.test(String(code))) {
    throw new Error(`Invalid code for Yahoo Finance: ${code}`);
  }

  // Japanese stocks on Tokyo Stock Exchange use ".T" suffix
  // 5-digit codes: take first 4 (Yahoo uses 4-digit symbol)
  const baseCode = String(code).length === 5 ? String(code).slice(0, 4) : String(code);
  const symbol = `${baseCode}.T`;

  // 1-month range gives us enough data for a 14-day spark + previous close
  const path = `/v8/finance/chart/${symbol}?interval=1d&range=1mo`;

  let lastError = null;
  for (const host of YF_HOSTS) {
    try {
      return await fetchYahooChart(host + path, symbol);
    } catch (e) {
      lastError = e;
      console.warn(`[Yahoo] ${host} failed for ${symbol}: ${e.message}`);
      continue;
    }
  }

  throw lastError || new Error(`Yahoo Finance: all endpoints failed for ${symbol}`);
}

async function fetchYahooChart(url, symbol) {
  let res;
  try {
    res = await fetch(url, { headers: BROWSER_HEADERS });
  } catch (e) {
    throw new Error(`Yahoo Finance ネットワークエラー: ${e.message}`);
  }

  if (!res.ok) {
    if (res.status === 404) throw new Error(`Yahoo Finance: 銘柄 ${symbol} が見つかりません`);
    if (res.status === 429) throw new Error(`Yahoo Finance: レート制限 (429)`);
    throw new Error(`Yahoo Finance HTTP ${res.status}`);
  }

  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error(`Yahoo Finance JSON parse error: ${e.message}`); }

  if (json.chart?.error) {
    throw new Error(`Yahoo Finance: ${json.chart.error.code || "unknown"} — ${json.chart.error.description || ""}`);
  }

  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: 応答に銘柄データなし (${symbol})`);

  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];
  const timestamps = result.timestamp || [];

  // ─── Strict 前日終値 vs 前々日終値 logic ─────────────────────
  // 仕様:
  //   price          = 前日終値   (closes 配列の最後の確定済み終値)
  //   previous_close = 前々日終値 (closes 配列の前日終値の 1 つ前の終値)
  //   change %       = (前日終値 - 前々日終値) / 前々日終値 × 100
  //
  // 重要なルール:
  //   ❌ chartPreviousClose は ~30 日前の終値なので絶対に使わない
  //   ❌ regularMarketPreviousClose も補助のみ (closes 配列を最優先)
  //   ✓ closes[] と timestamps[] からタイムスタンプ昇順で取り出す
  //   ✓ 場中 (REGULAR) は最後のエントリがライブ intraday なので除外

  const isMarketOpen = meta.marketState === "REGULAR";

  // (close, timestamp, volume) を timestamp 昇順で抽出
  const validPairs = closes
    .map((c, i) => ({ c, t: timestamps[i], v: volumes[i] ?? null }))
    .filter(p => p.c != null && p.t != null)
    .sort((a, b) => a.t - b.t);

  // 確定済みペア = 場中なら最後のライブ値を除外
  const settledPairs = (isMarketOpen && validPairs.length > 0)
    ? validPairs.slice(0, -1)
    : validPairs;

  let price = null;             // 前日終値
  let priceTs = null;
  let previousClose = null;     // 前々日終値
  let previousCloseTs = null;
  let priceSource = null;
  let prevSource = null;

  if (settledPairs.length >= 2) {
    // 通常パス: closes 配列の最後 2 日を使う (chartPreviousClose は使わない)
    const last = settledPairs[settledPairs.length - 1];
    const prev = settledPairs[settledPairs.length - 2];
    price = last.c;
    priceTs = last.t;
    previousClose = prev.c;
    previousCloseTs = prev.t;
    priceSource = "closes[last]";
    prevSource = "closes[last-1]";
  } else if (settledPairs.length === 1) {
    // 1 日しかない (新規上場直後等) — 前々日は補えないので null
    price = settledPairs[0].c;
    priceTs = settledPairs[0].t;
    priceSource = "closes[0]";
    // 場外で regularMarketPreviousClose がある場合のみ補助使用 (≠ chartPreviousClose)
    if (!isMarketOpen && meta.regularMarketPreviousClose != null) {
      previousClose = meta.regularMarketPreviousClose;
      prevSource = "meta.regularMarketPreviousClose";
    } else {
      previousClose = null;
      prevSource = "unavailable";
    }
  } else {
    // closes が完全に空の極端ケース (ほぼ起きない)
    price = meta.regularMarketPreviousClose ?? meta.regularMarketPrice ?? null;
    priceTs = meta.regularMarketTime ?? null;
    priceSource = "meta.regularMarketPrice (fallback)";
    previousClose = null;  // chartPreviousClose は絶対使わない
    prevSource = "unavailable";
  }

  if (price == null) throw new Error(`Yahoo Finance: 終値データなし (${symbol})`);

  const change = (price != null && previousClose != null) ? price - previousClose : null;
  const changePercent = (change != null && previousClose) ? (change / previousClose) * 100 : null;

  // Spark — 確定済み直近 14 日
  const spark = settledPairs.slice(-14).map(p => p.c);

  // 出来高 — 確定済み日のみ
  const settledVolumes = settledPairs.map(p => p.v).filter(v => v != null && v > 0);
  const lastVolume = settledVolumes.length > 0 ? settledVolumes[settledVolumes.length - 1] : null;
  const avgVolume5d = settledVolumes.length >= 5
    ? Math.round(settledVolumes.slice(-5).reduce((a, b) => a + b, 0) / 5)
    : null;

  // Prefer the timestamp of the last close in the spark for "as of"
  const asOfTs = priceTs || (validPairs.length > 0 ? validPairs[validPairs.length - 1].t : null);
  const asOfDate = asOfTs ? toJSTDateString(asOfTs * 1000) : null;
  const asOfIso = asOfTs ? new Date(asOfTs * 1000).toISOString() : null;
  const prevCloseDate = previousCloseTs ? toJSTDateString(previousCloseTs * 1000) : null;

  return {
    symbol,
    name: meta.shortName || meta.longName || null,
    currency: meta.currency || "JPY",
    exchange: meta.exchangeName || meta.fullExchangeName || null,
    market_state: meta.marketState || null,
    price,
    previous_close: previousClose,
    change,
    change_percent: changePercent,
    fifty_two_week_high: meta.fiftyTwoWeekHigh ?? null,
    fifty_two_week_low: meta.fiftyTwoWeekLow ?? null,
    spark,
    volume: lastVolume,
    avg_volume_5d: avgVolume5d,
    timestamp: asOfIso,
    as_of_date: asOfDate,
    previous_close_date: prevCloseDate,
    _price_source: priceSource,
    _prev_source: prevSource,
  };
}

/** Convert UNIX ms to Asia/Tokyo YYYY-MM-DD */
function toJSTDateString(ms) {
  const d = new Date(ms);
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
}

/** Format the as_of label for display: e.g. "2026-04-30 (前営業日終値)" or "ザラ場中" */
export function formatAsOfLabel(quote) {
  if (!quote) return "";
  const state = quote.market_state || "";
  if (state === "REGULAR") return `${quote.as_of_date} (ザラ場)`;
  return `${quote.as_of_date} (前営業日終値)`;
}

/** Format change for human display, e.g. "+1.23%" or "-0.45%" */
export function formatChangePercent(quote) {
  if (!quote || quote.change_percent == null) return null;
  const sign = quote.change_percent > 0 ? "+" : "";
  return `${sign}${quote.change_percent.toFixed(2)}%`;
}

/** Format absolute change in yen: "+12円" / "-8円" */
export function formatChangeAmount(quote) {
  if (!quote || quote.change == null) return null;
  const sign = quote.change > 0 ? "+" : "";
  return `${sign}${Math.round(quote.change)}円`;
}

/**
 * Compute market cap from EDINET shares × Yahoo price.
 * Returns formatted string like "237.5 億円" or "1.5 兆円".
 */
export function computeMarketCap(sharesIssued, priceYen) {
  if (!Number.isFinite(sharesIssued) || !Number.isFinite(priceYen)) return null;
  const yen = sharesIssued * priceYen;
  if (yen >= 1e12) return `${(yen / 1e12).toLocaleString("ja-JP", {maximumFractionDigits: 2})} 兆円`;
  if (yen >= 1e8)  return `${(yen / 1e8).toLocaleString("ja-JP", {maximumFractionDigits: 0})} 億円`;
  if (yen >= 1e4)  return `${(yen / 1e4).toLocaleString("ja-JP", {maximumFractionDigits: 0})} 万円`;
  return `${Math.round(yen).toLocaleString("ja-JP")} 円`;
}

/**
 * Compute trailing PER from EDINET net profit (in 百万円) + EDINET shares + Yahoo price.
 * Returns "27.9x" or "赤字" or null.
 */
export function computePER(netProfitMillionYen, sharesIssued, priceYen) {
  if (!Number.isFinite(netProfitMillionYen) || !Number.isFinite(sharesIssued) || !Number.isFinite(priceYen)) return null;
  if (sharesIssued <= 0) return null;
  if (netProfitMillionYen <= 0) return "赤字";
  const epsYen = (netProfitMillionYen * 1_000_000) / sharesIssued;
  if (epsYen <= 0) return "赤字";
  const per = priceYen / epsYen;
  if (!Number.isFinite(per)) return null;
  return `${per.toFixed(1)}x`;
}

/** Format volume into M / K display */
export function formatVolume(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString("ja-JP", {maximumFractionDigits: 1})}M 株`;
  if (v >= 1e4) return `${(v / 1e3).toLocaleString("ja-JP", {maximumFractionDigits: 0})}K 株`;
  return `${v.toLocaleString("ja-JP")} 株`;
}
