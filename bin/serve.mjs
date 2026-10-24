#!/usr/bin/env node
/**
 * `caretaker serve` — the optional local web client's server. W-1, W-3, W-4.
 *
 *     node bin/serve.mjs path/to/ops/caretaker/config.json [--port 7420]
 *
 * It holds NO RULES. It authenticates, routes, streams and serves files. Reads
 * go through readmodel.mjs; every mutation is core's own `command`, under
 * core's lock. A rule in this file would be a defect (TECH.md §Architecture).
 *
 * Built-ins only (node:http, node:fs, node:crypto), foreground, no pidfile,
 * nothing stored that cannot be rebuilt from the files. Ctrl-C stops it.
 *
 * SECURITY (auth and isolation, so security + reviewer + qa; each control is
 * attacked in bin/serve.test.mjs):
 *   - binds 127.0.0.1 only; any other host is refused, with ssh -L as the way
 *     to reach it remotely. Plain HTTP on a LAN would carry the token in clear.
 *   - a 256-bit token made in-process, never read from argv or env (where it
 *     would show in `ps`), printed once as a bootstrap URL.
 *   - GET /auth?t= compares it in constant time, sets caretaker_<port> (HttpOnly,
 *     SameSite=Strict; named by port because cookies are not port-scoped) and
 *     redirects to / so the token leaves the address bar and history.
 *   - every request: Host must be 127.0.0.1:<port> or localhost:<port> exactly,
 *     which defeats DNS rebinding. /api and the stream need the cookie.
 *   - every POST: exact Origin, application/json, and X-Caretaker: 1. A form or
 *     a cross-site fetch cannot set all three. No CORS headers, ever.
 *   - a strict CSP on every response; board.html is served sandboxed.
 *   - run files: fixed id shape, fixed filenames, realpath under the archive.
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { open as openReadModel, redactShapes } from "./readmodel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(HERE, "..", "web", "dist");

export const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------------------------------ tailing */
/**
 * Tail append-only files from byte offsets. A partial final line is held
 * until its newline arrives; an unparseable complete line is skipped and
 * counted, never thrown. Returns [{ file, offset, line, value }].
 */
export const TAIL_WINDOW = 8 * 1024 * 1024;
export function tailFile(path, from, { window = TAIL_WINDOW } = {}) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], offset: from, skipped: 0 };
  }
  if (size < from) from = 0; // truncated or replaced: start again rather than read past the end
  if (size === from) return { records: [], offset: from, skipped: 0 };
  const len = Math.min(size - from, window);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, from);
  } finally {
    closeSync(fd);
  }
  const records = [];
  let skipped = 0;
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const line = buf.subarray(pos, nl).toString("utf8");
    const end = from + nl + 1;
    if (line.trim()) {
      try {
        const value = JSON.parse(redactShapes(line));
        if (value && typeof value === "object" && !Array.isArray(value)) records.push({ offset: end, value });
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    pos = nl + 1;
  }
  // A full window with no newline in it is a line longer than the window.
  // Holding it, as a partial line is held, would stall this file forever
  // (independent review): skip past it and count it. The rest of that line
  // then arrives as an unparseable fragment, and is skipped the same way.
  if (pos === 0 && len === window) return { records, offset: from + len, skipped: skipped + 1 };
  return { records, offset: from + pos, skipped };
}

/**
 * Where a fresh reader of an append-only file starts: just after its last
 * complete line. The file's size is mid-line whenever a writer is part-way
 * through a line, and starting there would read that line's tail as a bad
 * line and drop it (independent QA).
 */
