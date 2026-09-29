#!/usr/bin/env node
/**
 * Tests for the egress proxy.
 *
 * THE REFUSALS ARE THE PRODUCT. An allowlist that lets something through is not
 * a slightly worse allowlist, it is not an allowlist, so most of these assert
 * that something is denied — including the bypasses that look correct to whoever
 * wrote the matcher.
 *
 * Run: node bin/egress.test.mjs
 */
import { createProxy, allowed, splitHostPort } from "./egress.mjs";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { connect as tcpConnect, createServer as tcpServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};

/* ---------------------------------------------------------------- matching */

const LIST = ["api.anthropic.com", "registry.npmjs.org", ".stripe.com"];

ok("an exact host is allowed", allowed("api.anthropic.com", LIST));
ok("case is ignored", allowed("API.Anthropic.COM", LIST));
ok("a trailing dot is ignored", allowed("api.anthropic.com.", LIST));
ok("an unlisted host is refused", !allowed("evil.example", LIST));

ok(
  "a leading-dot entry allows a subdomain",
  allowed("api.stripe.com", LIST) && allowed("files.stripe.com", LIST),
);
ok("a leading-dot entry allows the apex too", allowed("stripe.com", LIST));

ok(
  "SUFFIX CONFUSION IS REFUSED: evil-stripe.com is not stripe.com",
  !allowed("evil-stripe.com", LIST),
  "matching on raw string suffixes is how allowlists get bypassed, and it looks correct in " +
    "every test written by the person who wrote the bug",
);
ok(
  "a host that merely CONTAINS an allowed name is refused",
  !allowed("api.anthropic.com.evil.example", LIST),
  "the allowed name as a prefix of a longer domain must not pass",
);
ok(
  "a bare entry does not allow its subdomains",
  !allowed("evil.api.anthropic.com", LIST),
  "only a leading-dot entry opts into subdomains, and it has to be written that way",
);
ok("an empty allowlist refuses everything", !allowed("api.anthropic.com", []));

/* -------------------------------------------------------------- host:port */

ok("host:port splits", splitHostPort("example.com:443").port === 443);
ok("a bare host defaults to 443", splitHostPort("example.com").port === 443);
{
  const r = splitHostPort("[2606:4700::1111]:443");
  ok("an IPv6 literal is not split on its own colons", r.host === "2606:4700::1111" && r.port === 443, JSON.stringify(r));
}

/* ------------------------------------------------------------- the server */

const events = [];
const server = createProxy({ allowlist: ["allowed.example"], onEvent: (e) => events.push(e) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/*
 * NODE FIRES `connect` FOR ANY REPLY TO A CONNECT REQUEST, including a 403 —
 * not `response`. So a refusal's body arrives on the raw socket rather than
 * through the response parser, and reading it the obvious way finds nothing.
 * The first version of this test asserted an empty body and failed against a
 * proxy that was behaving correctly.
 */
const tryConnect = (authority) =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
    req.on("connect", (res, socket, head) => {
      if (res.statusCode === 200) {
        socket.destroy();
        return resolve({ status: 200, body: "" });
      }
      let body = String(head ?? "");
      socket.on("data", (c) => (body += c));
      socket.on("end", () => resolve({ status: res.statusCode, body }));
      socket.on("close", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ error: String(e.message) }));
    req.end();
  });

{
  const r = await tryConnect("blocked.example:443");
  ok(
    "an unlisted host gets 403, not a dropped connection",
    r.status === 403,
    JSON.stringify(r),
  );
  ok(
    "the refusal says WHY, so a block is not mistaken for a network fault",
    /not in this project's allowlist/.test(r.body ?? ""),
    r.body,
  );
}

{
  const r = await tryConnect("allowed.example:8443");
  ok(
    "an allowed host on a disallowed PORT is still refused",
    r.status === 403,
    "an allowlist that only checks the name lets anything through on any port",
  );
}

{
  await tryConnect("blocked.example:443");
  ok(
    "every refusal is logged with its reason",
    events.some((e) => e.kind === "refused" && e.host === "blocked.example" && e.reason === "not-allowed"),
    JSON.stringify(events.slice(-3)),
  );
}

{
  const before = events.length;
  await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "http://blocked.example/x" }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.end();
  });
  ok(
    "plain HTTP through the proxy is refused rather than forwarded",
    events.slice(before).some((e) => e.reason === "plain-http"),
    "forwarding cleartext is a second code path to get wrong for no gain",
  );
}

server.close();

{
  // THE PROXY SURVIVES A CLIENT THAT RESETS WHILE BEING REFUSED. On a CONNECT,
  // Node drops the socket's default error listener; a refusal path that added
  // none let one reset raise an uncaught ECONNRESET, and the proxy died,
  // taking every later request in the run with it (independent review,
  // reproduced three times). Run as the CLI, in its own process, so a crash
  // fails this check by name instead of taking the test down with it.
  const free = await new Promise((r) => {
    const s = tcpServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(here, "egress.mjs"), "serve", "--allow", "allowed.example", "--port", String(free)], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((r) => {
    const t = setInterval(() => /listening/.test(stderr) && (clearInterval(t), r()), 20);
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => {
      const c = tcpConnect(free, "127.0.0.1", () => {
        c.write("CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example:443\r\n\r\n");
        setImmediate(() => {
          c.resetAndDestroy();
          r();
        });
      });
      c.on("error", r);
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  const alive = child.exitCode === null;
  const after = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: free, method: "CONNECT", path: "blocked.example:443" });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(String(e.message)));
    req.end();
  });
  ok("THE PROXY SURVIVES CLIENTS THAT RESET WHILE BEING REFUSED, and still refuses", alive && after === 403, `alive=${alive} after=${after} ${stderr.split("\n").filter((l) => /Error|ECONNRESET/.test(l)).slice(0, 2).join(" | ")}`);
  child.kill();
}

console.log(failures === 0 ? "\n[egress] all checks passed" : `\n[egress] ${failures} FAILURE(S) above.`);
process.exit(failures === 0 ? 0 : 1);
