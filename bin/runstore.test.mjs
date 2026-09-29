#!/usr/bin/env node
/**
 * C-4: runs get an identity and an archive, and the archive holds no secret.
 *
 * Every run here uses `sandbox: "none"` and a fake CLI script, so no podman,
 * image or model is needed. What is under test is what happens around the
 * harness: the id, the live mirror, the archive layout, the redaction, the
 * refusal of a state dir the next agent could read, and that the read model
 * finds what was written.
 *
 * Run: node bin/runstore.test.mjs
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStoreError, archive, checkStateDir, redactorFor, runArchived, startMirror, stateDirFor } from "./runstore.mjs";
import { open } from "./readmodel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const throwsCode = (fn, code) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof RunStoreError && e.code === code;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = mkdtempSync(join(tmpdir(), "runstore-test-"));
const SECRET = "sk-test-DO-NOT-LEAK-4c1f9e2a7b";
const SECRETS = { TEST_API_KEY: SECRET };

// A repo the read model can open: installed board.mjs + dashboard.mjs + config.
const REPO = join(TMP, "repo");
mkdirSync(join(REPO, "ops", "caretaker"), { recursive: true });
mkdirSync(join(REPO, "docs"), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(REPO, "ops", "caretaker", "board.mjs"));
copyFileSync(join(HERE, "dashboard.mjs"), join(REPO, "ops", "caretaker", "dashboard.mjs"));
const STATE = join(TMP, "state");
const CFG = join(REPO, "ops", "caretaker", "config.json");
writeFileSync(CFG, JSON.stringify({ name: "Fixture", board: "docs/board.json", repo: ".", stateDir: STATE, events: "ops/caretaker/events" }));
writeFileSync(
  join(REPO, "docs", "board.json"),
  JSON.stringify({ meta: { name: "Fixture" }, phases: [{ name: "P", tasks: [{ id: "T-001", title: "t", status: "doing", owner: "you", est: "1h", ac: "a" }] }] }),
);

const WS = join(TMP, "workspace");
mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, "existing.txt"), "before\n");

let n = 0;
const fakeCli = (body) => {
  const p = join(TMP, `cli-${n++}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return { argv: [p] };
};

/** Prints a line, pauses so the mirror can be observed mid-run, leaks the key, ends mid-line. */
const AGENT = fakeCli(`
cat > /dev/null
echo "first line"
sleep 1
echo "the key is ${SECRET} ok"
echo "stderr has it too: ${SECRET}" >&2
printf 'edited\\n' > existing.txt
printf 'new\\n' > created.txt
echo '{"type":"result","num_turns":2,"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":3,"output_tokens":7}}'
printf 'unterminated tail ${SECRET}'
`);

const policy = (over = {}) => ({ adapter: "cli", cli: AGENT, sandbox: "none", events: join(REPO, "ops", "caretaker", "events"), timeoutMs: 20_000, env: { TEST_API_KEY: SECRET }, ...over });

/* --------------------------------------------------------- one real run */
const pending = runArchived(WS, "do the thing", policy(), { stateDir: STATE, task: "T-001", secrets: SECRETS });

// The mirror must show the first line while the run is still going.
let seenMidRun = false;
for (let i = 0; i < 40 && !seenMidRun; i++) {
  await sleep(100);
  const dirs = existsSync(join(STATE, "runs")) ? readdirSync(join(STATE, "runs")) : [];
  for (const d of dirs) {
    const live = join(STATE, "runs", d, "transcript.live.log");
    if (existsSync(live) && readFileSync(live, "utf8").includes("first line") && !existsSync(join(STATE, "runs", d, "run.json"))) {
      seenMidRun = true;
    }
  }
}
const out = await pending;
const runId = out.verdict.runId;
const dir = join(STATE, "runs", runId);

ok("the run id is r_ plus eight hex digits", /^r_[0-9a-f]{8}$/.test(runId), runId);
ok("the run completed", out.verdict.state === "completed", JSON.stringify(out.verdict.reason));
ok("the archive dir is <stateDir>/runs/<runId>", out.archived === dir && existsSync(dir));
for (const f of ["run.json", "diff.patch", "transcript.log", "stderr.log", "transcript.live.log"]) {
  ok(`the archive holds ${f}`, existsSync(join(dir, f)));
}
ok("shadow/ (the copy of the workspace) is NOT archived", !existsSync(join(dir, "shadow")));
ok("the live mirror showed output WHILE the run was in flight", seenMidRun);

/* ------------------------------------------------------------- redaction */
const archivedText = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
ok("the secret value appears in NO archived file", !archivedText.includes(SECRET));
ok("the transcript says where the secret was", readFileSync(join(dir, "transcript.log"), "utf8").includes("[redacted:TEST_API_KEY]"));
ok("stderr is redacted too", readFileSync(join(dir, "stderr.log"), "utf8").includes("[redacted:TEST_API_KEY]"));
const live = readFileSync(join(dir, "transcript.live.log"), "utf8");
ok("the mirror flushed the unterminated last line, redacted", live.includes("unterminated tail [redacted:TEST_API_KEY]"), JSON.stringify(live.slice(-80)));
ok("the raw harness transcript DID contain the secret (so the redaction above is doing work)", readFileSync(out.transcript.path, "utf8").includes(SECRET));

