# admin

cloudflare-simple-uploader と cloudflare-simple-2ch のための GUI 管理 Worker です。
各アプリ本体には管理画面を持たせず、この Worker に集約します。

## 認証について

HTTP Basic 認証をかけています。

- ID: メールアドレスっぽい文字列なら何でも構いません(形の判定は
  cloudflare-simple-ai と同じく、HTML 仕様(WHATWG)の「valid email address」の
  正規表現で確認します)。許可リストはありません
- パスワード: デプロイ時に `wrangler secret put ADMIN_PASSWORD` で設定した
  ものと照合します。**実質はパスワードのみの認証です。** ID は、誰が入ったかを
  ログに残すための名乗りとして扱います(admin や root の固定 ID よりはマシ、
  という位置づけです)
- シークレットが未設定の場合、この Worker は全てのリクエストを 503 で拒否します
- ログイン試行(資格情報を持ったリクエスト)は admin 専用の D1 `simple-admin-db` の
  `access_log` に記録され、ダッシュボードの「アクセスログ」で最新100件を見られます
- Basic 認証のため、ログアウトはできません。総当たりへのレート制限もありません
  (失敗は全件ログに残ります)

## できる操作

- ダッシュボード: uploader のファイル一覧(最新100件)と 2ch のレス一覧(最新100件)
- uploader
  - 強制ダウンロード: ダウンロードパスワードの有無にかかわらず、公開済みファイルを取得します
  - 強制削除: 削除キーの有無にかかわらず削除します。処理は uploader の ADMIN.md と同じで、
    files の行を消し、file_chunks / file_download_tokens / file_auth_attempts は
    ON DELETE CASCADE で消えます
  - 初期化: 全ファイルを削除して空に戻します(確認画面あり)。次のアップロードは No.1 からです
- 2ch
  - あぼーん: 2ch の ADMIN.md のテンプレートどおり、posts の名前・メール・日付・ID・本文を
    書き換えます。dat キャッシュ(dat_lines)には触れません(アプリが読み取り時に直します)。
    1 番は対象外です
  - 物理削除: **2 番以降の末尾のレスのみ**対象です。posts と dat_lines の両方から行を消します。
    途中を消すと欠番になり、番号を持たない dat の行位置とレス番号がずれるため、
    末尾でない番号は指定しても拒否されます。1 番はあぼーんと同じく対象外で、
    1 番ごと消す場合は「1含めて初期化」を使います
  - 1以外初期化: 2 番以降を全て削除し、タイトルと 1 番だけを残します(確認画面あり)
  - 1含めて初期化: 全レスとスレッドを削除し、初期化前の状態に戻します(確認画面あり)
  - 1 番の作成: スレッドがないときだけダッシュボードにフォームが出ます。init.sql と同じく
    thread と 1 番(名無しさん / ID: Admin001)を作成します。日付は実行時点の JST です
- アクセスログ: ログイン試行の記録(日時・ID・成功/失敗・IP・パス・User-Agent)を
  ダッシュボードに表示します(最新100件)

## セットアップ

前提: uploader と 2ch がデプロイ済みで、D1 データベース
`simple-uploader-db` と `simple-2ch-db` が存在すること。

まず設定ファイルをコピーし、アクセスログ用の D1 を作ります。作成の際、
Wrangler が `wrangler.jsonc` へ `d1_databases` を追記するので、提案を受け入れて
ください(バインディング名は DB 名から生成される `simple_admin_db` で、
コードはこの名前を使います)。その後、スキーマを適用します。

```sh
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create simple-admin-db
npx wrangler d1 execute simple-admin-db --remote --file ./admin-db.sql
npx wrangler d1 list   # 既存の2つのデータベースの id を確認する
```

`wrangler.jsonc` の `d1_databases` に残っている2か所の `database_id` の
プレースホルダを、確認した id に置き換えます
(`simple-uploader-db` と `simple-2ch-db` を取り違えないよう注意)。
追記された `simple_admin_db` のエントリは実 ID 入りなので、そのまま使います。

片方しか使わない、または片方の id が間違っている場合、その側はダッシュボードで
「未対応」と表示され、その側の操作は 503 になります。もう片方はそのまま使えます。

最後に、パスワードのシークレットを設定してデプロイします。

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

## テスト

```sh
npm test
```

テスト用のスキーマは test/schema/ にあり、各プロジェクトの実際のマイグレーションの
コピーです(uploader: 0001〜0003、2ch: 0001〜0002)。
