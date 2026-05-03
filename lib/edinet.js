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

/**
 * Parse EDINET-style TSV/CSV.
 * EDINET exports cells wrapped in double quotes, tab-separated:
 *   "要素ID"\t"項目名"\t"値"
 *   "jpcrp_cor:NetSales"\t"売上高"\t"15630000000"
 *
 * Handles:
 * - Cells wrapped in `"..."` (strips outer quotes)
 * - Doubled-quote escape (`""` inside a cell → `"`)
 * - Embedded delimiters inside quoted cells
 * - Auto-detects tab vs comma delimiter (EDINET is usually tab,
 *   but newer formats may differ)
 * - Strips UTF BOM remnants
 */
function parseTSV(text) {
  // Strip leading BOM if any survived decoding
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Auto-detect delimiter from header line
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delim = tabCount >= commaCount ? "\t" : ",";

  const parseLine = (line) => parseDelimitedLine(line, delim);

  const headers = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] != null ? cells[i] : "";
    });
    return row;
  });
}

/**
 * Parse a single delimited line with proper quote handling.
 * State machine: handles `"a,b"` as one field, `""` inside quotes as a literal `"`.
 */
function parseDelimitedLine(line, delim) {
  const cells = [];
  let cur = "";
  let inQuote = false;
  let i = 0;
  const len = line.length;

  while (i < len) {
    const c = line[i];

    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; i += 2; continue;  // Escaped quote
        }
        inQuote = false; i++; continue;  // End of quoted section
      }
      cur += c; i++;
    } else {
      if (c === '"' && cur === "") {
        inQuote = true; i++; continue;  // Start of quoted cell
      }
      if (c === delim) {
        cells.push(cur); cur = ""; i++; continue;
      }
      cur += c; i++;
    }
  }
  cells.push(cur);
  return cells.map(s => s.trim());
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
   Company info extraction from CSV
   ───────────────────────────────────────────────────────── */

/**
 * Extract authoritative company facts from XBRL CSV.
 * Returns: {
 *   name_jp, name_en, business_description, head_office,
 *   employees, capital_stock, fiscal_year_end, founded_date,
 *   shares_issued, settlement_date,
 * }
 * All fields are nullable (some companies omit certain disclosures).
 */
