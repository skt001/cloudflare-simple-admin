import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

// node:sqlite を D1 の API(prepare / bind / first / all / run / batch)に見せる薄い層。
// スキーマは各プロジェクトの実際のマイグレーション(test/schema/ 配下にコピー)を使う。
class Statement {
  constructor(sqlite, sql) {
    this.statement = sqlite.prepare(sql);
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  async first() {
    return this.statement.get(...this.params) ?? null;
  }
  async all() {
    return { results: this.statement.all(...this.params).map((row) => ({ ...row })) };
  }
  async run() {
    const result = this.statement.run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
}

export class FakeD1 {
  constructor(schemaFile) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(readFileSync(new URL(`./schema/${schemaFile}`, import.meta.url), "utf8"));
  }
  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) {
    this.sqlite.exec(sql);
  }
}

export const ORIGIN = "https://admin.example.test";

export function makeEnv() {
  return {
    simple_uploader_db: new FakeD1("uploader.sql"),
    simple_2ch_db: new FakeD1("2ch.sql"),
  };
}

export async function call(env, path, options = {}) {
  return worker.fetch(new Request(new URL(path, ORIGIN), options), env);
}

// uploader: パスワード・削除キー付きの公開済みファイル(チャンク2つ)と、
// アップロード中のファイルを1件ずつ用意する。
export const FILE_ID = "12345678-1234-4123-8123-123456789abc";
export const FILE_BYTES = new TextEncoder().encode("hello admin world");

export function seedUploader(env) {
  const db = env.simple_uploader_db;
  db.exec(`INSERT INTO files (id, file_no, name, mime_type, size, comment, created_at, download_count, status, download_password_hash, delete_key_hash)
    VALUES ('${FILE_ID}', 1, 'test.txt', 'text/plain', ${FILE_BYTES.length}, 'テストファイル', 1795000000000, 3, 'ready', 'hash-pw', 'hash-dk')`);
  const stmt = db.sqlite.prepare("INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)");
  stmt.run(FILE_ID, 0, FILE_BYTES.slice(0, 6));
  stmt.run(FILE_ID, 1, FILE_BYTES.slice(6));
  db.exec(`INSERT INTO file_download_tokens (token_hash, file_id, expires_at) VALUES ('tok', '${FILE_ID}', 1999999999999)`);
  db.exec(`INSERT INTO files (id, file_no, name, mime_type, size, comment, created_at, status)
    VALUES ('99999999-9999-4999-8999-999999999999', 2, 'wip.bin', 'application/octet-stream', 10, '', 1795000001000, 'uploading')`);
}

// 2ch: スレッドと3件のレス、dat_lines のキャッシュ行を用意する。
export function seed2ch(env) {
  const db = env.simple_2ch_db;
  db.exec(`INSERT INTO thread (id, title, created_at, modified_at) VALUES (1, 'テストスレ', 1795000000000, 1795000003000)`);
  db.exec(`INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source) VALUES
    (1, '名無しさん', '', '2026/11/19(木) 12:00:00', 'Admin001', '最初のレス', 1795000000000, 'web'),
    (2, '名無しさん', 'sage', '2026/11/19(木) 12:01:00', 'AbCdEf12', '消したいレス', 1795000001000, 'web'),
    (3, '名無しさん', '', '2026/11/19(木) 12:02:00', 'GhIjKl34', '残すレス', 1795000002000, 'web')`);
  const stmt = db.sqlite.prepare("INSERT INTO dat_lines (no, line, bytes, name, mail, date_text, poster_id, message, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  stmt.run(1, new TextEncoder().encode("line1\n"), 6, "名無しさん", "", "2026/11/19(木) 12:00:00", "Admin001", "最初のレス", "テストスレ");
  stmt.run(2, new TextEncoder().encode("line2\n"), 6, "名無しさん", "sage", "2026/11/19(木) 12:01:00", "AbCdEf12", "消したいレス", "");
  stmt.run(3, new TextEncoder().encode("line3\n"), 6, "名無しさん", "", "2026/11/19(木) 12:02:00", "GhIjKl34", "残すレス", "");
}
