#!/usr/bin/env node
/**
 * H-2 / H-10: a second vendor behind the SAME seam, with the model call above
 * the dev environment and the tools inside it.
 *
 * A fake OpenAI-compatible server scripts each model reply, so the test sees
 * exactly what the harness sends back after each tool call. Offline half uses
 * sandbox:none; the live half starts a real container and is skipped, with the
 * reason printed, where podman or the image is missing (CI has both).
 *
 * Run: node bin/openai-compatible.test.mjs
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEAM_KEYS, run } from "./harness.mjs";
import { confine } from "./openai-compatible.mjs";
import { runArchived } from "./runstore.mjs";

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

/* ---------------------------------------------------------- fake server */
// scripts[model] is a list of replies; each request pops the next one.
const scripts = {};
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const j = JSON.parse(body);
    seen.push({ model: j.model, messages: j.messages, tools: j.tools, auth: req.headers.authorization ?? null });
    const next = (scripts[j.model] ?? []).shift();
    if (next === undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
    }
    if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
    if (next.status) {
      res.writeHead(next.status);
      return res.end(next.text ?? "");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ENDPOINT = `http://127.0.0.1:${server.address().port}/v1`;

const call = (name, args, id = `c${Math.random().toString(36).slice(2, 8)}`) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const say = (tool_calls, usage = null, content = null) => ({ choices: [{ message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) } }], ...(usage ? { usage } : {}) });
const lastToolReply = (model) => {
  const reqs = seen.filter((s) => s.model === model);
  const msgs = reqs.at(-1)?.messages ?? [];
  return msgs.filter((m) => m.role === "tool").map((m) => m.content);
};

const TMP = mkdtempSync(join(tmpdir(), "oac-test-"));
let wsN = 0;
const workspace = () => {
  const w = join(TMP, `ws${wsN++}`);
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, "README.md"), "hello\n");
  return w;
};
const policy = (model, over = {}) => ({ adapter: "openai-compatible", endpoint: ENDPOINT, model, sandbox: "none", timeoutMs: 20_000, events: false, logDir: join(TMP, `logs-${model}-${wsN}`), ...over });

/* ------------------------------------------------------ a normal run */
{
  const ws = workspace();
  scripts.normal = [
    say([call("read_file", { path: "README.md" })], { prompt_tokens: 100, completion_tokens: 10 }),
    say([call("write_file", { path: "src/hello.js", content: "export const hi = 1;\n" }), call("run", { command: "ls src" })], { prompt_tokens: 150, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 90 } }),
    say(null, { prompt_tokens: 200, completion_tokens: 5 }, "Added src/hello.js."),
  ];
  const out = await run(ws, "add a hello module", policy("normal"));
  ok("the seam is unchanged: diff, transcript, verdict, cost", JSON.stringify(Object.keys(out).sort()) === JSON.stringify([...SEAM_KEYS].sort()));
  ok("the run completed", out.verdict.state === "completed" && out.verdict.adapter === "openai-compatible", JSON.stringify(out.verdict.reason));
  ok("it names no CLI, because none ran", out.verdict.cli === null && out.cost.source === "openai-compatible-usage");
  ok("the model's write landed in the workspace", readFileSync(join(ws, "src", "hello.js"), "utf8") === "export const hi = 1;\n");
  ok("…and the harness MEASURED it, as for any vendor", out.diff.measured && out.diff.files.map((f) => f.path).join() === "src/hello.js");
  ok("tool results went back to the model", lastToolReply("normal").some((c) => c.includes("hello.js")) && lastToolReply("normal").some((c) => /^exit 0/.test(c)));
  ok("tool use is scored: calls, nothing malformed or invented, and it stopped", JSON.stringify(out.verdict.toolUse) === JSON.stringify({ calls: 3, malformed: 0, invented: 0, stopped: true, turns: 3 }), JSON.stringify(out.verdict.toolUse));
  const t = out.cost.tokens;
  ok("cost sums every turn, with the cached part split out of input", t.in === 360 && t.cached === 90 && t.out === 35 && t.total === 485 && out.cost.turns === 3, JSON.stringify(out.cost));
  ok("the four tools were offered, and only those", JSON.stringify(seen.find((s) => s.model === "normal").tools.map((x) => x.function.name)) === '["list_files","read_file","write_file","run"]');
  ok("sandbox:none says the tools ran on the host", out.verdict.warnings.some((w) => /tools ran on the HOST/.test(w)));
  ok("no container was involved", out.verdict.container === null);
}

