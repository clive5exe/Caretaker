#!/usr/bin/env node
/**
 * W-1, W-2, W-3, W-4: the server, attacked (TECH.md §5, "prove a control by
 * attacking it"). Every control in serve.mjs's header has a request here that
 * tries to get past it.
 *
 *   1. auth: no cookie, wrong token, wrong Host (DNS rebinding), bind refusal,
 *      the token never on the command line
 *   2. writes: cross-origin, form-shaped, headerless, oversized
 *   3. files: traversal in the run id and the name, a symlink out of the
 *      archive, shadow/, static traversal; served text is inert and redacted
 *   4. commands: core's refusal comes back verbatim and changes nothing; an
 *      accepted one records who and via
 *   5. numbers: the API headlines what dashboard.metrics() computes
 *   6. stream: a half line is held, one line is one event, Last-Event-ID
 *      resumes with no gap and no duplicate, a board write invalidates
 *
 * Run: node bin/serve.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lineStart, startServer, tailFile } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* fixture ----------------------------------------------------------------- */
const root = mkdtempSync(join(tmpdir(), "caretaker-serve-"));
const ops = join(root, "ops", "caretaker");
const state = join(root, "state");
const evDir = join(ops, "events");
mkdirSync(evDir, { recursive: true });
mkdirSync(join(root, "docs"), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(ops, "board.mjs"));
copyFileSync(join(HERE, "dashboard.mjs"), join(ops, "dashboard.mjs"));
writeFileSync(
  join(ops, "config.json"),
  JSON.stringify({ name: "Fixture", board: "docs/board.json", out: "docs/board.html", repo: ".", activePhase: "P", operator: "five" }),
);
const boardFile = join(root, "docs", "board.json");
writeFileSync(
  boardFile,
  `${JSON.stringify(
    {
      meta: { name: "Fixture" },
      phases: [
        {
          name: "P",
          tasks: [
            { id: "T-1", title: "one", owner: "b", est: "2h", status: "doing", ac: "x", gate: { qa: { verdict: "pass", at: "2026-09-28" } } },
            { id: "T-2", title: "two", owner: "b", est: "3h", status: "todo", ac: "y", spec: "docs/two.md" },
            { id: "T-3", title: "three", owner: "b", est: "1h", status: "done", completed: "2026-09-28", ac: "z", gate: { reviewer: { verdict: "pass", at: "2026-09-28" }, qa: { verdict: "pass", at: "2026-09-28" } } },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(root, "docs", "board.html"), "<!doctype html><script>alert(1)</script><p>board</p>");
const KEY = `sk-ant-${"a1B2".repeat(8)}`;
const RUN = "r_0000000a";
mkdirSync(join(state, "runs", RUN), { recursive: true });
writeFileSync(join(state, "runs", RUN, "run.json"), JSON.stringify({ task: "T-1", verdict: { state: "ok", startedAt: "2026-09-28T10:00:00Z", endedAt: "2026-09-28T10:05:00Z" } }));
writeFileSync(join(state, "runs", RUN, "transcript.log"), `hello <script>alert(1)</script>\nkey ${KEY}\n`);
mkdirSync(join(state, "runs", RUN, "shadow"), { recursive: true });
writeFileSync(join(state, "runs", RUN, "shadow", "secret.txt"), "shadow copy\n");
writeFileSync(join(root, "outside.txt"), "outside the archive\n");
mkdirSync(join(state, "runs", "r_0000000b"), { recursive: true });
symlinkSync(join(root, "outside.txt"), join(state, "runs", "r_0000000b", "transcript.log"));
const dist = join(root, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
writeFileSync(join(dist, "assets", "a.js"), "console.log(1)");
const cfgPath = join(ops, "config.json");
spawnSync("git", ["-C", root, "init", "-q"]);
spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);

const s = await startServer({ cfgPath, dist, port: 0, stateDir: state, pollMs: 60_000, heartbeatMs: 60_000, log: () => {} });
const PORT = s.port;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
let cookie = "";

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolveReq, reject) => {
    const r = request({ host: "127.0.0.1", port: PORT, method, path, headers: { Host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolveReq({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const get = (path, headers = {}) => req("GET", path, { headers: { Cookie: cookie, ...headers } });
const WRITE = () => ({ Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", "X-Caretaker": "1" });
const post = (path, obj, headers = WRITE()) => req("POST", path, { headers, body: typeof obj === "string" ? obj : JSON.stringify(obj) });

/* 1. auth ----------------------------------------------------------------- */
{
  ok("the token is 256 bits of hex", /^[0-9a-f]{64}$/.test(s.token));
  let r = await req("GET", "/api/v1/snapshot");
  ok("no cookie: the API is 401", r.status === 401);
  r = await req("GET", "/api/v1/stream");
  ok("no cookie: the stream is 401", r.status === 401);
  r = await req("GET", "/board.html");
  ok("no cookie: board.html is 401", r.status === 401);
  r = await req("GET", `/auth?t=${"0".repeat(64)}`);
  ok("a wrong token is 403 and sets no cookie", r.status === 403 && !r.headers["set-cookie"]);
  r = await req("GET", `/auth?t=${s.token.slice(0, 10)}`);
  ok("a short token is 403", r.status === 403);
  r = await req("GET", `/auth?t=${s.token}`);
  const sc = String(r.headers["set-cookie"] ?? "");
  ok("the right token redirects to / (out of the address bar)", r.status === 302 && r.headers.location === "/");
  ok("the cookie is named by port, HttpOnly and SameSite=Strict", sc.startsWith(`caretaker_${PORT}=`) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), sc);
  cookie = sc.split(";")[0];
  r = await get("/api/v1/snapshot");
  ok("with the cookie the API answers", r.status === 200 && r.json?.name === "Fixture");
  r = await get("/api/v1/snapshot", { Cookie: `caretaker_${PORT}=${"f".repeat(64)}` });
  ok("the right cookie name with a wrong value is 401", r.status === 401);
  r = await get("/api/v1/snapshot", { Cookie: `caretaker_${PORT + 1}=${s.token}` });
  ok("the right token under another port's cookie name is 401", r.status === 401);
  for (const h of ["evil.example:" + PORT, `127.0.0.1:${PORT + 1}`, "127.0.0.1", `attacker.127.0.0.1.nip.io:${PORT}`]) {
    r = await get("/api/v1/snapshot", { Host: h });
    ok(`Host ${h} is refused even with the cookie (DNS rebinding)`, r.status === 421);
  }
  r = await get("/api/v1/snapshot", { Host: `localhost:${PORT}` });
  ok("Host localhost:<port> is accepted", r.status === 200);
  ok("no response carries a CORS header", !Object.keys(r.headers).some((k) => k.startsWith("access-control")));
  ok("every response carries the CSP", /script-src 'self'/.test(r.headers["content-security-policy"] ?? "") && /frame-ancestors 'none'/.test(r.headers["content-security-policy"] ?? ""));
  let refused = null;
  for (const host of ["0.0.0.0", "192.168.1.5", "::"]) {
    try {
      await startServer({ cfgPath, dist, port: 0, host, stateDir: state, log: () => {} });
    } catch (e) {
      refused = e.message;
      continue;
    }
    refused = null;
    break;
  }
  ok("binding anything but loopback is refused, naming ssh -L", !!refused && /ssh -L/.test(refused), refused ?? "it bound");
}

{
  // The CLI: the token is printed, never taken from argv or the environment.
  const child = spawn("node", [join(HERE, "serve.mjs"), cfgPath, "--port", "0", "--state-dir", state], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  for (let i = 0; i < 50 && !/auth\?t=/.test(out); i++) await sleep(100);
  const tok = out.match(/auth\?t=([0-9a-f]+)/)?.[1] ?? "";
  let cmdline = "";
  try {
    cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
  } catch {
    cmdline = "(no /proc)";
  }
  let environ = "";
  try {
    environ = readFileSync(`/proc/${child.pid}/environ`, "utf8");
  } catch {
    environ = "";
  }
  ok("the CLI prints a 64-hex bootstrap URL", tok.length === 64, out);
  ok("and the token is in neither its argv nor its environment", !!tok && !cmdline.includes(tok) && !environ.includes(tok));
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
}

/* 2. writes --------------------------------------------------------------- */
{
  const before = readFileSync(boardFile, "utf8");
  const cmd = { cmd: "note", args: { text: "should not land" } };
  const W = WRITE();
  const cases = [
    ["no Origin", { ...W, Origin: undefined }, 403],
    ["a foreign Origin", { ...W, Origin: "http://evil.example" }, 403],
    ["another port's Origin", { ...W, Origin: `http://127.0.0.1:${PORT + 1}` }, 403],
    ["an https Origin", { ...W, Origin: `https://${HOST}` }, 403],
    ["a null Origin (sandboxed frame)", { ...W, Origin: "null" }, 403],
    ["a form's content type", { ...W, "Content-Type": "application/x-www-form-urlencoded" }, 415],
    ["text/plain (a no-preflight fetch)", { ...W, "Content-Type": "text/plain" }, 415],
    ["no X-Caretaker", { ...W, "X-Caretaker": undefined }, 403],
    ["no cookie", { ...W, Cookie: undefined }, 401],
  ];
  for (const [name, h, want] of cases) {
    const headers = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
    const r = await post("/api/v1/work/T-2/commands", cmd, headers);
    ok(`a write with ${name} is ${want}`, r.status === want, `${r.status} ${r.text}`);
  }
  ok("and none of them changed the board", readFileSync(boardFile, "utf8") === before);
  let r = await post("/api/v1/work/T-2/commands", `{"cmd":"note","args":{"text":"${"x".repeat(70 * 1024)}"}}`);
  ok("an oversized body is 413", r.status === 413, String(r.status));
  r = await post("/api/v1/work/T-2/commands", "not json");
  ok("a body that is not JSON is 400", r.status === 400);
  r = await req("PUT", "/api/v1/work/T-2/commands", { headers: WRITE(), body: "{}" });
  ok("PUT is 405", r.status === 405);
  r = await post("/", {});
  ok("a POST outside the API is 405", r.status === 405);
  ok("the board is still untouched", readFileSync(boardFile, "utf8") === before);
}