export function extractCompanyInfo(rows) {
  const info = {
    name_jp: null,
    name_en: null,
    business_description: null,
    head_office: null,
    employees: null,
    capital_stock: null,           // 単位: 円
    fiscal_year_end: null,         // 例: "12月31日"
    founded_date: null,
    shares_issued: null,           // 株数
    settlement_date: null,         // 決算日
    audit_firm: null,              // 監査法人名
    representative: null,          // 代表者名
    phone: null,                   // 電話番号 (本店)
    stock_exchange: null,          // 上場取引所 (有報内に記載されることがある)
    securities_code: null,         // 証券コード
  };

  // Lenient column accessor (same as extractFinancials)
  const getCol = (row, ...candidates) => {
    for (const c of candidates) {
      if (row[c] != null && row[c] !== "") return String(row[c]);
    }
    const keys = Object.keys(row);
    for (const c of candidates) {
      const target = c.toLowerCase().replace(/\s+/g, "");
      const found = keys.find(k => k.toLowerCase().replace(/\s+/g, "") === target);
      if (found && row[found]) return String(row[found]);
    }
    return "";
  };

  // Element ID local name → field name mapping.
  // Match by suffix (case-insensitive) so namespace variants are tolerated.
  const PATTERNS = [
    [/FilerNameInJapaneseDEI$/i,                     "name_jp"],
    [/FilerNameInEnglishDEI$/i,                      "name_en"],
    [/CompanyNameCoverPage$/i,                       "name_jp"],   // fallback
    [/CompanyNameInEnglishCoverPage$/i,              "name_en"],   // fallback
    [/EntityRegistrantNameDEI$/i,                    "name_jp"],   // 2nd fallback
    [/DescriptionOfBusinessTextBlock$/i,             "business_description"],
    [/AddressOfRegisteredHeadquarter[Ss]?CoverPage$/i, "head_office"],
    [/AddressOfRegisteredHeadquarter[Ss]?$/i,        "head_office"],
    [/HeadOfficeAddress/i,                           "head_office"],
    [/NumberOfEmployees$/i,                          "employees"],
    [/CapitalStockSummaryOfBusinessResults$/i,       "capital_stock"],
    [/CapitalStockCoverPage$/i,                      "capital_stock"],
    [/CurrentFiscalYearEndDateDEI$/i,                "fiscal_year_end"],
    [/FiscalYearEnd$/i,                              "fiscal_year_end"],
    [/DateOfIncorporationCoverPage$/i,               "founded_date"],
    [/TotalNumberOfIssuedSharesSummaryOfBusinessResults$/i, "shares_issued"],
    [/TotalNumberOfIssuedShares/i,                   "shares_issued"],
    [/NameOfAuditFirmInJapan(CoverPage)?$/i,         "audit_firm"],
    [/NameOfAuditor[A-Za-z]*$/i,                     "audit_firm"],
    [/TitleAndNameOfRepresentativeCoverPage$/i,      "representative"],
    [/NameOfRepresentativeCoverPage$/i,              "representative"],
    [/TelephoneNumberAddress[A-Za-z]*CoverPage$/i,   "phone"],
    [/PhoneNumberCoverPage$/i,                       "phone"],
    [/SecurityCodeDEI$/i,                            "securities_code"],
  ];

  for (const row of rows) {
    const elementId = getCol(row, "要素ID", "要素 ID", "element ID");
    const value = getCol(row, "値", "value");
    const contextId = getCol(row, "コンテキストID", "コンテキスト ID", "context ID");
    const consolidatedFlag = getCol(row, "連結・個別", "連結個別");

    if (!elementId || !value) continue;

    // Most company-info fields use FilingDateInstant or CurrentYearInstant context
    // Skip prior-period values explicitly
    if (contextId && /^Prior\d/i.test(contextId)) continue;

    // For company facts, prefer 連結 or NonConsolidatedMember = false (parent-level)
    // Skip if explicitly individual-segment data
    if (consolidatedFlag === "個別" && info.name_jp != null) continue;

    const local = elementId.includes(":") ? elementId.split(":")[1] : elementId;

    for (const [pattern, field] of PATTERNS) {
      if (pattern.test(local)) {
        if (info[field] == null) {
          // Strip XBRL HTML wrapping in text blocks
          let v = value;
          if (field === "business_description") {
            v = stripXbrlHtml(v).slice(0, 800);
          }
          info[field] = v;
        }
        break;
      }
    }
  }

  // Numeric coercion for fields that should be numbers
  if (info.employees != null) {
    const n = Number(String(info.employees).replace(/[,,\s]/g, ""));
    if (Number.isFinite(n)) info.employees = n;
  }
  if (info.capital_stock != null) {
    const n = Number(String(info.capital_stock).replace(/[,,\s]/g, ""));
    if (Number.isFinite(n)) info.capital_stock = n;
  }
  if (info.shares_issued != null) {
    const n = Number(String(info.shares_issued).replace(/[,,\s]/g, ""));
    if (Number.isFinite(n)) info.shares_issued = n;
  }

  // Build a concise business summary from the long XBRL text block
  if (info.business_description) {
    info.business_summary = summarizeBusinessText(info.business_description, 220);
  }

  return info;
}

/**
 * Summarize a long EDINET business description into a concise blurb.
 * - Keeps the first sentence(s) up to maxLen chars
 * - Cuts at "。" boundary when possible to preserve readability
 */
function summarizeBusinessText(text, maxLen = 220) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;

  if (s.length <= maxLen) return s;

  // Find the last "。" before maxLen — preserve full sentences when possible
  const lastPeriod = s.lastIndexOf("。", maxLen);
  if (lastPeriod > maxLen / 2) {
    return s.slice(0, lastPeriod + 1);
  }
  // Fall back to char limit + ellipsis
  return s.slice(0, maxLen) + "…";
}

/** Strip XBRL HTML markup from text-block values (best-effort) */
function stripXbrlHtml(html) {
  return String(html)
    .replace(/<[^>]+>/g, " ")          // strip tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x?\d+;/g, "")          // numeric entities
    .replace(/\s+/g, " ")
    .trim();
}

