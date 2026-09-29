#!/usr/bin/env node
/**
 * C-5: a run's egress — what it was allowed to reach and what it was refused —
 * lands in THAT run's archive, and nowhere else.
 *
 * Offline half: the argv, the setup/teardown sequencing through an injected
 * exec, the archive redacting the proxy's log, and the proxy surviving a log
 * it cannot write. Live half: a real per-run network and proxy on podman,
 * attacked from a container, skipped with the reason printed where podman or
 * the images are missing (CI pulls both).
 *
 * Run: node bin/egress-attribution.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { perRunNames, proxyRunArgs, withRunEgress } from "./netns.mjs";
import { runArchived } from "./runstore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let skipped = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const skip = (name, why) => {
  console.log(`SKIP  ${name}\n      ${why}`);
  skipped += 1;
};
const throws = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e.message ?? String(e));
  }
};
const TMP = mkdtempSync(join(tmpdir(), "egress-attr-test-"));
const RUN = "r_0a1b2c3d";

/* -------------------------------------------------------------------- argv */
{
  const a = proxyRunArgs({ name: "p", internalNetwork: "i", egressNetwork: "e", allow: ["a.com"], logDir: "/host/state/runs/r_0a1b2c3d" });
  const s = a.join(" ");
  ok("the run's archive dir is mounted into the proxy, writable", s.includes("-v /host/state/runs/r_0a1b2c3d:/egress-log:Z ") && !s.includes("/egress-log:Z,ro"));
  ok("the proxy logs into that mount", s.endsWith("--log /egress-log/egress.jsonl"));
  ok("the tool mount stays read-only", /:\/egress-bin:Z,ro/.test(s));
  ok("no log mount unless asked for", !proxyRunArgs({ internalNetwork: "i", egressNetwork: "e", allow: ["a"] }).join(" ").includes("/egress-log"));
  ok("logFile and logDir together are refused", await throws(() => proxyRunArgs({ internalNetwork: "i", egressNetwork: "e", allow: ["a"], logFile: "/x", logDir: "/y" }), /not both/));
  ok("per-run names come from the run id", JSON.stringify(perRunNames(RUN)) === JSON.stringify({ internalNetwork: `fm-int-${RUN}`, proxyName: `fm-egress-${RUN}` }));
  ok("a malformed run id is refused before any name is built", await throws(() => perRunNames("x; rm -rf /"), /run id/));
}