/* 3. files ---------------------------------------------------------------- */
{
  const bad = [
    `/api/v1/runs/..%2F..%2Foutside.txt/transcript`,
    `/api/v1/runs/${encodeURIComponent("../../outside")}`,
    `/api/v1/runs/r_0000000a%2F..%2F..%2Foutside/transcript`,
    `/api/v1/runs/R_0000000A/transcript`,
  ];
  for (const p of bad) {
    const r = await get(p);
    ok(`a bad run id is refused: ${p}`, r.status === 400 || r.status === 404, `${r.status}`);
    ok("  and nothing outside leaks", !r.text.includes("outside the archive"));
  }
  let r = await get(`/api/v1/runs/${RUN}/shadow`);
  ok("shadow/ is not a route", r.status === 404 && !r.text.includes("shadow copy"));
  r = await get(`/api/v1/runs/${RUN}/shadow%2Fsecret.txt`);
  ok("nor a file under it", r.status === 404 && !r.text.includes("shadow copy"));
  r = await get(`/api/v1/runs/r_0000000b/transcript`);
  ok("a symlink out of the archive is 404", r.status === 404 && !r.text.includes("outside the archive"), r.text);
  r = await get(`/api/v1/runs/${RUN}/transcript`);
  ok("a transcript is served as text/plain with nosniff", r.status === 200 && /^text\/plain/.test(r.headers["content-type"]) && r.headers["x-content-type-options"] === "nosniff");
  ok("a <script> in it arrives as text, byte for byte", r.text.includes("<script>alert(1)</script>"));
  ok("a planted key is redacted by shape", !r.text.includes(KEY) && r.text.includes("[redacted:anthropic]"), r.text);
  r = await get(`/api/v1/runs/${RUN}/diff`);
  ok("a file not recorded is 404 saying so", r.status === 404 && /not recorded/.test(r.json?.error ?? ""));
  r = await get("/board.html");
  ok("board.html is served under CSP sandbox", r.status === 200 && r.headers["content-security-policy"] === "sandbox");
  // dist is <root>/dist and the board is <root>/docs/board.json: ONE level up.
  // Independent review: this climbed two, so it could not fail.
  ok("the traversal target is really one level above dist", existsSync(join(dist, "..", "docs", "board.json")));
  for (const path of ["/..%2fdocs%2fboard.json", "/%2e%2e/docs/board.json", "/assets/..%2f..%2fdocs%2fboard.json"]) {
    r = await get(path);
    ok(`static traversal does not leave dist: ${path}`, !r.text.includes("phases"), `${r.status} ${r.text.slice(0, 80)}`);
  }
  r = await get("/assets/a.js");
  ok("static assets are served with their type", r.status === 200 && /javascript/.test(r.headers["content-type"]));
  r = await get("/work/T-1");
  ok("a client route falls back to index.html", r.status === 200 && r.text.includes("<title>app</title>"));
}

