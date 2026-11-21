-- admin 自身の D1(simple-admin-db)用スキーマ。
-- ログイン試行の記録だけを持つ。
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  login_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ip TEXT NOT NULL,
  path TEXT NOT NULL,
  user_agent TEXT NOT NULL
);
