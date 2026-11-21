// simple-admin: cloudflare-simple-uploader と cloudflare-simple-2ch の管理用 Worker。
//
// 認証はこの Worker には実装しない。前段に Cloudflare Access を置く前提で、
// Access を設定するまでは公開デプロイしないこと(README 参照)。
// 管理操作は各プロジェクトの ADMIN.md の手順(SQL)を、そのまま GUI から実行する:
// - uploader のファイル削除は files の行削除のみ(残りは ON DELETE CASCADE が消す)
// - 2ch のあぼーんは posts の書き換えのみ(dat キャッシュには触れない)
// - 2ch の物理削除は posts と dat_lines の両方から消す(dat は dat_lines を直接読むため)

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

function page(title, body) {
  return new Response(
    `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n<title>${escapeHtml(title)}</title>\n` +
    `<style>body{font-family:sans-serif;margin:2em;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}td.msg{white-space:pre-wrap;word-break:break-all}.flash{background:#eef7ee;border:1px solid #9c9;padding:8px 12px}form{display:inline}</style>\n` +
    `</head>\n<body>\n${body}\n</body>\n</html>\n`,
    { status: 200, headers: { "Content-Type": HTML_TYPE, "Cache-Control": "no-store" } },
  );
}

function notFound() {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function redirectWithMessage(message) {
  return new Response(null, {
    status: 303,
    headers: { Location: `/?msg=${encodeURIComponent(message)}`, "Cache-Control": "no-store" },
  });
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
  // dat の出力は dat_lines を直接読むため、posts だけ消すと消した行が dat に残る。
  // 物理削除では dat_lines の該当行も一緒に消す。番号は詰めない(欠番になる)。
  await db.batch([
    db.prepare("DELETE FROM posts WHERE no = ?").bind(no),
    db.prepare("DELETE FROM dat_lines WHERE no = ?").bind(no),
  ]);
  return redirectWithMessage(`${no} 番を物理削除しました`);
}

// ---------- 画面 ----------

async function dashboard(env, url) {
  const msg = url.searchParams.get("msg");
  const upDb = env.simple_uploader_db;
  const bbsDb = env.simple_2ch_db;
  const [summary, files, thread, posts] = await Promise.all([
    uploaderSummary(upDb), listFiles(upDb), getThreadInfo(bbsDb), listPosts(bbsDb),
  ]);

  const fileRows = files.map((f) => `<tr>
    <td>${f.file_no}</td><td>${escapeHtml(f.name)}</td><td>${f.size}</td>
    <td>${escapeHtml(f.comment)}</td><td>${formatJst(f.created_at)}</td>
    <td>${f.download_count}</td><td>${f.status}</td>
    <td>${f.has_password ? "あり" : "なし"}</td><td>${f.has_delete_key ? "あり" : "なし"}</td>
    <td>${f.status === "ready" ? `<a href="/uploader/files/${encodeURIComponent(f.id)}/download">強制ダウンロード</a> ` : ""}<form method="post" action="/uploader/files/${encodeURIComponent(f.id)}/delete" onsubmit="return confirm('このファイルを削除しますか？')"><button type="submit">強制削除</button></form></td>
  </tr>`).join("\n");

  const postRows = posts.map((p) => `<tr>
    <td>${p.no}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.mail)}</td>
    <td>${escapeHtml(p.date_text)}</td><td>${escapeHtml(p.poster_id)}</td>
    <td class="msg">${escapeHtml(p.message)}</td>
    <td>${p.no >= 2 ? `<form method="post" action="/2ch/posts/${p.no}/abon" onsubmit="return confirm('${p.no} 番をあぼーんしますか？')"><button type="submit">あぼーん</button></form> ` : ""}<form method="post" action="/2ch/posts/${p.no}/delete" onsubmit="return confirm('${p.no} 番を物理削除しますか？番号は詰めません。')"><button type="submit">物理削除</button></form></td>
  </tr>`).join("\n");

  return page("simple-admin", `
<h1>simple-admin</h1>
${msg ? `<p class="flash">${escapeHtml(msg)}</p>` : ""}
<h2>uploader</h2>
<p>ファイル ${summary.total} 件(公開 ${summary.ready} / アップロード中 ${summary.uploading})、合計 ${summary.bytes} バイト。最新 ${LIST_LIMIT} 件まで表示します。</p>
<table>
<tr><th>No.</th><th>名前</th><th>サイズ</th><th>コメント</th><th>日時(JST)</th><th>DL</th><th>状態</th><th>PW</th><th>削除キー</th><th>操作</th></tr>
${fileRows}
</table>
<h2>2ch</h2>
${thread ? `<p>スレッド「${escapeHtml(thread.title)}」 レス ${thread.count} 件(最大番号 ${thread.lastNo})。最新 ${LIST_LIMIT} 件まで表示します。</p>
<table>
<tr><th>No.</th><th>名前</th><th>メール</th><th>日付</th><th>ID</th><th>本文</th><th>操作</th></tr>
${postRows}
</table>` : "<p>スレッドがありません。</p>"}
`);
}

// ---------- ルーター ----------

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/") return dashboard(env, url);

  const download = /^\/uploader\/files\/([^/]+)\/download$/.exec(path);
  if (method === "GET" && download) return forceDownload(env.simple_uploader_db, decodeURIComponent(download[1]));

  const delFile = /^\/uploader\/files\/([^/]+)\/delete$/.exec(path);
  if (method === "POST" && delFile) return forceDeleteFile(env.simple_uploader_db, decodeURIComponent(delFile[1]));

  const abon = /^\/2ch\/posts\/(\d+)\/abon$/.exec(path);
  if (method === "POST" && abon) return abonPost(env.simple_2ch_db, Number(abon[1]));

  const delPost = /^\/2ch\/posts\/(\d+)\/delete$/.exec(path);
  if (method === "POST" && delPost) return deletePost(env.simple_2ch_db, Number(delPost[1]));

  return notFound();
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env, new URL(request.url));
    } catch (error) {
      console.error(error);
      return new Response("サーバーでエラーが発生しました。\n", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
      });
    }
  },
};
