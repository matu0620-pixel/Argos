// lib/jpx-listing-criteria.js — 東証 上場維持基準 (Prime/Standard/Growth)
// Source: https://www.jpx.co.jp/equities/listing/continue/outline/01-03.html
// Last updated: 2025-12-08 (Growth は 2030 年改正予定の注記あり)

export const JPX_LISTING_CRITERIA = {
  prime: {
    market_key: "prime",
    market_label: "東証プライム市場",
    market_short: "PRIME",
    eyebrow: "▸ TSE PRIME — 上場維持基準",
    headline: "<em>時価総額・流動性・ガバナンスの高い基準</em>を満たす主要企業向け市場",
    desc: "グローバル投資家との建設的な対話を中心に据えた企業向けの市場で、高い開示水準・ガバナンスが求められます。",
    criteria: [
      { label: "株主数",             val: "800 人以上" },
      { label: "流通株式数",         val: "20,000 単位以上" },
      { label: "流通株式時価総額",   val: "100 億円以上" },
      { label: "流通株式比率",       val: "35% 以上" },
      { label: "売買代金",           val: "1日平均 0.2 億円以上" },
      { label: "純資産",             val: "正であること" },
    ],
    watermark: "PRIME",
    source_url: "https://www.jpx.co.jp/equities/listing/continue/outline/01.html",
  },
  standard: {
    market_key: "standard",
    market_label: "東証スタンダード市場",
    market_short: "STANDARD",
    eyebrow: "▸ TSE STANDARD — 上場維持基準",
    headline: "<em>公開された投資対象として十分な流動性</em>と基本的なガバナンス水準を備えた市場",
    desc: "公開された市場における投資対象として基本的なガバナンス水準を備えた企業向けの市場です。",
    criteria: [
      { label: "株主数",             val: "400 人以上" },
      { label: "流通株式数",         val: "2,000 単位以上" },
      { label: "流通株式時価総額",   val: "10 億円以上" },
      { label: "流通株式比率",       val: "25% 以上" },
      { label: "売買高",             val: "月平均 10 単位以上" },
      { label: "純資産",             val: "正であること" },
    ],
    watermark: "STANDARD",
    source_url: "https://www.jpx.co.jp/equities/listing/continue/outline/02.html",
  },
  growth: {
    market_key: "growth",
    market_label: "東証グロース市場",
    market_short: "GROWTH",
    eyebrow: "▸ TSE GROWTH — 上場維持基準",
    headline: "<em>高い成長可能性</em>を有する企業向けの市場",
    desc: "高い成長可能性を有する一方、相対的にリスクが高いと考えられる企業向けの市場です。",
    criteria: [
      { label: "株主数",             val: "150 人以上" },
      { label: "流通株式数",         val: "1,000 単位以上" },
      { label: "流通株式時価総額",   val: "5 億円以上" },
      { label: "流通株式比率",       val: "25% 以上" },
      { label: "売買高",             val: "月平均 10 単位以上" },
      { label: "時価総額",           val: "40 億円以上 (上場10年経過後)" },
    ],
    watermark: "GROWTH",
    note: "※ 2030年3月1日より、時価総額基準が100億円以上 (上場5年経過後) に見直し予定",
    source_url: "https://www.jpx.co.jp/equities/listing/continue/outline/03.html",
  },
};

/**
 * Detect the market segment from a merged result.
 * Looks at market_tags (from Phase 1) for "PRIME" / "STANDARD" / "GROWTH" hints.
 */
export function detectMarketSegment(merged) {
  if (!merged) return null;

  // 1) Check market_tags
  const tags = merged.market_tags || [];
  for (const t of tags) {
    const label = String(t?.label || "").toUpperCase();
    if (label.includes("PRIME") || label.includes("プライム")) return "prime";
    if (label.includes("STANDARD") || label.includes("スタンダード")) return "standard";
    if (label.includes("GROWTH") || label.includes("グロース")) return "growth";
  }

  // 2) Check listing.aside / market_card.eyebrow
  const aside = String(merged.listing?.aside || "").toUpperCase();
  if (aside.includes("PRIME") || aside.includes("プライム")) return "prime";
  if (aside.includes("STANDARD") || aside.includes("スタンダード")) return "standard";
  if (aside.includes("GROWTH") || aside.includes("グロース")) return "growth";

  const eyebrow = String(merged.listing?.market_card?.eyebrow || "").toUpperCase();
  if (eyebrow.includes("PRIME")) return "prime";
  if (eyebrow.includes("STANDARD")) return "standard";
  if (eyebrow.includes("GROWTH")) return "growth";

  // 3) Check listing.rows for a row with market info
  const rows = merged.listing?.rows || [];
  for (const r of rows) {
    if (r.key === "上場市場" || r.key?.includes("市場")) {
      const v = String(r.val || "").toUpperCase();
      if (v.includes("PRIME") || v.includes("プライム")) return "prime";
      if (v.includes("STANDARD") || v.includes("スタンダード")) return "standard";
      if (v.includes("GROWTH") || v.includes("グロース")) return "growth";
    }
  }

  return null;
}

/** Return market_card object ready for frontend rendering */
export function getMarketCard(segment) {
  const tpl = JPX_LISTING_CRITERIA[segment];
  if (!tpl) {
    return {
      eyebrow: "▸ MARKET",
      headline: "—",
      desc: "市場区分を判定できませんでした",
      criteria: [],
      watermark: "MARKET",
    };
  }
  return {
    eyebrow: tpl.eyebrow,
    headline: tpl.headline,
    desc: tpl.desc + (tpl.note ? `<br/><small>${tpl.note}</small>` : ""),
    criteria: tpl.criteria,
    watermark: tpl.watermark,
  };
}

/** Return aside HTML (right-side description) */
export function getMarketAside(segment) {
  const tpl = JPX_LISTING_CRITERIA[segment];
  if (!tpl) return "市場区分判定不可";
  return `<b>${tpl.market_label}</b><br/>${tpl.desc.split("。")[0]}`;
}