/* 4. commands ------------------------------------------------------------- */
{
  const board = await import(join(ops, "board.mjs"));
  const before = readFileSync(boardFile, "utf8");
  const t1 = board.find(JSON.parse(before), "T-1").t;
  let r = await post("/api/v1/work/T-1/commands", { cmd: "done" });
  ok("done with a gate missing is 409", r.status === 409, r.text);
  {
    // H-4 through the web: T-3 has every gate passed; a failing drift gate
    // for it must still refuse done, as on the CLI.
    const f = join(evDir, "events-2026-01-01.jsonl");
    writeFileSync(f, `${JSON.stringify({ t: "2026-01-01T00:00:00Z", kind: "gate", level: "error", stage: "review", task: "T-3", verdict: "fail", detail: "drift 1" })}\n`);
    const d = await post("/api/v1/work/T-3/commands", { cmd: "done" });
    rmSync(f);
    ok("done is 409 through the web while the drift gate fails", d.status === 409 && /drift gate/.test(d.text), d.text);
  }
  ok("the refusal is core's missingGates, verbatim", JSON.stringify(r.json?.refused) === JSON.stringify(board.missingGates(t1)), r.text);
  ok("and the board is byte-identical", readFileSync(boardFile, "utf8") === before);
  r = await post("/api/v1/work/T-9/commands", { cmd: "note", args: { text: "x" } });
  ok("an unknown task is 404", r.status === 404);
  r = await post("/api/v1/work/T-1/commands", { cmd: "qa", args: {} });
  ok("a verdict is not a command the web can send", r.status === 400);
  r = await post("/api/v1/work/T-1/commands", { cmd: "answer", args: { qid: "q9", text: "x" } });
  ok("core's error comes back as 409 with its words", r.status === 409 && /q9/.test(r.json?.error ?? ""), `${r.status} ${r.text}`);
  r = await post("/api/v1/work/T-2/commands", { cmd: "ask", args: { text: "which port?" } });
  const q = JSON.parse(readFileSync(boardFile, "utf8")).phases[0].tasks.find((t) => t.id === "T-2").questions?.[0];
  ok("an accepted command returns the updated work item", r.status === 200 && r.json?.task?.openQuestions === 1, r.text);
  ok("and core recorded it by the operator, via web", q?.by === "five" && q?.via === "web" && q?.q === "which port?", JSON.stringify(q));
  // W-4 (independent review): transitions ignored by and via, though the UI said they were recorded.
  r = await post("/api/v1/work/T-2/commands", { cmd: "block", args: { text: "waiting on a key" } });
  const moves = JSON.parse(readFileSync(boardFile, "utf8")).phases[0].tasks.find((t) => t.id === "T-2").transitions ?? [];
  ok("a transition through the web records by the operator, via web", r.status === 200 && moves.at(-1)?.cmd === "block" && moves.at(-1)?.by === "five" && moves.at(-1)?.via === "web" && /T/.test(moves.at(-1)?.at ?? ""), JSON.stringify(moves));
}

