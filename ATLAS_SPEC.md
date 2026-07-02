# ARGOS Atlas — 全上場統計DB 仕様書 (S1)

v4.1 "Panoptes" の共通基盤。EDINET有報 + JPX銘柄一覧から、全上場企業の
実数レコードと東証33業種×規模帯の分位統計を生成し、Bench / Model / Synthesis に供給する。

## ファイル構成

```
lib/atlas/
  metrics.js     指標計算 (純関数) — computeMetrics / sizeBand / STAT_METRICS
  stats.js       分位統計 (純関数) — buildStats / summarizeGroup / pickPeers
  bs-extract.js  XBRL行→追加BS項目 (総資産/純資産/売上債権/棚卸/仕入債務)
  record.js      XBRL行+書類メタ+JPXマスタ → 企業レコード
scripts/
  build-atlas.mjs   本番バッチ (EDINET巡回 → public/atlas/*.json)
  atlas-sample.mjs  合成サンプル生成 (開発用, meta.sample=true)
  test-atlas.mjs    単体テスト (ネットワーク不要)
api/atlas.js        配信エンドポイント (CORS許可)
public/atlas/       生成データ (companies.json / companies-lite.json / stats.json / meta.json)
```

## 運用

```bash
npm i                                 # xlsx (devDependency) を含む
npm run test:atlas                    # 単体テスト
npm run atlas:sample                  # 開発用サンプル (即時)
EDINET_API_KEY=xxx npm run atlas:build            # 本番 (全上場 60〜90分)
EDINET_API_KEY=xxx npm run atlas:build -- --limit 100   # 試運転
EDINET_API_KEY=xxx npm run atlas:build -- --industries "情報・通信業,サービス業"  # 段階投入
```

- キャッシュ: `.atlas-cache/` (日次一覧・企業別レコード)。再実行は差分のみ。`.gitignore` 推奨
- 更新頻度: **月次**でローカル or GitHub Actions 実行 → `public/atlas/` をコミット → デプロイ
- Vercel Cron での増分更新(当日提出分のみ)は S3 で KV とともに導入予定

## データ契約

### 企業レコード (companies.json の要素)

| フィールド | 型 | 説明 |
|---|---|---|
| code / name / edinet_code | string | 証券コード4桁 / 社名 / EDINETコード |
| industry33 / market | string | 東証33業種 / 市場区分 (JPXマスタ由来) |
| fy / period_end / basis / unit | string | 最新期ラベル / 期末日 / 連結・単体 / "百万円" |
| employees / average_salary | number | 従業員数 / 平均年収(**円**) |
| revenue / operating_profit | number | 最新期 (百万円) |
| cash / interest_bearing_debt | number | 現預金 / 有利子負債 (百万円) |
| total_assets / net_assets / receivables / inventories / payables | number | BS項目 (百万円) |
| size_band | string | S1(〜50億) S2(〜100億) S3(〜500億) S4(〜1000億) S5(1000億〜) |
| annual[] | array | 最大5期 (oldest→newest): revenue, cost_of_sales, gross_profit, sga, operating_profit, ordinary_profit, net_profit, operating_cf, investing_cf, free_cash_flow |
| metrics | object | 下表の派生指標 |

companies-lite.json は annual / business_summary を除いた軽量版。

### metrics (STAT_METRICS — Bench レーダー・Model 前提チェックの契約)

| キー | 単位 | 定義 |
|---|---|---|
| gp_margin / op_margin / net_margin / fcf_margin | % | 最新期の各利益率 |
| rev_cagr3 | % | 直近最大4期の売上CAGR |
| per_emp_revenue / per_emp_gp / per_emp_op | 百万円/人 | 人的生産性 |
| salary_m | 百万円 | 平均年収 |
| labor_share | % | 人件費(年収×人数)/粗利 |
| personnel_cost_ratio | % | 人件費/売上 |
| equity_ratio | % | 純資産/総資産 |
| net_de | 倍 | (有利子負債−現預金)/純資産 |
| roic | % | 営業利益×0.7 / (純資産+有利子負債) |
| dso / dio / dpo / ccc | 日 | 回転日数 (dio/dpo は売上原価ベース) |

### stats.json

```
{ generated_at, universe: {n, industries}, min_n: 5,
  industries: {
    "<業種名>": {
      n, metrics: { "<指標>": {n, p10, q1, med, q3, p90} },
      bands: { "S3": { n, metrics: {...} } }   // n>=5 の帯のみ
    } } }
```

## API

| リクエスト | レスポンス |
|---|---|
| `GET /api/atlas` | meta.json |
| `GET /api/atlas?stats=1` | 全統計 |
| `GET /api/atlas?stats=1&industry=化学&band=S3` | 業種×規模帯統計。帯が薄い場合 `fallback:"industry"` で業種全体を返す |
| `GET /api/atlas?code=7203` | 企業レコード (annual含む) |
| `GET /api/atlas?peers=7203&limit=10` | 同業・規模近接ピア (軽量レコード配列) |

静的直読みも可: `/atlas/stats.json` 等 (public 配下)。

## 実装メモ

- 33業種は JPX 東証上場銘柄一覧 (data_j.xls) 由来。ETF/REIT等は市場区分で除外
- 有報 (docTypeCode=120) のみ。訂正有報(130)は未対応 (S2で検討)
- 連結優先、単体のみの会社は単体値。IFRS要素 (jpigp_cor) にも対応
- n<5 のグループは統計非公開 (識別リスク+頑健性)
- ピア選定は S1 では「同業種×売上規模の対数距離」。S2 で事業内容 embedding に置換予定 (API契約は不変)

## S2 接続予定 (このデータを使う側)

- **Bench**: サンプル統計 → `/api/atlas?stats=1&industry=X&band=Y` に差し替え。ピア個社名表示は `?peers=`
- **Model**: 証券コード入力 → `?code=` で実績プリフィル。前提妥当性チェックは stats と突合
- **Equity Intelligence**: §03 競合分析へのピア実数注入
