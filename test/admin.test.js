import assert from "node:assert/strict";
import test from "node:test";
import { FILE_BYTES, FILE_ID, call, makeEnv, seed2ch, seedUploader } from "./helpers.js";

function seededEnv() {
  const env = makeEnv();
  seedUploader(env);
  seed2ch(env);
  return env;
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

test("2ch 物理削除: posts と dat_lines の両方から消え、欠番になる", async () => {
  const env = seededEnv();
  const response = await call(env, "/2ch/posts/2/delete", { method: "POST" });
  assert.equal(response.status, 303);
  const db = env.simple_2ch_db.sqlite;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM posts WHERE no = 2").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dat_lines WHERE no = 2").get().c, 0);
  assert.deepEqual(db.prepare("SELECT no FROM posts ORDER BY no").all().map((r) => r.no), [1, 3]);
});

test("2ch 物理削除: 存在しない番号は 404", async () => {
  const response = await call(seededEnv(), "/2ch/posts/99/delete", { method: "POST" });
  assert.equal(response.status, 404);
});

test("未知のパスは 404", async () => {
  assert.equal((await call(seededEnv(), "/nope")).status, 404);
});
