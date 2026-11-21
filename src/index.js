// admin: cloudflare-simple-uploader と cloudflare-simple-2ch の管理用 Worker。
//
// 認証は HTTP Basic 認証。ID はメールアドレスっぽい文字列なら何でもよく
// (@ の後ろにピリオドがあるか程度だけを正規表現で見る)、実質はパスワードのみで
// 認証する。パスワードは ADMIN_PASSWORD シークレットと照合し、未設定なら全て
// 拒否する。ログイン試行は simple_admin_db の access_log に残す(README 参照)。
// 管理操作は各プロジェクトの ADMIN.md の手順(SQL)を、そのまま GUI から実行する:
// - uploader のファイル削除は files の行削除のみ(残りは ON DELETE CASCADE が消す)
// - 2ch のあぼーんは posts の書き換えのみ(dat キャッシュには触れない)
// - 2ch の物理削除は末尾のレスのみ(posts と dat_lines の両方から消す)。
//   途中を消すと dat の行位置とレス番号がずれるため、対象を末尾に限る
// 左右は独立に扱う。片方の database_id が間違っている(プレースホルダのまま等)場合、
// その側は 500 にせず「未対応」と表示し、もう片方は使える状態に保つ。

const HTML_TYPE = "text/html; charset=UTF-8";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LIST_LIMIT = 100;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatJst(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + JST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 2ch 本体の formatJst と同じ表示形式(YYYY/MM/DD(曜) HH:MM:SS、JST)。
function formatDateText(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}(${WEEKDAYS[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n<title>${escapeHtml(title)}</title>\n` +
    `<style>body{font-family:sans-serif;margin:2em;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}td.msg{white-space:pre-wrap;word-break:break-all}.flash{background:#eef7ee;border:1px solid #9c9;padding:8px 12px}form{display:inline}</style>\n` +
    `</head>\n<body>\n${body}\n</body>\n</html>\n`,
    { status, headers: { "Content-Type": HTML_TYPE, "Cache-Control": "no-store" } },
  );
}

function notFound() {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

// database_id の間違い(プレースホルダのまま・取り違え等)で、対象のデータベースに
// 繋がっていない状態かどうか。対象外の DB ではテーブル自体が存在しない。
function isDbUnavailable(error) {
  const message = String(error?.message ?? error);
  return /no such table|no such column|D1_ERROR|Couldn't find DB|no such database/i.test(message);
}

function unavailablePage(name) {
  return page("未対応", `
<h1>未対応</h1>
<p>${escapeHtml(name)} のデータベースに接続できませんでした。wrangler.jsonc の database_id が対象のデータベースを指していない可能性があります。</p>
<p><a href="/">ダッシュボードへ戻る</a></p>
`, 503);
}

// ---------- 認証 ----------

// メールアドレスっぽさの判定はこれだけ(@ の後ろにピリオドが1つあること)。
// 許可リストはなく、ID はログに残すための名乗りとして扱う。実質の認証はパスワードのみ。
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseBasicAuth(request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  let decoded;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { id: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function passwordMatches(input, expected) {
  const [a, b] = await Promise.all([sha256Hex(input), sha256Hex(expected)]);
  return a === b;
}

async function logAccess(db, request, url, loginId, ok) {
  if (!db) return;
  try {
    await db.prepare("INSERT INTO access_log (at, login_id, ok, ip, path, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        Date.now(), loginId, ok ? 1 : 0,
        request.headers.get("CF-Connecting-IP") ?? "",
        url.pathname,
        request.headers.get("User-Agent") ?? "",
      )
      .run();
  } catch {
    // ログの失敗で認証や操作自体は止めない。
  }
}

function redirectWithMessage(message) {
  return new Response(null, {
    status: 303,
    headers: { Location: `/?msg=${encodeURIComponent(message)}`, "Cache-Control": "no-store" },
  });
}

// 初期化系(影響範囲が全体)のための確認画面。対象の説明と実行ボタンのみを出す。
function confirmPage(heading, description, action) {
  return page(heading, `
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(description)}</p>
<p>この操作は取り消せません。</p>
<form method="post" action="${action}"><button type="submit">実行する</button></form>
<p><a href="/">キャンセルして戻る</a></p>
`);
}

// ---------- uploader ----------

async function listFiles(db) {
  const { results } = await db.prepare(
    `SELECT id, file_no, name, size, comment, created_at, download_count, status,
       download_password_hash IS NOT NULL AS has_password,
       delete_key_hash IS NOT NULL AS has_delete_key
     FROM files ORDER BY file_no DESC LIMIT ?`,
  ).bind(LIST_LIMIT).all();
  return results;
}

async function uploaderSummary(db) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
       COALESCE(SUM(CASE WHEN status = 'uploading' THEN 1 ELSE 0 END), 0) AS uploading,
       COALESCE(SUM(size), 0) AS bytes
     FROM files`,
  ).first();
  return row;
}

async function forceDownload(db, id) {
  const file = await db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  if (!file || file.status !== "ready") return notFound();
  const { results } = await db.prepare(
    "SELECT data FROM file_chunks WHERE file_id = ? ORDER BY chunk_index",
  ).bind(id).all();
  const chunks = results.map((row) => (row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)));
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const fallback = file.name.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_");
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "no-store",
    },
  });
}

async function forceDeleteFile(db, id) {
  const file = await db.prepare("SELECT id FROM files WHERE id = ?").bind(id).first();
  if (!file) return notFound();
  // ADMIN.md の手順どおり files の行だけを消す。file_chunks / file_download_tokens /
  // file_auth_attempts は ON DELETE CASCADE で一緒に消える。
  await db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  return redirectWithMessage(`ファイル ${id} を削除しました`);
}

async function resetUploaderConfirm(db) {
  const summary = await uploaderSummary(db);
  return confirmPage(
    "uploader 初期化",
    `全 ${summary.total} 件のファイル(合計 ${summary.bytes} バイト)を削除し、空の状態に戻します。アップロード中の予約も消えます。`,
    "/uploader/reset",
  );
}

async function resetUploader(db) {
  await db.prepare("DELETE FROM files").run();
  return redirectWithMessage("uploader を初期化しました");
}

// ---------- 2ch ----------

async function getThreadInfo(db) {
  const thread = await db.prepare("SELECT id, title, created_at, modified_at FROM thread LIMIT 1").first();
  if (!thread) return null;
  const stats = await db.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(no), 0) AS last_no FROM posts").first();
  return { ...thread, count: stats.count, lastNo: stats.last_no };
}

async function listPosts(db) {
  const { results } = await db.prepare(
    "SELECT no, name, mail, date_text, poster_id, message FROM posts ORDER BY no DESC LIMIT ?",
  ).bind(LIST_LIMIT).all();
  return results;
}

async function abonPost(db, no) {
  // ADMIN.md の [template:abon] と同じ書き換え。1 番は対象外(no >= 2 の条件込み)。
  const result = await db.prepare(
    "UPDATE posts SET name = 'あぼーん', mail = '', date_text = 'あぼーん', poster_id = '', message = 'あぼーん' WHERE no >= 2 AND (no = ?)",
  ).bind(no).run();
  if (result.meta.changes === 0) {
    return redirectWithMessage(`${no} 番はあぼーんの対象外か、存在しません`);
  }
  return redirectWithMessage(`${no} 番をあぼーんしました`);
}

async function deletePost(db, no) {
  const post = await db.prepare("SELECT no FROM posts WHERE no = ?").bind(no).first();
  if (!post) return notFound();
  // 物理削除は末尾のみ。途中を消すと欠番になり、番号を持たない dat の行位置と
  // レス番号がずれるため、最大番号でない指定は拒否する(あぼーんの no >= 2 と同じ考え方)。
  // 1 番も対象外(あぼーんと同じ)。1 番ごと消す場合は「1含めて初期化」を使う。
  if (no === 1) {
    return redirectWithMessage("1 番は物理削除できません(消す場合は「1含めて初期化」を使ってください)");
  }
  const max = await db.prepare("SELECT COALESCE(MAX(no), 0) AS m FROM posts").first();
  if (no !== max.m) {
    return redirectWithMessage(`${no} 番は末尾ではないため物理削除できません`);
  }
  // dat の出力は dat_lines を直接読むため、posts だけ消すと消した行が dat に残る。
  // 物理削除では dat_lines の該当行も一緒に消す。
  await db.batch([
    db.prepare("DELETE FROM posts WHERE no = ?").bind(no),
    db.prepare("DELETE FROM dat_lines WHERE no = ?").bind(no),
  ]);
  return redirectWithMessage(`${no} 番を物理削除しました`);
}

async function resetExceptFirstConfirm(db) {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE no >= 2").first();
  return confirmPage(
    "2ch 1以外初期化",
    `2 番以降の ${row.c} 件のレスを削除し、スレッドタイトルと 1 番だけを残します。`,
    "/2ch/reset/except-first",
  );
}

async function resetExceptFirst(db) {
  await db.batch([
    db.prepare("DELETE FROM posts WHERE no >= 2"),
    db.prepare("DELETE FROM dat_lines WHERE no >= 2"),
  ]);
  return redirectWithMessage("2 番以降を削除しました");
}

async function resetAllConfirm(db) {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM posts").first();
  return confirmPage(
    "2ch 1含めて初期化",
    `全 ${row.c} 件のレスとスレッドを削除し、初期化前の状態に戻します。`,
    "/2ch/reset/all",
  );
}

async function resetAll(db) {
  await db.batch([
    db.prepare("DELETE FROM posts"),
    db.prepare("DELETE FROM dat_lines"),
    db.prepare("DELETE FROM thread"),
  ]);
  return redirectWithMessage("スレッドを初期化しました");
}

// スレッドがないときだけ、init.sql と同じ内容で thread と 1 番を作る。
async function createFirstPost(db, request) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  if (title === "" || message === "") {
    return redirectWithMessage("タイトルと本文を入力してください");
  }
  if (message.length > 4096) {
    return redirectWithMessage("本文が長すぎます(4096 文字まで)");
  }
  const count = await db.prepare("SELECT COUNT(*) AS c FROM posts").first();
  if (count.c > 0) {
    return redirectWithMessage("既にスレッドがあるため、1 番は作れません");
  }
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM thread"),
    db.prepare("INSERT INTO thread (id, title, created_at, modified_at) VALUES (1, ?, ?, ?)").bind(title, now, now),
    db.prepare(
      "INSERT INTO posts (no, name, mail, date_text, poster_id, message, posted_at, source) VALUES (1, '名無しさん', '', ?, 'Admin001', ?, ?, 'web')",
    ).bind(formatDateText(now), message, now),
  ]);
  return redirectWithMessage("スレッドを作成しました");
}

// ---------- 画面 ----------

async function dashboard(env, url) {
  const msg = url.searchParams.get("msg");
  const up = await uploaderSection(env.simple_uploader_db);
  const bbs = await chSection(env.simple_2ch_db);
  const log = await accessLogSection(env.simple_admin_db);
  return page("admin", `
<h1>admin</h1>
${msg ? `<p class="flash">${escapeHtml(msg)}</p>` : ""}
${up}
${bbs}
${log}
`);
}

async function accessLogSection(db) {
  if (!db) return `<h2>アクセスログ</h2>\n<p>未対応です(バインディング simple_admin_db がありません)。</p>`;
  let rows;
  try {
    ({ results: rows } = await db.prepare(
      "SELECT at, login_id, ok, ip, path, user_agent FROM access_log ORDER BY id DESC LIMIT ?",
    ).bind(LIST_LIMIT).all());
  } catch (error) {
    if (!isDbUnavailable(error)) throw error;
    return `<h2>アクセスログ</h2>\n<p>未対応です(データベースに接続できませんでした。database_id が simple-admin-db を指しているか確認してください)。</p>`;
  }
  const trs = rows.map((r) => `<tr>
    <td>${formatJst(r.at)}</td><td>${escapeHtml(r.login_id)}</td><td>${r.ok ? "成功" : "失敗"}</td>
    <td>${escapeHtml(r.ip)}</td><td>${escapeHtml(r.path)}</td><td>${escapeHtml(r.user_agent)}</td>
  </tr>`).join("\n");
  return `<h2>アクセスログ</h2>
<p>ログイン試行の記録です。最新 ${LIST_LIMIT} 件まで表示します。</p>
<table>
<tr><th>日時(JST)</th><th>ID</th><th>結果</th><th>IP</th><th>パス</th><th>User-Agent</th></tr>
${trs}
</table>`;
}

async function uploaderSection(db) {
  if (!db) return `<h2>uploader</h2>\n<p>未対応です(バインディング simple_uploader_db がありません)。</p>`;
  let summary, files;
  try {
    [summary, files] = await Promise.all([uploaderSummary(db), listFiles(db)]);
  } catch (error) {
    if (!isDbUnavailable(error)) throw error;
    return `<h2>uploader</h2>\n<p>未対応です(データベースに接続できませんでした。database_id が simple-uploader-db を指しているか確認してください)。</p>`;
  }
  const fileRows = files.map((f) => `<tr>
    <td>${f.file_no}</td><td>${escapeHtml(f.name)}</td><td>${f.size}</td>
    <td>${escapeHtml(f.comment)}</td><td>${formatJst(f.created_at)}</td>
    <td>${f.download_count}</td><td>${f.status}</td>
    <td>${f.has_password ? "あり" : "なし"}</td><td>${f.has_delete_key ? "あり" : "なし"}</td>
    <td>${f.status === "ready" ? `<a href="/uploader/files/${encodeURIComponent(f.id)}/download">強制ダウンロード</a> ` : ""}<form method="post" action="/uploader/files/${encodeURIComponent(f.id)}/delete" onsubmit="return confirm('このファイルを削除しますか？')"><button type="submit">強制削除</button></form></td>
  </tr>`).join("\n");
  return `<h2>uploader</h2>
<p>ファイル ${summary.total} 件(公開 ${summary.ready} / アップロード中 ${summary.uploading})、合計 ${summary.bytes} バイト。最新 ${LIST_LIMIT} 件まで表示します。</p>
<table>
<tr><th>No.</th><th>名前</th><th>サイズ</th><th>コメント</th><th>日時(JST)</th><th>DL</th><th>状態</th><th>PW</th><th>削除キー</th><th>操作</th></tr>
${fileRows}
</table>
<p><form method="get" action="/uploader/reset"><button type="submit">uploader を初期化</button></form></p>`;
}

async function chSection(db) {
  if (!db) return `<h2>2ch</h2>\n<p>未対応です(バインディング simple_2ch_db がありません)。</p>`;
  let thread, posts;
  try {
    [thread, posts] = await Promise.all([getThreadInfo(db), listPosts(db)]);
  } catch (error) {
    if (!isDbUnavailable(error)) throw error;
    return `<h2>2ch</h2>\n<p>未対応です(データベースに接続できませんでした。database_id が simple-2ch-db を指しているか確認してください)。</p>`;
  }
  const postRows = posts.map((p) => `<tr>
    <td>${p.no}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.mail)}</td>
    <td>${escapeHtml(p.date_text)}</td><td>${escapeHtml(p.poster_id)}</td>
    <td class="msg">${escapeHtml(p.message)}</td>
    <td>${p.no >= 2 ? `<form method="post" action="/2ch/posts/${p.no}/abon" onsubmit="return confirm('${p.no} 番をあぼーんしますか？')"><button type="submit">あぼーん</button></form> ` : ""}${thread && p.no >= 2 && p.no === thread.lastNo ? `<form method="post" action="/2ch/posts/${p.no}/delete" onsubmit="return confirm('${p.no} 番(末尾)を物理削除しますか？')"><button type="submit">物理削除</button></form>` : ""}</td>
  </tr>`).join("\n");
  if (!thread || thread.count === 0) {
    return `<h2>2ch</h2>
<p>スレッドがありません。最初のレスを作成します。</p>
<form method="post" action="/2ch/first-post">
<p>タイトル <input type="text" name="title" size="60"></p>
<p>本文<br><textarea name="message" rows="4" cols="60"></textarea></p>
<p><button type="submit">1 番を作成</button></p>
</form>`;
  }
  return `<h2>2ch</h2>
<p>スレッド「${escapeHtml(thread.title)}」 レス ${thread.count} 件(最大番号 ${thread.lastNo})。最新 ${LIST_LIMIT} 件まで表示します。</p>
<table>
<tr><th>No.</th><th>名前</th><th>メール</th><th>日付</th><th>ID</th><th>本文</th><th>操作</th></tr>
${postRows}
</table>
<p><form method="get" action="/2ch/reset/except-first"><button type="submit">1以外初期化</button></form>
<form method="get" action="/2ch/reset/all"><button type="submit">1含めて初期化</button></form></p>`;
}

// ---------- ルーター ----------

function routeUploader(db, path, method) {
  const download = /^\/uploader\/files\/([^/]+)\/download$/.exec(path);
  if (method === "GET" && download) return forceDownload(db, decodeURIComponent(download[1]));

  const delFile = /^\/uploader\/files\/([^/]+)\/delete$/.exec(path);
  if (method === "POST" && delFile) return forceDeleteFile(db, decodeURIComponent(delFile[1]));

  if (method === "GET" && path === "/uploader/reset") return resetUploaderConfirm(db);
  if (method === "POST" && path === "/uploader/reset") return resetUploader(db);

  return notFound();
}

function route2ch(db, request, path, method) {
  const abon = /^\/2ch\/posts\/(\d+)\/abon$/.exec(path);
  if (method === "POST" && abon) return abonPost(db, Number(abon[1]));

  const delPost = /^\/2ch\/posts\/(\d+)\/delete$/.exec(path);
  if (method === "POST" && delPost) return deletePost(db, Number(delPost[1]));

  if (method === "GET" && path === "/2ch/reset/except-first") return resetExceptFirstConfirm(db);
  if (method === "POST" && path === "/2ch/reset/except-first") return resetExceptFirst(db);
  if (method === "GET" && path === "/2ch/reset/all") return resetAllConfirm(db);
  if (method === "POST" && path === "/2ch/reset/all") return resetAll(db);
  if (method === "POST" && path === "/2ch/first-post") return createFirstPost(db, request);

  return notFound();
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/") return dashboard(env, url);

  // 左右は独立。片方の DB に繋がらなくても、もう片方と画面自体は落とさない。
  if (path.startsWith("/uploader")) {
    if (!env.simple_uploader_db) return unavailablePage("uploader");
    try {
      return await routeUploader(env.simple_uploader_db, path, method);
    } catch (error) {
      if (isDbUnavailable(error)) return unavailablePage("uploader");
      throw error;
    }
  }
  if (path.startsWith("/2ch")) {
    if (!env.simple_2ch_db) return unavailablePage("2ch");
    try {
      return await route2ch(env.simple_2ch_db, request, path, method);
    } catch (error) {
      if (isDbUnavailable(error)) return unavailablePage("2ch");
      throw error;
    }
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      // パスワードのシークレットが未設定なら、開かずに全て拒否する(フェイルクローズ)。
      if (typeof env.ADMIN_PASSWORD !== "string" || env.ADMIN_PASSWORD === "") {
        return new Response("認証が設定されていません(ADMIN_PASSWORD シークレットが未設定です)。\n", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
        });
      }
      const credentials = parseBasicAuth(request);
      const ok = credentials !== null
        && EMAIL_LIKE.test(credentials.id)
        && (await passwordMatches(credentials.password, env.ADMIN_PASSWORD));
      // 資格情報を持ったリクエスト(=ログイン試行)だけを記録する。
      if (request.headers.get("Authorization")) {
        await logAccess(env.simple_admin_db, request, url, credentials?.id ?? "", ok);
      }
      if (!ok) {
        return new Response("認証が必要です。\n", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="admin", charset="UTF-8"',
            "Content-Type": "text/plain; charset=UTF-8",
            "Cache-Control": "no-store",
          },
        });
      }
      return await route(request, env, url);
    } catch (error) {
      console.error(error);
      return new Response("サーバーでエラーが発生しました。\n", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
      });
    }
  },
};
