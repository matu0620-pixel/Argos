// lib/atlas/bs-extract.js
// =======================================================================
// ARGOS Atlas — XBRL行データから追加BS項目を抽出(edinet.js 非改変の独立モジュール)
// 総資産・純資産・売上債権・棚卸資産・仕入債務(いずれも CurrentYearInstant, 百万円)
// edinet.js の extractBenchExtras と同じ行フォーマット(EDINET CSV)を前提とする。
// =======================================================================

const FIRST_MATCH = {
  total_assets: ["jppfs_cor:Assets", "jpigp_cor:TotalAssetsIFRS", "jpigp_cor:AssetsIFRS"],
  net_assets: ["jppfs_cor:NetAssets", "jpigp_cor:EquityIFRS", "jpigp_cor:EquityAttributableToOwnersOfParentIFRS"],
  receivables: [
    "jppfs_cor:NotesAndAccountsReceivableTrade",
    "jppfs_cor:NotesAndAccountsReceivableTradeAndContractAssets",
    "jppfs_cor:AccountsReceivableTrade",
    "jpigp_cor:TradeAndOtherReceivablesCAIFRS",
  ],
  inventories: ["jppfs_cor:Inventories", "jpigp_cor:InventoriesIFRS"],
  payables: [
    "jppfs_cor:NotesAndAccountsPayableTrade",
    "jppfs_cor:AccountsPayableTrade",
    "jpigp_cor:TradeAndOtherPayablesCLIFRS",
  ],
};

// 棚卸資産の集約科目が無い会社向け: 構成科目の合算でフォールバック
const INVENTORY_COMPONENTS = [
  "jppfs_cor:MerchandiseAndFinishedGoods",
  "jppfs_cor:Merchandise",
  "jppfs_cor:FinishedGoods",
  "jppfs_cor:WorkInProcess",
  "jppfs_cor:RawMaterialsAndSupplies",
  "jppfs_cor:RawMaterials",
];

function getCol(row, ...cands) {
  for (const c of cands) { if (row[c] != null && row[c] !== "") return String(row[c]); }
  const keys = Object.keys(row);
  for (const c of cands) {
    const t = c.toLowerCase().replace(/\s+/g, "");
    const f = keys.find((k) => k.toLowerCase().replace(/\s+/g, "") === t);
    if (f && row[f]) return String(row[f]);
  }
  return "";
}

/**
 * @param {Array<object>} rows - EDINET CSV 行(edinet.js parseTSV の出力)
 * @returns {{total_assets, net_assets, receivables, inventories, payables}} 百万円 or null
 */
export function extractAtlasBS(rows) {
  const found = {};            // key → value (first-match)
  const invComponents = {};    // elementId → value

  for (const row of rows) {
    const el = getCol(row, "要素ID", "要素 ID", "element ID", "Element ID");
    if (!el) continue;
    const ctx = getCol(row, "コンテキストID", "コンテキスト ID", "context ID", "Context ID");
    if (!ctx || !ctx.includes("CurrentYearInstant")) continue;
    // 連結優先: NonConsolidatedMember を含むコンテキストは後回し(値が無い時のみ採用)
    const nonCons = ctx.includes("NonConsolidatedMember");
    const raw = getCol(row, "値", "value", "Value");
    const v = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    const mil = v / 1e6;

    for (const [key, ids] of Object.entries(FIRST_MATCH)) {
      if (!ids.includes(el)) continue;
      const slot = nonCons ? `${key}__nc` : key;
      if (found[slot] == null) found[slot] = mil;
    }
    if (INVENTORY_COMPONENTS.includes(el) && !nonCons) {
      if (invComponents[el] == null) invComponents[el] = mil;
    }
  }

  const pick = (key) => found[key] ?? found[`${key}__nc`] ?? null;
  let inventories = pick("inventories");
  if (inventories == null) {
    const comp = Object.values(invComponents);
    if (comp.length) inventories = comp.reduce((a, b) => a + b, 0);
  }

  const r = (n) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    total_assets: r(pick("total_assets")),
    net_assets: r(pick("net_assets")),
    receivables: r(pick("receivables")),
    inventories: r(inventories),
    payables: r(pick("payables")),
  };
}
