# ARGOS  ·  v3.0  (Gemini Edition)

> **Institutional Equity Intelligence for Japanese listed markets**
> EDINET-backed financial analysis × Gemini AI × Sell-side PDF output
> Live: **https://argos-zeta.vercel.app**

---

## What's new in v3.0

| | v2.x (Claude Edition) | v3.0 (Gemini Edition) |
|---|---|---|
| **AI Provider** | Anthropic Claude Sonnet/Haiku | Google Gemini 2.5 Flash / Flash-Lite |
| **AI cost** | ~¥0.4 / 銘柄 | **¥0** (free tier: 1,500 req/日) |
| **Required API key** | ANTHROPIC_API_KEY | GEMINI_API_KEY |
| **マイカルテ機能** | あり | **削除** (簡素化) |
| **Coverage Tiers** | 5 段階 (FULL/EDINET/KARTE/LIMITED/DRAFT) | **3 段階** (FULL/LIMITED/DRAFT) |
| **履歴サイドバー** | ✓ | ✓ (継続) |
| **PDF 10ページ出力** | ✓ | ✓ (継続) |
| **Web 検索** | Claude web_search ツール | Gemini Google Search grounding |
| **Upstash KV (Redis)** | 必須 (karte 用) | **オプション** |

---

## Quick start

### 1. API keys を取得

| API | 取得先 | 料金 |
|---|---|---|
| **Gemini API** | https://aistudio.google.com/apikey | **無料** (1,500 req/日, 15 RPM) |
| **EDINET API** | https://api.edinet-fsa.go.jp/api/auth/index.aspx?mode=1 | **無料** (メール+SMS 登録) |

### 2. ローカル起動

```bash
git clone https://github.com/matu0620-pixel/Argos
cd argos
npm install
cp .env.example .env
# .env を編集して GEMINI_API_KEY と EDINET_API_KEY を設定
npm run dev
# → http://localhost:3000
```

### 3. Vercel デプロイ

```bash
npm run deploy
# Vercel ダッシュボードで環境変数を設定:
#   GEMINI_API_KEY  (必須)
#   EDINET_API_KEY  (必須)
#   KV_REST_API_URL, KV_REST_API_TOKEN (任意 — 履歴永続化用)
```

---

## アーキテクチャ

### 5-phase analysis pipeline (variable per call)

| Phase | 担当 | データソース | モデル |
|---|---|---|---|
| **Phase 1** | Profile + Pricing + Listing | Gemini + Google Search | Gemini 2.5 Flash |
| **Phase 2** | Financials (5 期分 P/L) | EDINET XBRL | (no AI) |
| **Phase 2.5** | Yahoo Finance | Yahoo (並列) | (no AI) |
| **Phase 3** | Risks + Competitive Analysis | Gemini + Google Search | Gemini 2.5 Flash |
| **Phase 4** | Investment Thesis | Gemini + Industry knowledge | Gemini 2.5 Flash |
| **Phase 5** | Report Authoring | (Phases 1-4 を統合) | Gemini 2.5 Flash-Lite |

### Gemini Compatibility Shim

`lib/gemini-client.js` が Anthropic SDK の `client.messages.create()` 互換 API を提供します。これにより analyze.js / analyze-stream.js のロジックを大幅変更せずに済みました。

```javascript
import GeminiClient from "../lib/gemini-client.js";
const client = new GeminiClient({ apiKey: process.env.GEMINI_API_KEY });

// Anthropic と同じインターフェース
const r = await client.messages.create({
  model: "gemini-2.5-flash",
  max_tokens: 8000,
  messages: [{ role: "user", content: prompt }],
  tools: [{ type: "google_search" }],  // ← Anthropic の "web_search" 相当
});
// r.content = [{ type: "text", text: "..." }]  ← Anthropic と同形
```

---

## ファイル構成

