// lib/edinet.js — EDINET API v2 client + CSV/XBRL parser
// API docs: https://disclosure2.edinet-fsa.go.jp/weee0010.aspx

import AdmZip from "adm-zip";

const EDINET_BASE = "https://api.edinet-fsa.go.jp/api/v2";

/* ─────────────────────────────────────────────────────────
   API endpoints
   ───────────────────────────────────────────────────────── */

/**
 * GET /documents.json — list all documents filed on a date
 * Returns: array of document metadata objects
 */
export async function listDocsForDate(apiKey, dateStr) {
  const url = `${EDINET_BASE}/documents.json?date=${dateStr}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`EDINET listDocs ${dateStr}: HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.results || [];
}

/**
 * GET /documents/{docID}?type=5 — download document as CSV (zipped)
 * Returns: { rows, csvFileName, csvCount, sampleRow, headers, encoding }
 * (rows is the parsed CSV; rest is diagnostic info)
 */
export async function downloadDocumentCSV(apiKey, docID) {
  const url = `${EDINET_BASE}/documents/${docID}?type=5&Subscription-Key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EDINET download ${docID}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  let zip;
  try {
    zip = new AdmZip(buf);
  } catch (e) {
    throw new Error(`Invalid ZIP from EDINET: ${e.message}`);
  }

  const entries = zip.getEntries();
  const csvEntries = entries.filter(e => e.entryName.toLowerCase().endsWith(".csv"));
  if (csvEntries.length === 0) {
    throw new Error("No CSV files in EDINET ZIP");
  }

  // Pick the best CSV — prefer 有報 main file (jpcrp030000-asr-* in the path)
  // Falls back to any jpcrp_cor or jpcrp* file, then the largest CSV
  const pickPriority = (entry) => {
    const name = entry.entryName.toLowerCase();
    if (name.includes("jpcrp030000-asr") || name.includes("asr-001")) return 100; // 有報 main
    if (name.includes("jpcrp030000-q")) return 50;                                  // 四半期
    if (name.includes("jpcrp_cor")) return 40;
    if (name.includes("jpcrp")) return 30;
    if (name.includes("jpsps")) return 20;
    return 0;
  };
  const sorted = [...csvEntries].sort((a, b) => pickPriority(b) - pickPriority(a));
  const mainCsv = sorted[0];

  const data = mainCsv.getData();
  const decoded = decodeEdinetText(data);
  const rows = parseTSV(decoded.text);

  return {
    rows,
    csvFileName: mainCsv.entryName,
    csvCount: csvEntries.length,
    csvFiles: csvEntries.map(e => e.entryName),
    sampleRow: rows[0] || null,
    headers: rows[0] ? Object.keys(rows[0]) : [],
    encoding: decoded.encoding,
    rowCount: rows.length,
  };
}

/* ─────────────────────────────────────────────────────────
   Encoding / parsing helpers
   ───────────────────────────────────────────────────────── */

function decodeEdinetText(buf) {
  // EDINET CSVs are UTF-16 LE with BOM (FF FE) most commonly
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString("utf16le"), encoding: "utf-16le-bom" };
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf-8-bom" };
  }
  // Heuristic: if many bytes are 0x00, it's likely UTF-16 without BOM
  const sample = buf.slice(0, Math.min(buf.length, 200));
  let zeroBytes = 0;
  for (const b of sample) if (b === 0x00) zeroBytes++;
  if (zeroBytes > sample.length * 0.3) {
    // Probably UTF-16 LE without BOM
    return { text: buf.toString("utf16le"), encoding: "utf-16le-noBOM" };
  }
  // Default to UTF-8
  return { text: buf.toString("utf8"), encoding: "utf-8" };
}

function parseTSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t");
  return lines
    .slice(1)
    .filter(line => line.trim().length > 0)
    .map(line => {
      const cells = line.split("\t");
      const row = {};
      headers.forEach((h, i) => {
        row[h.trim()] = (cells[i] || "").trim();
      });
      return row;
    });
}

/* ─────────────────────────────────────────────────────────
   Document discovery
   ───────────────────────────────────────────────────────── */

/**
 * Find documents for a securities code by scanning recent dates.
 * EDINET stores secCode as 5-digit (4-digit code + check digit '0').
 *
 * Strategy: scan EVERY day for the past 90 days (catches latest filing reliably),
 * then days 18-31 of older months (annual report filing windows) as fallback.
 * Early-terminates as soon as a match is found in a batch.
 *
 * Returns matching docs sorted newest first.
 */
export async function findDocsForCode(apiKey, code, options = {}) {
  const {
    typeCodes = [120, 140, 160], // 120=有報, 140=四半期, 160=半期
    recentDailyDays = 90,         // scan every day for last N days
    fallbackMonths = 18           // for older months, scan day 18-end of month
  } = options;

  // EDINET secCode is "<4-digit>0" format (e.g., "24920" for 2492)
  const codePrefix = String(code).padStart(4, "0");

  // Build dates list: newest → oldest
  const dates = generateComprehensiveDates(recentDailyDays, fallbackMonths);

  const allDocs = [];
  const batchSize = 10;
  let totalApiCalls = 0;
  let httpErrors = 0;
  let lastHttpError = null;

  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(date =>
        listDocsForDate(apiKey, date).catch(e => {
          httpErrors++;
          lastHttpError = e.message;
          console.warn(`[EDINET] Skip ${date}: ${e.message}`);
          return null; // sentinel for failed call
        })
      )
    );
    totalApiCalls += batch.length;

    let foundInBatch = false;
    for (const docs of results) {
      if (!docs) continue;
      const matching = docs.filter(d => {
        if (!d.secCode) return false;
        if (!d.secCode.startsWith(codePrefix)) return false;
        if (!typeCodes.includes(Number(d.docTypeCode))) return false;
        if (d.withdrawalStatus && d.withdrawalStatus !== "0") return false;
        return true;
      });
      if (matching.length > 0) foundInBatch = true;
      allDocs.push(...matching);
    }

    // Early termination: once a match is found in a batch, stop scanning.
    // The newest match within the batch is the latest filing.
    if (foundInBatch) {
      console.log(`[EDINET] code=${code}: match found after ${totalApiCalls} API calls`);
      break;
    }
  }

  // If 100% of API calls failed (likely auth issue), surface that
  if (allDocs.length === 0 && totalApiCalls > 0 && httpErrors === totalApiCalls) {
    if (lastHttpError && lastHttpError.includes("401")) {
      throw new Error(`EDINET API キーが無効です (HTTP 401)。Vercel の EDINET_API_KEY を確認してください`);
    }
    if (lastHttpError && lastHttpError.includes("403")) {
      throw new Error(`EDINET API アクセスが拒否されました (HTTP 403)。キーが有効か確認してください`);
    }
    throw new Error(`EDINET API への接続に失敗しました: ${lastHttpError || "unknown"}`);
  }

  // De-duplicate by docID, sort newest first
  const seen = new Set();
  const unique = allDocs.filter(d => {
    if (seen.has(d.docID)) return false;
    seen.add(d.docID);
    return true;
  });
  unique.sort((a, b) => (b.submitDateTime || "").localeCompare(a.submitDateTime || ""));
  return unique;
}

/**
 * Generate dates to scan, newest → oldest.
 *  - First: every day for the past N days (typically 90 days)
 *    catches any filing in the recent quarter regardless of which day-of-month
 *  - Second: days 18-end of each older month for older filings
 *    annual reports (有報) cluster in days 20-30 of June (3月期) or March (12月期)
 */
function generateComprehensiveDates(recentDailyDays, fallbackMonths) {
  const dates = [];
  const today = new Date();
  const todayYMD = formatYMD(today);
  const seen = new Set();

  // Phase 1: every day, last N days (newest first)
  for (let i = 0; i < recentDailyDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ymd = formatYMD(d);
    if (ymd > todayYMD) continue; // never scan future dates
    if (!seen.has(ymd)) { seen.add(ymd); dates.push(ymd); }
  }

  // Phase 2: days 18-end of each month, going back monthsFallback months
  // Skip the most recent few months (already covered by phase 1)
  const phase2StartMonth = Math.ceil(recentDailyDays / 30) + 1;
  for (let m = phase2StartMonth; m <= fallbackMonths; m++) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    for (let day = 18; day <= lastDay; day++) {
      const d = new Date(monthDate.getFullYear(), monthDate.getMonth(), day);
      const ymd = formatYMD(d);
      if (ymd > todayYMD) continue;
      if (!seen.has(ymd)) { seen.add(ymd); dates.push(ymd); }
    }
  }

  return dates;
}

function formatYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ─────────────────────────────────────────────────────────
   Financial extraction from CSV
   ───────────────────────────────────────────────────────── */

// Target XBRL element IDs for the 4 standard metrics
// Coverage: JP GAAP + IFRS + 業績推移表 (Summary of Business Results) + Quarterly variants
const TARGET_ELEMENTS = {
  revenue: [
    // 業績推移表 (most reliable for 5-year history)
    "jpcrp_cor:NetSalesSummaryOfBusinessResults",
    "jpcrp_cor:RevenueIFRSSummaryOfBusinessResults",
    "jpcrp_cor:OperatingRevenuesSummaryOfBusinessResults",
    "jpcrp_cor:RevenueAndOtherOperatingRevenueIFRSSummaryOfBusinessResults",
    "jpcrp_cor:NetSalesUSGAAPSummaryOfBusinessResults",
    "jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults",
    "jpcrp_cor:GrossOperatingRevenueSummaryOfBusinessResults",
    "jpcrp_cor:OrdinaryIncomeBKSummaryOfBusinessResults",  // 銀行業
    "jpcrp_cor:GrossPremiumIncomeINSSummaryOfBusinessResults", // 保険業
    // P/L direct
    "jppfs_cor:NetSales",
    "jppfs_cor:OperatingRevenue",
    "jppfs_cor:Revenue",
    "jpigp_cor:RevenueIFRS",
    "jpigp_cor:Revenues"
  ],
  operating_profit: [
    "jpcrp_cor:OperatingIncomeSummaryOfBusinessResults",
    "jpcrp_cor:OperatingProfitLossIFRSSummaryOfBusinessResults",
    "jpcrp_cor:OperatingIncomeUSGAAPSummaryOfBusinessResults",
    "jpcrp_cor:OperatingIncomeLossUSGAAPSummaryOfBusinessResults",
    "jppfs_cor:OperatingIncome",
    "jppfs_cor:OperatingProfit",
    "jpigp_cor:OperatingProfitLossIFRS",
    "jpigp_cor:OperatingIncomeIFRS"
  ],
  ordinary_profit: [
    "jpcrp_cor:OrdinaryIncomeLossSummaryOfBusinessResults",
    "jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults",
    "jppfs_cor:OrdinaryIncome",
    // IFRS doesn't have ordinary income — use pre-tax profit as substitute
    "jpcrp_cor:ProfitLossBeforeTaxIFRSSummaryOfBusinessResults",
    "jpcrp_cor:IncomeLossBeforeIncomeTaxesUSGAAPSummaryOfBusinessResults",
    "jpigp_cor:ProfitLossBeforeTaxIFRS"
  ],
  net_profit: [
    "jpcrp_cor:NetIncomeLossAttributableToOwnersOfParentSummaryOfBusinessResults",
    "jpcrp_cor:ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults",
    "jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults",
    "jpcrp_cor:NetIncomeLossSummaryOfBusinessResults",
    "jpcrp_cor:NetIncomeLossUSGAAPSummaryOfBusinessResults",
    "jpcrp_cor:ProfitLossAttributableToOwnersOfParentUSGAAPSummaryOfBusinessResults",
    "jpcrp_cor:ProfitLossAttributableToOwnersOfParent",
    "jppfs_cor:ProfitLossAttributableToOwnersOfParent",
    "jppfs_cor:ProfitLoss",
    "jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS"
  ]
};

/**
 * Fallback fuzzy matcher: when exact element ID isn't in our list, try
 * matching by suffix pattern. Catches namespace variants and renames.
 * Returns metric name or null.
 */
function fuzzyMatchElement(elementId) {
  // Strip namespace prefix to get the local name
  const local = elementId.includes(":") ? elementId.split(":")[1] : elementId;
  const lower = local.toLowerCase();

  // Revenue patterns (must NOT contain operating/ordinary/net unless prefixed correctly)
  if (/^(netsales|revenue|operatingrevenues?|grossoperatingrevenue|gross[a-z]*revenue|grosspremium)/i.test(local)
      && !lower.includes("expense") && !lower.includes("cost")) {
    return "revenue";
  }

  // Operating profit
  if (/^operating(income|profitloss|profit)/i.test(local) && !lower.includes("revenue")) {
    return "operating_profit";
  }

  // Ordinary income
  if (/^ordinaryincome(loss)?/i.test(local)) {
    return "ordinary_profit";
  }

  // Net profit (parent-attributable preferred)
  if (/profitlossattributabletoownersofparent/i.test(local)) {
    return "net_profit";
  }
  // Pre-tax as ordinary fallback
  if (/^profitlossbeforetax/i.test(local) || /^incomelossbeforeincometax/i.test(local)) {
    return "ordinary_profit";
  }

  return null;
}

/* Match a context ID to a fiscal year offset (current = 0, prior1 = 1, etc.) */
function matchYearOffset(contextId) {
  if (!contextId) return null;
  if (contextId.includes("CurrentYearDuration")) return 0;
  const m = contextId.match(/Prior(\d)YearDuration/);
  if (m) return Number(m[1]);
  return null;
}

/* Determine if context is consolidated (連結) or non-consolidated (単体) */
function isConsolidatedContext(contextId, consolidatedFlag) {
  if (consolidatedFlag === "連結") return true;
  if (consolidatedFlag === "個別" || consolidatedFlag === "単体") return false;
  // Check context ID for "NonConsolidated" hint
  if (contextId.includes("NonConsolidated")) return false;
  return true; // default to consolidated when ambiguous
}

/**
 * Extract 4 standard metrics from parsed CSV rows.
 * Returns: { byYear: {...}, isConsolidated, diagnostic: {...} }
 * yearOffset 0 = current period, 1 = prior1, etc.
 */
export function extractFinancials(rows, options = {}) {
  const { preferConsolidated = true, allowFuzzy = true } = options;

  const byYear = {};
  let elementsScanned = 0;
  let elementsMatchedExact = 0;
  let elementsMatchedFuzzy = 0;
  const seenElementsSummary = {}; // element ID → count (for diagnostic)
  const skippedReasons = { noContext: 0, nonPeriod: 0, nonJpy: 0, nonConsolidated: 0, nonNumeric: 0 };

  // Lenient column accessor — handles whitespace, fullwidth chars, alternate names
  const getCol = (row, ...candidates) => {
    for (const c of candidates) {
      if (row[c] != null && row[c] !== "") return String(row[c]);
    }
    // Fallback: case/whitespace-insensitive search
    const keys = Object.keys(row);
    for (const c of candidates) {
      const target = c.toLowerCase().replace(/\s+/g, "");
      const found = keys.find(k => k.toLowerCase().replace(/\s+/g, "") === target);
      if (found && row[found]) return String(row[found]);
    }
    return "";
  };

  for (const row of rows) {
    const elementId = getCol(row, "要素ID", "要素 ID", "element ID", "Element ID", "elementid");
    const contextId = getCol(row, "コンテキストID", "コンテキスト ID", "context ID", "Context ID");
    const consolidatedFlag = getCol(row, "連結・個別", "連結個別", "consolidated, individual", "consolidated/individual");
    const periodType = getCol(row, "期間・時点", "期間時点", "period, instant", "period/instant");
    const unitId = getCol(row, "ユニットID", "ユニット ID", "unit ID", "Unit ID");
    const valueRaw = getCol(row, "値", "value", "Value");
    // EDINET also has "相対年度" (relative year) column — alternative for context matching
    const relativeYear = getCol(row, "相対年度", "relative year");

    if (!elementId || !valueRaw) continue;

    // Period filter — lenient matching on substring "期間" or "Duration"
    if (periodType && !periodType.includes("期間") && !periodType.toLowerCase().includes("duration")) {
      skippedReasons.nonPeriod++;
      continue;
    }

    // JPY-only filter (allows JPY, JPYPerShares, etc.)
    if (unitId && !unitId.includes("JPY") && !unitId.includes("円")) {
      skippedReasons.nonJpy++;
      continue;
    }

    // Determine year offset — try contextId first, then 相対年度 column
    let yearOffset = matchYearOffset(contextId);
    if (yearOffset === null) yearOffset = matchYearOffsetFromRelativeYear(relativeYear);
    if (yearOffset === null) {
      skippedReasons.noContext++;
      continue;
    }

    const isConsolidated = isConsolidatedContext(contextId, consolidatedFlag);
    if (preferConsolidated && !isConsolidated) {
      skippedReasons.nonConsolidated++;
      continue;
    }

    const numValue = Number(valueRaw);
    if (!Number.isFinite(numValue)) { skippedReasons.nonNumeric++; continue; }
    const valueInMillions = Math.round(numValue / 1_000_000);

    elementsScanned++;
    seenElementsSummary[elementId] = (seenElementsSummary[elementId] || 0) + 1;

    // 1) Exact match against TARGET_ELEMENTS (fast path)
    let matchedMetric = null;
    for (const [metric, ids] of Object.entries(TARGET_ELEMENTS)) {
      if (ids.includes(elementId)) {
        matchedMetric = metric;
        break;
      }
    }

    // 2) Fallback: fuzzy match by suffix pattern
    if (!matchedMetric && allowFuzzy) {
      matchedMetric = fuzzyMatchElement(elementId);
      if (matchedMetric) elementsMatchedFuzzy++;
    } else if (matchedMetric) {
      elementsMatchedExact++;
    }

    if (matchedMetric) {
      if (!byYear[yearOffset]) byYear[yearOffset] = {};
      // Only set if not already set (priority: TARGET_ELEMENTS order > fuzzy)
      if (byYear[yearOffset][matchedMetric] == null) {
        byYear[yearOffset][matchedMetric] = valueInMillions;
      }
    }
  }

  // Fallback: if we got NO data with consolidated preference, retry with individual
  const totalEntries = Object.values(byYear).reduce((sum, y) => sum + Object.keys(y).length, 0);
  if (preferConsolidated && totalEntries === 0) {
    return extractFinancials(rows, { ...options, preferConsolidated: false });
  }

  // Build diagnostic info — useful when extraction fails
  // Top 20 most common element IDs we saw (helps user understand why we couldn't match)
  const topElements = Object.entries(seenElementsSummary)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id, count]) => ({ id, count }));

  return {
    byYear,
    isConsolidated: preferConsolidated && totalEntries > 0,
    diagnostic: {
      rowsTotal: rows.length,
      elementsScanned,
      elementsMatchedExact,
      elementsMatchedFuzzy,
      yearsCovered: Object.keys(byYear).map(Number).sort((a, b) => a - b),
      topElements,
      skippedReasons,
    }
  };
}

/**
 * Match relative year string ("当期", "前期", "前々期", "前期1", etc.) to year offset.
 * Used as fallback when contextId doesn't follow CurrentYearDuration / Prior\dYearDuration pattern.
 */
function matchYearOffsetFromRelativeYear(rel) {
  if (!rel) return null;
  const r = String(rel).trim();
  if (r === "当期" || r === "Current") return 0;
  if (r === "前期" || r === "Prior" || r === "Prior1") return 1;
  if (r === "前々期" || r === "前期1" || r === "Prior2") return 2;
  if (r === "前期2") return 3;
  if (r === "前期3") return 4;
  // Pattern "前期N"
  const m = r.match(/前期(\d+)/);
  if (m) return Number(m[1]);
  // Pattern "PriorN"
  const m2 = r.match(/Prior(\d+)/);
  if (m2) return Number(m2[1]);
  return null;
}

/* ─────────────────────────────────────────────────────────
   High-level entry point
   ───────────────────────────────────────────────────────── */

/**
 * Get financials for a securities code.
 * Returns { financials_annual, edinet_meta } in the same schema used by the rest of the app.
 */
export async function getFinancialsByCode(apiKey, code) {
  if (!apiKey) throw new Error("EDINET_API_KEY が設定されていません");
  if (apiKey.length < 16) throw new Error(`EDINET_API_KEY が短すぎます (${apiKey.length} 文字)。正しいキーか確認してください`);

  // Find recent 有価証券報告書 (annual report)
  const docs = await findDocsForCode(apiKey, code, {
    typeCodes: [120],         // 有報のみ
    recentDailyDays: 90,      // 直近 90 日は毎日スキャン
    fallbackMonths: 18        // それ以前は月末週のみ
  });

  if (docs.length === 0) {
    throw new Error(`証券コード ${code} の有価証券報告書が過去 18 ヶ月以内に見つかりません。新規上場銘柄か、決算期がずれている可能性があります`);
  }

  const latestDoc = docs[0];
  console.log(`[EDINET] code=${code} using doc ${latestDoc.docID} (${latestDoc.docDescription}) submitted ${latestDoc.submitDateTime}`);

  let csvResult;
  try {
    csvResult = await downloadDocumentCSV(apiKey, latestDoc.docID);
  } catch (e) {
    throw new Error(`有報の CSV ダウンロードに失敗 (docID=${latestDoc.docID}): ${e.message}`);
  }

  const { rows, csvFileName, csvCount, encoding, headers, rowCount } = csvResult;
  console.log(`[EDINET] CSV: ${csvFileName} (${rowCount} rows, ${encoding}, ${csvCount} CSVs in ZIP)`);

  const { byYear, isConsolidated, diagnostic } = extractFinancials(rows, { preferConsolidated: true });
  console.log(`[EDINET] extracted ${diagnostic.elementsMatchedExact} exact + ${diagnostic.elementsMatchedFuzzy} fuzzy matches across ${diagnostic.yearsCovered.length} years`);

  if (Object.keys(byYear).length === 0) {
    // Build a richer error message with diagnostic clues
    const topEls = (diagnostic.topElements || []).slice(0, 5).map(e => e.id).join(", ");
    const reasonHints = [];
    if (diagnostic.skippedReasons.noContext > 0) reasonHints.push(`${diagnostic.skippedReasons.noContext} 行が CurrentYear/Prior\\dYear のコンテキスト形式に該当せず`);
    if (diagnostic.skippedReasons.nonPeriod > 0) reasonHints.push(`${diagnostic.skippedReasons.nonPeriod} 行が期間外`);
    if (diagnostic.skippedReasons.nonConsolidated > 0) reasonHints.push(`${diagnostic.skippedReasons.nonConsolidated} 行が単体のみ (連結データなし)`);

    const detail = topEls
      ? `主な要素 ID: ${topEls}${reasonHints.length ? ` / ${reasonHints.join(", ")}` : ""}`
      : `${diagnostic.rowsTotal} 行スキャンしたがマッチなし`;
    throw new Error(`docID=${latestDoc.docID} から財務指標を抽出できません — ${detail} (CSV: ${csvFileName})`);
  }

  // Calculate the actual fiscal year label from the document's period end
  const periodEnd = latestDoc.periodEnd || latestDoc.docPeriodEnd; // YYYY-MM-DD
  const fyEndYear = periodEnd ? Number(periodEnd.slice(0, 4)) : new Date().getFullYear();
  const fyEndMonth = periodEnd ? Number(periodEnd.slice(5, 7)) : 3;
  // Fiscal year label: for March-end → FY24 means fiscal year ending March 2024
  // For December-end → FY24 means fiscal year ending Dec 2024
  const fyLabelFor = (yearOffset) => {
    const yr = (fyEndYear - yearOffset) % 100;
    return `FY${String(yr).padStart(2, "0")}`;
  };

  // Build annual array (chronological: oldest → newest)
  const yearOffsets = Object.keys(byYear).map(Number).sort((a, b) => b - a); // [4, 3, 2, 1, 0]
  const annual = yearOffsets.map(offset => {
    const y = byYear[offset];
    const rev = y.revenue;
    const op = y.operating_profit;
    const ord = y.ordinary_profit;
    const np = y.net_profit;

    return {
      fy: fyLabelFor(offset),
      year_offset: offset,
      revenue: rev ?? null,
      operating_profit: op ?? null,
      ordinary_profit: ord ?? null,
      net_profit: np ?? null,
      op_margin: rev && op != null ? Math.round((op / rev) * 1000) / 10 : null,
      ord_margin: rev && ord != null ? Math.round((ord / rev) * 1000) / 10 : null,
      net_margin: rev && np != null ? Math.round((np / rev) * 1000) / 10 : null
    };
  });

  // Calculate YoY changes
  for (let i = 1; i < annual.length; i++) {
    const cur = annual[i];
    const prev = annual[i - 1];
    const pct = (a, b) => (a != null && b != null && b !== 0) ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null;
    cur.rev_yoy = pct(cur.revenue, prev.revenue);
    cur.op_yoy = pct(cur.operating_profit, prev.operating_profit);
    cur.ord_yoy = pct(cur.ordinary_profit, prev.ordinary_profit);
    cur.np_yoy = pct(cur.net_profit, prev.net_profit);
  }
  // First year has null YoY
  if (annual.length > 0) {
    annual[0].rev_yoy = null;
    annual[0].op_yoy = null;
    annual[0].ord_yoy = null;
    annual[0].np_yoy = null;
  }

  return {
    financials_annual: annual,
    data_basis: isConsolidated ? "連結" : "単体",
    fy_unit: "百万円",
    edinet_meta: {
      docID: latestDoc.docID,
      docDescription: latestDoc.docDescription,
      submitDateTime: latestDoc.submitDateTime,
      edinetCode: latestDoc.edinetCode,
      secCode: latestDoc.secCode,
      periodEnd: periodEnd,
      filerName: latestDoc.filerName
    }
  };
}