export function lineStart(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  const fd = openSync(path, "r");
  try {
    const chunk = 64 * 1024;
    for (let end = size; end > 0; end -= chunk) {
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(10);
      if (nl >= 0) return start + nl + 1;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** A cursor over several files: "name:offset,name:offset". Every file's offset rides in every id. */
export const encodeCursor = (offsets) => Object.entries(offsets).map(([k, v]) => `${k}:${v}`).join(",");
export function decodeCursor(s) {
  const out = {};
  for (const part of String(s ?? "").split(",")) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i);
    const n = Number(part.slice(i + 1));
    if (/^[\w.-]+$/.test(name) && Number.isInteger(n) && n >= 0) out[name] = n;
  }
  return out;
}

/* ------------------------------------------------------------------- server */
export async function startServer({ cfgPath, dist = DIST, port = 7420, host = "127.0.0.1", pollMs = 2000, heartbeatMs = 15000, stateDir, log = console.log, token: fixedToken } = {}) {
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing to bind ${host}: v1 serves loopback only. To reach it from another machine, tunnel: ssh -L ${port}:127.0.0.1:${port} <this-host>`);
  }
  const rm = await openReadModel(cfgPath, { stateDir });
  // fixedToken exists for the tests only; the CLI never passes it.
  const token = fixedToken ?? randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);
  let actualPort = port;
  const cookieName = () => `caretaker_${actualPort}`;
  const hostsOk = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);

  const clients = new Set();

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === "string" || Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      ...(isText ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      ...headers,
    });
    res.end(isText ? body : JSON.stringify(body));
  };

  const cookieOk = (req) => {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === cookieName()) {
        const got = Buffer.from(v.join("="));
        return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
      }
    }
    return false;
  };

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks = [];
      // Past the limit the rest is read and dropped, so the 413 reaches the
      // client instead of a reset connection.
      req.on("data", (c) => {
        size += c.length;
        if (size <= limit) chunks.push(c);
      });
      req.on("end", () => (size > limit ? reject(Object.assign(new Error("body too large"), { status: 413 })) : resolveBody(Buffer.concat(chunks).toString("utf8"))));
      req.on("error", reject);
    });
  }

  /* ---------------------------------------------------------------- static */
  function serveStatic(res, urlPath) {
    const built = existsSync(join(dist, "index.html"));
    if (!built) {
      return send(res, 200, fallbackPage(), { "Content-Type": "text/html; charset=utf-8" });
    }
    let rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
    let p = resolve(dist, rel);
    if (p !== dist && !p.startsWith(dist + sep)) return send(res, 404, { error: "not found" });
    if (!rel || !existsSync(p) || statSync(p).isDirectory()) p = join(dist, "index.html"); // client-side routes
    const type = MIME[extname(p)] ?? "application/octet-stream";
    const cache = p.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-store";
    return send(res, 200, readFileSync(p), { "Content-Type": type, "Cache-Control": cache });
  }

  // Unstyled on purpose: the page is served under CSP, which blocks inline
  // style attributes, and it is the one page with no stylesheet to point at
  // (independent review).
  const fallbackPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Caretaker</title></head>
<body>
<h1>Caretaker</h1>
<p>The web client has not been built. Build it once, then reload:</p>
<pre>npm --prefix web ci &amp;&amp; npm --prefix web run build</pre>
<p>Until then: the static page is at <a href="/board.html">/board.html</a>, and the API is under <code>/api/v1</code>
(snapshot, work, work/:id, inbox, runs, runs/:id, agents, specs, metrics, events, settings, stream).</p>
</body></html>`;

  /* ---------------------------------------------------------------- stream */
  const watched = rm.watchPaths();
  const tailSources = () => {
    const out = { "runs.jsonl": watched.runs };
    try {
      for (const n of readdirSync(watched.eventsDir)) if (/^events-\d{4}-\d\d-\d\d\.jsonl$/.test(n)) out[n] = join(watched.eventsDir, n);
    } catch {
      /* no event log yet */
    }
    return out;
  };
  const stamp = (p) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "absent";
    }
  };
  const archiveStamp = () => {
    try {
      return readdirSync(watched.archiveDir).sort().join(",");
    } catch {
      return "absent";
    }
  };
  let boardStamp = stamp(watched.board);
  let arcStamp = archiveStamp();

  function pump() {
    const bs = stamp(watched.board);
    if (bs !== boardStamp) {
      boardStamp = bs;
      broadcast("invalidate", { resource: "board" });
    }
    const as = archiveStamp();
    if (as !== arcStamp) {
      arcStamp = as;
      broadcast("invalidate", { resource: "runs" });
    }
    const files = tailSources();
    for (const c of clients) {
      for (const [name, path] of Object.entries(files)) {
        // A file that appeared after the client connected is read from its start.
        const from = c.offsets[name] ?? 0;
        const { records, offset } = tailFile(path, from);
        c.offsets[name] = offset;
        for (const r of records) {
          c.res.write(`id: ${encodeCursor({ ...c.offsets, [name]: r.offset })}\nevent: log\ndata: ${JSON.stringify({ file: name, ...r.value })}\n\n`);
        }
      }
    }
  }
  function broadcast(event, data) {
    for (const c of clients) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // fs.watch is fast and unreliable across filesystems; the stat poll is the
  // guarantee, so a missed watch event means a two-second delay, never a stale page.
  const watchers = [];
  for (const p of [dirname(watched.board), dirname(watched.runs), watched.eventsDir, watched.archiveDir]) {
    try {
      watchers.push(watch(p, { persistent: false }, () => setImmediate(pump)));
    } catch {
      /* missing dir: the poll covers it */
    }
  }
  const poll = setInterval(pump, pollMs);
  const beat = setInterval(() => {
    for (const c of clients) c.res.write(`: heartbeat\n\n`);
  }, heartbeatMs);

  function openStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    });
    const files = tailSources();
    const resume = decodeCursor(req.headers["last-event-id"]);
    const offsets = {};
    // With Last-Event-ID, every file resumes from its offset in the cursor, so
    // there is no gap and no duplicate. A fresh client starts at the end: it
    // has just fetched the current state over REST.
    for (const [name, path] of Object.entries(files)) offsets[name] = name in resume ? resume[name] : req.headers["last-event-id"] ? 0 : lineStart(path);
    const c = { res, offsets };
    clients.add(c);
    res.write(`retry: 3000\n\n`);
    // hello carries the cursor, so a client that drops before any log event
    // still resumes from here rather than reconnecting as fresh (a gap).
    res.write(`id: ${encodeCursor(offsets)}\nevent: hello\ndata: ${JSON.stringify({ sources: rm.sources() })}\n\n`);
    req.on("close", () => clients.delete(c));
    if (req.headers["last-event-id"]) setImmediate(pump);
  }

  function openRunStream(req, res, id) {
    const name = rm.runFilePath(id, "transcript.live.log") ? "transcript.live.log" : rm.runFilePath(id, "transcript.log") ? "transcript.log" : null;
    if (!name) return send(res, 404, { error: "no transcript recorded for this run" });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP });
    let from = Number(decodeCursor(req.headers["last-event-id"])[name] ?? 0);
    const tick = () => {
      const r = rm.runFile(id, name, from);
      if (r && r.next > from) {
        from = r.next;
        res.write(`id: ${name}:${from}\nevent: text\ndata: ${JSON.stringify(r.text)}\n\n`);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    // The same heartbeat as the main stream: a quiet transcript must not look
    // like a dead connection to a proxy, or to EventSource.
    const hb = setInterval(() => res.write(`: heartbeat\n\n`), heartbeatMs);
    req.on("close", () => {
      clearInterval(t);
      clearInterval(hb);
    });
  }

  /* ----------------------------------------------------------------- routes */
  const API = "/api/v1";
  async function route(req, res, url) {
    const path = url.pathname;
    const q = url.searchParams;
    if (req.method === "GET") {
      if (path === `${API}/snapshot`) return send(res, 200, rm.snapshot());
      if (path === `${API}/work`) return send(res, 200, rm.work());
      let m = path.match(/^\/api\/v1\/work\/([^/]+)$/);
      if (m) {
        const w = rm.workItem(decodeURIComponent(m[1]));
        return w ? send(res, 200, w) : send(res, 404, { error: "no such task" });
      }
      if (path === `${API}/inbox`) return send(res, 200, rm.inbox());
      if (path === `${API}/runs`) return send(res, 200, rm.runs({ task: q.get("task"), state: q.get("state"), agent: q.get("agent"), model: q.get("model") }));
      m = path.match(/^\/api\/v1\/runs\/([^/]+)(?:\/(transcript|stderr|diff|egress|stream|control))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!/^r_[0-9a-f]{8}$/.test(id)) return send(res, 400, { error: "a run id is r_ and eight hex digits" });
        if (!m[2]) {
          const r = rm.run(id);
          return r ? send(res, 200, r) : send(res, 404, { error: "no such run" });
        }
        if (m[2] === "stream") return openRunStream(req, res, id);
        if (m[2] === "control") {
          const c = rm.runControl(id);
          return c ? send(res, 200, c) : send(res, 404, { error: "no such run" });
        }
        const name = { transcript: rm.runFilePath(id, "transcript.log") ? "transcript.log" : "transcript.live.log", stderr: "stderr.log", diff: "diff.patch", egress: "egress.jsonl" }[m[2]];
        const r = rm.runFile(id, name, q.get("from") ?? 0);
        if (!r) return send(res, 404, { error: `not recorded: no ${name} in the run archive` });
        return send(res, 200, r.text, { "Content-Type": "text/plain; charset=utf-8", "X-Next-Offset": String(r.next), "X-Size": String(r.size) });
      }
      if (path === `${API}/agents`) return send(res, 200, rm.agents());
      if (path === `${API}/specs`) return send(res, 200, rm.specs());
      if (path === `${API}/metrics`) return send(res, 200, rm.metrics(q.get("days") ?? 14));
      if (path === `${API}/events`) return send(res, 200, rm.events({ limit: Math.min(Number(q.get("limit")) || 100, 1000), level: q.get("level") }));
      if (path === `${API}/settings`) return send(res, 200, rm.settings({ host, port: actualPort, loopbackOnly: true, rotate: "restart the server to rotate it; the token lives only in its process" }));
      if (path === `${API}/stream`) return openStream(req, res);
      return send(res, 404, { error: "no such route" });
    }
    if (req.method === "POST") {
      // Steering a live run: answer its question, or send it a message.
      const r = path.match(/^\/api\/v1\/runs\/(r_[0-9a-f]{8})\/(answer|steer)$/);
      if (r) {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, e.status ?? 400, { error: e.status ? e.message : "body is not JSON" });
        }
        const out = rm.steerRun(r[1], r[2], body);
        return send(res, out.status, out.body);
      }
      const m = path.match(/^\/api\/v1\/work\/([^/]+)\/commands$/);
      if (!m) return send(res, 404, { error: "no such route" });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, e.status ?? 400, { error: e.status ? e.message : "body is not JSON" });
      }
      if (!body || typeof body.cmd !== "string") return send(res, 400, { error: "expected { cmd, args }" });
      const args = body.args && typeof body.args === "object" ? body.args : {};
      const out = rm.command(decodeURIComponent(m[1]), body.cmd, args);
      if (out.status === 200) setImmediate(pump);
      return send(res, out.status, out.body);
    }
    return send(res, 405, { error: "method not allowed" });
  }

  const server = createServer(async (req, res) => {
    try {
      if (!hostsOk().has(req.headers.host ?? "")) return send(res, 421, { error: "wrong Host" });
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === "/auth") {
        const t = Buffer.from(url.searchParams.get("t") ?? "");
        if (t.length !== tokenBuf.length || !timingSafeEqual(t, tokenBuf)) return send(res, 403, "wrong or expired token; use the URL the server printed", { "Content-Type": "text/plain; charset=utf-8" });
        return send(res, 302, "", { "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/" });
      }
      const isApi = url.pathname.startsWith("/api/");
      if (isApi || url.pathname === "/board.html") {
        if (!cookieOk(req)) return send(res, 401, { error: "not signed in: open the URL the server printed" });
      }
      if (req.method === "POST") {
        const origin = req.headers.origin;
        if (!origin || !hostsOk().has(origin.replace(/^http:\/\//, "")) || !origin.startsWith("http://")) return send(res, 403, { error: "cross-origin write refused" });
        if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "writes are application/json" });
        if (req.headers["x-caretaker"] !== "1") return send(res, 403, { error: "missing X-Caretaker header" });
      } else if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, { error: "method not allowed" });
      }
      if (isApi) return await route(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      if (url.pathname === "/board.html") {
        const p = rm.settings().paths.page;
        if (!p || !existsSync(p)) return send(res, 404, "not recorded: docs/board.html has not been generated (node ops/caretaker/dashboard.mjs)", { "Content-Type": "text/plain; charset=utf-8" });
        // Generated outside this server and full of agent-written text: no script runs in it.
        return send(res, 200, readFileSync(p), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox" });
      }
      return serveStatic(res, url.pathname);
    } catch (e) {
      return send(res, 500, { error: String(e.message ?? e).split("\n")[0] });
    }
  });

  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/auth?t=${token}`;
  log(`Caretaker is serving ${rm.cfg.name ?? "the board"} on http://127.0.0.1:${actualPort} (loopback only).`);
  log(`Open this once to sign in; it is the only copy of the token:\n\n  ${url}\n`);
  if (!existsSync(join(dist, "index.html"))) log(`The web client is not built: npm --prefix web ci && npm --prefix web run build`);
  log(`Ctrl-C stops it. Remote: ssh -L ${actualPort}:127.0.0.1:${actualPort} <host>`);

  return {
    server,
    port: actualPort,
    url,
    token,
    readmodel: rm,
    pump,
    close: () =>
      new Promise((done) => {
        clearInterval(poll);
        clearInterval(beat);
        for (const w of watchers) w.close();
        for (const c of clients) c.res.end();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}

/* --------------------------------------------------------------------- cli */
const isEntry = (() => {
  try {
    return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntry) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfgPath = argv.find((a, i) => !a.startsWith("--") && !["--port", "--host", "--state-dir"].includes(argv[i - 1]));
  if (!cfgPath) {
    console.error("usage: node bin/serve.mjs path/to/ops/caretaker/config.json [--port 7420]");
    process.exit(2);
  }
  try {
    const s = await startServer({ cfgPath, port: Number(flag("--port") ?? 7420), host: flag("--host") ?? "127.0.0.1", stateDir: flag("--state-dir") });
    const stop = () => s.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(`serve: ${e.message}`);
    process.exit(1);
  }
}

