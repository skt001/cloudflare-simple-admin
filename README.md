# simple-admin

cloudflare-simple-uploader と cloudflare-simple-2ch のための GUI 管理 Worker です。
各アプリ本体には管理画面を持たせず、この Worker に集約します。

## 警告(認証について)

**この Worker 自体に認証はありません。** 全ファイルの強制ダウンロード・強制削除、
掲示板のあぼーん・物理削除ができるため、**前段に Cloudflare Access を設定するまで
公開デプロイしないでください。** Access の設定が前提の運用です。

## できる操作

- ダッシュボード: uploader のファイル一覧(最新100件)と 2ch のレス一覧(最新100件)
- uploader
  - 強制ダウンロード: ダウンロードパスワードの有無にかかわらず、公開済みファイルを取得します
  - 強制削除: 削除キーの有無にかかわらず削除します。処理は uploader の ADMIN.md と同じで、
    files の行を消し、file_chunks / file_download_tokens / file_auth_attempts は
    ON DELETE CASCADE で消えます
- 2ch
  - あぼーん: 2ch の ADMIN.md のテンプレートどおり、posts の名前・メール・日付・ID・本文を
    書き換えます。dat キャッシュ(dat_lines)には触れません(アプリが読み取り時に直します)。
    1 番は対象外です
  - 物理削除: posts と dat_lines の両方から行を消します。**番号は詰めないため欠番になります。**
    1 番を物理削除すると、dat の1行目が持つスレッドタイトルが dat から失われます

## セットアップ

前提: uploader と 2ch がデプロイ済みで、D1 データベース
`simple-uploader-db` と `simple-2ch-db` が存在すること。

```sh
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 list   # 2つのデータベースの id を確認する
```

`wrangler.jsonc` に、確認した id で2つのバインディングを書きます。

```jsonc
"d1_databases": [
  { "binding": "simple_uploader_db", "database_name": "simple-uploader-db", "database_id": "<id>" },
  { "binding": "simple_2ch_db", "database_name": "simple-2ch-db", "database_id": "<id>" }
]
```

デプロイと Access の設定:

```sh
npx wrangler deploy
```

デプロイ後、Cloudflare Zero Trust の Access で、この Worker のホスト名に対する
アプリケーションを作成し、許可するメールアドレスだけが到達できるようにしてください。

## テスト

```sh
npm test
```

テスト用のスキーマは test/schema/ にあり、各プロジェクトの実際のマイグレーションの
コピーです(uploader: 0001〜0003、2ch: 0001〜0002)。