/* ---------------------------------------------------------------- run.json */
const rec = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
ok("run.json records the task", rec.task === "T-001");
ok("run.json records adapter and cli", rec.adapter === "cli" && rec.cli === "custom");
ok("run.json carries the verdict", rec.verdict?.state === "completed" && rec.verdict?.runId === runId);
ok("run.json carries the token breakdown the CLI reported", rec.cost?.tokens?.total === 40 && rec.cost?.tokens?.cached === 20, JSON.stringify(rec.cost?.tokens));
const paths = (rec.diff?.files ?? []).map((f) => f.path).sort();
ok("run.json carries the measured diff summary", JSON.stringify(paths) === JSON.stringify(["created.txt", "existing.txt"]), JSON.stringify(paths));
ok("run.json does not inline the patch", rec.diff && !("patch" in rec.diff));
ok("diff.patch holds the patch", readFileSync(join(dir, "diff.patch"), "utf8").includes("+edited"));
ok("the policy's env VALUES are not recorded, only names", rec.policy?.env?.TEST_API_KEY === "[not recorded]");

/* ---------------------------------------------------------- the read model */
const rm = await open(CFG);
ok("the read model uses the same state dir as the writer", rm.stateDir === STATE && stateDirFor(REPO, { stateDir: STATE }) === STATE);
const detail = rm.run(runId);
ok("the read model finds the archived run", detail !== null && detail.id === runId);
ok("run detail shows the archived diff", detail?.diff?.files?.length === 2);
ok("run detail shows the task link", detail?.task === "T-001");
const listed = rm.runs({}).runs ?? [];
ok("the runs list includes it", listed.some((r) => r.id === runId));

/* ---------------------------------------------------------------- parents */
const child = await runArchived(WS, "check it", policy({ cli: fakeCli("cat > /dev/null; echo child") }), {
  stateDir: STATE, task: "T-001", parent: runId, secrets: SECRETS,
});
const childRec = JSON.parse(readFileSync(join(child.archived, "run.json"), "utf8"));
ok("a child run records its parent", childRec.parent === runId);
const parentDetail = (await open(CFG)).run(runId);
ok("the parent's detail lists the child", (parentDetail?.children ?? []).includes(child.verdict.runId), JSON.stringify(parentDetail?.children));

/* --------------------------------------------------------------- refusals */
ok("a state dir inside the workspace is refused by name", throwsCode(() => checkStateDir(join(WS, ".state"), WS), "STATE_IN_WORKSPACE"));
ok("a state dir that IS the workspace is refused", throwsCode(() => checkStateDir(WS, WS), "STATE_IN_WORKSPACE"));
ok("a state dir beside the workspace is fine", (() => { checkStateDir(join(TMP, "elsewhere"), WS); return true; })());
let refusedRun = false;
try {
  await runArchived(WS, "x", policy(), { stateDir: join(WS, "state"), secrets: SECRETS });
} catch (e) {
  refusedRun = e.code === "STATE_IN_WORKSPACE";
}
ok("runArchived refuses before running when the state dir is in the workspace", refusedRun && !existsSync(join(WS, "state")));
ok("archive without a redactor is refused", throwsCode(() => archive(out, { stateDir: STATE }), "NO_REDACTOR"));
ok("archive with a malformed run id is refused", throwsCode(() => archive({ ...out, verdict: { ...out.verdict, runId: "../../etc" } }, { stateDir: STATE, redact: (s) => s }), "BAD_RUN_ID"));
ok("archive with a malformed parent is refused", throwsCode(() => archive(out, { stateDir: STATE, parent: "nope", redact: (s) => s }), "BAD_PARENT"));

/* ------------------------------------------------------ mirror line rules */
{
  const src = join(TMP, "mirror-src.log");
  const dst = join(TMP, "mirror-dst.log");
  writeFileSync(src, "");
  const redact = redactorFor(SECRETS);
  const m = startMirror({ from: src, to: dst, redact, intervalMs: 10_000 });
  // A key split across two writes: the first half alone must not be emitted.
  writeFileSync(src, `half ${SECRET.slice(0, 12)}`);
  m.pump();
  ok("a partial line is held back, not emitted", readFileSync(dst, "utf8") === "");
  writeFileSync(src, `half ${SECRET}\n`);
  m.pump();
  const got = readFileSync(dst, "utf8");
  ok("once the line completes it is emitted, redacted as a whole", got === "half [redacted:TEST_API_KEY]\n", JSON.stringify(got));
  m.stop();
}

/* -------------------------------------------------------------- run.mjs */
{
  const rr = join(TMP, "rr");
  mkdirSync(join(rr, "ops", "caretaker"), { recursive: true });
  copyFileSync(join(HERE, "run.mjs"), join(rr, "ops", "caretaker", "run.mjs"));
  writeFileSync(join(rr, "ops", "caretaker", "config.json"), JSON.stringify({ runs: "ops/caretaker/runs.jsonl", repo: "." }));
  const cli = (...a) => spawnSync("node", [join(rr, "ops", "caretaker", "run.mjs"), ...a], { encoding: "utf8" });
  const good = cli("start", "--name", "qa", "--task", "T-1", "--run", "r_0a1b2c3d", "--parent", "r_11112222", "--adapter", "cli", "--cli", "claude");
  const row = JSON.parse(readFileSync(join(rr, "ops", "caretaker", "runs.jsonl"), "utf8").trim().split("\n").pop());
  ok("run.mjs records --run, --parent, --adapter and --cli", good.status === 0 && row.run === "r_0a1b2c3d" && row.parent === "r_11112222" && row.adapter === "cli" && row.cli === "claude", good.stderr);
  const bad = cli("end", "--name", "qa", "--run", "run-7");
  ok("run.mjs refuses a malformed --run by name", bad.status === 2 && /--run must be a run id/.test(bad.stderr), bad.stderr);
  const badParent = cli("end", "--name", "qa", "--parent", "../x");
  ok("run.mjs refuses a malformed --parent by name", badParent.status === 2 && /--parent must be a run id/.test(badParent.stderr));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[runstore] ${failures} FAILED` : "\n[runstore] all checks passed");
process.exit(failures ? 1 : 0);