```
argos/
├── api/
│   ├── analyze.js              # 非ストリーミング分析 (Gemini)
│   ├── analyze-stream.js       # SSE ストリーミング分析 (Gemini)
│   ├── resolve-code.js         # 会社名 → 証券コード (Gemini Flash-Lite)
│   ├── history.js              # 履歴 (KV 任意)
│   ├── bench-financials.js     # ARGOS Bench 用 EDINET 実数取得
│   ├── auth.js                 # ログイン認証 (Edge)
│   ├── export-pdf.js           # 10 ページ機関投資家 PDF
│   └── edinet-test.js          # EDINET 接続デバッグ
├── lib/
│   ├── gemini-client.js        # ★ NEW: Anthropic SDK 互換シム
│   ├── prompt.js               # プロンプトテンプレート (Phase 1-5)
│   ├── edinet.js               # EDINET XBRL クライアント
│   ├── yahoo-finance.js        # Yahoo Finance スクレイピング
│   ├── code-resolver.js        # 会社名解決ロジック (Gemini)
│   ├── industry.js             # 業界プロファイル
│   ├── jpx-listing-criteria.js # TSE 上場区分判定
│   ├── ir-url-finder.js        # IR URL 検証
│   ├── market-segment.js       # 市場区分マッピング
│   ├── shikiho-tokushoku.js    # 四季報「特色」取得
│   ├── url-helpers.js          # URL ユーティリティ
│   ├── history.js              # 履歴ストレージ
│   ├── memos.js                # KV_AVAILABLE export のみ保持
│   └── fonts/NotoSansJP.ttf    # PDF 埋め込みフォント
├── public/
│   ├── index.html              # SPA (karte UI は削除)
│   └── version.json            # ビルド情報
├── package.json                # @anthropic-ai/sdk を削除済み
├── vercel.json                 # Vercel 設定 (300s timeout, font include)
└── .env.example                # GEMINI_API_KEY 用に更新済み
```

---

## v2 からの移行ガイド

### コードの主な変更点

```diff
- import Anthropic from "@anthropic-ai/sdk";
+ import GeminiClient from "../lib/gemini-client.js";

- const apiKey = process.env.ANTHROPIC_API_KEY;
+ const apiKey = process.env.GEMINI_API_KEY;

- const client = new Anthropic({ apiKey });
+ const client = new GeminiClient({ apiKey });

  await client.messages.create({
-   model: "claude-sonnet-4-5-20250929",
+   model: "gemini-2.5-flash",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
-   tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
+   tools: [{ type: "google_search", name: "web_search", max_uses: 10 }],
  });
```

### 削除された機能

- **マイカルテ機能を完全削除** — 関連コード（解析パイプライン・プロンプト・PDF・UI）と表示をすべて除去。スタブ `lib/karte.js` / `api/karte.js` も廃止。
- Coverage Tier は EDINET 充実度ベースの 3 段階（FULL / LIMITED / DRAFT）
- KV (Upstash Redis) 必須要件 → オプション化（履歴用）

### 保持された機能

- 履歴サイドバー (KV があれば永続化、なければ instance memory)
- 10 ページ PDF 出力 (pdfkit、Phase 5 で生成)
- 会社名検索 + 確認画面 (新形式コード 173A 等含む)
- EDINET 5 期分財務 + 事業の内容 全文展開

---

## Gemini 無料枠の制限と運用Tips

| モデル | 1 日 | 1 分 | 用途 |
|---|---|---|---|
| Gemini 2.5 Flash | 1,500 req | 15 req | Phase 1, 3, 4 (重い分析) |
| Gemini 2.5 Flash-Lite | 1,500 req | 30 req | Phase 5 + コード解決 (軽量) |

1 銘柄の完全分析 = 約 4 リクエスト (Phase 1, 3, 4, 5)。1 日約 375 銘柄まで分析可能。

無料枠を超えると 429 (Rate Limit) エラーになるため、本格運用時は **Paid tier** へのアップグレードを検討してください。Paid tier は従量課金 (~$0.075 / 1M tokens) で、月数千円〜の範囲です。

---

## License

Internal use only. Not for redistribution.