/* ─────────────────────────────────────────────────────────
   Format helpers for listing rows display
   ───────────────────────────────────────────────────────── */

/** Format ISO date string ("2024-03-31" or "2024年3月31日") to Japanese display */
export function formatJapaneseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // ISO format YYYY-MM-DD
  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]} 年 ${Number(iso[2])} 月 ${Number(iso[3])} 日`;
  }
  // Already Japanese formatted
  return str;
}

/** Format fiscal year end date to "○月期" display */
export function formatFiscalYearEnd(s) {
  if (!s) return null;
  const str = String(s).trim();
  const iso = str.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const m = Number(iso[1]);
    return `${m} 月期`;
  }
  // Pattern "12月31日"
  const jp = str.match(/(\d{1,2})月(\d{1,2})日/);
  if (jp) return `${Number(jp[1])} 月期`;
  return str;
}

/** Format capital stock (yen) to readable display */
export function formatCapital(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (num >= 1e12) return `${(num / 1e12).toLocaleString("ja-JP", {maximumFractionDigits: 2})} 兆円`;
  if (num >= 1e8)  return `${(num / 1e8).toLocaleString("ja-JP", {maximumFractionDigits: 1})} 億円`;
  if (num >= 1e6)  return `${(num / 1e6).toLocaleString("ja-JP", {maximumFractionDigits: 0})} 百万円`;
  return `${num.toLocaleString("ja-JP")} 円`;
}

/** Format shares issued to readable display */
export function formatSharesIssued(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (num >= 1e8) return `${(num / 1e8).toLocaleString("ja-JP", {maximumFractionDigits: 2})} 億株`;
  if (num >= 1e4) return `${(num / 1e4).toLocaleString("ja-JP", {maximumFractionDigits: 1})} 万株`;
  return `${num.toLocaleString("ja-JP")} 株`;
}

/** Format employee count */
export function formatEmployees(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return `${num.toLocaleString("ja-JP")} 名`;
}

/**
 * Build §01 Listing Profile rows from EDINET company info.
 * Returns 6 fields (per user spec): 決算期, 資本金, 発行済株式数, 従業員数, 代表者, 本店所在地
 * All rows tagged _src=edinet for visual marker.
 */
export function buildEdinetListingRows(info) {
  if (!info) return [];
  const rows = [];

  if (info.fiscal_year_end) {
    rows.push({
      key: "決算期",
      val: formatFiscalYearEnd(info.fiscal_year_end),
      small: formatJapaneseDate(info.fiscal_year_end),
      extra: "EDINET",
      _src: "edinet",
    });
  }

  if (info.capital_stock) {
    rows.push({
      key: "資本金",
      val: formatCapital(info.capital_stock),
      extra: "EDINET",
      _src: "edinet",
    });
  }

  if (info.shares_issued) {
    rows.push({
      key: "発行済株式数",
      val: formatSharesIssued(info.shares_issued),
      extra: "EDINET",
      _src: "edinet",
    });
  }

  if (info.employees) {
    rows.push({
      key: "従業員数",
      val: formatEmployees(info.employees),
      extra: "EDINET",
      _src: "edinet",
    });
  }

  if (info.representative) {
    let rep = String(info.representative).trim();
    if (rep.length > 30) rep = rep.slice(0, 28) + "…";
    rows.push({
      key: "代表者",
      val: rep,
      extra: "EDINET",
      _src: "edinet",
    });
  }

  if (info.head_office) {
    let addr = String(info.head_office).trim();
    if (addr.length > 50) addr = addr.slice(0, 48) + "…";
    rows.push({
      key: "本店所在地",
      val: addr,
      extra: "EDINET",
      _src: "edinet",
    });
  }

  return rows;
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

  // Extract authoritative company info from same XBRL CSV
  const companyInfo = extractCompanyInfo(rows);
  // Use docs metadata's filerName as fallback for name_jp (it's always present)
  if (!companyInfo.name_jp && latestDoc.filerName) companyInfo.name_jp = latestDoc.filerName;
  console.log(`[EDINET] company: ${companyInfo.name_jp || "(name not extracted)"}`);

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
    company_info: companyInfo,
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
