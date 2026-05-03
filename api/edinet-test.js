// api/edinet-test.js — Diagnostic endpoint to verify EDINET API key works
// Usage: GET /api/edinet-test?code=2492
//        GET /api/edinet-test?code=2492&debug=1   ← shows raw element IDs

import { findDocsForCode, getFinancialsByCode, downloadDocumentCSV, extractFinancials } from "../lib/edinet.js";

export default async function handler(req, res) {
  const code = String(req.query?.code || "2492").trim();

  if (!/^\d{4,5}$/.test(code)) {
    return res.status(400).json({ error: "invalid_code", message: "code must be 4-5 digits" });
  }

  const apiKey = process.env.EDINET_API_KEY;
  const result = {
    code,
    timestamp: new Date().toISOString(),
    env_check: {
      EDINET_API_KEY_set: !!apiKey,
      EDINET_API_KEY_length: apiKey ? apiKey.length : 0,
      EDINET_API_KEY_starts_with: apiKey ? apiKey.slice(0, 4) + "..." : null
    }
  };

  if (!apiKey) {
    result.error = "EDINET_API_KEY が Vercel 環境変数に設定されていません";
    result.fix = "Vercel → Project → Settings → Environment Variables で EDINET_API_KEY を追加し、Deployments で Redeploy してください";
    return res.status(500).json(result);
  }

  if (apiKey.length < 16) {
    result.error = `EDINET_API_KEY が短すぎます (${apiKey.length} 文字)。正しい Subscription-Key は 32 文字程度です`;
    result.fix = "EDINET の API キー発行画面でキーを再確認してください";
    return res.status(500).json(result);
  }

  // Test 1: Can we call the API at all? (Try fetching today's document list)
  const today = new Date().toISOString().slice(0, 10);
  result.test_1_api_reachable = "checking...";
  try {
    const url = `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=${today}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url);
    result.test_1_api_reachable = {
      status: r.status,
      ok: r.ok
    };
    if (!r.ok) {
      const text = await r.text().catch(() => "(no body)");
      result.test_1_api_reachable.body_preview = text.slice(0, 200);
      if (r.status === 401) {
        result.error = "EDINET API キーが無効です (HTTP 401)";
        result.fix = "1) Vercel の EDINET_API_KEY が正しいか確認  2) EDINET でキーを再発行して Vercel に設定し直す  3) Redeploy する";
        return res.status(401).json(result);
      }
      if (r.status === 403) {
        result.error = "EDINET API アクセスが拒否されました (HTTP 403)";
        result.fix = "API キーの利用規約違反による停止の可能性。EDINET ヘルプデスクに問合せ";
        return res.status(403).json(result);
      }
      result.error = `EDINET API HTTP ${r.status}`;
      return res.status(502).json(result);
    }
    const json = await r.json();
    result.test_1_api_reachable.docs_today = json.results?.length || 0;
  } catch (e) {
    result.test_1_api_reachable = { error: e.message };
    result.error = `EDINET API への HTTP リクエスト失敗: ${e.message}`;
    return res.status(502).json(result);
  }

  // Test 2: Can we find the company's documents?
  result.test_2_find_docs = "checking...";
  try {
    const t0 = Date.now();
    const docs = await findDocsForCode(apiKey, code, {
      typeCodes: [120, 140, 160],
      recentDailyDays: 90,
      fallbackMonths: 18
    });
    result.test_2_find_docs = {
      elapsed_ms: Date.now() - t0,
      total_found: docs.length,
      docs_summary: docs.slice(0, 5).map(d => ({
        docID: d.docID,
        type: d.docTypeCode,
        description: d.docDescription,
        submitDateTime: d.submitDateTime,
        secCode: d.secCode,
        edinetCode: d.edinetCode,
        periodEnd: d.periodEnd
      }))
    };
    if (docs.length === 0) {
      result.warning = `証券コード ${code} の書類が見つかりませんでした。新規上場銘柄か、決算期がずれている可能性があります`;
      return res.status(200).json(result);
    }
  } catch (e) {
    result.test_2_find_docs = { error: e.message };
    result.error = `findDocsForCode でエラー: ${e.message}`;
    return res.status(502).json(result);
  }

  // Test 3: Full financial extraction
  result.test_3_extract_financials = "checking...";
  try {
    const t0 = Date.now();
    const fin = await getFinancialsByCode(apiKey, code);
    result.test_3_extract_financials = {
      elapsed_ms: Date.now() - t0,
      data_basis: fin.data_basis,
      doc_used: fin.edinet_meta,
      years_extracted: fin.financials_annual.length,
      sample_year: fin.financials_annual[fin.financials_annual.length - 1]
    };
    result.success = true;
    return res.status(200).json(result);
  } catch (e) {
    result.test_3_extract_financials = { error: e.message };

    // Deep diagnostic — re-download the CSV and capture what elements were found
    if (req.query?.debug === "1" || req.query?.debug === "true") {
      try {
        const docs = result.test_2_find_docs?.docs_summary || [];
        const yuhoDoc = docs.find(d => d.type === 120) || docs[0];
        if (yuhoDoc) {
          const csvResult = await downloadDocumentCSV(apiKey, yuhoDoc.docID);
          const ext = extractFinancials(csvResult.rows, { preferConsolidated: true });
          result.test_3_extract_financials.deep_diagnostic = {
            csv_file_picked: csvResult.csvFileName,
            csv_count_in_zip: csvResult.csvCount,
            csv_files_available: csvResult.csvFiles,
            encoding_detected: csvResult.encoding,
            row_count: csvResult.rowCount,
            headers: csvResult.headers,
            sample_row: csvResult.sampleRow,
            extraction: ext.diagnostic,
            byYear: ext.byYear,
          };
        }
      } catch (debugErr) {
        result.test_3_extract_financials.deep_diagnostic_error = debugErr.message;
      }
    } else {
      result.test_3_extract_financials.tip = "Add ?debug=1 to URL to see raw XBRL elements found in the document";
    }

    result.error = `getFinancialsByCode でエラー: ${e.message}`;
    return res.status(502).json(result);
  }
}