/* ---------------------------------------------- what the scoring catches */
{
  const ws = workspace();
  scripts.clumsy = [
    say([call("delete_everything", {}), call("write_file", "{not json"), call("read_file", { nope: 1 })]),
    say(null, null, "ok"),
  ];
  const out = await run(ws, "x", policy("clumsy"));
  ok("a call to a tool never offered is counted as invented", out.verdict.toolUse.invented === 1);
  ok("bad JSON arguments and a missing required argument are counted as malformed", out.verdict.toolUse.malformed === 2);
  const replies = lastToolReply("clumsy");
  ok("each mistake is answered with an error the model can act on, not dropped", replies.some((r) => /no tool named "delete_everything"/.test(r)) && replies.some((r) => /not a JSON object/.test(r)) && replies.some((r) => /needs path/.test(r)));
  ok("…and nothing was written", out.diff.files.length === 0);
}
{
  const ws = workspace();
  scripts.loop = Array.from({ length: 10 }, () => say([call("list_files", {})]));
  const out = await run(ws, "x", policy("loop", { maxTurns: 3 }));
  ok("a model that never stops is a FAILED run at the turn ceiling, not a hung one", out.verdict.state === "failed" && out.verdict.toolUse.stopped === false && out.verdict.toolUse.turns === 3);
  ok("…and stderr says why", readFileSync(out.transcript.stderrPath, "utf8").includes("did not stop within 3 turns"));
}

/* ---------------------------------------------------- the path boundary */
{
  const ws = workspace();
  mkdirSync(join(TMP, "outside"), { recursive: true });
  symlinkSync(join(TMP, "outside"), join(ws, "escape"));
  scripts.escape = [
    say([call("write_file", { path: "../evil.txt", content: "x" }), call("write_file", { path: "/tmp/evil-abs.txt", content: "x" }), call("write_file", { path: "escape/evil.txt", content: "x" }), call("read_file", { path: "../../etc/passwd" })]),
    say(null, null, "tried"),
  ];
  const out = await run(ws, "x", policy("escape"));
  const replies = lastToolReply("escape");
  ok("writes that climb out, are absolute, or go through a symlink out are refused", replies.filter((r) => /refused: path is outside/.test(r)).length === 4, JSON.stringify(replies));
  ok("…and nothing landed outside", !existsSync(join(TMP, "evil.txt")) && !existsSync("/tmp/evil-abs.txt") && !existsSync(join(TMP, "outside", "evil.txt")));
  ok("confine: a path that stays inside is kept", confine("/w", "a/../b") === "b" && confine("/w", "../x") === null && confine("/w", "/etc") === null);
  void out;
}

/* --------------------------------------------------- failure outcomes */
{
  const dead = await run(workspace(), "x", policy("x", { endpoint: "http://127.0.0.1:1/v1" }));
  ok("no server answering is UNAVAILABLE, not a failure of the work", dead.verdict.state === "unavailable", JSON.stringify(dead.verdict.reason));
  scripts.err500 = [{ status: 500, text: "model exploded" }];
  const e = await run(workspace(), "x", policy("err500"));
  ok("an HTTP error is a failed run, with the body in stderr", e.verdict.state === "failed" && readFileSync(e.transcript.stderrPath, "utf8").includes("model exploded"));
  scripts.slow = [{ delayMs: 3000, ...say(null) }];
  const k = await run(workspace(), "x", policy("slow", { timeoutMs: 500 }));
  ok("a model slower than the ceiling is KILLED, never completed", k.verdict.state === "killed");
  let threw = null;
  try {
    await run(workspace(), "x", policy("x", { model: null }));
  } catch (err) {
    threw = err;
  }
  ok("no model named is refused before anything runs", threw?.name === "HarnessError" && /needs policy.model/.test(threw.message));
}