/* 5. numbers -------------------------------------------------------------- */
{
  const dash = await import(join(ops, "dashboard.mjs"));
  const board = await import(join(ops, "board.mjs"));
  const d = JSON.parse(readFileSync(boardFile, "utf8"));
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const m = dash.metrics(d, null, dash.readGit(root, 14, new Date()), cfg, new Date());
  const snap = (await get("/api/v1/snapshot")).json;
  ok("progress by effort is dashboard.metrics' figure", snap.progress.pctEffort === m.pctEffort && snap.progress.totalHours === m.totalHours, `${snap.progress.pctEffort} vs ${m.pctEffort}`);
  ok("the first-pass rate is dashboard.metrics' figure", JSON.stringify(snap.quality) === JSON.stringify(m.quality));
  ok("held is dashboard.metrics' figure", snap.held === m.heldTotal);
  ok("a missing run log is null, not zero", snap.sources.runs === "absent" && snap.tokensPerClosedTask === null && snap.legacyRunning === null);
  const { kpis, gitFacts } = await import("./kpis.mjs");
  const mk = (await get("/api/v1/metrics?days=30")).json.kpis;
  const want = kpis({ board: d, runs: null, facts: gitFacts(root, { days: 30 }), cfg });
  ok("the Metrics API's KPIs are kpis.mjs's, with no run log as null", JSON.stringify(mk) === JSON.stringify(want) && mk.ai.tokensPerClosedTask === null && mk.antiKpis.length === 3, JSON.stringify(mk).slice(0, 300));
  const work = (await get("/api/v1/work")).json;
  const t3 = work.tasks.find((t) => t.id === "T-3");
  ok("a closed task is in the done stage", t3.lifecycle === "done");
  ok("a work card carries its spec path, and null for none (B-3)", work.tasks.find((t) => t.id === "T-2")?.specPath === "docs/two.md" && t3.specPath === null);
  ok("a work item's commands come from lifecycle.commandsFor", !work.tasks.some((t) => t.commands.some((c) => ["reviewer", "qa", "security"].includes(c.cmd))));
  const run = (await get(`/api/v1/runs/${RUN}`)).json;
  ok("a run folds its archive record", run?.task === "T-1" && run?.status === "ok", JSON.stringify(run));
  ok("and names the files it has", run?.archiveFiles?.["transcript.log"] > 0 && run?.archiveFiles?.["diff.patch"] === null, JSON.stringify(run?.archiveFiles));
  void board;
}

