// lib/pdf-generator.js — Institutional research PDF
// Theme: navy + gold (matches sales deck and product UI)
// Library: PDFKit + bundled IPAGothic for Japanese
//
// Page structure (10 pages):
//   01 Cover                — code, name, segment, price, recommendation badge
//   02 Executive Summary    — 投資要旨, key drivers (upside/downside)
//   03 Investment Thesis    — Bull/Base/Bear scenarios + Analyst Take
//   04 Business Profile     — EDINET listing facts + market criteria
//   05 Financial Trajectory — 5-year P/L table
//   06 Competitive Position — peer comparison
//   07 Risk Factors         — risk cards
//   08 Industry Outlook     — industry topics
//   09 Valuation            — price metrics + valuation_take comment
//   10 Disclaimer           — methodology, data sources, legal notice

import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveFontPath() {
  const candidates = [
    path.resolve(__dirname, "fonts/NotoSansJP.ttf"),
    path.resolve(__dirname, "../lib/fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "lib/fonts/NotoSansJP.ttf"),
    path.resolve(process.cwd(), "argos/lib/fonts/NotoSansJP.ttf"),
    "/var/task/lib/fonts/NotoSansJP.ttf",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}
const FONT_PATH = resolveFontPath();

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
const PAGE = { w: 842, h: 595 };
const TOTAL_PAGES = 10;

/* ─── Helpers ─────────────────────────────────────── */
function safeStr(v, fb = "—") {
  if (v == null || v === "") return fb;
  let s = String(v);
  s = s.replace(/▸/g, "▶").replace(/►/g, "▶").replace(/▪/g, "■");
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
  doc.circle(34, 30, 3.2).fill(C.gold);
  doc.font("JP").fontSize(8.5).fillColor(C.gold).text(num, 44, 26.5, { lineBreak: false });
  doc.fillColor(C.text3).text(`  —  ${label}`, 60, 26.5, { lineBreak: false });
  doc.restore();
}
function drawFooter(doc, page, total) {
  doc.save();
  doc.strokeColor(C.borderStrong).lineWidth(0.4).moveTo(34, PAGE.h - 24).lineTo(PAGE.w - 34, PAGE.h - 24).stroke();
  doc.font("JP").fontSize(7).fillColor(C.text4).text("ARGOS  ·  Institutional Equity Intelligence", 34, PAGE.h - 17);
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
  if (opts.accent) doc.rect(x, y, 3, h).fill(opts.accentColor || C.gold);
  if (opts.topAccent) doc.rect(x, y, w, 1.5).fill(opts.accentColor || C.gold);
  doc.restore();
}
function drawTagChip(doc, x, y, label, opts = {}) {
  const w = opts.width || (label.length * 4.5 + 10);
  const h = opts.height || 14;
  doc.save();
  doc.rect(x, y, w, h).fillAndStroke(opts.fill || C.surface2, opts.stroke || C.borderStrong);
  doc.font("JP").fontSize(opts.fontSize || 7).fillColor(opts.color || C.text3).text(
    label, x, y + (h - (opts.fontSize || 7)) / 2 - 1, { width: w, align: "center", lineBreak: false }
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

const RATING_COLORS = {
  BUY:         { color: C.gain,  label: "BUY" },
  ACCUMULATE:  { color: C.gain,  label: "ACCUMULATE" },
  HOLD:        { color: C.cyan,  label: "HOLD" },
  UNDERWEIGHT: { color: C.warn,  label: "UNDERWEIGHT" },
  SELL:        { color: C.loss,  label: "SELL" },
};
function getRatingColor(rating) {
  return RATING_COLORS[String(rating || "HOLD").toUpperCase()] || RATING_COLORS.HOLD;
}

/* ─── Page 01: Cover ──────────────────────────────── */
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

  const code = safeStr(d.code, "----");
  const nameJp = d.company?.name_jp || "";
  const nameEn = d.company?.name_en || "";

  // Big code
  doc.save();
  doc.font("JP").fontSize(14).fillColor(C.gold).text("STOCK CODE", 0, 110, { width: PAGE.w, align: "center", characterSpacing: 4 });
  doc.fontSize(72).fillColor(C.text).text(code, 0, 130, { width: PAGE.w, align: "center" });
  doc.restore();

  if (nameJp) doc.font("JP").fontSize(22).fillColor(C.text).text(nameJp, 60, 230, { width: PAGE.w - 120, align: "center" });
  if (nameEn) doc.font("JP").fontSize(11).fillColor(C.cyan).text(nameEn, 60, 265, { width: PAGE.w - 120, align: "center" });

  // Gold rule
  doc.save().strokeColor(C.gold).lineWidth(0.6).moveTo(PAGE.w / 2 - 60, 295).lineTo(PAGE.w / 2 + 60, 295).stroke().restore();

  // Tag chips
  const segMap = { prime: "TSE PRIME", standard: "TSE STANDARD", growth: "TSE GROWTH", other: "TSE OTHER" };
  const chipText = [
    segMap[d._market_segment] || (d._market_segment ? `TSE ${d._market_segment.toUpperCase()}` : null),
    d.industry_key || null,
  ].filter(Boolean);
  if (chipText.length > 0) {
    let cx = (PAGE.w - chipText.length * 100) / 2;
    chipText.forEach(t => {
      cx = drawTagChip(doc, cx, 315, t, { width: 95, fill: C.surface, stroke: C.gold, color: C.gold });
    });
  }

  // Recommendation Badge (Phase 5 data)
  const rec = d.report_authoring?.recommendation;
  if (rec?.rating) {
    const rc = getRatingColor(rec.rating);
    const badgeY = 350;
    doc.save();
    doc.rect(PAGE.w / 2 - 110, badgeY, 220, 50).fillAndStroke(C.surface2, rc.color);
    doc.font("JP").fontSize(20).fillColor(rc.color).text(rc.label, 0, badgeY + 12, { width: PAGE.w, align: "center", characterSpacing: 6 });
    if (rec.target_price_jpy) {
      doc.fontSize(9).fillColor(C.text3).text(
        `Target ¥${formatNumber(rec.target_price_jpy)}  ·  ${rec.time_horizon || "12M"}  ·  Conviction ${(rec.conviction || "medium").toUpperCase()}`,
        0, badgeY + 35, { width: PAGE.w, align: "center" }
      );
    }
    doc.restore();
  }

  // Price
  const price = d.price?.value;
  const changePct = d.price?.change_percent;
  if (price != null) {
    doc.save();
    doc.font("JP").fontSize(28).fillColor(C.text).text(formatYen(Math.round(price)), 0, 425, { width: PAGE.w, align: "center" });
    if (changePct != null) {
      const c = changePct >= 0 ? C.gain : C.loss;
      const arrow = changePct >= 0 ? "▲" : "▼";
      doc.fontSize(11).fillColor(c).text(`${arrow}  ${formatPct(changePct)}`, 0, 460, { width: PAGE.w, align: "center" });
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

/* ─── Page 02: Executive Summary ──────────────────── */
function pageExecutiveSummary(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "01", "EXECUTIVE SUMMARY");
  drawTitle(doc, "投資要旨", "Investment summary at a glance");

  const ra = d.report_authoring || {};
  const yStart = 130;

  // Recommendation card (left)
  const rc = getRatingColor(ra.recommendation?.rating);
  drawCard(doc, 34, yStart, 380, 130, { topAccent: true, accentColor: rc.color });
  doc.font("JP").fontSize(8).fillColor(rc.color).text("RECOMMENDATION", 50, yStart + 14, { characterSpacing: 2 });
  doc.fontSize(36).fillColor(rc.color).text(rc.label, 50, yStart + 32);
  if (ra.recommendation?.target_price_jpy) {
    doc.fontSize(12).fillColor(C.text).text(
      `Target  ¥${formatNumber(ra.recommendation.target_price_jpy)}`,
      50, yStart + 80
    );
  }
  if (ra.recommendation) {
    doc.fontSize(9).fillColor(C.text3).text(
      `${ra.recommendation.time_horizon || "12M"}  ·  Conviction ${(ra.recommendation.conviction || "medium").toUpperCase()}`,
      50, yStart + 102
    );
  }

  // Quick metrics (right, 2x2)
  const px = 430;
  const quickStats = [
    ["前日終値", d.price?.value ? formatYen(Math.round(d.price.value)) : "—"],
    ["時価総額", d.price?.market_cap_jpy ? `${formatNumber(Math.round(d.price.market_cap_jpy / 1e8))} 億円` : "—"],
    ["PER", d.price?.per_calculated ? `${d.price.per_calculated.toFixed(1)}x` : "—"],
    ["市場区分", d._market_segment ? d._market_segment.toUpperCase() : "—"],
  ];
  quickStats.forEach((s, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const sx = px + col * 195;
    const sy = yStart + row * 65;
    drawCard(doc, sx, sy, 185, 55);
    doc.font("JP").fontSize(7.5).fillColor(C.text3).text(s[0], sx + 12, sy + 8, { characterSpacing: 1 });
    doc.fontSize(15).fillColor(C.text).text(s[1], sx + 12, sy + 22, { width: 175 });
  });

  // Executive summary text (full-width)
  if (ra.executive_summary) {
    const exY = yStart + 145;
    drawCard(doc, 34, exY, PAGE.w - 68, 90, { accent: true });
    doc.font("JP").fontSize(8).fillColor(C.gold).text("●  ANALYST'S TAKE", 50, exY + 14, { characterSpacing: 1 });
    drawTextBlock(doc, 50, exY + 32, PAGE.w - 100, ra.executive_summary, {
      size: 11, color: C.text, lineGap: 3, maxHeight: 50,
    });
  }

  // Key Drivers — 2 cols
  const kdY = yStart + 245;
  const kd = ra.key_drivers || {};
  const colW = (PAGE.w - 68 - 16) / 2;

  // Upside
  drawCard(doc, 34, kdY, colW, 130, { accent: true, accentColor: C.gain });
  doc.font("JP").fontSize(9).fillColor(C.gain).text("▲  UPSIDE DRIVERS", 50, kdY + 14, { characterSpacing: 1 });
  let uY = kdY + 36;
  (kd.upside || []).slice(0, 4).forEach(driver => {
    doc.circle(56, uY + 4, 1.3).fill(C.gain);
    doc.font("JP").fontSize(9).fillColor(C.text).text(safeStr(driver), 64, uY, { width: colW - 80, lineGap: 1 });
    uY = doc.y + 6;
  });

  // Downside
  const dx = 34 + colW + 16;
  drawCard(doc, dx, kdY, colW, 130, { accent: true, accentColor: C.loss });
  doc.font("JP").fontSize(9).fillColor(C.loss).text("▼  DOWNSIDE RISKS", dx + 16, kdY + 14, { characterSpacing: 1 });
  let dY = kdY + 36;
  (kd.downside || []).slice(0, 4).forEach(driver => {
    doc.circle(dx + 22, dY + 4, 1.3).fill(C.loss);
    doc.font("JP").fontSize(9).fillColor(C.text).text(safeStr(driver), dx + 30, dY, { width: colW - 50, lineGap: 1 });
    dY = doc.y + 6;
  });

  drawFooter(doc, 2, TOTAL_PAGES);
}

/* ─── Page 03: Investment Thesis ──────────────────── */
function pageThesis(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "02", "INVESTMENT THESIS");
  drawTitle(doc, "投資テーゼ", "Bull / Base / Bear scenarios with conviction");

  const yStart = 130;
  const t = d.investment_thesis || {};

  if (t.available === false || (!t.scenarios && !t.bull && !t.base && !t.bear)) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text(
      safeStr(t.reason, "Investment Thesis は EDINET 財務データが 3 期分以上ある場合のみ生成されます"),
      0, yStart + 180, { width: PAGE.w, align: "center" }
    );
    drawFooter(doc, 3, TOTAL_PAGES);
    return;
  }

  const scenarios = [
    { tag: "BULL", color: C.gain, data: t.scenarios?.bull || t.bull },
    { tag: "BASE", color: C.cyan, data: t.scenarios?.base || t.base },
    { tag: "BEAR", color: C.loss, data: t.scenarios?.bear || t.bear },
  ];

  const cardW = (PAGE.w - 68 - 30) / 3;
  scenarios.forEach((s, i) => {
    if (!s.data) return;
    const x = 34 + i * (cardW + 15);
    const cardH = 290;
    drawCard(doc, x, yStart, cardW, cardH, { topAccent: true, accentColor: s.color });
    doc.font("JP").fontSize(11).fillColor(s.color).text(s.tag, x + 16, yStart + 14, { characterSpacing: 4 });

    if (s.data.probability != null) {
      const pct = (s.data.probability * 100).toFixed(0);
      doc.font("JP").fontSize(48).fillColor(C.text).text(`${pct}%`, x + 16, yStart + 38);
      doc.fontSize(8).fillColor(C.text3).text("確率", x + 16, yStart + 96);
    }

    if (s.data.implied_return || s.data.target_range) {
      const ret = s.data.implied_return || s.data.target_range;
      doc.font("JP").fontSize(11).fillColor(s.color).text(
        `想定リターン  ${ret}`,
        x + 16, yStart + 120, { width: cardW - 32 }
      );
    }

    let dy = yStart + 150;
    doc.font("JP").fontSize(7.5).fillColor(C.text4).text("KEY DRIVERS", x + 16, dy, { characterSpacing: 1 });
    dy += 14;
    const drivers = Array.isArray(s.data.drivers) ? s.data.drivers : [];
    drivers.slice(0, 4).forEach(driver => {
      doc.circle(x + 19, dy + 4, 1.3).fill(s.color);
      doc.font("JP").fontSize(8).fillColor(C.text2).text(safeStr(driver), x + 26, dy, { width: cardW - 42, lineGap: 1 });
      dy = doc.y + 4;
    });
  });

  // Analyst Take (full width below)
  const ra = d.report_authoring || {};
  if (ra.analyst_take) {
    const aY = yStart + 305;
    drawCard(doc, 34, aY, PAGE.w - 68, 90, { accent: true, accentColor: C.gold });
    doc.font("JP").fontSize(8).fillColor(C.gold).text("●  ANALYST TAKE  —  総括", 50, aY + 14, { characterSpacing: 2 });
    drawTextBlock(doc, 50, aY + 32, PAGE.w - 100, ra.analyst_take, {
      size: 10.5, color: C.text2, lineGap: 3, maxHeight: 50,
    });
  }

  drawFooter(doc, 3, TOTAL_PAGES);
}

/* ─── Page 04: Business Profile ───────────────────── */
function pageBusinessProfile(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "03", "BUSINESS PROFILE");
  drawTitle(doc, "事業プロファイル", "EDINET 6 fields + JPX listing criteria");

  const yStart = 130;

  // Left: Company info + EDINET facts
  const lx = 34, lw = 480;
  drawCard(doc, lx, yStart, lw, 380, { accent: true });
  let y = yStart + 18;
  if (d.company?.name_jp) {
    doc.font("JP").fontSize(14).fillColor(C.text).text(d.company.name_jp, lx + 16, y, { width: lw - 32 });
    y = doc.y + 4;
  }
  if (d.company?.blurb) {
    y = drawTextBlock(doc, lx + 16, y, lw - 32, d.company.blurb, {
      size: 9, color: C.text2, lineGap: 2, maxHeight: 80, ellipsis: true,
    });
    y += 12;
  }
  doc.font("JP").fontSize(8).fillColor(C.gold).text("●  EDINET FACTS", lx + 16, y, { characterSpacing: 1 });
  y += 18;

  const rows = d.listing?.rows || [];
  rows.slice(0, 6).forEach((r, i) => {
    if (i > 0) drawDivider(doc, lx + 16, y - 2, lx + lw - 16);
    doc.font("JP").fontSize(9).fillColor(C.gold).text(safeStr(r.k), lx + 16, y, { width: 130 });
    doc.font("JP").fontSize(11).fillColor(C.text).text(safeStr(r.v), lx + 158, y - 1, { width: 240 });
    y += 32;
  });

  // Right: Market criteria
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

  drawFooter(doc, 4, TOTAL_PAGES);
}

/* ─── Page 05: Financial Trajectory ───────────────── */
function pageFinancials(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "04", "FINANCIAL TRAJECTORY");
  drawTitle(doc, "財務トレンド (5 年)", "Annual P/L from EDINET XBRL");

  const yStart = 130;
  const fin = d.financials || {};
  const years = fin.years || [];
  const rows = fin.rows || [];

  if (rows.length === 0 || years.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3)
      .text("EDINET 有報データの取得に失敗しました。", 34, yStart + 180, { width: PAGE.w - 68, align: "center" });
    drawFooter(doc, 5, TOTAL_PAGES);
    return;
  }

  const cardW = PAGE.w - 68, cardH = 380;
  drawCard(doc, 34, yStart, cardW, cardH, { accent: true });
  const colW = (cardW - 200) / years.length;
  const ty = yStart + 18;
  doc.font("JP").fontSize(8.5).fillColor(C.gold).text("METRIC", 50, ty, { width: 180, characterSpacing: 1 });
  years.forEach((y, i) => {
    doc.font("JP").fontSize(8.5).fillColor(C.gold).text(safeStr(y), 230 + i * colW, ty, { width: colW - 10, align: "right" });
  });
  drawDivider(doc, 50, ty + 18, 34 + cardW - 16, C.gold);

  let dy = ty + 28;
  rows.slice(0, 5).forEach((r, idx) => {
    if (idx > 0) drawDivider(doc, 50, dy - 4, 34 + cardW - 16, C.border);
    doc.font("JP").fontSize(10).fillColor(C.text).text(safeStr(r.label), 50, dy, { width: 180 });
    if (r.unit) doc.fontSize(7).fillColor(C.text4).text(`(${r.unit})`, 50, dy + 14, { width: 180 });
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
  doc.font("JP").fontSize(7.5).fillColor(C.text4).text(
    "出典: EDINET 有価証券報告書 (XBRL) — NetSales / OperatingIncome / OrdinaryIncome / Profit",
    50, yStart + cardH - 22, { width: cardW - 32 }
  );
  drawFooter(doc, 5, TOTAL_PAGES);
}

/* ─── Page 06: Competitive Position ───────────────── */
function pageCompetitive(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "05", "COMPETITIVE POSITION");
  drawTitle(doc, "競合・業界比較", "Industry KPIs and peer comparison");

  const yStart = 130;
  const comp = d.competitive_analysis || {};
  const peers = comp.peers || [];
  drawCard(doc, 34, yStart, PAGE.w - 68, 380);

  let y = yStart + 18;
  if (comp.industry_summary) {
    y = drawTextBlock(doc, 50, y, PAGE.w - 100, comp.industry_summary, { size: 10.5, color: C.text2, lineGap: 2 });
    y += 12;
  }

  if (peers.length === 0) {
    doc.font("JP").fontSize(10).fillColor(C.text4).text("競合企業データなし", 50, y);
  } else {
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
  drawFooter(doc, 6, TOTAL_PAGES);
}

/* ─── Page 07: Risk Factors ───────────────────────── */
function pageRisks(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "06", "RISK FACTORS");
  drawTitle(doc, "事業等のリスク", "Risk factors extracted from EDINET annual report");

  const yStart = 130;
  const risks = d.risks || [];

  if (risks.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text("リスクデータなし", 0, yStart + 180, { width: PAGE.w, align: "center" });
    drawFooter(doc, 7, TOTAL_PAGES);
    return;
  }

  const colW = (PAGE.w - 68 - 16) / 2;
  const rowH = 95;
  risks.slice(0, 8).forEach((r, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 34 + col * (colW + 16);
    const y = yStart + row * (rowH + 12);
    drawCard(doc, x, y, colW, rowH, { accent: true, accentColor: C.loss });
    doc.font("JP").fontSize(8).fillColor(C.loss).text(safeStr(r.category), x + 16, y + 12, { characterSpacing: 1 });
    doc.fontSize(11).fillColor(C.text).text(safeStr(r.title), x + 16, y + 26, { width: colW - 32, ellipsis: true });
    drawTextBlock(doc, x + 16, y + 46, colW - 32, r.summary, { size: 8.5, color: C.text2, lineGap: 1, maxHeight: 42, ellipsis: true });
  });
  drawFooter(doc, 7, TOTAL_PAGES);
}

/* ─── Page 08: Industry Outlook ───────────────────── */
function pageIndustryTopics(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "07", "INDUSTRY OUTLOOK");
  drawTitle(doc, "業界・事業環境ウォッチ", "Regulatory & macro context relevant to this stock");

  const yStart = 130;
  const topics = d.industry_topics || [];
  if (topics.length === 0) {
    drawCard(doc, 34, yStart, PAGE.w - 68, 380);
    doc.font("JP").fontSize(11).fillColor(C.text3).text("業界トピックデータなし", 0, yStart + 180, { width: PAGE.w, align: "center" });
    drawFooter(doc, 8, TOTAL_PAGES);
    return;
  }
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

/* ─── Page 09: Valuation ──────────────────────────── */
function pageValuation(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "08", "VALUATION");
  drawTitle(doc, "バリュエーション", "Trading metrics and valuation perspective");

  const yStart = 130;
  const p = d.price || {};
  const ra = d.report_authoring || {};

  // Top: 4 metric cards
  const metrics = [
    { label: "前日終値", value: p.value != null ? formatYen(Math.round(p.value)) : "—", sub: p.as_of_date || "" },
    { label: "前々日終値", value: p.previous_close != null ? formatYen(Math.round(p.previous_close)) : "—", sub: p.previous_close_date || "" },
    { label: "時価総額", value: p.market_cap_jpy ? `${formatNumber(Math.round(p.market_cap_jpy / 1e8))} 億円` : "—", sub: "EDINET 株数 × 終値" },
    { label: "PER (実績)", value: p.per_calculated ? `${p.per_calculated.toFixed(1)}x` : "—", sub: "純利益ベース" },
  ];
  const cardW = (PAGE.w - 68 - 30) / 4;
  metrics.forEach((m, i) => {
    const x = 34 + i * (cardW + 10);
    drawCard(doc, x, yStart, cardW, 110, { accent: true, accentColor: C.gold });
    doc.font("JP").fontSize(8).fillColor(C.gold).text(m.label, x + 14, yStart + 14, { characterSpacing: 1 });
    doc.fontSize(20).fillColor(C.text).text(m.value, x + 14, yStart + 34, { width: cardW - 28 });
    if (m.sub) doc.fontSize(7).fillColor(C.text4).text(m.sub, x + 14, yStart + 78, { width: cardW - 28 });
  });

  // Bottom: change card | 52w range | valuation_take
  const by = yStart + 130;

  // Change card (left)
  drawCard(doc, 34, by, 250, 230);
  doc.font("JP").fontSize(8).fillColor(C.gold).text("●  変動  —  前日 vs 前々日", 50, by + 14, { characterSpacing: 1 });
  if (p.change != null && p.change_percent != null) {
    const c = p.change >= 0 ? C.gain : C.loss;
    const arrow = p.change >= 0 ? "▲" : "▼";
    const sign = p.change >= 0 ? "+" : "";
    doc.font("JP").fontSize(40).fillColor(c).text(formatPct(p.change_percent), 50, by + 40);
    doc.fontSize(13).fillColor(c).text(`${arrow}  ${sign}${Math.round(p.change)} 円`, 50, by + 100);
  }

  // 52w range (middle)
  const mx = 300;
  drawCard(doc, mx, by, 250, 230, { topAccent: true, accentColor: C.cyan });
  doc.font("JP").fontSize(8).fillColor(C.cyan).text("●  52-WEEK RANGE", mx + 14, by + 14, { characterSpacing: 1 });
  const high = p.fifty_two_week_high, low = p.fifty_two_week_low;
  if (high != null && low != null && p.value != null) {
    const barX = mx + 14, barY = by + 60, barW = 222;
    doc.save();
    doc.rect(barX, barY, barW, 8).fillAndStroke(C.surface2, C.borderStrong);
    const pos = (p.value - low) / (high - low);
    const px2 = barX + Math.max(0, Math.min(1, pos)) * barW;
    doc.rect(barX, barY, px2 - barX, 8).fill(C.cyan);
    doc.circle(px2, barY + 4, 5).fillAndStroke(C.gold, C.bg).lineWidth(1.5);
    doc.restore();
    doc.font("JP").fontSize(9).fillColor(C.text2).text(formatYen(Math.round(low)), barX, barY + 16);
    doc.text(formatYen(Math.round(high)), barX, barY + 16, { width: barW, align: "right" });
    doc.fontSize(10).fillColor(C.gold).text(
      `現在位置 ${(pos * 100).toFixed(0)}%`,
      mx + 14, by + 110, { width: 222 }
    );
  }

  // Valuation take (right)
  const rx2 = 565;
  drawCard(doc, rx2, by, PAGE.w - 34 - rx2, 230, { accent: true, accentColor: C.gold });
  doc.font("JP").fontSize(8).fillColor(C.gold).text("●  VALUATION TAKE", rx2 + 14, by + 14, { characterSpacing: 1 });
  if (ra.valuation_take) {
    drawTextBlock(doc, rx2 + 14, by + 36, PAGE.w - 34 - rx2 - 28, ra.valuation_take, {
      size: 9.5, color: C.text2, lineGap: 2, maxHeight: 180,
    });
  } else {
    doc.font("JP").fontSize(8.5).fillColor(C.text4).text("バリュエーションコメントなし", rx2 + 14, by + 36, { width: PAGE.w - 34 - rx2 - 28 });
  }

  drawFooter(doc, 9, TOTAL_PAGES);
}

