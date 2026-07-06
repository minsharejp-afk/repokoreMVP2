# れぽこれ！ MVP（GitHub + Cloudflare）

テナントがスマホで精算レシートを撮影・送信 → サーバ側で **Gemini** が読み取り → **管理者がPCブラウザで不読修正・承認** する最小構成。

## 構成
- **Cloudflare Pages**: 静的な管理者画面 + API（Pages Functions）を同一オリジンでホスト
- **Pages Functions（`/functions/api`）**: 送信受付・一覧・承認・画像配信のAPI。**Geminiはここでシークレットのキーを使って呼ぶ**（ブラウザにキーを出さない）
- **D1**: 売上報告データ（純売上・客数・式の計算結果・状態）
- **R2**: レシート画像
- **算術はサーバ側で確定計算**（純売上＝総売上−返品−割引）。Geminiは画像からの構造抽出のみ。

```
public/index.html      … 管理者画面（PCブラウザ）
public/tenant.html     … テナント用スマホアプリ（ログイン→撮影→送信）
functions/api/…        … API（Pages Functions）
schema.sql             … D1スキーマ
wrangler.jsonc         … バインディング設定
```

## デプロイ手順（GitHub → Cloudflare）
前提: Node.js、`npm i -g wrangler`、Cloudflareアカウント、Gemini APIキー。

1. **このフォルダをGitHubリポジトリにpush**。
2. **D1を作成**: `wrangler d1 create repokore` → 出力の `database_id` を `wrangler.jsonc` に記入。
3. **スキーマ適用**: `wrangler d1 execute repokore --remote --file=schema.sql`
4. **R2バケット作成**: `wrangler r2 bucket create repokore-receipts`
5. **Cloudflare Pagesプロジェクト作成**: ダッシュボード → Workers & Pages → Pages → 「Connect to Git」で当リポジトリを接続。ビルド設定はフレームワークなし、出力ディレクトリ `public`。
6. **バインディングを設定**: Pagesプロジェクト → Settings → Bindings で D1（変数名 `DB`）と R2（変数名 `BUCKET`）を追加。`wrangler.jsonc` を真実の情報源にしてもよい。
7. **シークレット登録（重要）**: `wrangler pages secret put GEMINI_API_KEY`（対話でキーを貼付）。**キーはコードや設定ファイルに書かない**。
8. デプロイ後、`https://<project>.pages.dev/` が管理者画面、`/tenant.html` がテスト送信、`/api/...` がAPI。

ローカル確認: `.dev.vars.example` を `.dev.vars` にコピーしてキーを記入 → `wrangler pages dev`。

## テナント用スマホアプリ（同梱・作り直し版）
テナントアプリは `public/tenant.html` として同梱し、管理者画面と一緒にデプロイされます（スマホ利用）。
実物フロー準拠：ログイン → 売上日・レシート選択 → カメラ撮影（青いガイド枠／撮り方ガイド）→ 確認 → 送信完了。
送信すると同一オリジンの `/api/submissions` へ画像がPOSTされ、管理者画面（`/`）に自動反映されます。
- テナント: `https://<project>.pages.dev/tenant.html`（スマホのカメラを使うため https でのアクセスが必要）
- 管理者:   `https://<project>.pages.dev/`（PCブラウザ）

（参考）別途、既存の自社アプリから繋ぐ場合も、撮影画像を base64 にして以下へ **POST** するだけです。

```
POST https://<project>.pages.dev/api/submissions
Content-Type: application/json
{
  "tenant": "ビームス 六本木ヒルズ",
  "sale_date": "2026-07-02",
  "image_base64": "<画像のbase64（データURLの ',' 以降）>",
  "mime": "image/jpeg"
}
→ 200 { "id": "..." }
```
別オリジンから呼ぶ場合はCORSが必要です（APIは暫定で `*` を許可）。**本番では `_lib.js` の許可オリジンを自社アプリのドメインに限定**してください。

## セキュリティ上の注意（本番前に必ずレビュー）
- `GEMINI_API_KEY` は必ず **Pagesシークレット** で登録し、コード／設定に書かない。用途・APIを最小権限に制限し、漏洩時はローテーション。
- 撮影画像は Google（Gemini）へ送信される（外部通信）。実データ投入はプライバシー判断の起動線。無料枠は学習利用の可能性があるため、本番は有料枠／Vertex等の非学習構成を検討。
- CORSの許可オリジンを自社ドメインに限定。認証（テナント／管理者のログイン）は本MVPに未実装なので、本番前に追加すること。
- 承認は人間が行う Human-in-the-loop を維持（自動確定しない）。
