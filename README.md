# free-to-keep-game-radar

Steamで期間限定の100%割引になったゲームを検出し、新規キャンペーンだけをBuffer経由でXへ投稿するGitHub Actions Botです。各実行について、人間向けMarkdownと分析向けJSONのレポートを追記保存します。

## 対象

次の条件を満たすSteam商品だけを対象にします。

- 種別がゲーム
- 通常価格が0より大きい
- 現在価格が0
- 割引率が100%
- 常時無料（F2P）ではない
- 日本向けSteamストアで取得可能

無料週末、デモ、DLC、常時無料ゲーム、「現在はF2Pだが将来有料化予定」のゲームは対象外です。

## 動作

GitHub Actionsが毎日04:17（Asia/Tokyo）に以下を実行します。

1. Steam Store検索から100%割引候補を取得
2. Steamの商品詳細でゲーム種別、通常価格、割引率を再検証
3. `data/state.json`と比較して新規キャンペーンを判定
4. 有効化されていればXへ投稿
5. `reports/YYYY/MM/`へMarkdownとJSONを新規作成
6. 状態とレポートをリポジトリへcommit

同一ゲームでも、配布終了を2回連続で確認した後に再配布された場合は、新しいキャンペーンとして扱います。

## GitHub設定

Steamの検出にAPIキーやログイン情報は不要です。X投稿には無料のBufferアカウントを使用します。BufferでXチャンネルを接続した後、Repository Settingsの `Secrets and variables` → `Actions` に以下を登録します。

### Secrets

| 名前                | 内容                                        |
| ------------------- | ------------------------------------------- |
| `BUFFER_API_KEY`    | Buffer Personal API Key（`postsWrite`権限） |
| `BUFFER_CHANNEL_ID` | Bufferに接続したXチャンネルのChannel ID     |

APIキーはBufferの `Settings` → `API` → `Personal Access` で作成します。有効期限は最長1年で、期限前に再生成してGitHub Secretを更新する必要があります。Channel IDはBuffer API Explorerで、まずOrganization IDを取得します。

```graphql
query GetOrganizations {
  account {
    organizations {
      id
      name
    }
  }
}
```

次に取得したIDを指定してチャンネルを取得します。

```graphql
query GetChannels {
  channels(input: { organizationId: "取得したOrganization ID" }) {
    id
    name
    service
  }
}
```

レスポンス内で `service` が `twitter` のチャンネルIDを使用してください。認証情報はファイルやログへ保存しないでください。

### Variables

| 名前             | 推奨値     | 説明                                                     |
| ---------------- | ---------- | -------------------------------------------------------- |
| `POST_TO_X`      | `true`     | `true`の場合だけXへ投稿。未設定時は投稿せずpendingを維持 |
| `STEAM_COUNTRY`  | `JP`       | 判定対象の国                                             |
| `STEAM_LANGUAGE` | `japanese` | Steamレスポンスの言語                                    |

投稿はBufferの `shareNow` を使用して即時送信します。X Developer AppやX APIクレジットは不要です。Buffer無料プランのAPIリクエスト数や投稿数の制限は、Bufferの最新プラン条件に従います。

投稿文はXの加重文字数上限（280）を安全側に計算します。長いゲーム名は書記素単位で末尾を `…` に省略し、絵文字の結合列を途中で分割せず、案内文・配布URL・ハッシュタグを必ず残します。

### 接続テスト

Actionsの `Daily free-to-keep scan` を手動実行し、`Send one visible Buffer-to-X connection test post`を有効にすると、日時入りのテスト投稿を1件だけ即時送信します。この入力は定期実行では使用されません。

## レポート

レポートは上書きせず、Run IDとAttemptを含む名前で毎回新規作成します。

```text
reports/2026/10/
├─ 2026-10-07_041723_JST_run-123456789_attempt-1.md
└─ 2026-10-07_041723_JST_run-123456789_attempt-1.json
```

レポートには実行日時、検出件数、投稿結果、現在配布中の商品、エラーを記録します。秘密情報や外部サービスのレスポンス全文は記録しません。

## ローカル実行

```shell
npm ci
npm run check
npm start
```

既定ではX投稿は無効です。環境変数は `.env.example` を参照してください。Node.js 22以降が必要です。

## 注意事項

Steam Store検索とappdetailsは公開ストアが使用するエンドポイントですが、安定した製品APIとして保証されたものではありません。取得処理はProviderとして分離してあり、レスポンス変更時に交換できる設計です。
