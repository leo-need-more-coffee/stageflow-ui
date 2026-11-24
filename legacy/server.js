/**
 * The static server of the editor.
 *
 * The editor is HTML, CSS and ES modules — nothing to build and nothing to
 * render on a server. What is still needed is a server: ES modules are not
 * loaded from `file://` (the browser blocks them as cross-origin), so the page
 * has to come over http. That is all this does.
 *
 * It deliberately has no dependencies: the whole point of the editor is that it
 * is plain files, and a static server that drags a framework in would be the
 * first thing to contradict that.
 *
 *   node server.js            # http://0.0.0.0:8080
 *   PORT=3000 node server.js
 *
 * The backend (stage specs, the run API) is a different thing entirely, on a
 * different address — the user types it on the connection screen.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
}));

/**
 * The path from a URL into a path inside ROOT, or null if it leads outside.
 *
 * `..` in a URL is the classic way to read the rest of the disk through a
 * static server, and the check has to happen after normalisation: `/a/../../x`
 * looks innocent until it is collapsed.
 */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null; // a broken percent-encoding is not a path
  }
  if (decoded.endsWith("/")) decoded += "index.html";
  const full = normalize(join(ROOT, decoded));
  return full === ROOT.slice(0, -1) || full.startsWith(ROOT) ? full : null;
}

const server = createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(405, "method not allowed", { Allow: "GET, HEAD" });
  }

  const path = resolvePath(req.url ?? "/");
  if (!path) return send(400, "bad path");

  let info;
  try {
    info = await stat(path);
  } catch {
    return send(404, "not found");
  }
  if (info.isDirectory()) return send(404, "not found");

  const headers = {
    "Content-Type": TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": info.size,
    // no-store rather than an ETag: without it the browser caches ES modules
    // heuristically and assembles the page out of DIFFERENT versions after an
    // update — a fresh palette with a stale canvas, and nothing says so
    "Cache-Control": "no-store",
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`StageFlow editor: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  console.log("The backend address is typed on the connection screen.");
});

// in a container the stop signal is SIGTERM, and without this the process is
// killed after the grace period instead of closing its sockets
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export { server };
