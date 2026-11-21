import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FILE_BYTES, FILE_ID, FakeD1, call, makeEnv, seed2ch, seedUploader } from "./helpers.js";

function seededEnv() {
  const env = makeEnv();
  seedUploader(env);
  seed2ch(env);
  return env;
}

// テーブルのない空の DB(database_id の間違いで対象外の DB を指した状態の再現)。
function emptyDb() {
  const db = Object.create(FakeD1.prototype);
  db.sqlite = new DatabaseSync(":memory:");
  return db;
}

test("ダッシュボード: uploader のファイルと 2ch のレスが表示される", async () => {
  const response = await call(seededEnv(), "/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("test.txt"));
  assert.ok(html.includes("テストスレ"));
  assert.ok(html.includes("消したいレス"));
});

test("uploader 強制ダウンロード: パスワード付きでもチャンクを結合して返す", async () => {
  const response = await call(seededEnv(), `/uploader/files/${FILE_ID}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Length"), String(FILE_BYTES.length));
  assert.ok(response.headers.get("Content-Disposition").includes("test.txt"));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), FILE_BYTES);
});

test("uploader 強制ダウンロード: アップロード中と存在しないファイルは 404", async () => {
  const env = seededEnv();
  assert.equal((await call(env, "/uploader/files/99999999-9999-4999-8999-999999999999/download")).status, 404);
  assert.equal((await call(env, "/uploader/files/no-such-id/download")).status, 404);
});

test("uploader 強制削除: files の行とカスケード対象が消える", async () => {
  const env = seededEnv();
  const response = await call(env, `/uploader/files/${FILE_ID}/delete`, { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_uploader_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM files WHERE id = ?").get(FILE_ID).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM file_chunks WHERE file_id = ?").get(FILE_ID).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM file_download_tokens WHERE file_id = ?").get(FILE_ID).c, 0);
});

test("uploader 強制削除: 存在しないファイルは 404", async () => {
  const response = await call(seededEnv(), "/uploader/files/no-such-id/delete", { method: "POST" });
  assert.equal(response.status, 404);
});

test("2ch あぼーん: ADMIN.md のテンプレートどおりに書き換わる", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/posts/2/abon", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  const row = db.prepare("SELECT name, mail, date_text, poster_id, message FROM posts WHERE no = 2").get();
  assert.deepEqual({ ...row }, { name: "あぼーん", mail: "", date_text: "あぼーん", poster_id: "", message: "あぼーん" });
  // dat キャッシュには触れない(あぼーんの思想どおり)
  assert.equal(db.prepare("SELECT message FROM dat_lines WHERE no = 2").get().message, "消したいレス");
});

test("2ch あぼーん: 1 番は対象外で変わらない", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/posts/1/abon", { method: "POST" });
  assert.equal(response.status, 303);
  const row = env.simple_2ch_db.sqlite.prepare("SELECT message FROM posts WHERE no = 1").get();
  assert.equal(row.message, "最初のレス");
});

test("2ch 物理削除: 末尾なら posts と dat_lines の両方から消える", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/posts/3/delete", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM posts WHERE no = 3").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dat_lines WHERE no = 3").get().c, 0);
  assert.deepEqual(db.prepare("SELECT no FROM posts ORDER BY no").all().map((r) => r.no), [1, 2]);
});

test("2ch 物理削除: 末尾でない番号は拒否され、残る", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/posts/2/delete", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM posts WHERE no = 2").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dat_lines WHERE no = 2").get().c, 1);
});

test("ダッシュボード: 物理削除ボタンは末尾のレスにだけ出る", async () => {
  const response = await call(seededEnv(), "/");
  const html = await response.text();
  assert.ok(html.includes("/2ch/posts/3/delete"));
  assert.ok(!html.includes("/2ch/posts/2/delete"));
  assert.ok(!html.includes("/2ch/posts/1/delete"));
});

test("2ch 物理削除: 存在しない番号は 404", async () => {
  const response = await call(seededEnv(), "/2ch/posts/99/delete", { method: "POST" });
  assert.equal(response.status, 404);
});

test("未知のパスは 404", async () => {
  assert.equal((await call(seededEnv(), "/nope")).status, 404);
});

test("uploader 初期化: 確認画面に対象件数が出て、実行すると全件消える", async () => {
  const env = seededEnv();
  const confirm = await call(env, "/uploader/reset");
  assert.equal(confirm.status, 200);
  assert.ok((await confirm.text()).includes("全 2 件"));
  const response = await call(env, "/uploader/reset", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_uploader_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM files").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM file_chunks").get().c, 0);
});

test("2ch 1以外初期化: 確認画面に対象件数が出て、実行すると 1 番だけ残る", async () => {
  const env = seededEnv();
  const confirm = await call(env, "/2ch/reset/except-first");
  assert.equal(confirm.status, 200);
  assert.ok((await confirm.text()).includes("2 番以降の 2 件"));
  const response = await call(env, "/2ch/reset/except-first", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  assert.deepEqual(db.prepare("SELECT no FROM posts ORDER BY no").all().map((r) => r.no), [1]);
  assert.deepEqual(db.prepare("SELECT no FROM dat_lines ORDER BY no").all().map((r) => r.no), [1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM thread").get().c, 1);
});

test("2ch 1含めて初期化: スレッドごと消える", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/reset/all", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM posts").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dat_lines").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM thread").get().c, 0);
});

test("2ch 1番作成: スレッドがないときだけ作れる", async () => {
  const env = makeEnv();
  seedUploader(env);
  const form = new URLSearchParams({ title: "新しいスレッド", message: "最初の本文です" });
  const response = await call(env, "/2ch/first-post", { method: "POST", body: form });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  const thread = db.prepare("SELECT title FROM thread WHERE id = 1").get();
  assert.equal(thread.title, "新しいスレッド");
  const post = db.prepare("SELECT name, mail, poster_id, message, source FROM posts WHERE no = 1").get();
  assert.deepEqual({ ...post }, { name: "名無しさん", mail: "", poster_id: "Admin001", message: "最初の本文です", source: "web" });
  // 既にスレッドがある状態では作れない
  const again = await call(env, "/2ch/first-post", { method: "POST", body: new URLSearchParams({ title: "x", message: "y" }) });
  assert.equal(again.status, 303);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM posts").get().c, 1);
  assert.equal(db.prepare("SELECT title FROM thread WHERE id = 1").get().title, "新しいスレッド");
});

test("ダッシュボード: スレッドがないときは 1 番作成フォームが出る", async () => {
  const env = makeEnv();
  seedUploader(env);
  const html = await (await call(env, "/")).text();
  assert.ok(html.includes("/2ch/first-post"));
  assert.ok(!html.includes("/2ch/reset/all"));
});

test("片方の DB が対象外(id ミス相当)でも、もう片方は使える", async () => {
  const env = seededEnv();
  env.simple_2ch_db = emptyDb();
  const response = await call(env, "/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("test.txt"));
  assert.ok(html.includes("未対応です"));
  assert.equal((await call(env, "/2ch/reset/all")).status, 503);
  assert.equal((await call(env, "/2ch/posts/2/abon", { method: "POST" })).status, 503);
  assert.equal((await call(env, "/uploader/reset")).status, 200);
});

test("バインディング自体がない側も未対応になる", async () => {
  const env = seededEnv();
  delete env.simple_uploader_db;
  const response = await call(env, "/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("未対応です"));
  assert.ok(html.includes("テストスレ"));
  assert.equal((await call(env, "/uploader/reset")).status, 503);
});