/* 6. stream --------------------------------------------------------------- */
function openStream(lastId) {
  const events = [];
  let buf = "";
  const r = request({ host: "127.0.0.1", port: PORT, path: "/api/v1/stream", headers: { Host: HOST, Cookie: cookie, ...(lastId ? { "Last-Event-ID": lastId } : {}) } });
  r.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { id: null, event: "message", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = line.slice(4);
          else if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data += line.slice(6);
        }
        if (ev.data) events.push({ ...ev, json: JSON.parse(ev.data) });
      }
    });
  });
  r.end();
  return { events, close: () => r.destroy() };
}
const logs = (st) => st.events.filter((e) => e.event === "log");
const line = (n) => `${JSON.stringify({ t: `2026-09-29T10:00:0${n}Z`, kind: "system", level: "info", detail: `event ${n}` })}\n`;
{
  const evFile = join(evDir, "events-2026-09-29.jsonl");
  writeFileSync(evFile, line(0)); // history before the client connects
  const a = openStream();
  await sleep(200);
  ok("the stream says hello with the sources", a.events[0]?.event === "hello" && !!a.events[0].json.sources);
  // W-3 (independent review): hello had no id, so a client that dropped before
  // any log event reconnected as fresh, and missed what arrived meanwhile.
  ok("hello carries the cursor, pointing at the end of what exists", a.events[0]?.id?.includes(`${basename(evFile)}:${line(0).length}`), a.events[0]?.id);
  ok("a fresh client does not replay history (it has just fetched it)", logs(a).length === 0);
  const l1 = line(1);
  appendFileSync(evFile, l1.slice(0, 20));
  s.pump();
  await sleep(150);
  ok("a half-written line is held back", logs(a).length === 0);
  appendFileSync(evFile, l1.slice(20));
  s.pump();
  await sleep(150);
  ok("once complete it is exactly one event", logs(a).length === 1 && logs(a)[0].json.detail === "event 1", JSON.stringify(logs(a)));
  const lastId = logs(a)[0]?.id;
  a.close();
  appendFileSync(evFile, line(2) + line(3));
  const b = openStream(lastId);
  await sleep(300);
  s.pump();
  await sleep(150);
  const got = logs(b).map((e) => e.json.detail);
  ok("Last-Event-ID resumes with no gap and no duplicate", got.join() === "event 2,event 3", got.join());
  const planted = `${JSON.stringify({ t: "2026-09-29T10:00:09Z", kind: "system", level: "warn", detail: `leaked ${KEY}` })}\n`;
  appendFileSync(evFile, planted);
  s.pump();
  await sleep(150);
  const last = logs(b).at(-1);
  ok("a key in a streamed event is redacted", last && !last.data.includes(KEY) && last.data.includes("[redacted:anthropic]"));
  // The same event through the REST routes, which the stream's redaction
  // never covered: every route that serves the event log gets it redacted.
  for (const route of ["/api/v1/events", "/api/v1/snapshot"]) {
    const body = (await get(route)).text;
    ok(`…and on ${route}`, body.includes("[redacted:anthropic]") && !body.includes(KEY), body.slice(0, 200));
  }
  // W-3 (independent QA): a fresh client started at the file's SIZE, which is
  // mid-line while a writer is part-way through one; that line was lost.
  const l5 = line(5);
  appendFileSync(evFile, l5.slice(0, 25));
  const c = openStream();
  await sleep(200);
  appendFileSync(evFile, l5.slice(25));
  s.pump();
  await sleep(150);
  ok("a client that connects while a line is half-written still gets that line", logs(c).map((e) => e.json.detail).join() === "event 5", JSON.stringify(logs(c)));
  c.close();
  const d = JSON.parse(readFileSync(boardFile, "utf8"));
  d.phases[0].tasks[1].note = "changed by the CLI";
  writeFileSync(boardFile, `${JSON.stringify(d, null, 2)}\n`);
  s.pump();
  await sleep(150);
  ok("a board write sends invalidate board", b.events.some((e) => e.event === "invalidate" && e.json.resource === "board"));
  b.close();
}

