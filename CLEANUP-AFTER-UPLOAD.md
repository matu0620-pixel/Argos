# ARGOS デプロイ後 - GitHub 残存ファイル削除チェックリスト

ZIP に含まれていないファイルが GitHub に残っていると、その古いファイルが本番にデプロイされ続けます。
以下のファイルが GitHub に残っている場合、**手動で削除してください**:

## 必ず削除すべきファイル

### 1. `lib/ir-news-finder.js` (削除済み)
- 場所: https://github.com/matu0620-pixel/Argos/tree/main/lib
- 操作: ファイル名をクリック → 右上の `🗑 (ゴミ箱アイコン)` または `︙` メニュー → "Delete file" → "Commit changes"

### 2. `api/memos.js` (削除済み)
- 場所: https://github.com/matu0620-pixel/Argos/tree/main/api
- 操作: 同上

### 3. `lib/memos.js` 内の旧コード(残してOK)
- このファイル自体は残しておきますが、API からは使われていません

## 削除手順 (図解)

```
1. GitHub リポジトリを開く
   https://github.com/matu0620-pixel/Argos

2. lib/ フォルダをクリック

3. ir-news-finder.js が表示されている場合:
   - ファイル名をクリックして開く
   - 右上の鉛筆マーク横の「ゴミ箱アイコン」をクリック
   - 下のコミットメッセージで "delete: remove ir-news-finder.js" と入力
   - "Commit changes" をクリック

4. api/ フォルダで同様に memos.js を削除

5. Vercel が自動再デプロイ(緑の Ready バッジを待つ)

6. ブラウザで Ctrl+Shift+R (Mac: Cmd+Shift+R) で強制リフレッシュ
```

## デプロイ確認方法

### バージョン確認
```
https://argos-zeta.vercel.app/version.json
```

期待値:
```json
{
  "version": "2.1.0",
  "build_signature": "argos-2.1.0-institutional-pdf-no-ir-news",
  "features": {
    "ir_news_section": false,
    "phase5_report_authoring": true,
    "institutional_pdf_export": true
  }
}
```

もし古いバージョン (1.x) が返るか、404 になる場合は、ZIP のアップロードが完全ではありません。

### PDF 生成診断
```
https://argos-zeta.vercel.app/api/export-pdf-diagnostic
```

期待値:
```json
{
  "status": "OK",
  "font_check": { "found": "/var/task/lib/fonts/NotoSansJP.ttf" },
  "pdfkit_check": { "imported": true },
  "generator_check": { "imported": true }
}
```

### ブラウザキャッシュ問題

サイトを開いた後に Ctrl+Shift+R (Windows) または Cmd+Shift+R (Mac) で強制リフレッシュしてください。
それでも IR ニュースセクションが見える場合、Vercel Edge Network のキャッシュなので 5-10 分待ってください。

## 更にトラブルシューティング

ブラウザの開発者ツール → Console で以下を実行:
```javascript
document.querySelector('meta[name="argos-build-version"]').content
```
返り値が `"2.1.0-institutional-pdf-no-ir-news"` であれば、最新版がブラウザに読み込まれています。
