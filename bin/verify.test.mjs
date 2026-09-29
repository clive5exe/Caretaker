#!/usr/bin/env node
/**
 * H-3: a refuting run can fail the task, and a run that fails to refute
 * cannot pass it.
 *
 * Real harness, sandbox:none, fake CLIs: a builder run that edits a file, then
 * refuters that answer each way. What is under test is what happens with the
 * answer — the board, the event log, the archive link and the Inbox.
 *
 * Run: node bin/verify.test.mjs
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RefuteError, parseVerdict, refutationPrompt, refute } from "./verify.mjs";
import { runArchived } from "./runstore.mjs";
import * as events from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const rejects = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof RefuteError && e.code === code;
  }
};
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ------------------------------------------------------------ parseVerdict */
ok("REFUTED with a reason", JSON.stringify(parseVerdict("work\nVERDICT: REFUTED the fee is charged twice\n")) === JSON.stringify({ outcome: "refuted", reason: "the fee is charged twice" }));
ok("STANDS with a reason", parseVerdict("VERDICT: STANDS ran the suite, all green").outcome === "stands");
ok("no verdict line is inconclusive, never a pass", parseVerdict("I think it is fine.").outcome === "inconclusive");
ok("the last verdict wins, so a quoted instruction does not decide it", parseVerdict("I must end with VERDICT: REFUTED <x> or…\nVERDICT: REFUTED <x>\nlater\nVERDICT: STANDS nothing broke").outcome === "stands");
ok("a verdict inside JSON-escaped output is read", parseVerdict('{"type":"result","result":"checked it\\nVERDICT: REFUTED test_x fails on empty input"}').reason === "test_x fails on empty input");
ok("a reply that IS the verdict line is read from a JSON transcript line", parseVerdict('{"type":"assistant","turn":1,"content":"VERDICT: REFUTED empty input crashes"}\n{"type":"result","num_turns":1}').reason === "empty input crashes");
ok("…including a CLI result that is only the verdict", parseVerdict('{"type":"result","result":"VERDICT: STANDS"}').outcome === "stands");
ok("a lower-case 'verdict: refuted' in prose is not a verdict", parseVerdict("the verdict: refuted claims were wrong").outcome === "inconclusive");
{
  const p = refutationPrompt({ task: { id: "T-9", title: "t", ac: "it works" }, parent: { runId: "r_00000000" }, patch: "+x" });
  ok("the prompt carries the acceptance criterion, the measured patch and the required last line", p.includes("it works") && p.includes("+x") && p.includes("VERDICT: REFUTED") && p.includes("VERDICT: STANDS"));
}

/* ----------------------------------------------------------------- fixture */
const TMP = mkdtempSync(join(tmpdir(), "verify-test-"));
const REPO = join(TMP, "repo");
const OPS = join(REPO, "ops", "caretaker");
mkdirSync(OPS, { recursive: true });
mkdirSync(join(REPO, "docs"), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(OPS, "board.mjs"));
copyFileSync(join(HERE, "dashboard.mjs"), join(OPS, "dashboard.mjs"));
const STATE = join(TMP, "state");
const CFG = join(OPS, "config.json");
const EVENTS = join(REPO, "ops", "caretaker", "events");
writeFileSync(CFG, JSON.stringify({ name: "Fixture", board: "docs/board.json", boardMarkdown: "docs/board.md", repo: ".", stateDir: STATE, events: "ops/caretaker/events", operator: "tester" }));
const BOARD = join(REPO, "docs", "board.json");
writeFileSync(BOARD, JSON.stringify({ meta: { name: "Fixture" }, phases: [{ name: "P", tasks: [
  { id: "T-001", title: "parse the header", status: "doing", owner: "backend", est: "1h", ac: "empty input returns an empty list" },
] }] }));
const WS = join(TMP, "ws");
mkdirSync(WS, { recursive: true });

let n = 0;
const cli = (body) => {
  const p = join(TMP, `cli-${n++}.sh`);
  writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return { argv: [p] };
};
const policy = (c, over = {}) => ({ adapter: "cli", cli: c, sandbox: "none", timeoutMs: 20_000, events: EVENTS, ...over });

const builder = await runArchived(WS, "build it", policy(cli("printf 'def parse(x): return x.split()\\n' > parse.py")), { stateDir: STATE, task: "T-001" });
const PARENT = builder.verdict.runId;
ok("the builder run is archived with its task", builder.verdict.ok && existsSync(join(STATE, "runs", PARENT, "diff.patch")));

const qaOf = () => JSON.parse(readFileSync(BOARD, "utf8")).phases[0].tasks[0].gate?.qa ?? null;
const refuteEvents = () => events.read(EVENTS).events.filter((e) => e.source === "refute");

