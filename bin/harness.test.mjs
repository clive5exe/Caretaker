#!/usr/bin/env node
/**
 * Tests for the harness seam.
 *
 * MOST OF THESE ARE NEGATIVE, AND NONE CALLS A MODEL. The interesting failures
 * of this layer are all of the form "it reported something that was not true":
 * a diff taken from the agent's own account, a killed run reported as finished,
 * an unknown cost reported as zero, a misspelt adapter silently falling back to
 * the default. A test suite that only runs the happy path passes through every
 * one of them.
 *
 * The agent is FAKED with a shell script that writes a known file and prints a
 * known transcript — including a sentence claiming it changed a file it never
 * touched, because that is the exact lie the diff measurement exists to catch.
 *
 * Run: node bin/harness.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  CLI_PRESETS,
  HarnessError,
  SEAM_KEYS,
  adapterNames,
  buildContainerArgv,
  emptyCost,
  normalisePolicy,
  parseUsage,
  run,
  spliceRunFlags,
} from "./harness.mjs";
import { read as readEvents } from "./events.mjs";
import { checkLimits, delegatedControllers, detect } from "./sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let skipped = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const skip = (name, why) => {
  console.log(`SKIP ${name} — ${why}`);
  skipped += 1;
};

/* ------------------------------------------------------------- fixtures */

const TMP = mkdtempSync(join(tmpdir(), "harness-test-"));

/**
 * A workspace that is ALREADY DIRTY. That is not incidental: the run must
 * attribute the pre-existing edit to nobody, and diffing against HEAD would
 * attribute it to the agent.
 */
