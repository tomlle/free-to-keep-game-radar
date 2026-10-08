# free-to-keep-game-radar

日本向けゲームストアの無料キャンペーンを見つけてXへ投稿するBotです。無料で入手して終了後も遊べる配布と、期間中だけ遊べる一時プレイ無料を区別して告知します。

現在はSteamに対応し、次の3種類を監視しています。

- 有料ゲームの期間限定無料配布（100%割引）
- 有料ゲームを期間中だけ遊べる一時プレイ無料
- 現在は無料だが、今後有料化されるゲーム

cron-job.orgからGitHub Actionsを定期起動し、検出、投稿、状態更新、実行レポートの保存を行います。

## 投稿例

### 期間限定無料配布

```text
無料配布🎁

『ゲームタイトル』
¥1,200 → 無料（100% OFF）
⏰ 10/8 09:00まで

https://store.steampowered.com/app/000000/

#ゲーム無料配布 #Steam #もろとこ
```

### 有料化予定

```text
もうすぐ有料⚠️

『ゲームタイトル』
現在無料 → 10月13日以降に有料化予定

https://store.steampowered.com/app/000000/

#ゲーム無料配布 #Steam #もろとこ
```

### 一時プレイ無料

```text
一時プレイ無料🎮

『ゲームタイトル』
期間限定で無料プレイ
⏰ 10/5 09:00〜10/8 09:00

気になってたゲームを、この機会に遊んでみよう！

https://store.steampowered.com/app/000000/

#ゲーム無料プレイ #Steam #もろとこ
```

有料化の正確な日付が発表されていない場合は「近日中に有料化予定」と表示します。投稿内の日付と時刻はすべて日本標準時（JST）で表示します。投稿文はXの加重文字数上限を計算し、必要な場合はゲームタイトルだけを書記素単位で省略します。URLとハッシュタグは必ず残ります。

## 検出条件

### 期間限定無料配布

以下をすべて満たすSteam商品を対象にします。

- 商品種別がゲーム
- 通常価格が0より大きい
- 現在価格が0
- 割引率が100%
- 常時無料（Free to Play）ではない
- 日本向けSteamストアで取得可能

デモ、DLC、常時無料ゲームは除外します。

### 一時プレイ無料

Steamの無料候補検索に掲載され、商品データに一時プレイ中であることが明示されたうえで、以下をすべて満たす商品を対象にします。

- 商品種別がゲーム
- 通常価格が0より大きい有料ゲーム
- 商品詳細上の現在価格が0より大きい
- 常時無料（Free to Play）ではない
- 日本向けSteamストアで取得可能

一時プレイ無料は所有権を獲得する無料配布とは区別し、終了後も遊ぶには購入が必要であることを告知します。

### 有料化予定

Steam公式ニュースを有料化に関する複数の表現で検索し、見つかったゲームの商品情報とニュース本文を再検証します。以下をすべて満たす場合だけ投稿します。

- 商品種別がゲーム
- 日本向けSteamストアで現在無料
- 公式ニュースに無料から有料へ移行する旨が記載されている
- 無料期間中の取得者が、有料化後もアクセスを保持できると明記されている

検索から新しく検出する場合は、30日以内の公式ニュースを対象にします。一度検出した有料化イベントは、実際に有料化されるまで継続して確認します。

## 処理の流れ

cron-job.orgから毎日00:15・08:15・17:15・18:15（UTC）にGitHub Actionsを起動し、次の順番で実行します。日本時間では09:15・17:15・翌02:15・翌03:15です。17:15・18:15（UTC）の2回は、Steamの標準更新時刻である10:00（America/Los_Angeles）の夏時間と冬時間をそれぞれカバーします。

1. Steam Storeから100%割引候補と一時プレイ無料候補を取得
2. 商品詳細を使ってそれぞれの条件を再検証
3. 未投稿のキャンペーンをXへ投稿
4. 期間限定無料配布の処理完了後、Steam公式ニュースから有料化予定を探索
5. 未投稿の有料化告知をXへ投稿
6. 状態と実行レポートをリポジトリへ保存