/* ---------------------------------------------------------------- the key */
{
  const KEY = "sk-local-TEST-7a6b5c4d3e2f";
  process.env.OAC_TEST_KEY = KEY;
  const state = join(TMP, "state");
  scripts.keyed = [say([call("run", { command: "echo working" })]), say(null, null, "done")];
  const out = await runArchived(workspace(), "x", policy("keyed", { apiKeyEnv: "OAC_TEST_KEY" }), { stateDir: state, secrets: { OAC_TEST_KEY: KEY } });
  ok("the key reaches the server as a bearer token", seen.filter((s) => s.model === "keyed").every((s) => s.auth === `Bearer ${KEY}`));
  const dir = join(state, "runs", out.verdict.runId);
  const archived = ["run.json", "transcript.log", "stderr.log"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  ok("the key is nowhere in the archive, and the policy records only the variable's NAME", !archived.includes(KEY) && JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).policy.apiKeyEnv === "OAC_TEST_KEY");
  ok("the raw transcript never held it either", !readFileSync(out.transcript.path, "utf8").includes(KEY));
  let threw = null;
  try {
    await run(workspace(), "x", policy("x", { apiKeyEnv: "OAC_NOT_SET_ANYWHERE" }));
  } catch (err) {
    threw = err;
  }
  ok("a named key variable that is not set is refused by name", /OAC_NOT_SET_ANYWHERE/.test(threw?.message ?? ""));
}

/* ------------------------------------------------------- the tool fixture */
{
  const { runFixture, FIXTURE } = await import("./tool-fixture.mjs");
  // A good candidate: read, write the right thing, stop.
  scripts["good-model"] = [
    say([call("read_file", { path: "names.txt" })]),
    say([call("write_file", { path: "upper.txt", content: FIXTURE.expect["upper.txt"] })]),
    say(null, null, "done"),
  ];
  const good = await runFixture({ endpoint: ENDPOINT, model: "good-model", sandbox: "none" }, { runs: 1 });
  ok("the fixture passes a model that reads, writes the right file and stops", good.passed === 1, JSON.stringify(good.results[0]));
  // A poor one: invents a tool, sends bad JSON, writes the wrong content, never stops.
  scripts["poor-model"] = [
    say([call("shell_exec", {}), call("write_file", "{oops")]),
    say([call("write_file", { path: "upper.txt", content: "ada\n" })]),
    ...Array.from({ length: 60 }, () => say([call("list_files", {})])),
  ];
  const poor = await runFixture({ endpoint: ENDPOINT, model: "poor-model", sandbox: "none", maxTurns: 5 }, { runs: 1 });
  const c = poor.results[0].checks;
  ok("the fixture fails it on each behaviour separately, by name", poor.passed === 0 && !c.correct && !c.wellFormed && !c.noInvented && !c.stopped && !c.completed, JSON.stringify(c));
}

/* ------------------------------------------------------------------ live */
const LIVE = "live: tools execute INSIDE a container with no network, while the model call stays outside";
const rootless = spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], { encoding: "utf8" }).stdout?.trim();
const IMAGE = process.env.OAC_TEST_IMAGE ?? "docker.io/library/nginx:alpine";
if (rootless !== "true") skip(LIVE, `podman not available or not rootless (got ${JSON.stringify(rootless)})`);
else if (spawnSync("podman", ["image", "exists", IMAGE]).status !== 0) skip(LIVE, `image ${IMAGE} not present — pull it or set OAC_TEST_IMAGE`);
else {
  const ws = workspace();
  scripts.live = [
    say([call("write_file", { path: "made/inside.txt", content: "from the container\n" }), call("run", { command: "cat /proc/1/cgroup >/dev/null; hostname; wget -q -T 3 -O /dev/null http://example.com && echo NET-OPEN || echo NET-CLOSED" })]),
    say(null, null, "done"),
  ];
  const out = await run(ws, "x", policy("live", { sandbox: "podman", image: IMAGE, net: "none" }));
  ok(`${LIVE}: completed`, out.verdict.state === "completed", JSON.stringify(out.verdict));
  ok(`${LIVE}: the write reached the repo through /work and was measured`, readFileSync(join(ws, "made", "inside.txt"), "utf8") === "from the container\n" && out.diff.files.some((f) => f.path === "made/inside.txt"));
  const replies = lastToolReply("live").join("\n");
  ok(`${LIVE}: the container had no route out`, replies.includes("NET-CLOSED") && !replies.includes("NET-OPEN"), replies);
  ok(`${LIVE}: the container is gone afterwards`, spawnSync("podman", ["container", "exists", `caretaker-${out.verdict.runId}`]).status !== 0 && out.verdict.container?.cleanup?.removed === true);
}

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[openai-compatible] ${failures} FAILED` : `\n[openai-compatible] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`);
process.exit(failures ? 1 : 0);