function makeWorkspace(label) {
  const ws = join(TMP, `ws-${label}`);
  mkdirSync(ws, { recursive: true });
  const g = (...a) => spawnSync("git", a, { cwd: ws, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  writeFileSync(join(ws, "committed.txt"), "one\n");
  writeFileSync(join(ws, ".gitignore"), "ignored/\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  // dirty BEFORE the run, and never touched by it
  writeFileSync(join(ws, "committed.txt"), "one\ndirtied by a human before the run\n");
  writeFileSync(join(ws, "untracked-before.txt"), "also here before the run\n");
  return ws;
}

let scriptN = 0;
function fakeCli(body) {
  const p = join(TMP, `fake-cli-${scriptN++}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return { argv: [p] };
}

const logDirFor = (label) => join(TMP, `logs-${label}`);
/** Every run in this file logs here, never to the repo's own ops/foreman/events. */
const EVENTS_DIR = join(TMP, "events");

const basePolicy = (label, cli, over = {}) => ({
  adapter: "cli",
  cli,
  sandbox: "none",
  logDir: logDirFor(label),
  events: EVENTS_DIR,
  timeoutMs: 20_000,
  ...over,
});

const MARKER = "MARKER_TRANSCRIPT_7f3a";

/** An agent that writes one file and lies about writing another. */
const LIAR = fakeCli(`
PROMPT=$(cat)
echo "${MARKER}"
echo "prompt-was: $PROMPT"
echo "I created src/claimed-but-never-written.txt and removed the old module."
printf 'the agent really wrote this\\n' > really-written.txt
echo '{"type":"result","subtype":"success","num_turns":3,"usage":{"input_tokens":11,"cache_read_input_tokens":2200,"cache_creation_input_tokens":33,"output_tokens":44}}'
`);

/** An agent that changes nothing and claims otherwise, and reports no usage. */
const SILENT = fakeCli(`
cat > /dev/null
echo "Done. I refactored committed.txt and added three files."
`);

/* ================================================================== argv */

{
  const argv = buildContainerArgv({
    image: "img",
    limits: { memory: "2gb", cpus: "2", pids: 512 },
    workspace: "/w",
    net: "none",
    runtime: "podman",
    containerName: "foreman-r_dead",
    cliArgv: ["claude", "--print"],
    env: { HOME: "/tmp/agent-home" },
  });
  const has = (flag, value) => {
    const i = argv.indexOf(flag);
    return i !== -1 && (value === undefined || argv[i + 1] === value);
  };
  ok("the container argv still carries the sandbox's isolation flags", argv.includes("--read-only") && has("--cap-drop", "ALL") && has("-v", "/w:/work:Z"),
    "the harness must not fork a second copy of the container flags");
  ok("stdin is attached with -i, or the prompt reaches nothing", argv.includes("-i"),
    "measured: `echo X | podman run --rm IMAGE sh -c cat` prints nothing without -i");
  ok("the container is named, so a killed run has a handle to remove", has("--name", "foreman-r_dead"),
    "measured: SIGKILL on the podman client leaves the container Up despite --rm");
  ok("environment is passed with -e", has("-e", "HOME=/tmp/agent-home"));
  ok("the agent CLI is the container's command", argv.slice(-2).join(" ") === "claude --print", argv.slice(-3).join(" "));
  ok("THE CONTAINER SOCKET IS STILL NEVER MOUNTED", !argv.some((a) => String(a).includes(".sock")));
  ok("the prompt is not on the command line", !argv.some((a) => /prompt/i.test(String(a))),
    "argv is visible in ps and podman inspect");
}

{
  let threw = null;
  try {
    spliceRunFlags(["create", "--rm"], ["-i"]);
  } catch (e) {
    threw = e;
  }
  ok("splicing into an argv that no longer starts with `run` fails loudly", threw instanceof HarnessError && /no longer starts with "run"/.test(threw.message),
    String(threw));
}

/* =============================================================== policy */

{
  let threw = null;
  try {
    normalisePolicy({ timeouMs: 10 });
  } catch (e) {
    threw = e;
  }
  ok("a misspelt policy field is refused BY NAME", threw instanceof HarnessError && threw.message.includes("timeouMs"),
    "a silently ignored policy field is a policy somebody believes they set");
}

ok("cli is the default adapter", normalisePolicy({}).adapter === "cli",
  "the SDKs are API-key only; defaulting to one bills API rates over a subscription");
ok("the network is closed by default", normalisePolicy({}).net === "none");
ok("there is always a timeout, even when nobody asked for one", normalisePolicy({}).timeoutMs > 0);

/* ============================================================= adapters */

{
  const ws = makeWorkspace("unknown-adapter");
  let threw = null;
  try {
    await run(ws, "hi", { adapter: "clii", logDir: logDirFor("unknown-adapter"), events: EVENTS_DIR });
  } catch (e) {
    threw = e;
  }
  ok("an adapter that does not exist FAILS BY NAME", threw instanceof HarnessError && threw.message.includes('"clii"'),
    String(threw?.message));
  ok("...and the error lists the adapters that do exist", threw && adapterNames().every((n) => threw.message.includes(n)),
    String(threw?.message));
}

{
  const ws = makeWorkspace("sdk");
  let threw = null;
  let returned = null;
  try {
    returned = await run(ws, "hi", { adapter: "sdk", logDir: logDirFor("sdk"), events: EVENTS_DIR });
  } catch (e) {
    threw = e;
  }
  ok("the sdk adapter is registered", adapterNames().includes("sdk"));
  ok("the sdk adapter says it is NOT IMPLEMENTED rather than faking a run", threw instanceof HarnessError && /not implemented/i.test(threw.message),
    String(threw?.message ?? returned));
  ok("the sdk adapter returns no result at all", returned === null,
    "a stub returning an empty diff and a zero cost is indistinguishable from a real run that did nothing");
}

/*
 * The acceptance criterion: nothing above this layer imports a vendor's SDK.
 *
 * THE PACKAGE LIST IS NOT CLAIMED TO BE COMPLETE. It is the npm package names
 * for the four adapter families docs/vendors.md names, plus the two Anthropic
 * ones. A vendor not on it would not be caught here, and saying so is the point
 * — this proves nobody imported one of THESE, not that nobody imported any.
 */
{
  const VENDOR_PACKAGES = [
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "openai",
    "@google/generative-ai",
    "@google/genai",
    "@mistralai/mistralai",
    "cohere-ai",
    "ollama",
  ];
  const offenders = [];
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(HERE, f), "utf8");
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (VENDOR_PACKAGES.some((v) => spec === v || spec.startsWith(`${v}/`))) {
        offenders.push(`${f} imports ${spec}`);
      }
    }
  }
  ok(`no file in bin/ imports one of the ${VENDOR_PACKAGES.length} vendor SDK packages checked`, offenders.length === 0, offenders.join("; "));
}

/* ================================================== the diff is MEASURED */

{
  const ws = makeWorkspace("measured");
  const r = await run(ws, "please do the thing", basePolicy("measured", LIAR));
  const paths = r.diff.files.map((f) => f.path);

  ok("the run completed", r.verdict.state === "completed", `${r.verdict.state}: ${r.verdict.reason}`);
  ok("the seam returns exactly the four agreed keys", JSON.stringify(Object.keys(r).sort()) === JSON.stringify([...SEAM_KEYS].sort()), Object.keys(r).join(","));

  ok("THE FILE THE AGENT ACTUALLY WROTE IS IN THE DIFF", paths.includes("really-written.txt"), paths.join(","));
  ok(
    "THE FILE THE AGENT ONLY CLAIMED TO WRITE IS NOT",
    !paths.some((p) => p.includes("claimed-but-never-written")),
    "the diff came from the transcript instead of from the filesystem",
  );
  ok(
    "the lie is in the transcript, so the fixture really did make the claim",
    /claimed-but-never-written/.test(readFileSync(r.transcript.path, "utf8")),
    "if this fails the previous assertion proves nothing",
  );
  ok(
    "a file dirtied by a human BEFORE the run is not attributed to the agent",
    !paths.includes("committed.txt") && !paths.includes("untracked-before.txt"),
    `${paths.join(",")} — diffing against HEAD instead of a pre-run snapshot does this`,
  );
  ok("the patch is real unified diff text", /^diff --git a\/really-written.txt/m.test(r.diff.patch), r.diff.patch?.slice(0, 120));
  ok("the measurement declares its own blind spot", r.diff.ignoredPathsNotMeasured === true);
  ok("the prompt reached the agent on stdin", /prompt-was: please do the thing/.test(readFileSync(r.transcript.path, "utf8")));
  ok("the prompt was not written into the workspace", !paths.some((p) => /prompt/i.test(p)), paths.join(","));
}

{
  const ws = makeWorkspace("nothing");
  const r = await run(ws, "go", basePolicy("nothing", SILENT));
  ok(
    "an agent that changed nothing and said otherwise produces an EMPTY diff",
    r.diff.measured && r.diff.filesChanged === 0,
    `${r.diff.filesChanged} file(s): ${r.diff.files.map((f) => f.path).join(",")}`,
  );
  ok("...and the boast is still in the transcript", /I refactored committed.txt/.test(readFileSync(r.transcript.path, "utf8")));
}

/* ================================================================ timeout */

{
  const ws = makeWorkspace("timeout");
  const pidFile = join(TMP, "grandchild.pid");
  const HANG = fakeCli(`
cat > /dev/null
printf 'written before hanging\\n' > wrote-then-hung.txt
sh -c 'sleep 60' &
echo $! > ${pidFile}
sleep 60
`);
  const t0 = Date.now();
  const r = await run(ws, "hang please", basePolicy("timeout", HANG, { timeoutMs: 800, graceMs: 200 }));
  const elapsed = Date.now() - t0;

  ok("a run that hangs is KILLED, and the result says so", r.verdict.state === "killed", `state=${r.verdict.state}`);
  ok("...and is NEVER reported as completed", r.verdict.state !== "completed" && r.verdict.ok === false);
  ok("...and names the timeout as what killed it", r.verdict.killed === true && r.verdict.killedBy === "timeout", JSON.stringify({ killed: r.verdict.killed, by: r.verdict.killedBy }));
  ok(`...and returns near the ceiling rather than the sleep (${elapsed}ms for an 800ms ceiling on a 60s sleep)`, elapsed < 15_000, `${elapsed}ms`);
  ok(
    "the diff is still MEASURED for a killed run",
    r.diff.measured && r.diff.files.some((f) => f.path === "wrote-then-hung.txt"),
    "a killed run still changed the workspace, and that has to be visible or it gets lost",
  );

  const gpid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  if (!gpid) {
    skip("the whole process tree is dead, not just the child", "the fixture never recorded a grandchild pid");
  } else {
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while (alive(gpid) && Date.now() < deadline) {
      spawnSync("sh", ["-c", "sleep 0.1"]);
    }
    ok(
      `THE WHOLE PROCESS TREE IS DEAD, not just the direct child (grandchild ${gpid})`,
      !alive(gpid),
      "killing only the child leaves a grandchild holding the lock, which is the sixteen-hour failure",
    );
  }
}

/*
 * The fixture above keeps every descendant in the child's process group, so
 * the group kill alone ends it and the bounded settle after SIGKILL never
 * runs. This one leaves the group with `setsid`, holding stdout open, which is
 * the only case the bounded settle exists for.
 */
{
  const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
  if (!hasSetsid) {
    skip("a descendant that ESCAPED the process group cannot hold the result hostage", "setsid not on PATH");
  } else {
    const ws = makeWorkspace("escaped");
    const pidFile = join(TMP, "escaped.pid");
    const ESCAPE = fakeCli(`
cat > /dev/null
setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' &
sleep 30
`);
    const t0 = Date.now();
    const r = await run(ws, "escape", basePolicy("escaped", ESCAPE, { timeoutMs: 800, graceMs: 200 }));
    const elapsed = Date.now() - t0;
    ok(
      `a descendant that ESCAPED the process group cannot hold the result hostage (${elapsed}ms for an 800ms ceiling on a 30s sleep)`,
      elapsed < 15_000,
      `${elapsed}ms — the result waited for the pipes the escaped process still holds`,
    );
    ok("...and the run is still reported as killed", r.verdict.state === "killed", `state=${r.verdict.state}`);
    // Nothing in sandbox:none can reach a process that left the group, so the
    // test cleans up after itself rather than leaving a 30s sleep behind.
    const epid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
    if (epid) {
      try {
        process.kill(epid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/* =================================================================== cost */

{
  const c = emptyCost();
  ok("unknown cost is NULL, not zero", c.tokens.in === null && c.tokens.total === null && c.turns === null, JSON.stringify(c.tokens));
  ok("...and is explicitly not the number 0", c.tokens.in !== 0 && c.tokens.out !== 0);
  ok("nothing reported means reported:false", c.reported === false && c.source === "none");
  ok("money is never stored, only tokens", c.money === null, "the token-to-money rate is per-deployment; see docs/vendors.md");
}

{
  const ws = makeWorkspace("cost-none");
  const r = await run(ws, "go", basePolicy("cost-none", SILENT, { billing: "subscription" }));
  ok(
    "a CLI that reported no usage yields NULL tokens, not zero",
    r.cost.tokens.in === null && r.cost.tokens.total === null && r.cost.reported === false,
    JSON.stringify(r.cost.tokens),
  );
  ok(
    "a subscription run is still UNKNOWN rather than free-and-zero",
    r.cost.billing === "subscription" && r.cost.tokens.total === null,
    "no marginal charge is not the same fact as no tokens spent, and only one of them was measured",
  );
  ok("...and the note says which of the two it is", /not zero/.test(r.cost.note), r.cost.note);
}

{
  const ws = makeWorkspace("cost-some");
  const r = await run(ws, "go", basePolicy("cost-some", LIAR, { billing: "subscription" }));
  ok("reported usage is read out of the transcript", r.cost.reported === true, JSON.stringify(r.cost));
  ok("input tokens", r.cost.tokens.in === 11, String(r.cost.tokens.in));
  ok("cache reads", r.cost.tokens.cached === 2200, String(r.cost.tokens.cached));
  ok("cache writes", r.cost.tokens.write === 33, String(r.cost.tokens.write));
  ok("output tokens", r.cost.tokens.out === 44, String(r.cost.tokens.out));
  ok("turns", r.cost.turns === 3, String(r.cost.turns));
  ok("the total is DERIVED from the parts (11+2200+33+44)", r.cost.tokens.total === 2288, String(r.cost.tokens.total));
}

{
  // A CLI that reports SOME fields. The missing one must stay null: counting it
  // as zero understates the run and does it silently.
  const partial = parseUsage('{"usage":{"input_tokens":5,"output_tokens":7}}');
  ok("a partly-reported usage keeps the missing fields null", partial.tokens.cached === null && partial.tokens.write === null, JSON.stringify(partial.tokens));
  ok("...and the total sums only what was reported (5+7)", partial.tokens.total === 12, String(partial.tokens.total));
}

{
  const none = parseUsage("just some prose, no json at all\nsecond line\n");
  ok("prose with no JSON parses to all-null, not all-zero", none.tokens.total === null && none.reported === false, JSON.stringify(none.tokens));
}

/* ============================================================= transcript */

{
  /*
   * The agent's stdout must never reach the terminal: a TUI tails the log, and
   * two writers on one terminal shred each other's output. Asserted by running
   * the harness in a CHILD process and looking for the agent's marker in that
   * child's stdout — the only way to observe "what a terminal would have seen".
   */
  const ws = makeWorkspace("tty");
  const runner = join(TMP, "runner.mjs");
  writeFileSync(
    runner,
    `import { run } from ${JSON.stringify(resolve(HERE, "harness.mjs"))};\n` +
      `const r = await run(${JSON.stringify(ws)}, "go", ${JSON.stringify(basePolicy("tty", LIAR))});\n` +
      "process.stdout.write(JSON.stringify({ path: r.transcript.path, bytes: r.transcript.bytes }));\n",
  );
  const child = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 60_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
  } catch {
    /* reported by the assertions below */
  }
  ok("the harness ran in a child process", parsed !== null, `stdout=${child.stdout?.slice(0, 300)} stderr=${child.stderr?.slice(0, 300)}`);
  ok(
    "THE AGENT'S STDOUT DOES NOT REACH THE TERMINAL",
    !child.stdout.includes(MARKER) && !(child.stderr ?? "").includes(MARKER),
    "the agent's output was written to this process's stdout, which shreds a TUI tailing the same terminal",
  );
  ok(
    "...but it IS in the log file, so it was captured rather than dropped",
    parsed && readFileSync(parsed.path, "utf8").includes(MARKER),
    "if this fails, the assertion above passes for the wrong reason",
  );
  ok("the transcript records its own size", parsed && parsed.bytes > 0, JSON.stringify(parsed));
}

/* ============================================== the CLI is not installed */

{
  const ws = makeWorkspace("missing-cli");
  const r = await run(ws, "go", basePolicy("missing-cli", { argv: [join(TMP, "definitely-not-installed")] }));
  ok(
    "a CLI that is not there is UNAVAILABLE, not failed",
    r.verdict.state === "unavailable",
    `${r.verdict.state}: ${r.verdict.reason}`,
  );
  ok("...and the reason names what could not be started", /definitely-not-installed|ENOENT/.test(r.verdict.reason ?? ""), r.verdict.reason);
  ok("...and the diff is still measured (it changed nothing)", r.diff.measured && r.diff.filesChanged === 0);
  ok("...and its cost is unknown rather than zero", r.cost.tokens.total === null && r.cost.reported === false);
}

{
  const ws = makeWorkspace("exit127");
  const cli = fakeCli(`
cat > /dev/null
echo "sh: 1: claude: not found" >&2
exit 127
`);
  const r = await run(ws, "go", basePolicy("exit127", cli));
  ok(
    "exit 127 from inside the container reads as UNAVAILABLE, not as the model declining",
    r.verdict.state === "unavailable",
    `${r.verdict.state}: ${r.verdict.reason}`,
  );
}

{
  const ws = makeWorkspace("enoent-but-real");
  const cli = fakeCli(`
cat > /dev/null
echo "open config.json: no such file or directory" >&2
exit 1
`);
  const r = await run(ws, "go", basePolicy("enoent-but-real", cli));
  ok(
    "a real run that died on a missing PROJECT file is FAILED, not unavailable",
    r.verdict.state === "failed",
    `${r.verdict.state}: ${r.verdict.reason} — matching that phrase on any exit code files a real failure as a missing CLI`,
  );
}

{
  const ws = makeWorkspace("failing");
  const cli = fakeCli(`
cat > /dev/null
echo "the model returned an error" >&2
exit 2
`);
  const r = await run(ws, "go", basePolicy("failing", cli));
  ok("a non-zero exit that is not 127 is FAILED", r.verdict.state === "failed" && r.verdict.exitCode === 2, `${r.verdict.state} ${r.verdict.exitCode}`);
  ok("failed is not killed", r.verdict.killed === false);
}

/* ============================================== the log must not pollute */

{
  const ws = makeWorkspace("logdir");
  let threw = null;
  try {
    await run(ws, "go", basePolicy("logdir", SILENT, { logDir: join(ws, "logs") }));
  } catch (e) {
    threw = e;
  }
  ok(
    "a log directory inside the workspace is REFUSED",
    threw instanceof HarnessError && /inside the workspace/.test(threw.message),
    "the transcript is written between the two snapshots, so it would be measured as the agent's work",
  );
}

/* ================================================================ warnings */

{
  const ws = makeWorkspace("warn");
  const r = await run(ws, "go", basePolicy("warn", SILENT));
  ok(
    "running outside a container warns that nothing was isolated",
    r.verdict.warnings.some((w) => /sandbox:none/.test(w)),
    JSON.stringify(r.verdict.warnings),
  );
}

{
  // Pure: net:none plus a real container is a contradiction the caller has to
  // see. Asserted through the preset table rather than by booting a container.
  ok("both shipped CLI presets move HOME off the read-only root", Object.values(CLI_PRESETS).every((p) => p.env?.HOME?.startsWith("/tmp")),
    "the sandbox root is read-only; a CLI writing its own config under HOME dies with what looks like a permissions bug");
  ok("both shipped CLI presets are non-interactive", JSON.stringify(CLI_PRESETS.claude.argv({ model: null })).includes("--print") && JSON.stringify(CLI_PRESETS.codex.argv({ model: null })).includes("exec"),
    "a TUI in a container with no tty hangs instead of failing");
}

/* ============================================================ event log */

{
  const byRun = (dir, runId) => readEvents(dir).events.filter((e) => e.run === runId);

  const done = join(TMP, "events-done");
  const ws = makeWorkspace("events-done");
  const r = await run(ws, "go", basePolicy("events-done", LIAR, { events: done, task: "T-9" }));
  const evs = byRun(done, r.verdict.runId);
  const [start, end] = evs;
  ok("every run appends a START and an END event, keyed by its run id",
    evs.length === 2 && start.phase === "start" && end.phase === "end",
    JSON.stringify(evs));
  ok("...both carry the task and stage as FIELDS", evs.every((e) => e.task === "T-9" && e.stage === "build" && e.kind === "agent"));
  ok("...and the end records the outcome, the measured file count and the tokens",
    end?.state === "completed" && end.level === "info" && end.files === r.diff.files.length && end.tokens === r.cost.tokens.total,
    JSON.stringify(end));

  const killedDir = join(TMP, "events-killed");
  const hang = fakeCli("cat > /dev/null\nsleep 30");
  const k = await run(makeWorkspace("events-killed"), "go", basePolicy("events-killed", hang, { events: killedDir, timeoutMs: 500, graceMs: 100 }));
  const kEnd = byRun(killedDir, k.verdict.runId).find((e) => e.phase === "end");
  ok("a killed run's end event is a WARN that says killed", kEnd?.state === "killed" && kEnd.level === "warn", JSON.stringify(kEnd));

  const sdkDir = join(TMP, "events-sdk");
  try {
    await run(makeWorkspace("events-sdk"), "go", { adapter: "sdk", logDir: logDirFor("events-sdk"), events: sdkDir });
  } catch {
    /* the sdk adapter throws; asserted above */
  }
  const sdkEvs = readEvents(sdkDir).events;
  ok("a run that never started still gets an END, so the log holds no orphan start",
    sdkEvs.length === 2 && sdkEvs[1].state === "not-started" && sdkEvs[1].level === "error",
    JSON.stringify(sdkEvs));

  const offDir = join(TMP, "events-off");
  await run(makeWorkspace("events-off"), "go", basePolicy("events-off", SILENT, { events: false }));
  let stageErr = null;
  try {
    await run(makeWorkspace("events-stage"), "go", basePolicy("events-stage", SILENT, { stage: "deploy" }));
  } catch (e) {
    stageErr = e;
  }
  ok("a stage the log does not know is refused up front, not warned about on every run",
    stageErr instanceof HarnessError && /stage/.test(stageErr.message), String(stageErr?.message));

  ok("events:false writes nothing", !existsSync(offDir) && readEvents(offDir).events.length === 0);

  // A FILE where the directory should be: mkdir fails, the run must not.
  const blocked = join(TMP, "events-blocked");
  writeFileSync(blocked, "not a directory\n");
  const b = await run(makeWorkspace("events-blocked"), "go", basePolicy("events-blocked", SILENT, { events: blocked }));
  ok("an event log that cannot be written does NOT fail the run, and says so",
    b.verdict.state === "completed" && b.verdict.warnings.filter((w) => /event log was not written/.test(w)).length === 2,
    JSON.stringify(b.verdict.warnings));

  const wsIn = makeWorkspace("events-inside");
  const inside = await run(wsIn, "go", basePolicy("events-inside", SILENT, { events: join(wsIn, "events") }));
  ok("an event directory INSIDE the workspace is not measured as the agent's work",
    readEvents(join(wsIn, "events")).events.length === 2 && !inside.diff.files.some((f) => f.path.startsWith("events/")),
    inside.diff.files.map((f) => f.path).join(","));
}

/* =============================================================== live run */

/*
 * A REAL CONTAINER. The fakes above prove the seam's logic; they cannot prove
 * that the argv the harness builds actually boots, that a process inside the
 * container can edit the mounted workspace, or that the container is gone
 * afterwards. Only a live run shows those, and the last one is the failure that
 * was MEASURED on this box: `kill -9` on the podman client left the container
 * reported as "Up" despite --rm.
 *
 * SKIPS LOUDLY without podman or the image, rather than passing.
 */
const LIVE_IMAGE = process.env.HARNESS_TEST_IMAGE ?? "docker.io/library/nginx:alpine";
const havePodman = detect().chosen === "podman";
const haveImage =
  havePodman && spawnSync("podman", ["image", "exists", LIVE_IMAGE], { stdio: "ignore" }).status === 0;

if (!havePodman) {
  skip("live: an agent inside the container edits the workspace", "podman not available");
  skip("live: a hung container is killed AND removed", "podman not available");
} else if (!haveImage) {
  skip("live: an agent inside the container edits the workspace", `image ${LIVE_IMAGE} not present`);
  skip("live: a hung container is killed AND removed", `image ${LIVE_IMAGE} not present`);
} else {
  {
    const ws = makeWorkspace("live-edit");
    const r = await run(ws, "go", {
      adapter: "cli",
      cli: { argv: ["sh", "-c", "cat > /dev/null; echo 'written from inside the container' > /work/from-container.txt"] },
      sandbox: "podman",
      net: "none",
      image: LIVE_IMAGE,
      logDir: logDirFor("live-edit"),
      events: EVENTS_DIR,
      timeoutMs: 90_000,
    });
    ok(
      "live: the container booted and the run completed",
      r.verdict.state === "completed",
      `${r.verdict.state}: ${r.verdict.reason} :: ${r.transcript.stderrTail?.slice(0, 300)}`,
    );
    ok(
      "live: a file written INSIDE the container is measured in the diff",
      r.diff.measured && r.diff.files.some((f) => f.path === "from-container.txt"),
      `${r.diff.files.map((f) => f.path).join(",") || "(nothing)"} — ${r.diff.reason ?? ""}`,
    );
    ok(
      "live: the human's pre-existing edit is still not attributed to the run",
      !r.diff.files.some((f) => f.path === "committed.txt"),
      r.diff.files.map((f) => f.path).join(","),
    );

    const missing = checkLimits(["memory", "cpus", "pids"], delegatedControllers().controllers);
    ok(
      `live: every limit this user cannot enforce is dropped AND warned about (${missing.length} here)`,
      missing.every((m) => r.verdict.warnings.some((w) => w.includes(m.limit))),
      `missing=${JSON.stringify(missing)} warnings=${JSON.stringify(r.verdict.warnings)} — ` +
        "sandbox.mjs does this check inside its CLI block, so a programmatic caller of buildArgs " +
        "does not get it for free and passing --cpus without the controller fails the whole run",
    );
  }

  {
    const ws = makeWorkspace("live-kill");
    const runId = `r_live${process.pid.toString(16)}`;
    const name = `foreman-${runId}`;
    const r = await run(ws, "hang", {
      adapter: "cli",
      cli: { argv: ["sh", "-c", "cat > /dev/null; sleep 300"] },
      sandbox: "podman",
      net: "none",
      image: LIVE_IMAGE,
      logDir: logDirFor("live-kill"),
      events: EVENTS_DIR,
      timeoutMs: 6000,
      graceMs: 1000,
      runId,
    });
    ok("live: a hung container run is KILLED", r.verdict.state === "killed", `${r.verdict.state}: ${r.verdict.reason}`);
    const ps = spawnSync("podman", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}} {{.Status}}"], {
      encoding: "utf8",
    });
    ok(
      "live: THE CONTAINER IS GONE, not merely orphaned by a dead client",
      (ps.stdout ?? "").trim() === "",
      `podman ps -a still lists: ${(ps.stdout ?? "").trim()} — measured: --rm does NOT clean up ` +
        "after a killed client, so killing the process tree alone leaves the container running",
    );
    ok("live: the result records the cleanup it attempted", r.verdict.container?.cleanup?.attempted === true, JSON.stringify(r.verdict.container));
    // Leave nothing behind even if the assertion above failed.
    spawnSync("podman", ["rm", "-f", "-t", "1", name], { stdio: "ignore" });
  }
}

console.log(
  failures === 0
    ? `\n[harness] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[harness] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