/* ------------------------------------------------- sequencing, injected exec */
function fakeExec({ ip = "10.89.0.7", failOn = null, onProxyStart = null } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const line = args.join(" ");
    if (failOn && line.includes(failOn)) return { status: 125, stdout: "", stderr: `boom: ${failOn}` };
    if (args[0] === "run" && onProxyStart) onProxyStart(args);
    if (args[0] === "inspect") return { status: 0, stdout: `${ip}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const verb = (c) => `${c[0]} ${c[1] ?? ""}`.trim();

{
  const f = fakeExec();
  let seen = null;
  const out = await withRunEgress({ runId: RUN, allow: ["a.com"], logDir: TMP, exec: f.exec }, async (w) => {
    seen = w;
    return "ran";
  });
  ok("setup order: network, proxy, address — then teardown: proxy, network",
    JSON.stringify(f.calls.map(verb)) === JSON.stringify(["network create", "run -d", "inspect fm-egress-r_0a1b2c3d", "rm -f", "network rm"]),
    JSON.stringify(f.calls.map(verb)));
  ok("the network is internal with DNS off", f.calls[0].includes("--internal") && f.calls[0].includes("--disable-dns"));
  ok("the agent is put on the run's own network", seen?.net === `fm-int-${RUN}`);
  ok("the agent reaches the proxy by a static hosts entry", JSON.stringify(seen?.extraRunFlags) === JSON.stringify(["--add-host", "proxy:10.89.0.7"]));
  ok("the proxy variables point at it", seen?.env?.HTTPS_PROXY === "http://proxy:8080" && seen?.env?.https_proxy === "http://proxy:8080");
  ok("the result comes back with a clean teardown recorded", out.result === "ran" && out.cleanup.every((c) => c.ok) && out.cleanup.length === 2);
}
{
  const f = fakeExec();
  const threw = await throws(() => withRunEgress({ runId: RUN, allow: [], logDir: TMP, exec: f.exec }, async () => { throw new Error("agent exploded"); }), /agent exploded/);
  ok("teardown runs even when the run throws", threw && f.calls.some((c) => c[0] === "rm") && f.calls.some((c) => verb(c) === "network rm"));
  const run = f.calls.find((c) => c[0] === "run");
  ok("an empty allowlist reaches the proxy as deny-all, not as a missing flag", run[run.indexOf("--allow") + 1] === ",");
}
{
  const f = fakeExec({ failOn: "network create" });
  const threw = await throws(() => withRunEgress({ runId: RUN, allow: [], logDir: TMP, exec: f.exec }, async () => "never"), /create the run's internal network/);
  ok("no network means no run and no proxy", threw && !f.calls.some((c) => c[0] === "run"));
}
{
  const f = fakeExec({ ip: "proxy.evil; touch /x" });
  let ran = false;
  const threw = await throws(() => withRunEgress({ runId: RUN, allow: [], logDir: TMP, exec: f.exec }, async () => { ran = true; }), /IP address/);
  ok("an address that is not an address stops the run, and tears down", threw && !ran && f.calls.some((c) => verb(c) === "network rm"));
}
{
  const f = fakeExec({ failOn: "network rm" });
  const out = await withRunEgress({ runId: RUN, allow: [], logDir: TMP, exec: f.exec }, async () => "kept");
  ok("a failed teardown is reported, not thrown over the result", out.result === "kept" && out.cleanup.some((c) => c.step === "remove network" && !c.ok));
}

/* ---------------------------------------------- into the archive, redacted */
const SECRET = "sk-test-EXFIL-9f8e7d6c5b4a";
{
  const state = join(TMP, "state");
  const ws = join(TMP, "ws");
  mkdirSync(ws, { recursive: true });
  // The fake "proxy" writes the log the real one would, into the mounted dir.
  const f = fakeExec({
    onProxyStart: (args) => {
      const host = args[args.indexOf("-v", args.indexOf("-v") + 1) + 1].split(":")[0];
      writeFileSync(join(host, "egress.jsonl"),
        `${JSON.stringify({ t: "2026-09-29T00:00:00Z", kind: "allowed", host: "a.com", port: 443 })}\n` +
        `${JSON.stringify({ t: "2026-09-29T00:00:01Z", kind: "refused", reason: "not-allowed", host: `${SECRET}.evil.example`, port: 443 })}\n`);
    },
  });
  let policySeen = null;
  const harness = {
    run: async (_ws, _p, pol) => {
      policySeen = pol;
      mkdirSync(pol.logDir, { recursive: true });
      writeFileSync(join(pol.logDir, "transcript.log"), "hello\n");
      writeFileSync(join(pol.logDir, "stderr.log"), "");
      return {
        verdict: { runId: pol.runId, state: "completed", ok: true, adapter: "cli", cli: "claude", warnings: [] },
        diff: { measured: true, files: [], patch: "" },
        cost: null,
        transcript: { path: join(pol.logDir, "transcript.log"), stderrPath: join(pol.logDir, "stderr.log") },
      };
    },
  };
  const out = await runArchived(ws, "p", { runId: RUN, sandbox: "podman", extraRunFlags: ["--keep"] }, {
    stateDir: state, task: "T-1", secrets: { TEST_KEY: SECRET }, harness, egress: { allow: ["a.com"], exec: f.exec },
  });
  const dir = join(state, "runs", RUN);
  ok("the harness ran on the run's network", policySeen?.net === `fm-int-${RUN}`);
  ok("the caller's own run flags are kept, the hosts entry appended", JSON.stringify(policySeen?.extraRunFlags) === JSON.stringify(["--keep", "--add-host", "proxy:10.89.0.7"]));
  const log = existsSync(join(dir, "egress.jsonl")) ? readFileSync(join(dir, "egress.jsonl"), "utf8") : "";
  ok("the run's egress log is in its archive", log.includes('"kind":"allowed"') && log.includes('"kind":"refused"'));
  ok("a secret smuggled out as a hostname is redacted in the archive", !log.includes(SECRET) && log.includes("[redacted:TEST_KEY].evil.example"), log);
  const rec = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  ok("run.json names the network, the proxy and the allowlist", rec.egress?.network === `fm-int-${RUN}` && rec.egress?.proxy === `fm-egress-${RUN}` && rec.egress?.allow?.[0] === "a.com");
  ok("run.json records the teardown", rec.egress?.cleanup?.length === 2);
  ok("the proxy variables' values are not in run.json's policy", !JSON.stringify(rec.policy).includes("http://proxy:8080"));
  ok("an egress-attributed run with sandbox:none is refused", await throws(
    () => runArchived(ws, "p", { sandbox: "none" }, { stateDir: state, secrets: {}, harness, egress: { allow: [], exec: f.exec } }),
    /needs the agent in a container/,
  ));
  void out;
}

/* ------------------------------------- the proxy survives an unwritable log */
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("node", [join(HERE, "egress.mjs"), "serve", "--allow", "allowed.example", "--port", String(port), "--log", join(TMP, "no", "such", "dir", "egress.jsonl")], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  for (let i = 0; i < 50 && !stderr.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
  const knock = () => new Promise((res) => {
    const s = connect(port, "127.0.0.1", () => s.write("CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n"));
    let buf = "";
    s.on("data", (d) => (buf += d));
    s.on("close", () => res(buf));
    s.on("error", () => res(`error ${buf}`));
    setTimeout(() => { s.destroy(); res(buf || "timeout"); }, 3000);
  });
  const first = await knock();
  const second = await knock();
  ok("with an unwritable --log, the first refusal is still answered 403", first.startsWith("HTTP/1.1 403"), first.slice(0, 60));
  ok("…and the proxy is still up to answer the next one", second.startsWith("HTTP/1.1 403") && proc.exitCode === null, `${second.slice(0, 60)} exit=${proc.exitCode}`);
  ok("the unwritable log is reported once, by name", (stderr.match(/cannot write --log/g) ?? []).length === 1, stderr);
  proc.kill("SIGTERM");
}

/* ---------------------------------------------------------------------- live */
const LIVE = "live: a per-run proxy logs one run's allowed and refused hosts into that run's dir";
const rootless = spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], { encoding: "utf8" }).stdout?.trim();
const PROXY_IMAGE = process.env.NETNS_TEST_PROXY_IMAGE ?? "docker.io/library/node:22-alpine";
const AGENT_IMAGE = process.env.NETNS_TEST_AGENT_IMAGE ?? "docker.io/library/nginx:alpine";
const hasImage = (img) => spawnSync("podman", ["image", "exists", img], { stdio: "ignore" }).status === 0;
if (rootless !== "true") skip(LIVE, `podman not available or not rootless (got ${JSON.stringify(rootless)})`);
else if (!hasImage(PROXY_IMAGE)) skip(LIVE, `proxy image ${PROXY_IMAGE} not present — pull it`);
else if (!hasImage(AGENT_IMAGE)) skip(LIVE, `agent image ${AGENT_IMAGE} not present — pull it`);
else {
  const runId = `r_${(process.pid % 0xffffffff).toString(16).padStart(8, "0").slice(-8)}`;
  const logDir = join(TMP, "live", runId);
  mkdirSync(logDir, { recursive: true });
  const { internalNetwork } = perRunNames(runId);
  const curl = (w, host) => spawnSync("podman", ["run", "--rm", "--network", w.net, ...w.extraRunFlags, AGENT_IMAGE, "sh", "-c",
    `curl -sS -x ${w.env.HTTPS_PROXY} https://${host} -o /dev/null -w 'HTTP_STATUS=%{http_code}' --max-time 10 2>&1`], { encoding: "utf8", timeout: 60_000 });
  const out = await withRunEgress({ runId, allow: ["example.com"], logDir, image: PROXY_IMAGE }, async (w) => {
    await new Promise((r) => setTimeout(r, 1500)); // the proxy's listen, after `run -d` returns
    return { allowed: curl(w, "example.com"), denied: curl(w, "evil.example") };
  });
  const log = existsSync(join(logDir, "egress.jsonl")) ? readFileSync(join(logDir, "egress.jsonl"), "utf8") : "";
  ok(`${LIVE}: the allowed host is logged as allowed`, /"kind":"allowed","host":"example.com"/.test(log), `${log}\n${out.result.allowed.stdout}`);
  ok(`${LIVE}: the undeclared host is logged as refused`, /"kind":"refused".*"host":"evil.example"/.test(log), log);
  ok(`${LIVE}: the network is gone afterwards`, spawnSync("podman", ["network", "exists", internalNetwork]).status !== 0);
  ok(`${LIVE}: teardown reported clean`, out.cleanup.every((c) => c.ok), JSON.stringify(out.cleanup));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[egress-attribution] ${failures} FAILED` : `\n[egress-attribution] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`);
process.exit(failures ? 1 : 0);
