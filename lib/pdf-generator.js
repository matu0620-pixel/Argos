// lib/pdf-generator.js — Generates landscape A4 institutional research PDF
// Theme: matches ARGOS sales deck (navy + gold premium)
// Font: bundled IPAGothic (renamed NotoSansJP.ttf) for Japanese support
// Library: PDFKit (lightweight, Vercel serverless friendly)

import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try multiple font path locations — Vercel sometimes rearranges files
function resolveFontPath() {
  const candidates = [
    path.resolve(__dirname, "fonts/NotoSansJP.ttf"),
    path.resolve(__dirname, "../lib/fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "lib/fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "argos/lib/fonts/NotoSansJP.ttf"),
    "/var/task/lib/fonts/NotoSansJP.ttf",  // Common Vercel function path
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const FONT_PATH = resolveFontPath();
if (!FONT_PATH) {
  console.error("[PDF] Japanese font not found. Tried:", [
    path.resolve(__dirname, "fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "lib/fonts/NotoSansJP.ttf"),
    "/var/task/lib/fonts/NotoSansJP.ttf",
  ]);
}

// Brand palette (matches sales deck and product UI)
const C = {
  bg:       "#02060F",
  bgLight:  "#060B1A",
  surface:  "#0B1124",
  surface2: "#0F1830",
  border:   "#1A2342",
  borderStrong: "#2A3658",
  gold:     "#D4A24E",
  goldDim:  "#1F1A0E",
  goldLine: "#5C4A28",
  cyan:     "#38BDF8",
  gain:     "#34D399",
  loss:     "#FB7185",
  warn:     "#FBBF24",
  text:     "#F1F5F9",
  text2:    "#CBD5E1",
  text3:    "#94A3B8",
  text4:    "#64748B",
};

const PAGE = { w: 842, h: 595 }; // A4 landscape (in points)

/* ─── Helpers ─────────────────────────────────────── */

function safeStr(v, fallback = "—") {
  if (v == null || v === "") return fallback;
  let s = String(v);
  // IPAGothic glyph fallbacks — replace unsupported chars with visually similar supported ones
  s = s.replace(/▸/g, "▶")     // small triangle right → filled triangle right
       .replace(/►/g, "▶")     // black right pointing pointer → filled triangle right
       .replace(/▪/g, "■")     // small black square → black square
       .replace(/[\u2BC8\u2BC7\u29FB\u29FA]/g, "");  // misc unsupported
  return s;
}

function formatNumber(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("ja-JP");
}

function formatYen(n) {
  if (n == null) return "—";
  return `¥${formatNumber(n)}`;
}

function formatPct(n, withSign = true) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = withSign && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function jstDate() {
  const d = new Date();
  const j = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return `${j.getFullYear()}.${String(j.getMonth() + 1).padStart(2, "0")}.${String(j.getDate()).padStart(2, "0")}`;
}

/* ─── Drawing primitives ──────────────────────────── */

function fillBg(doc) {
  doc.save().rect(0, 0, PAGE.w, PAGE.h).fill(C.bg).restore();
}

function drawEyebrow(doc, num, label) {
  doc.save();
  // Gold dot
  doc.circle(34, 30, 3.2).fill(C.gold);
  // Number + label
  doc.font("JP").fontSize(8.5).fillColor(C.gold).text(num, 44, 26.5, { lineBreak: false });
  doc.fillColor(C.text3).text(`  —  ${label}`, 60, 26.5, { lineBreak: false });
  doc.restore();
}

function drawFooter(doc, page, total) {
  doc.save();
  // Bottom rule
  doc.strokeColor(C.borderStrong).lineWidth(0.4).moveTo(34, PAGE.h - 24).lineTo(PAGE.w - 34, PAGE.h - 24).stroke();
  // Left mark
  doc.font("JP").fontSize(7).fillColor(C.text4).text("ARGOS  ·  Institutional Equity Intelligence", 34, PAGE.h - 17);
  // Right pager
  const pageStr = `${String(page).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  doc.fontSize(7).fillColor(C.gold).text(pageStr, PAGE.w - 80, PAGE.h - 17, { width: 46, align: "right" });
  doc.restore();
}

function drawTitle(doc, title, subtitle = null) {
  doc.save();
  doc.font("JP").fontSize(22).fillColor(C.text).text(title, 34, 50, { width: PAGE.w - 68 });
  if (subtitle) {
    doc.fontSize(10).fillColor(C.gold).text(subtitle, 34, 84, { width: PAGE.w - 68 });
  }
  doc.restore();
}

function drawCard(doc, x, y, w, h, opts = {}) {
  doc.save();
  doc.rect(x, y, w, h).fillAndStroke(opts.fill || C.surface, opts.stroke || C.border);
  if (opts.accent) {
    // Left accent bar
    doc.rect(x, y, 3, h).fill(opts.accentColor || C.gold);
  }
  if (opts.topAccent) {
    doc.rect(x, y, w, 1.5).fill(opts.accentColor || C.gold);
  }
  doc.restore();
}

function drawTagChip(doc, x, y, label, opts = {}) {
  const w = opts.width || (label.length * 4.5 + 10);
  const h = 14;
  doc.save();
  doc.rect(x, y, w, h).fillAndStroke(opts.fill || C.surface2, opts.stroke || C.borderStrong);
  doc.font("JP").fontSize(7).fillColor(opts.color || C.text3).text(
    label, x, y + 3.5, { width: w, align: "center", lineBreak: false }
  );
  doc.restore();
  return x + w + 4;
}

function drawTextBlock(doc, x, y, w, text, opts = {}) {
  if (!text) return y;
  doc.save();
  doc.font("JP")
    .fontSize(opts.size || 10)
    .fillColor(opts.color || C.text2)
    .text(safeStr(text), x, y, {
      width: w,
      lineGap: opts.lineGap ?? 2,
      ellipsis: opts.ellipsis,
      height: opts.maxHeight,
    });
  const newY = doc.y;
  doc.restore();
  return newY;
}

function drawDivider(doc, x1, y, x2, color = C.border) {
  doc.save();
  doc.strokeColor(color).lineWidth(0.4).moveTo(x1, y).lineTo(x2, y).stroke();
  doc.restore();
}

/* ─── Pages ───────────────────────────────────────── */

const TOTAL_PAGES = 10;

function pageCover(doc, d) {
  fillBg(doc);

  // Top brand bar
  doc.save();
  doc.circle(48, 48, 7).fillAndStroke(C.bg, C.gold).lineWidth(1);
  doc.circle(48, 48, 3.2).fill(C.gold);
  doc.circle(48, 48, 1.2).fill(C.bg);
  doc.font("JP").fontSize(10).fillColor(C.gold).text("ARGOS", 65, 43, { lineBreak: false });
  doc.fontSize(6.5).fillColor(C.text4).text("MMXXVI · INSTITUTIONAL EDITION", 65, 56, { lineBreak: false });
  doc.fontSize(7).fillColor(C.gold).text("EQUITY BRIEF", PAGE.w - 90, 43, { width: 56, align: "right", lineBreak: false });
  doc.fontSize(6.5).fillColor(C.text4).text("VOL. I", PAGE.w - 90, 56, { width: 56, align: "right", lineBreak: false });
  doc.restore();

  // Center content
  const code = safeStr(d.code, "----");
  const nameJp = d.company?.name_jp || "";
  const nameEn = d.company?.name_en || "";

  // Big code
  doc.save();
  doc.font("JP").fontSize(14).fillColor(C.gold).text("STOCK CODE", 0, 130, { width: PAGE.w, align: "center", characterSpacing: 4 });
  doc.fontSize(72).fillColor(C.text).text(code, 0, 150, { width: PAGE.w, align: "center" });
  doc.restore();

  // Name
  if (nameJp) {
    doc.font("JP").fontSize(22).fillColor(C.text).text(nameJp, 60, 250, { width: PAGE.w - 120, align: "center" });
  }
  if (nameEn) {
    doc.font("JP").fontSize(11).fillColor(C.cyan).text(nameEn, 60, 285, { width: PAGE.w - 120, align: "center" });
  }

  // Gold horizontal rule
  const ruleY = 320;
  doc.save();
  doc.strokeColor(C.gold).lineWidth(0.6).moveTo(PAGE.w / 2 - 60, ruleY).lineTo(PAGE.w / 2 + 60, ruleY).stroke();
  doc.restore();

  // Tag chips row (centered)
  const segMap = { prime: "TSE PRIME", standard: "TSE STANDARD", growth: "TSE GROWTH", other: "TSE OTHER" };
  const chipText = [
    segMap[d._market_segment] || (d._market_segment ? `TSE ${d._market_segment.toUpperCase()}` : null),
    d.industry_key || null,
  ].filter(Boolean);

  if (chipText.length > 0) {
    let cx = (PAGE.w - chipText.length * 100) / 2;
    chipText.forEach(t => {
      cx = drawTagChip(doc, cx, ruleY + 22, t, {
        width: 95, fill: C.surface, stroke: C.gold, color: C.gold,
      });
    });
  }

  // Price
  const price = d.price?.value;
  const changePct = d.price?.change_percent;
  if (price != null) {
    doc.save();
    doc.font("JP").fontSize(36).fillColor(C.text).text(formatYen(Math.round(price)), 0, 380, { width: PAGE.w, align: "center" });
    if (changePct != null) {
      const c = changePct >= 0 ? C.gain : C.loss;
      const arrow = changePct >= 0 ? "▲" : "▼";
      doc.fontSize(13).fillColor(c).text(`${arrow}  ${formatPct(changePct)}`, 0, 425, { width: PAGE.w, align: "center" });
    }
    doc.restore();
  }

  // Footer
  doc.save();
  doc.strokeColor(C.borderStrong).lineWidth(0.4).moveTo(34, PAGE.h - 30).lineTo(PAGE.w - 34, PAGE.h - 30).stroke();
  doc.font("JP").fontSize(7).fillColor(C.text4).text(`Generated  ${jstDate()}`, 34, PAGE.h - 22);
  doc.fontSize(7).fillColor(C.gold).text(`PAGE  01 / ${TOTAL_PAGES}`, PAGE.w - 100, PAGE.h - 22, { width: 66, align: "right" });
  doc.restore();
}

function pageHero(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "00", "HERO SNAPSHOT");
  drawTitle(doc, "ヒーロー・スナップショット", "Quick reference — listing, price, and key metrics");

  const yStart = 130;

  // Left column: Company info card
  drawCard(doc, 34, yStart, 480, 420, { topAccent: true });

  let y = yStart + 18;
  // Code + tags
  doc.save();
  doc.rect(48, y, 50, 22).fillAndStroke(C.surface2, C.cyan);
  doc.font("JP").fontSize(11).fillColor(C.cyan).text(safeStr(d.code), 48, y + 5, { width: 50, align: "center" });
  doc.restore();

  let cx = 110;
  const segMap = { prime: "TSE PRIME", standard: "TSE STANDARD", growth: "TSE GROWTH" };
  const segLabel = segMap[d._market_segment];
  if (segLabel) {
    cx = drawTagChip(doc, cx, y + 4, segLabel, { width: 78, color: C.gold, fill: C.goldDim, stroke: C.goldLine });
  }
  if (d.industry_key) {
    cx = drawTagChip(doc, cx, y + 4, d.industry_key, { width: 80, color: C.text3 });
  }

  y += 38;
  // Company name (multiline allowed)
  if (d.company?.name_jp) {
    doc.font("JP").fontSize(18).fillColor(C.text).text(d.company.name_jp, 48, y, { width: 450 });
    y = doc.y + 4;
  }
  if (d.company?.name_en) {
    doc.font("JP").fontSize(9).fillColor(C.cyan).text(d.company.name_en, 48, y, { width: 450 });
    y = doc.y + 8;
  }

  // Business blurb
  if (d.company?.blurb) {
    y = drawTextBlock(doc, 48, y, 450, d.company.blurb, {
      size: 9.5, color: C.text2, lineGap: 2, maxHeight: 80, ellipsis: true,
    });
    y += 6;
  }

  // EDINET facts row
  const facts = d.company?._edinet_facts || {};
  const factPairs = [];
  if (facts.employees != null) factPairs.push(["従業員", `${formatNumber(facts.employees)} 名`]);
  if (facts.capital_stock != null) {
    const oku = facts.capital_stock / 1e8;
    const txt = oku >= 100 ? `${Math.round(oku)} 億円` : `${oku.toFixed(1)} 億円`;
    factPairs.push(["資本金", txt]);
  }
  if (facts.shares_issued != null) factPairs.push(["発行株式数", `${formatNumber(Math.round(facts.shares_issued / 1e4))} 万株`]);

  if (factPairs.length > 0) {
    y += 4;
    let fx = 48;
    factPairs.forEach(([k, v]) => {
      const text = `${k}  ${v}`;
      // Wider per-character estimate to handle Japanese (full-width) characters
      const charWidth = 8;
      const w = Math.max(110, text.length * charWidth);
      doc.save();
      doc.rect(fx, y, w, 18).fillAndStroke(C.goldDim, C.goldLine);
      doc.circle(fx + 7, y + 9, 1.6).fill(C.gold);
      doc.font("JP").fontSize(8.5).fillColor(C.gold).text(text, fx + 13, y + 4.5, { width: w - 16, lineBreak: false });
      doc.restore();
      fx += w + 6;
    });
    y += 26;
  }

  // Right column: Price card
  const px = 530, pw = 280;
  drawCard(doc, px, yStart, pw, 200, { fill: C.surface2 });

  let py = yStart + 14;
  doc.font("JP").fontSize(8).fillColor(C.text3).text("株価  —  LAST CLOSE", px + 14, py, { characterSpacing: 1 });
  py += 14;
  doc.fontSize(7).fillColor(C.text4).text(`${d.price?.as_of_date || "—"} · 前営業日終値 (Yahoo)`, px + 14, py);
  py += 18;

  if (d.price?.value != null) {
    doc.font("JP").fontSize(40).fillColor(C.text).text(formatYen(Math.round(d.price.value)), px + 14, py);
    py += 50;
  }

  if (d.price?.change != null && d.price?.change_percent != null) {
    const c = d.price.change >= 0 ? C.gain : C.loss;
    const arrow = d.price.change >= 0 ? "▲" : "▼";
    const sign = d.price.change >= 0 ? "+" : "";
    doc.font("JP").fontSize(12).fillColor(c).text(
      `${arrow}  ${sign}${Math.round(d.price.change)} 円  /  ${formatPct(d.price.change_percent)}`,
      px + 14, py
    );
    py += 22;
  }

  // Sub stats grid (2x2)
  const subY = yStart + 220;
  const subStats = [
    ["時価総額", d.price?.market_cap_jpy ? `${formatNumber(Math.round(d.price.market_cap_jpy / 1e8))} 億円` : "—"],
    ["PER", d.price?.per_calculated ? `${d.price.per_calculated.toFixed(1)}x` : "—"],
    ["52週高値", d.price?.fifty_two_week_high ? formatYen(Math.round(d.price.fifty_two_week_high)) : "—"],
    ["52週安値", d.price?.fifty_two_week_low ? formatYen(Math.round(d.price.fifty_two_week_low)) : "—"],
  ];

  subStats.forEach((s, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const sx = px + col * 140;
    const sy = subY + row * 50;
    doc.save();
    doc.rect(sx, sy, 130, 42).fillAndStroke(C.surface, C.border);
    doc.font("JP").fontSize(7).fillColor(C.text3).text(s[0], sx + 10, sy + 6);
    doc.fontSize(13).fillColor(C.text).text(s[1], sx + 10, sy + 18, { width: 115 });
    doc.restore();
  });

  drawFooter(doc, 2, TOTAL_PAGES);
}

function pageListing(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "01", "LISTING PROFILE");
  drawTitle(doc, "市場・上場プロファイル", "Where it trades — EDINET 6 fields + JPX listing criteria");

  const yStart = 130;

  // Left: 6 EDINET facts table
  const lx = 34, lw = 480;
  drawCard(doc, lx, yStart, lw, 380, { accent: true });
  doc.font("JP").fontSize(9).fillColor(C.gold).text("●  EDINET-AUTHORITATIVE FACTS", lx + 18, yStart + 14, { characterSpacing: 1 });

  const rows = d.listing?.rows || [];
  let ry = yStart + 40;
  rows.slice(0, 6).forEach((r, i) => {
    if (i > 0) drawDivider(doc, lx + 18, ry - 2, lx + lw - 18);
    doc.font("JP").fontSize(9).fillColor(C.gold).text(safeStr(r.k), lx + 18, ry, { width: 130 });
    doc.font("JP").fontSize(11).fillColor(C.text).text(safeStr(r.v), lx + 160, ry - 1, { width: 240 });
    // EDINET badge on the right
    doc.save();
    doc.rect(lx + lw - 70, ry - 2, 56, 14).fillAndStroke(C.goldDim, C.goldLine);
    doc.fontSize(7).fillColor(C.gold).text("●EDINET", lx + lw - 70, ry + 1, { width: 56, align: "center" });
    doc.restore();
    ry += 50;
  });

  // Right: Market criteria card
  const rx = 530, rw = 280;
  drawCard(doc, rx, yStart, rw, 380, { topAccent: true, accentColor: C.gold });

  const mc = d.listing?.market_card;
  let my = yStart + 14;
  if (mc) {
    doc.font("JP").fontSize(8).fillColor(C.gold).text(safeStr(mc.eyebrow), rx + 14, my, { characterSpacing: 1 });
    my += 14;
    doc.fontSize(13).fillColor(C.text).text(safeStr(mc.title), rx + 14, my, { width: rw - 28 });
    my = doc.y + 10;

    if (Array.isArray(mc.criteria)) {
      mc.criteria.slice(0, 6).forEach(crit => {
        doc.circle(rx + 18, my + 4, 1.4).fill(C.gold);
        doc.font("JP").fontSize(8.5).fillColor(C.text2).text(safeStr(crit), rx + 26, my, { width: rw - 40, lineGap: 1 });
        my = doc.y + 4;
      });
    }
  }

  if (d.listing?.aside) {
    my = Math.max(my, yStart + 320);
    drawDivider(doc, rx + 14, my, rx + rw - 14, C.borderStrong);
    drawTextBlock(doc, rx + 14, my + 6, rw - 28, d.listing.aside, {
      size: 8, color: C.text3, lineGap: 1.5, maxHeight: 50,
    });
  }

  drawFooter(doc, 3, TOTAL_PAGES);
}

function pageFinancials(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "02", "FINANCIAL TRAJECTORY");
  drawTitle(doc, "財務トレンド (5 年)", "Quarterly & annual P/L from EDINET XBRL");

  const yStart = 130;
  const fin = d.financials || {};
  const years = fin.years || [];
  const rows = fin.rows || [];

  if (rows.length === 0 || years.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3)
      .text("EDINET 有報データの取得に失敗しました。次回分析時に再試行されます。",
        34, yStart + 180, { width: PAGE.w - 68, align: "center" });
    drawFooter(doc, 4, TOTAL_PAGES);
    return;
  }

  // Card
  const cardW = PAGE.w - 68, cardH = 380;
  drawCard(doc, 34, yStart, cardW, cardH, { accent: true });

  // Header row
  const colW = (cardW - 200) / years.length;
  const ty = yStart + 18;
  doc.font("JP").fontSize(8.5).fillColor(C.gold).text("METRIC", 50, ty, { width: 180, characterSpacing: 1 });
  years.forEach((y, i) => {
    doc.font("JP").fontSize(8.5).fillColor(C.gold).text(safeStr(y), 230 + i * colW, ty, { width: colW - 10, align: "right" });
  });

  drawDivider(doc, 50, ty + 18, 34 + cardW - 16, C.gold);

  // Data rows
  let dy = ty + 28;
  rows.slice(0, 5).forEach((r, idx) => {
    if (idx > 0) drawDivider(doc, 50, dy - 4, 34 + cardW - 16, C.border);
    doc.font("JP").fontSize(10).fillColor(C.text).text(safeStr(r.label), 50, dy, { width: 180 });
    if (r.unit) {
      doc.fontSize(7).fillColor(C.text4).text(`(${r.unit})`, 50, dy + 14, { width: 180 });
    }
    (r.values || []).forEach((v, i) => {
      let txt = "—";
      if (v != null && Number.isFinite(v)) {
        if (Math.abs(v) >= 1e8) txt = `${(v / 1e8).toFixed(1)} 億`;
        else if (Math.abs(v) >= 1e4) txt = `${(v / 1e4).toFixed(0)} 万`;
        else txt = formatNumber(v);
      }
      doc.font("JP").fontSize(11).fillColor(C.text).text(txt, 230 + i * colW, dy + 2, { width: colW - 10, align: "right" });
    });
    dy += 50;
  });

  // Source note
  doc.font("JP").fontSize(7.5).fillColor(C.text4).text(
    "出典: EDINET 有価証券報告書 (XBRL) — NetSales / OperatingIncome / OrdinaryIncome / Profit",
    50, yStart + cardH - 22, { width: cardW - 32 }
  );

  drawFooter(doc, 4, TOTAL_PAGES);
}

function pageCompetitive(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "03", "COMPETITIVE LANDSCAPE");
  drawTitle(doc, "競合・業界比較", "Industry KPIs and peer comparison");

  const yStart = 130;
  const comp = d.competitive_analysis || {};
  const peers = comp.peers || [];

  drawCard(doc, 34, yStart, PAGE.w - 68, 380);

  // Industry summary header
  let y = yStart + 18;
  if (comp.industry_summary) {
    y = drawTextBlock(doc, 50, y, PAGE.w - 100, comp.industry_summary, { size: 10.5, color: C.text2, lineGap: 2 });
    y += 12;
  }

  if (peers.length === 0) {
    doc.font("JP").fontSize(10).fillColor(C.text4).text("競合企業データなし", 50, y);
  } else {
    // Peer table header
    const tx = 50;
    drawDivider(doc, tx, y, PAGE.w - 50, C.gold);
    y += 6;
    doc.font("JP").fontSize(8.5).fillColor(C.gold).text("PEER", tx, y, { width: 200 });
    doc.text("時価総額", tx + 220, y, { width: 100, align: "right" });
    doc.text("PER", tx + 340, y, { width: 80, align: "right" });
    doc.text("YoY 売上", tx + 440, y, { width: 100, align: "right" });
    doc.text("特徴", tx + 560, y, { width: 200 });
    y += 18;
    drawDivider(doc, tx, y, PAGE.w - 50, C.border);
    y += 8;

    peers.slice(0, 6).forEach((p, i) => {
      if (i > 0) drawDivider(doc, tx, y - 4, PAGE.w - 50, C.border);
      doc.font("JP").fontSize(10).fillColor(C.text).text(safeStr(p.name), tx, y, { width: 200, ellipsis: true });
      doc.text(safeStr(p.market_cap), tx + 220, y, { width: 100, align: "right" });
      doc.text(safeStr(p.per), tx + 340, y, { width: 80, align: "right" });
      doc.text(safeStr(p.revenue_yoy), tx + 440, y, { width: 100, align: "right" });
      doc.font("JP").fontSize(8.5).fillColor(C.text3).text(safeStr(p.note), tx + 560, y + 1, { width: 200, ellipsis: true });
      y += 28;
    });
  }

  drawFooter(doc, 5, TOTAL_PAGES);
}

function pageRisks(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "04", "BUSINESS RISKS");
  drawTitle(doc, "事業等のリスク", "Risk factors extracted from EDINET annual report");

  const yStart = 130;
  const risks = d.risks || [];

  if (risks.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text("リスクデータなし", 0, yStart + 180, { width: PAGE.w, align: "center" });
    drawFooter(doc, 6, TOTAL_PAGES);
    return;
  }

  // 2-col layout for risk cards
  const colW = (PAGE.w - 68 - 16) / 2;
  const rowH = 95;
  const maxRows = 4;

  risks.slice(0, maxRows * 2).forEach((r, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 34 + col * (colW + 16);
    const y = yStart + row * (rowH + 12);
    drawCard(doc, x, y, colW, rowH, { accent: true, accentColor: C.loss });
    doc.font("JP").fontSize(8).fillColor(C.loss).text(safeStr(r.category), x + 16, y + 12, { characterSpacing: 1 });
    doc.fontSize(11).fillColor(C.text).text(safeStr(r.title), x + 16, y + 26, { width: colW - 32, ellipsis: true });
    drawTextBlock(doc, x + 16, y + 46, colW - 32, r.summary, { size: 8.5, color: C.text2, lineGap: 1, maxHeight: 42, ellipsis: true });
  });

  drawFooter(doc, 6, TOTAL_PAGES);
}

function pageIrNews(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "05", "IR PULSE");
  drawTitle(doc, "重要 IR ニュース", "M&A · Equity · Partnership — most recent disclosures");

  const yStart = 130;
  const news = d.ir_news || [];

  if (news.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text("IR ニュースなし", 0, yStart + 180, { width: PAGE.w, align: "center" });
    drawFooter(doc, 7, TOTAL_PAGES);
    return;
  }

  let y = yStart;
  const itemH = 60;
  news.slice(0, 6).forEach((n, i) => {
    drawCard(doc, 34, y, PAGE.w - 68, itemH - 8, { accent: true, accentColor: C.cyan });
    // Date
    doc.font("JP").fontSize(9).fillColor(C.gold).text(safeStr(n.date), 50, y + 12);
    if (n.fy_label) doc.fontSize(7).fillColor(C.text4).text(safeStr(n.fy_label), 50, y + 26);

    // Tag
    if (n.tag) drawTagChip(doc, 130, y + 12, n.tag, { width: 80, color: C.cyan, fill: C.surface2 });

    // Title
    doc.font("JP").fontSize(11).fillColor(C.text).text(safeStr(n.title), 230, y + 10, { width: 480, ellipsis: true });
    if (n.summary) {
      doc.fontSize(8.5).fillColor(C.text3).text(safeStr(n.summary), 230, y + 28, { width: 480, ellipsis: true, height: 20 });
    }

    // Impact badge
    if (n.impact_pct != null) {
      const c = n.impact_pct >= 0 ? C.gain : C.loss;
      doc.font("JP").fontSize(7).fillColor(C.text4).text("推定インパクト", PAGE.w - 130, y + 10);
      doc.fontSize(13).fillColor(c).text(formatPct(n.impact_pct), PAGE.w - 130, y + 24, { width: 90, align: "right" });
    }

    y += itemH;
  });

  drawFooter(doc, 7, TOTAL_PAGES);
}

function pageIndustryTopics(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "06", "INDUSTRY WATCH");
  drawTitle(doc, "業界・事業環境ウォッチ", "Regulatory & macro context relevant to this stock");

  const yStart = 130;
  const topics = d.industry_topics || [];

  if (topics.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text("業界トピックデータなし", 0, yStart + 180, { width: PAGE.w, align: "center" });
    drawFooter(doc, 8, TOTAL_PAGES);
    return;
  }

  // 2-col grid
  const colW = (PAGE.w - 68 - 16) / 2;
  const rowH = 90;

  topics.slice(0, 8).forEach((t, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 34 + col * (colW + 16);
    const y = yStart + row * (rowH + 8);
    drawCard(doc, x, y, colW, rowH, { accent: true, accentColor: C.warn });
    doc.font("JP").fontSize(8).fillColor(C.warn).text(safeStr(t.tag || "TOPIC"), x + 16, y + 10, { characterSpacing: 1 });
    doc.fontSize(10.5).fillColor(C.text).text(safeStr(t.title), x + 16, y + 24, { width: colW - 32, ellipsis: true });
    drawTextBlock(doc, x + 16, y + 42, colW - 32, t.summary, { size: 8, color: C.text2, lineGap: 1, maxHeight: 42, ellipsis: true });
  });

  drawFooter(doc, 8, TOTAL_PAGES);
}

function pagePriceMetrics(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "07", "PRICE & VALUATION");
  drawTitle(doc, "株価・時価総額・PER", "Trading metrics and valuation snapshot");

  const yStart = 130;
  const p = d.price || {};

  // Top: 4 large metric cards
  const metrics = [
    { label: "前日終値",   value: p.value != null ? formatYen(Math.round(p.value)) : "—", sub: p.as_of_date || "" },
    { label: "前々日終値", value: p.previous_close != null ? formatYen(Math.round(p.previous_close)) : "—", sub: p.previous_close_date || "" },
    { label: "時価総額",   value: p.market_cap_jpy ? `${formatNumber(Math.round(p.market_cap_jpy / 1e8))} 億円` : "—", sub: "EDINET 株数 × 終値" },
    { label: "PER (実績)", value: p.per_calculated ? `${p.per_calculated.toFixed(1)}x` : "—", sub: "純利益ベース" },
  ];

  const cardW = (PAGE.w - 68 - 30) / 4;
  metrics.forEach((m, i) => {
    const x = 34 + i * (cardW + 10);
    drawCard(doc, x, yStart, cardW, 130, { accent: true, accentColor: C.gold });
    doc.font("JP").fontSize(8).fillColor(C.gold).text(m.label, x + 14, yStart + 14, { characterSpacing: 1 });
    doc.fontSize(22).fillColor(C.text).text(m.value, x + 14, yStart + 38, { width: cardW - 28 });
    if (m.sub) doc.fontSize(7).fillColor(C.text4).text(m.sub, x + 14, yStart + 90, { width: cardW - 28 });
  });

  // Bottom: 52-week range + change
  const by = yStart + 150;

  // Change card
  drawCard(doc, 34, by, 380, 230);
  doc.font("JP").fontSize(9).fillColor(C.gold).text("●  PRICE CHANGE — 前日 vs 前々日", 50, by + 16, { characterSpacing: 1 });

  if (p.change != null && p.change_percent != null) {
    const c = p.change >= 0 ? C.gain : C.loss;
    const arrow = p.change >= 0 ? "▲" : "▼";
    const sign = p.change >= 0 ? "+" : "";
    doc.font("JP").fontSize(56).fillColor(c).text(formatPct(p.change_percent), 50, by + 50);
    doc.fontSize(16).fillColor(c).text(`${arrow}  ${sign}${Math.round(p.change)} 円`, 50, by + 130);
  }

  doc.font("JP").fontSize(7.5).fillColor(C.text4).text(
    `${p.previous_close_date || "前々日"} 終値 → ${p.as_of_date || "前日"} 終値の変動`,
    50, by + 200, { width: 350 }
  );

  // 52-week range card
  drawCard(doc, 430, by, PAGE.w - 34 - 430, 230, { topAccent: true, accentColor: C.cyan });
  doc.font("JP").fontSize(9).fillColor(C.cyan).text("●  52-WEEK RANGE", 446, by + 16, { characterSpacing: 1 });
  doc.fontSize(7).fillColor(C.text4).text("Yahoo Finance 1年データ", 446, by + 32);

  const high = p.fifty_two_week_high;
  const low = p.fifty_two_week_low;

  if (high != null && low != null && p.value != null) {
    // Bar visualization
    const barX = 446, barY = by + 70, barW = PAGE.w - 34 - 446 - 32;
    doc.save();
    doc.rect(barX, barY, barW, 8).fillAndStroke(C.surface2, C.borderStrong);
    // Position marker
    const pos = (p.value - low) / (high - low);
    const px = barX + Math.max(0, Math.min(1, pos)) * barW;
    doc.rect(barX, barY, px - barX, 8).fill(C.cyan);
    doc.circle(px, barY + 4, 5).fillAndStroke(C.gold, C.bg).lineWidth(1.5);
    doc.restore();

    doc.font("JP").fontSize(8).fillColor(C.text3).text("LOW", barX, barY + 16);
    doc.text("HIGH", barX + barW - 28, barY + 16, { width: 28, align: "right" });

    doc.fontSize(13).fillColor(C.text).text(formatYen(Math.round(low)), barX, barY + 35);
    doc.text(formatYen(Math.round(high)), barX, barY + 35, { width: barW, align: "right" });

    doc.fontSize(9).fillColor(C.gold).text(
      `現在位置  ${(pos * 100).toFixed(0)}%  (¥${formatNumber(Math.round(p.value))})`,
      446, by + 130, { width: PAGE.w - 34 - 446 - 32 }
    );
  }

  drawFooter(doc, 9, TOTAL_PAGES);
}

function pageThesis(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "08", "INVESTMENT THESIS");
  drawTitle(doc, "投資テーゼ", "Bull / Base / Bear scenarios with conviction");

  const yStart = 130;
  const t = d.investment_thesis || {};

  if (!t.bull && !t.base && !t.bear) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text(
      "Investment Thesis は EDINET 財務データが 3 年分以上ある場合のみ生成されます。",
      0, yStart + 180, { width: PAGE.w, align: "center" }
    );
    drawFooter(doc, 10, TOTAL_PAGES);
    return;
  }

  const scenarios = [
    { tag: "BULL", color: C.gain, data: t.bull },
    { tag: "BASE", color: C.cyan, data: t.base },
    { tag: "BEAR", color: C.loss, data: t.bear },
  ];

  const cardW = (PAGE.w - 68 - 30) / 3;
  scenarios.forEach((s, i) => {
    if (!s.data) return;
    const x = 34 + i * (cardW + 15);
    const cardH = 350;
    drawCard(doc, x, yStart, cardW, cardH, { topAccent: true, accentColor: s.color });

    // Tag
    doc.font("JP").fontSize(11).fillColor(s.color).text(s.tag, x + 16, yStart + 14, { characterSpacing: 4 });

    // Probability (big)
    if (s.data.probability != null) {
      const pct = (s.data.probability * 100).toFixed(0);
      doc.font("JP").fontSize(48).fillColor(C.text).text(`${pct}%`, x + 16, yStart + 38);
      doc.fontSize(8).fillColor(C.text3).text("確率", x + 16, yStart + 96);
    }

    // Implied return
    if (s.data.implied_return) {
      doc.font("JP").fontSize(11).fillColor(s.color).text(
        `想定リターン  ${s.data.implied_return}`,
        x + 16, yStart + 120, { width: cardW - 32 }
      );
    }

    // Drivers
    let dy = yStart + 150;
    doc.font("JP").fontSize(7.5).fillColor(C.text4).text("KEY DRIVERS", x + 16, dy, { characterSpacing: 1 });
    dy += 14;
    const drivers = Array.isArray(s.data.drivers) ? s.data.drivers : [];
    drivers.slice(0, 5).forEach(driver => {
      doc.circle(x + 19, dy + 4, 1.3).fill(s.color);
      doc.font("JP").fontSize(8).fillColor(C.text2).text(safeStr(driver), x + 26, dy, { width: cardW - 42, lineGap: 1 });
      dy = doc.y + 4;
    });
  });

  // Conviction footer
  if (t.conviction) {
    doc.font("JP").fontSize(9).fillColor(C.gold).text(
      `◆  Conviction (確度): ${safeStr(t.conviction).toUpperCase()}  —  Buy/Sell の推奨ではなく、判断材料の整理`,
      0, yStart + 360, { width: PAGE.w, align: "center" }
    );
  }

  drawFooter(doc, 10, TOTAL_PAGES);
}

/* ─── Public entry point ──────────────────────────── */

export async function generateReportPdf(merged) {
  // Verify font exists
  if (!FONT_PATH) {
    throw new Error(
      "Japanese font file (NotoSansJP.ttf) not found in deployment. " +
      "Check that lib/fonts/NotoSansJP.ttf is included in the Vercel function bundle " +
      "(see vercel.json includeFiles config)."
    );
  }
  if (!fs.existsSync(FONT_PATH)) {
    throw new Error(`Font file resolved to ${FONT_PATH} but file does not exist`);
  }

  const doc = new PDFDocument({
    size: [PAGE.w, PAGE.h],
    margin: 0,
    info: {
      Title: `ARGOS_${merged.code || "report"}`,
      Author: "ARGOS",
      Subject: "Institutional Equity Brief",
      Keywords: "ARGOS, equity research, " + (merged.code || ""),
    },
    autoFirstPage: false,
  });

  doc.registerFont("JP", FONT_PATH);

  // Page generator order
  const pageGenerators = [
    pageCover,
    pageHero,
    pageListing,
    pageFinancials,
    pageCompetitive,
    pageRisks,
    pageIrNews,
    pageIndustryTopics,
    pagePriceMetrics,
    pageThesis,
  ];

  for (const fn of pageGenerators) {
    doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 });
    try {
      fn(doc, merged);
    } catch (err) {
      console.error(`[PDF] page ${fn.name} failed:`, err.message);
      // Render a fallback "section unavailable" page
      fillBg(doc);
      doc.font("JP").fontSize(12).fillColor(C.text3)
        .text(`${fn.name} のレンダリングに失敗しました: ${err.message}`,
          50, 200, { width: PAGE.w - 100, align: "center" });
    }
  }

  // Collect bytes
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