/* ─── Page 10: Disclaimer & Methodology ───────────── */
function pageDisclaimer(doc, d) {
  fillBg(doc);
  drawEyebrow(doc, "09", "DISCLAIMER & METHODOLOGY");
  drawTitle(doc, "免責事項・方法論", "Data sources, methodology, and legal notice");

  const yStart = 130;

  // Methodology card (left)
  drawCard(doc, 34, yStart, 380, 380, { accent: true });
  doc.font("JP").fontSize(9).fillColor(C.gold).text("●  METHODOLOGY", 50, yStart + 14, { characterSpacing: 1 });
  let y = yStart + 36;
  const methodology = [
    "■ Phase 1 — 基本情報・株価・上場区分 (Web 検索)",
    "■ Phase 2 — 財務データ (EDINET XBRL から 5 年分の P/L)",
    "■ Phase 3 — 競合分析・リスク・業界トピック (Web 検索 + AI)",
    "■ Phase 4 — Investment Thesis (Bull/Base/Bear シナリオ確率)",
    "■ Phase 5 — レポート用追加コメント (推奨レーティング・要旨)",
    "",
    "■ 市場区分は会社四季報を Web 検索で照合済",
    "■ 株価変動 % は前日終値 vs 前々日終値で計算",
    "■ 会社 IR URL は Web 検索で動作確認済のもののみ表示",
  ];
  methodology.forEach(line => {
    if (line === "") { y += 4; return; }
    doc.font("JP").fontSize(8.5).fillColor(C.text2).text(safeStr(line), 50, y, { width: 350, lineGap: 1 });
    y = doc.y + 4;
  });

  // Disclaimer card (right)
  const rx = 430;
  drawCard(doc, rx, yStart, PAGE.w - 34 - rx, 380, { topAccent: true, accentColor: C.warn });
  doc.font("JP").fontSize(9).fillColor(C.warn).text("●  DISCLAIMER", rx + 14, yStart + 14, { characterSpacing: 1 });

  let dy = yStart + 36;
  const disclaimers = [
    "本レポートは、ARGOS が公開情報 (EDINET 有価証券報告書、会社 IR ページ、kabutan、Yahoo!ファイナンス、会社四季報、JPX 上場会社情報等) を基に AI で集約・分析したものです。",
    "",
    "本レポートに含まれる投資推奨 (BUY/HOLD/SELL 等)、目標株価、シナリオ確率は、AI による参考情報であり、特定の投資の勧誘または推奨を目的としたものではありません。",
    "",
    "投資判断はご自身の責任で行ってください。本レポートに依拠した結果生じる損失について、ARGOS 及び Anthropic は一切の責任を負いません。",
    "",
    "情報の正確性については最大限の注意を払っていますが、データソース側の更新遅延・誤情報の可能性があり、生成 AI の特性上、誤った情報が含まれる場合があります。重要な投資判断を行う前に、原典 (EDINET、TDnet、会社 IR ページ等) を必ずご確認ください。",
  ];

  const addendum = d.report_authoring?.report_disclaimer_addendum;
  if (addendum) disclaimers.push("", `※ 本銘柄固有: ${addendum}`);

  disclaimers.forEach(line => {
    if (line === "") { dy += 4; return; }
    doc.font("JP").fontSize(7.5).fillColor(C.text3).text(safeStr(line), rx + 14, dy, { width: PAGE.w - 34 - rx - 28, lineGap: 1.5 });
    dy = doc.y + 3;
  });

  drawFooter(doc, 10, TOTAL_PAGES);
}