/* ---------------------------------------------------------------- stands */
{
  const before = sha(BOARD);
  const r = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo 'ran it'; echo 'VERDICT: STANDS empty input returns []'")) });
  ok("a refuter that cannot break it reports stands", r.outcome === "stands", JSON.stringify(r));
  ok("…and the board is untouched: failing to refute is not a pass", sha(BOARD) === before && qaOf() === null);
  const ev = refuteEvents().at(-1);
  ok("…the event records it without a verdict", ev?.detail.includes("stands") && ev.verdict === undefined && ev.run === r.run);
  const childRec = JSON.parse(readFileSync(join(STATE, "runs", r.run, "run.json"), "utf8"));
  ok("the refuting run is archived as a child of the run it checked", childRec.parent === PARENT && childRec.task === "T-001");
  ok("the refuter was given the measured patch, not a description", readFileSync(join(STATE, "runs", r.run, "transcript.log"), "utf8") !== "" && refutationPrompt({ task: { id: "T-001", title: "", ac: "" }, parent: { runId: PARENT }, patch: readFileSync(join(STATE, "runs", PARENT, "diff.patch"), "utf8") }).includes("def parse"));
  ok("same cli and model as the builder is named as a warning", r.warnings.some((w) => /same cli and model/.test(w)));
}

/* ------------------------------------------------------------- inconclusive */
{
  const before = sha(BOARD);
  const r = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo 'looks fine to me'")) });
  ok("no verdict line is inconclusive", r.outcome === "inconclusive" && sha(BOARD) === before);
  const crashed = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo 'VERDICT: STANDS all good'; exit 1")) });
  ok("a refuter that did not complete is inconclusive, whatever it printed", crashed.outcome === "inconclusive" && /did not complete/.test(crashed.reason), JSON.stringify(crashed));
}

/* ----------------------------------------------------------------- refuted */
{
  const r = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo 'VERDICT: REFUTED parse(\"\") returns [\"\"] not []'"), { model: "other-model" }) });
  ok("a refutation is reported", r.outcome === "refuted" && r.recorded, JSON.stringify(r));
  const qa = qaOf();
  ok("it fails the task: a qa fail is recorded on the board", qa?.verdict === "fail");
  ok("the verdict note names the refuting run and the run it checked", qa?.note?.includes(r.run) && qa?.note?.includes(PARENT) && qa?.note?.includes('returns [""]'), qa?.note);
  const ev = refuteEvents().at(-1);
  ok("the event is a gate fail marked as a refutation", ev?.verdict === "fail" && ev.kind === "gate" && ev.source === "refute" && ev.stage === "verify");
  ok("a different model is not warned about", !r.warnings.some((w) => /same cli and model/.test(w)));
  const again = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo 'VERDICT: REFUTED still broken'")) });
  ok("a second refutation appends; the first is kept in history", again.recorded && qaOf().history?.length === 1 && qaOf().history[0].verdict === "fail");
}

/* ------------------------------------------------------------------ inbox */
{
  const { open } = await import("./readmodel.mjs");
  const rm = await open(CFG);
  const item = rm.inbox().items.find((i) => i.task === "T-001" && i.kind === "gate-failure");
  ok("two refutations reach the Inbox through the qa rework rule", Boolean(item), JSON.stringify(rm.inbox().items));
  ok("…and are not mistaken for the drift gate", item && !item.dismissCommand && !/drift gate/.test(JSON.stringify(item.reasons ?? item)));
}

/* -------------------------------------------------- refuter edits the work */
{
  const r = await refute({ cfgPath: CFG, parent: PARENT, workspace: WS, policy: policy(cli("echo fixed > parse.py; echo 'VERDICT: STANDS'")) });
  ok("a refuter that edits the workspace is named in the warnings", r.warnings.some((w) => /changed 1 file/.test(w)));
}

/* ------------------------------------------- a different adapter, same model */
{
  // The builder was the CLI with model m; the refuter is an API endpoint with
  // model m. Different builders, so no shared-blind-spot warning.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "VERDICT: STANDS checked" } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const b = await runArchived(WS, "build", policy(cli("true"), { model: "m" }), { stateDir: STATE, task: "T-001" });
  // `cli` is still set, as it is when harness settings name a default CLI and
  // the refuter role switches only the adapter: the CLI is not what runs.
  const api = { adapter: "openai-compatible", cli: cli("true"), endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "m", sandbox: "none", events: EVENTS };
  const r = await refute({ cfgPath: CFG, parent: b.verdict.runId, workspace: WS, policy: api });
  ok("an API refuter is not mistaken for the CLI builder it checks", r.outcome === "stands" && !r.warnings.some((w) => /same cli and model/.test(w)), JSON.stringify(r));
  const same = await refute({ cfgPath: CFG, parent: b.verdict.runId, workspace: WS, policy: policy(cli("echo 'VERDICT: STANDS'"), { model: "m" }) });
  ok("…while the same CLI with the same model still is", same.warnings.some((w) => /same cli and model/.test(w)));
  server.close();
}

/* --------------------------------------------------------------- refusals */
ok("a malformed parent id is refused", await rejects(() => refute({ cfgPath: CFG, parent: "../x", workspace: WS }), "BAD_PARENT"));
ok("a parent with no archive is refused", await rejects(() => refute({ cfgPath: CFG, parent: "r_ffffffff", workspace: WS }), "NO_PARENT"));
{
  const orphan = await runArchived(WS, "x", policy(cli("true")), { stateDir: STATE });
  ok("a parent that names no task is refused: there would be nothing to fail", await rejects(() => refute({ cfgPath: CFG, parent: orphan.verdict.runId, workspace: WS }), "NO_TASK"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[verify] ${failures} FAILED` : "\n[verify] all checks passed");
process.exit(failures ? 1 : 0);