GitHub Actions側にはスケジュールを定義せず、手動実行とcron-job.orgからの`workflow_dispatch`だけを受け付けます。

投稿状態をリポジトリ内に保持するため、同じキャンペーンは重複投稿しません。有料化予定はApp ID単位のイベントとして管理し、複数の続報が公開されても再投稿せず、関連ニュースとして同じイベントへ記録します。実際に有料化された後、再び無料化されて新しい有料化告知が出た場合だけ、次の世代のイベントとして扱います。

## cron-job.orgの設定

GitHubでFine-grained personal access tokenを作成し、Repository accessをこのリポジトリだけに限定して、Repository permissionsの`Actions`へ`Read and write`を付与します。トークンはリポジトリへ保存せず、cron-job.orgのリクエストヘッダーだけに設定します。

[cron-job.org Console](https://console.cron-job.org/)で次のジョブを作成します。

- Title: `free-to-keep-game-radar`
- URL: `https://api.github.com/repos/tomlle/free-to-keep-game-radar/actions/workflows/daily.yml/dispatches`
- Request method: `POST`
- Schedule timezone: `UTC`
- Schedule: 毎日、時刻は`00:15`・`08:15`・`17:15`・`18:15`
- Request timeout: `30`秒
- Save responses: 有効
- Failure notification: 1回目の失敗から通知
- Success notification: 障害復旧時に通知

リクエストヘッダーは次のとおりです。`YOUR_FINE_GRAINED_PAT`は作成したトークンへ置き換えます。

```text
Accept: application/vnd.github+json
Authorization: Bearer YOUR_FINE_GRAINED_PAT
Content-Type: application/json
X-GitHub-Api-Version: 2026-03-10
```

リクエスト本文には次のJSONを設定します。

```json
{
  "ref": "main",
  "inputs": {
    "verify_buffer": false,
    "trigger_source": "cron-job.org"
  },
  "return_run_details": true
}
```

保存後にcron-job.orgのテスト実行を行い、GitHub Actionsに`workflow_dispatch`の実行が作成され、`Record trigger source`へ`cron-job.org`と記録されることを確認します。cron-job.orgのアカウントには多要素認証を設定し、PATの有効期限前に更新します。

## ディレクトリ構成

```text
.
├─ .github/workflows/       GitHub Actions
├─ data/                    検出対象と重複投稿防止の状態
├─ reports/                 期間限定無料配布の実行レポート
│  └─ paid-transitions/     有料化予定の実行レポート
├─ src/
│  ├─ providers/            ストアごとの検出処理
│  └─ publishers/           投稿処理
└─ tests/                   単体テスト
```

## レポート

各実行についてMarkdownとJSONを新規作成します。既存レポートは上書きしません。

```text
reports/YYYY/MM/YYYY-MM-DD_HHMMSS_JST_run-RUN_ID_attempt-N.md
reports/YYYY/MM/YYYY-MM-DD_HHMMSS_JST_run-RUN_ID_attempt-N.json

reports/paid-transitions/YYYY/MM/YYYY-MM-DD_HHMMSS_JST_run-RUN_ID_attempt-N.md
reports/paid-transitions/YYYY/MM/YYYY-MM-DD_HHMMSS_JST_run-RUN_ID_attempt-N.json
```

レポートには実行日時、検出件数、投稿結果、検出商品、エラーを記録します。認証情報や外部サービスのレスポンス全文は保存しません。

## 開発

Node.js 22以降が必要です。

```shell
npm ci
npm run check
```

主なコマンド：

```shell
npm start                         # 期間限定無料配布を検出
npm run start:paid-transitions    # 有料化予定を検出
npm test                          # 単体テスト
npm run typecheck                 # 型チェック
```

ローカル実行では、明示的に有効化しない限りXへ投稿しません。

## 技術上の注意

Steam Store検索と`appdetails`はSteamストアが利用する公開エンドポイントですが、安定した製品APIとして保証されたものではありません。レスポンスやHTML構造の変更により検出処理の更新が必要になる場合があります。

このBotは無料取得や購入を自動実行しません。配布条件や終了日時は変更される可能性があるため、取得前に必ずストアページを確認してください。
