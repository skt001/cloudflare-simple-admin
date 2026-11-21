-- スレッド情報(1 行のみ)。bbs・key は保存しない(src/config.js の定数)。
CREATE TABLE thread (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
) STRICT;

-- レス。物理削除はしない。あぼーんは値の書き換えだけで行う。
CREATE TABLE posts (
  no INTEGER PRIMARY KEY NOT NULL CHECK (no >= 1),
  name TEXT NOT NULL,
  mail TEXT NOT NULL,
  date_text TEXT NOT NULL,
  poster_id TEXT NOT NULL,
  message TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'api'))
) STRICT;

-- 連続投稿規制(同じ poster_id の直近の投稿数)用
CREATE INDEX posts_poster_posted ON posts (poster_id, posted_at);

-- 最終更新: 追加・更新(あぼーんを含む)のたびに thread.modified_at を現在時刻(UTC ミリ秒)にする。
-- 時刻は strftime だけで求める(秒 + %f の小数部のミリ秒)。SQLite のバージョンに依存しない。
CREATE TRIGGER posts_after_insert AFTER INSERT ON posts
BEGIN
  UPDATE thread
  SET modified_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
                    + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER)
  WHERE id = 1;
END;

CREATE TRIGGER posts_after_update AFTER UPDATE ON posts
BEGIN
  UPDATE thread
  SET modified_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
                    + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER)
  WHERE id = 1;
END;
CREATE TABLE dat_lines (
  no INTEGER PRIMARY KEY NOT NULL,
  line BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  name TEXT NOT NULL,
  mail TEXT NOT NULL,
  date_text TEXT NOT NULL,
  poster_id TEXT NOT NULL,
  message TEXT NOT NULL,
  title TEXT NOT NULL
) STRICT;