/* ─── Public entry ────────────────────────────────── */
export async function generateReportPdf(merged) {
  if (!FONT_PATH) throw new Error("Japanese font not found. Check that lib/fonts/NotoSansJP.ttf is bundled.");
  if (!fs.existsSync(FONT_PATH)) throw new Error(`Font file resolved to ${FONT_PATH} but does not exist`);

  const doc = new PDFDocument({
    size: [PAGE.w, PAGE.h], margin: 0,
    info: {
      Title: `ARGOS_${merged.code || "report"}`,
      Author: "ARGOS",
      Subject: "Institutional Equity Brief",
      Keywords: "ARGOS, equity research, " + (merged.code || ""),
    },
    autoFirstPage: false,
  });
  doc.registerFont("JP", FONT_PATH);

  const pageGenerators = [
    pageCover, pageExecutiveSummary, pageThesis, pageBusinessProfile,
    pageFinancials, pageCompetitive, pageRisks, pageIndustryTopics,
    pageValuation, pageDisclaimer,
  ];

  for (const fn of pageGenerators) {
    doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 });
    try {
      fn(doc, merged);
    } catch (err) {
      console.error(`[PDF] page ${fn.name} failed:`, err.message);
      fillBg(doc);
      doc.font("JP").fontSize(12).fillColor(C.text3)
        .text(`${fn.name} のレンダリングに失敗しました: ${err.message}`,
          50, 200, { width: PAGE.w - 100, align: "center" });
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
