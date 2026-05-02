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
  const timestamps = result.timestamp || [];

  // Use regularMarketPrice as the latest "close" (yesterday or last trading day)
  // If unavailable, fall back to last non-null close from the array
  let price = meta.regularMarketPrice;
  let priceTs = meta.regularMarketTime;
  if (price == null) {
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        price = closes[i];
        priceTs = timestamps[i];
        break;
      }
    }
  }

  // Previous close: priority chartPreviousClose > regularMarketPreviousClose >
  // (calc from second-to-last close in array)
  let previousClose = meta.chartPreviousClose ?? meta.regularMarketPreviousClose;
  if (previousClose == null) {
    const validCloses = closes.filter(c => c != null);
    if (validCloses.length >= 2) previousClose = validCloses[validCloses.length - 2];
  }

  if (price == null) throw new Error(`Yahoo Finance: 終値データなし (${symbol})`);

  const change = (price != null && previousClose != null) ? price - previousClose : null;
  const changePercent = (change != null && previousClose) ? (change / previousClose) * 100 : null;

  // Build a spark line of last ~14 trading days
  const validPairs = closes.map((c, i) => ({ c, t: timestamps[i] }))
    .filter(p => p.c != null && p.t != null);
  const spark = validPairs.slice(-14).map(p => p.c);

  // Prefer the timestamp of the last close in the spark for "as of"
  const asOfTs = priceTs || (validPairs.length > 0 ? validPairs[validPairs.length - 1].t : null);
  const asOfDate = asOfTs ? toJSTDateString(asOfTs * 1000) : null;
  const asOfIso = asOfTs ? new Date(asOfTs * 1000).toISOString() : null;

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
    timestamp: asOfIso,
    as_of_date: asOfDate,
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
