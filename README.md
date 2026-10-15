# kametti

推しの Spoon 配信を手伝う Discord ボットです。**Spoon Developers 公式 API** だけを使います（旧版の非公式ライブラリ `@sopia-bot/core` は使いません）。

- 仕様書: [docs/spec.md](docs/spec.md)
- Spoon Developers への申請内容: [docs/app-purpose.md](docs/app-purpose.md)
- 公式ドキュメント: https://developers.spooncast.net/docs/ja/
- 利用規約: https://spoonvip.oopy.io/static/terms/jp/developerterms

## 機能（予定）

| 機能 | 内容 |
| ---- | ---- |
| Spoon 連携 | Discord の `/link` で発行した URL から、推しが Spoon の同意画面で許可する |
| 配信の通知 | 推しの配信が始まったら Discord に「配信に参加」ボタン付きで通知する |
| 参加・退室 | `/join`・`/leave`（ボタン）で、ボットが配信に入る・抜ける。自動では参加しない |
| コメント送信 | Discord のチャットチャンネルへの投稿を、ボット名で配信チャットに送る |
| ハートコメント | 無料ハート・有料ハート1個に、決まった文面を送る。`!ハート on/off`・`/heart` で切り替え |
| ダジャレ判定 | 登録したリスナーのダジャレ候補を Discord に投稿し、⭕/❌ で投票する |

現在は段階3（配信の検知と参加）です。段階は仕様書 §12 を参照してください。

## 使う公式 API

`GET /v1/live`、`GET /v1/live/events`、`POST /v1/live/chat`、`POST /v1/oauth/token`、`POST /v1/oauth/revoke` だけです。権限は `live.read`、`events.chat`、`events.like`、`chat.send` の4つです。ほかの API は HTTP クライアント（`src/spoon/http.ts` の `ALLOWED_ENDPOINTS`）が送信前に拒否します。

## 開発

必要なもの: Node.js 22.6以上、pnpm 10

```sh
pnpm install
cp .env.example .env   # 値を設定する。.env はコミットしない
pnpm mock              # Spoon API のモックサーバー（http://localhost:8788）
```

運用承認の前は、開発・テストをモックで行います（実際の配信には接続しません）。

| コマンド | 内容 |
| -------- | ---- |
| `pnpm dev` | ボットと連携用ページを起動（ファイル変更で再起動。`.env` のすべての値が必要） |
| `pnpm mock` | Spoon API のモックサーバーを起動 |
| `pnpm test` | テストを実行（Vitest、DB は PGlite） |
| `pnpm test:pg` | 本物の PostgreSQL でテストを実行（`TEST_DATABASE_URL`。テストごとにスキーマを作って削除する） |
| `pnpm db:migrate` | `DATABASE_URL` のデータベースにスキーマを適用 |
| `pnpm check` | 型チェック |
| `pnpm lint` | Lint・フォーマットの確認（Biome） |
| `pnpm format` | フォーマットを適用 |
| `pnpm build` | `dist/` にビルド |
| `pnpm start` | ビルドしたものを起動 |

### モックの操作

`/__mock` 以下のエンドポイントで、配信やイベントを起こせます。

| エンドポイント | 本文の例 | 内容 |
| -------------- | -------- | ---- |
| `POST /__mock/start-live` | `{"title":"テスト配信"}` | 配信を始める |
| `POST /__mock/end-live` | なし | 配信を終える（`LIVE_ENDED`） |
| `POST /__mock/chat` | `{"id":"l1","nickname":"リスナー1","message":"こんにちは","isDj":false}` | チャットを送る |
| `POST /__mock/like` | `{"id":"l1","type":"FREE"}`、`{"id":"l1","type":"PAID","totalAmount":10}` | ハートを送る |
| `POST /__mock/blocked` | `{"value":true}` | DJ がボットをブロックする |
| `POST /__mock/chat-frozen` | `{"value":true}` | チャットを凍結する |
| `POST /__mock/end-streams` | `{"reason":"TOKEN_EXPIRED"}` | 接続を指定の理由で終える |
| `POST /__mock/drop-streams` | なし | 通信断を再現する |
| `POST /__mock/revoke` | なし | DJ が連携を解除した状態にする |
| `GET /__mock/state` | — | 配信・接続・送信したチャットの数 |

同意画面（`/jp/oauth/authorize`）は省略され、すぐに `code` 付きでリダイレクトされます。`mock_deny=1` を付けると、同意しなかった場合（`error=access_denied`）を再現できます。Windows の curl で日本語を送ると文字化けするため、日本語を含む本文はファイルに保存して `--data-binary @body.json` で送ってください。
