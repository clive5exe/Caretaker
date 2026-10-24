#!/usr/bin/env node
/**
 * B-5 and B-8: the unattended loop records what the pass said and what it
 * spent, although it calls its CLI directly rather than through runstore.
 *
 * A scratch repo with the installed layout (ops/caretaker/loop.sh, run.mjs,
 * config.json, prompt.txt) and a stand-in `claude` that prints the JSON shape
 * `claude -p --output-format json` prints: a DECISION line, a key-shaped
 * string, a token breakdown, turns and one model.
 *
 * Run: node bin/loop.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "loop-test-"));
const KEY = "sk-ant-api03-" + "x".repeat(40);
const OAUTH = "oauth-token-value-0123456789";

// What `claude -p --output-format stream-json --verbose` writes: one event per
// line as it happens, ending with the result. `killed` stops after the
// decision, exiting 137, as a pass killed mid-work does.
const events = (killed) => [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "text", text: `DECISION: retry the upload twice because the API rate-limits a third\nleaked ${KEY} and ${OAUTH}` }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ...(killed ? [] : [{ type: "result", result: "Did T-1.", num_turns: 7, usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 40 }, modelUsage: { "claude-test-model": {} } }]),
].map((e) => JSON.stringify(e)).join("\n");

function repo(name, { killed = false } = {}) {
  const root = join(TMP, name);
  const ops = join(root, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  for (const f of ["loop.sh", "run.mjs"]) copyFileSync(join(HERE, f), join(ops, f));
  chmodSync(join(ops, "loop.sh"), 0o755);
  writeFileSync(join(ops, "config.json"), JSON.stringify({ runs: "ops/caretaker/runs.jsonl", stateDir: join(root, "state"), repo: "." }));
  writeFileSync(join(ops, "prompt.txt"), "do one task\n");
  const claude = join(root, "fake-claude");
  // It also records the arguments it was given.
  writeFileSync(
    claude,
    `#!/bin/sh\necho "$@" > '${join(root, "claude-args")}'\ncat <<'JSON'\n${events(killed)}\nJSON\n${killed ? "exit 137\n" : ""}`,
  );
  chmodSync(claude, 0o755);
  return { root, ops, claude };
}
const loop = (r, env = {}) =>
  spawnSync("bash", [join(r.ops, "loop.sh")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_BIN: r.claude, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ...env },
  });
const rows = (r) => (existsSync(join(r.ops, "runs.jsonl")) ? readFileSync(join(r.ops, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

{
  const r = repo("with-harvest");
  const outs = () => new Set(readdirSync("/tmp").filter((f) => f.startsWith("caretaker-loop-out.")));
  const before = outs();
  const res = loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
  const left = [...outs()].filter((f) => !before.has(f));
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  const skipped = /skip — only/.test(log);
  ok("the pass ran (not skipped for memory)", res.status === 0 && !skipped, log);
  const row = rows(r).at(-1);
  ok("the run row carries the token breakdown, and the total is derived from it", row?.in === 100 && row.cached === 2000 && row.write === 300 && row.out === 40 && row.tokens === 2440, JSON.stringify(row));
  ok("…and the turns and the one model", row?.turns === 7 && row.model === "claude-test-model");
  const runs = existsSync(join(r.root, "state", "runs")) ? readdirSync(join(r.root, "state", "runs")) : [];
  ok("the pass's output is archived as a run, and the row names it", runs.length === 1 && row?.run === runs[0], `${runs} ${row?.run}`);
  const dir = join(r.root, "state", "runs", runs[0] ?? "none");
  const h = existsSync(join(dir, "harvest.json")) ? JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) : null;
  ok("its DECISION line is harvested, recorded nowhere, so it reaches the Inbox", h?.decisions.length === 1 && /retry the upload twice/.test(h.decisions[0].text) && h.decisions[0].recordedIn === null, JSON.stringify(h));
  const archived = existsSync(join(dir, "transcript.log")) ? readFileSync(join(dir, "transcript.log"), "utf8") : "";
  ok("the archived output is redacted: a key by its shape", archived.length > 0 && !archived.includes(KEY), archived.slice(0, 300));
  ok("…and the CLI's own credential by its value", archived.length > 0 && !archived.includes(OAUTH));
  const rec = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : null;
  ok("run.json says what was not recorded, rather than leaving it empty", rec?.source === "loop.sh" && /did not go through runstore/.test(rec.notRecorded ?? ""));
  ok("the pass's unredacted output is deleted afterwards", left.length === 0, left.join());
}
{
  // Independent re-review: a killed pass exited before the harvest, lost what
  // it had decided, and put the raw tail of its output in loop.log.
  const r = repo("killed", { killed: true });
  const res = loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  ok("the loop asks claude to stream its events", readFileSync(join(r.root, "claude-args"), "utf8").includes("--output-format stream-json --verbose"));
  const runs = existsSync(join(r.root, "state", "runs")) ? readdirSync(join(r.root, "state", "runs")) : [];
  const h = runs[0] ? JSON.parse(readFileSync(join(r.root, "state", "runs", runs[0], "harvest.json"), "utf8")) : null;
  ok("a killed pass still has what it decided harvested", res.status === 137 && h?.decisions.some((d) => /retry the upload twice/.test(d.text)), `${res.status} ${JSON.stringify(h)}`);
  ok("…its row says failed, and names the archived run", rows(r).at(-1)?.state === "failed" && rows(r).at(-1)?.run === runs[0], JSON.stringify(rows(r).at(-1)));
  ok("…and loop.log carries no raw output: no key, no credential", !log.includes(KEY) && !log.includes(OAUTH) && /archived, redacted, as run r_/.test(log), log);
}
{
  const r = repo("no-harvest");
  const res = loop(r, { CARETAKER_HARVEST: join(TMP, "nowhere.mjs") });
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  ok("with no harvest.mjs, the pass still ends and says where decisions went", res.status === 0 && /no harvest\.mjs at .*decision lines kept here/.test(log), log);
  ok("…and the decision line is kept in loop.log, not lost with the output", /DECISION: retry the upload twice/.test(log));
  ok("…and the row still has the breakdown, with no run id", rows(r).at(-1)?.tokens === 2440 && rows(r).at(-1)?.run === undefined);
}

{
  // B-5, independent re-review round 3: killing loop.sh ITSELF archived
  // nothing and left the unredacted stream in /tmp. Now the stream is
  // recorded as it arrives: the CLI and the recorder outlive loop.sh.
  const r = repo("loop-killed");
  const slow = join(r.root, "slow-claude");
  const [first, ...rest] = events(false).split("\n");
  writeFileSync(slow, `#!/bin/sh\ncat <<'JSON'\n${events(false).split("\n").slice(0, 2).join("\n")}\nJSON\nsleep 2\ncat <<'JSON'\n${events(false).split("\n").slice(2).join("\n")}\nJSON\n`);
  chmodSync(slow, 0o755);
  const outs = () => new Set(readdirSync("/tmp").filter((f) => f.startsWith("caretaker-loop-out.")));
  const before = outs();
  const child = spawn("bash", [join(r.ops, "loop.sh")], { env: { ...process.env, CLAUDE_BIN: slow, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, CARETAKER_HARVEST: join(HERE, "harvest.mjs") }, stdio: "ignore" });
  await new Promise((res) => setTimeout(res, 800));
  child.kill("SIGKILL");
  const runsDir = join(r.root, "state", "runs");
  let rec = null;
  for (let i = 0; i < 60 && !(rec && rec.state !== "recording"); i++) {
    await new Promise((res) => setTimeout(res, 200));
    const id = existsSync(runsDir) ? readdirSync(runsDir)[0] : null;
    if (id && existsSync(join(runsDir, id, "run.json"))) rec = JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
  }
  const id = rec?.runId;
  const dir = join(runsDir, id ?? "none");
  ok("with loop.sh killed mid-pass, the recorder still finishes the run when the stream ends", rec?.state === "recorded", JSON.stringify(rec));
  const h = existsSync(join(dir, "harvest.json")) ? JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) : null;
  ok("…and its decision is harvested for the Inbox", h?.decisions.some((d) => /retry the upload twice/.test(d.text)), JSON.stringify(h));
  const archived = existsSync(join(dir, "transcript.log")) ? readFileSync(join(dir, "transcript.log"), "utf8") : "";
  ok("…the archive is redacted, and holds the whole stream", archived.includes('"type":"result"') && !archived.includes(KEY) && !archived.includes(OAUTH));
  ok("…and no raw stream is left in /tmp", [...outs()].filter((f) => !before.has(f)).length === 0);
}
{
  // A recorder killed WITH the loop (kill -9 on the group) cannot finish the
  // run itself; what streamed is archived, and the next pass finishes it.
  const r = repo("recover");
  const dir = join(r.root, "state", "runs", "r_deadbeef");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "r_deadbeef", state: "recording" }));
  writeFileSync(join(dir, "transcript.log"), `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "DECISION: pin the proxy image by digest" }] } })}\n`);
  loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
  const rec = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const h = existsSync(join(dir, "harvest.json")) ? JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) : null;
  ok("the next pass finishes a run its recorder was killed in, and says it was cut off", /^cut off/.test(rec.state) && h?.decisions.some((d) => /pin the proxy image/.test(d.text)), JSON.stringify({ rec, h }));
}
{
  // B-2: which task the pass worked on, from the board.
  const withBoard = (name, touch) => {
    const r = repo(name);
    mkdirSync(join(r.root, "docs"), { recursive: true });
    const board = join(r.root, "docs", "board.json");
    writeFileSync(board, JSON.stringify({ meta: {}, phases: [{ name: "p", tasks: [{ id: "T-1", status: "todo" }, { id: "T-2", status: "todo" }] }] }));
    const cfg = JSON.parse(readFileSync(join(r.ops, "config.json"), "utf8"));
    writeFileSync(join(r.ops, "config.json"), JSON.stringify({ ...cfg, board: "docs/board.json" }));
    // The fake agent moves the named tasks, as `board.mjs start` would.
    const edit = `node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));for(const t of d.phases[0].tasks)if(${JSON.stringify(touch)}.includes(t.id))t.status="doing";require("fs").writeFileSync(f,JSON.stringify(d))' ${board}`;
    writeFileSync(r.claude, `#!/bin/sh\n${edit}\ncat <<'JSON'\n${events(false)}\nJSON\n`);
    loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
    return { row: rows(r).at(-1), log: readFileSync(join(r.ops, "loop.log"), "utf8") };
  };
  const one = withBoard("task-one", ["T-1"]);
  ok("a pass that moved exactly one task puts its spend on that task", one.row?.task === "T-1" && one.row?.tokens === 2440, JSON.stringify(one.row));
  const two = withBoard("task-two", ["T-1", "T-2"]);
  ok("a pass that moved several puts it on none, and the log says which", two.row?.task === undefined && /no task: the pass changed several \(T-1 T-2\)/.test(two.log), `${JSON.stringify(two.row)}\n${two.log}`);
  const none = withBoard("task-none", []);
  ok("a pass that moved none says so", none.row?.task === undefined && /no task: the pass changed none/.test(none.log));
}
{
  const r = repo("killed-msg", { killed: true });
  loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  ok("a failed pass names its run once (it was printed twice)", /as run r_[0-9a-f]{8}\./.test(log), log);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[loop] ${failures} FAILED` : "\n[loop] all checks passed");
process.exit(failures ? 1 : 0);