{
  // W-3: tailing helpers.
  const f = join(root, "tail-test.jsonl");
  writeFileSync(f, "{}\n{\"a\":1}\n{\"b\"");
  ok("lineStart is just after the last complete line", lineStart(f) === "{}\n{\"a\":1}\n".length);
  writeFileSync(f, "no newline at all");
  ok("…and 0 when there is none", lineStart(f) === 0 && lineStart(join(root, "absent")) === 0);
  // Independent review: a line longer than the read window stalled the file forever.
  writeFileSync(f, `${JSON.stringify({ big: "x".repeat(100) })}\n${JSON.stringify({ ok: 1 })}\n`);
  let at = 0;
  let got = [];
  for (let i = 0; i < 20 && !got.length; i++) {
    const r = tailFile(f, at, { window: 32 });
    at = r.offset;
    got = r.records;
  }
  ok("a line longer than the window is skipped, not waited on, and the next line is read", got[0]?.value?.ok === 1, JSON.stringify({ at, got }));
}
{
  // W-3: the per-run stream had no heartbeat.
  const hs = await startServer({ cfgPath, dist, port: 0, stateDir: state, pollMs: 60_000, heartbeatMs: 50, log: () => {}, token: "t".repeat(64) });
  const port = hs.port;
  const auth = await new Promise((res) => request({ host: "127.0.0.1", port, path: `/auth?t=${"t".repeat(64)}`, headers: { Host: `127.0.0.1:${port}` } }, (r) => res(r.headers["set-cookie"]?.[0]?.split(";")[0])).end());
  const raw = await new Promise((res) => {
    let text = "";
    const r = request({ host: "127.0.0.1", port, path: `/api/v1/runs/${RUN}/stream`, headers: { Host: `127.0.0.1:${port}`, Cookie: auth } }, (resp) => {
      resp.setEncoding("utf8");
      resp.on("data", (c) => (text += c));
    });
    r.end();
    setTimeout(() => {
      r.destroy();
      res(text);
    }, 400);
  });
  ok("the per-run stream sends heartbeats", /: heartbeat/.test(raw), raw.slice(0, 200));
  await hs.close();
}

await s.close();
rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n[serve] ${failures} FAILED` : "\n[serve] all checks passed");
process.exit(failures ? 1 : 0);
