#!/usr/bin/env node
/**
 * C-1: board.mjs is importable, and the CLI did not change.
 *
 *   1. GOLDEN. The CLI as it was before C-1 is frozen in
 *      testdata/board.pre-c1.mjs. Both copies run the same command script over
 *      the same fixture board, every command and every refusal path, and after
 *      each step stdout, stderr, the exit code, board.json and board.md must be
 *      identical. Two things are normalised, and only these: today's date
 *      (a run that crosses midnight) and the fixture's absolute path. The
 *      usage text may only grow: C-6 appends lines for its commands.
 *   2. IMPORT. Importing board.mjs reads nothing and prints nothing, and the
 *      exported domain returns results instead of exiting.
 *   3. LOCK. Parallel writers do not lose each other's updates. Proven able to
 *      fail: the same check against the pre-C-1 copy loses notes (see the
 *      commit that introduced this file for the run).
 *
 * The frozen copy pins behaviour for the commands that existed before C-1. An
 * intentional change to one of them updates the frozen copy in the same
 * commit, so the diff says so out loud.
 *
 * Run: node bin/board-lib.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const BOARD = {
  meta: { name: "Fixture", updated: "2026-01-01", launch: "2026-12-01" },
  phases: [
    {
      name: "Phase 0",
      start: "2025-11-01",
      end: "2025-12-01",
      goal: "old scope",
      tasks: [{ id: "Z-1", title: "archived", owner: "you", est: "2h", status: "done", completed: "2025-11-20" }],
    },
    {
      name: "Phase 1",
      start: "2026-01-01",
      end: "2026-02-01",
      goal: "fixture",
      tasks: [
        { id: "T-001", title: "plain task", owner: "builder", est: "1h", status: "todo", ac: "it works" },
        { id: "T-002", title: "rotate the auth token", owner: "builder", est: "2d", status: "todo", ac: "rotated" },
        { id: "T-003", title: "write the guide", owner: "product-architect", est: "4h", status: "todo", ac: "a guide" },
        { id: "T-004", title: "dropped work", owner: "builder", est: "1w", status: "dropped" },
        {
          id: "T-005",
          title: "already gated",
          owner: "builder",
          est: "3h",
          status: "doing",
          ac: "x",
          gate: { reviewer: { verdict: "pass", at: "2026-01-02" }, qa: { verdict: "pass", at: "2026-01-02" } },
        },
      ],
    },
    // Undated, with no goal: the shape of this repo's own board.
    { name: "Phase 2", tasks: [{ id: "U-1", title: "later", owner: "builder", est: "1h", status: "todo", ac: "y" }] },
  ],
};

function fixture(boardFile) {
  const root = mkdtempSync(join(tmpdir(), "caretaker-boardlib-"));
  const ops = join(root, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  copyFileSync(boardFile, join(ops, "board.mjs"));
  writeFileSync(
    join(ops, "config.json"),
    JSON.stringify({ name: "Fixture", board: "docs/board.json", boardMarkdown: "docs/board.md", repo: ".", activePhase: "Phase 1" }),
  );
  writeFileSync(join(root, "docs", "board.json"), `${JSON.stringify(BOARD, null, 2)}\n`);
  writeFileSync(join(root, "docs", "board-status.md"), "# status\n\n- **Board:** stale\n");
  return { root, ops };
}

const TODAY = new Date().toISOString().slice(0, 10);
const norm = (s, root) => String(s ?? "").split(root).join("<root>").split(TODAY).join("<today>");

/* 1. golden --------------------------------------------------------------- */
const SCRIPT = [
  [],
  ["status"],
  ["build"],
  ["nonsense"],
  ["start"],
  ["start", "T-999"],
  ["start", "t-001"],
  ["note", "T-001", "first", "note"],
  ["note", "T-001", "second"],
  ["block", "T-001", "waiting", "on", "access"],
  ["block", "T-002"],
  ["todo", "T-001"],
  ["done", "T-001"],
  ["done", "T-002"],
  ["done", "T-003"],
  ["reviewer"],
  ["qa", "T-999", "pass"],
  ["qa", "T-001", "maybe"],
  ["qa", "T-001", "FAIL", "broke", "the", "build"],
  ["qa", "T-001", "fail"],
  ["qa", "T-001", "pass", "fixed"],
  ["reviewer", "T-001", "pass"],
  ["done", "T-001"],
  ["start", "T-001"],
  ["reviewer", "T-003", "pass"],
  ["done", "T-003"],
  ["reviewer", "T-002", "pass"],
  ["qa", "T-002", "pass"],
  ["done", "T-002"],
  ["security", "T-002", "pass", "attacked it"],
  ["done", "T-002"],
  ["done", "T-005"],
  ["status"],
];

{
  const old = fixture(join(HERE, "testdata", "board.pre-c1.mjs"));
  const neu = fixture(join(HERE, "board.mjs"));
  let diverged = 0;
  for (const args of SCRIPT) {
    const run = (f) => {
      const r = spawnSync("node", [join(f.ops, "board.mjs"), ...args], { cwd: f.root, encoding: "utf8" });
      return {
        stdout: norm(r.stdout, f.root),
        stderr: norm(r.stderr, f.root),
        code: r.status,
        json: norm(readFileSync(join(f.root, "docs", "board.json"), "utf8"), f.root),
        md: norm(readFileSync(join(f.root, "docs", "board.md"), "utf8"), f.root),
        status: norm(readFileSync(join(f.root, "docs", "board-status.md"), "utf8"), f.root),
      };
    };
    // docs/board.md does not exist until the first build; seed it identically.
    for (const f of [old, neu]) if (!existsSync(join(f.root, "docs", "board.md"))) writeFileSync(join(f.root, "docs", "board.md"), "");
    const a = run(old);
    const b = run(neu);
    // Usage text is the one additive change: C-6 appends lines for its new
    // commands, and the old lines must still come first, unchanged.
    if (args[0] === "nonsense" && b.stdout.startsWith(a.stdout) && b.stdout.length > a.stdout.length) b.stdout = a.stdout;
    for (const k of Object.keys(a)) {
      if (a[k] !== b[k]) {
        diverged += 1;
        ok(`golden: \`${args.join(" ") || "(no args)"}\` ${k} is identical`, false, `old: ${JSON.stringify(a[k]).slice(0, 300)}\n      new: ${JSON.stringify(b[k]).slice(0, 300)}`);
      }
    }
  }
  ok(`golden: ${SCRIPT.length} commands give identical stdout, stderr, exit code, board.json, board.md and status line`, diverged === 0);
  // The script must actually reach the paths it claims to cover.
  const f = fixture(join(HERE, "board.mjs"));
  const refusal = spawnSync("node", [join(f.ops, "board.mjs"), "done", "T-002"], { cwd: f.root, encoding: "utf8" });
  ok("golden covers a refusal (done without verdicts exits 1 with REFUSED)", refusal.status === 1 && refusal.stderr.includes("REFUSED"));
  for (const x of [old, neu, f]) rmSync(x.root, { recursive: true, force: true });
}

/* 2. import --------------------------------------------------------------- */
{
  const f = fixture(join(HERE, "board.mjs"));
  // Import from a process whose cwd and FACTORY_CONFIG point nowhere useful:
  // module load must not read a config.
  const probe = `
    const m = await import(${JSON.stringify(pathToFileURL(join(f.ops, "board.mjs")).href)});
    const out = { api: m.API_VERSION, keys: Object.keys(m).sort() };
    const ctx = m.loadConfig(${JSON.stringify(join(f.ops, "config.json"))});
    const d = m.load(ctx);
    out.missing = m.missingGates(m.find(d, "T-002").t);
    out.docs = m.missingGates(m.find(d, "T-003").t);
    out.refused = m.transition(d, "T-002", "done");
    out.started = m.transition(d, "T-001", "start").task.status;
    out.bad = m.transition(d, "T-404", "start");
    out.v = m.recordVerdict(d, "T-001", "qa", "pass", "n").task.gate.qa.verdict;
    out.badGate = m.recordVerdict(d, "T-001", "deploy", "pass");
    const r = m.mutate(ctx, (b) => m.transition(b, "T-001", "note", "via import"));
    out.saved = JSON.parse((await import("node:fs")).readFileSync(ctx.data, "utf8")).phases[1].tasks[0].note;
    out.mutateOk = r.ok;
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, FACTORY_CONFIG: join(f.root, "does-not-exist.json") },
  });
  ok("importing board.mjs with a bad FACTORY_CONFIG does not throw", r.status === 0, r.stderr);
  let o = {};
  try {
    o = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {}
  ok("importing prints nothing but the probe's own line", r.stdout.trim().split("\n").length === 1, r.stdout);
  ok("API_VERSION is exported and is 1", o.api === 1);
  for (const k of ["load", "find", "progress", "transition", "recordVerdict", "missingGates", "loadConfig", "mutate", "withLock", "build"]) {
    ok(`exports ${k}`, o.keys?.includes(k));
  }
  ok(
    "missingGates: an auth task needs reviewer, qa and security",
    JSON.stringify(o.missing) === JSON.stringify({ missing: ["reviewer", "qa", "security (money/auth/isolation)"], docsOnly: false }),
    JSON.stringify(o.missing),
  );
  ok("missingGates: a docs-only task needs reviewer only", JSON.stringify(o.docs) === JSON.stringify({ missing: ["reviewer"], docsOnly: true }));
  ok("transition refuses done with a structured refusal, not an exit", o.refused?.ok === false && o.refused?.refused?.missing?.length === 3);
  ok("transition start sets doing", o.started === "doing");
  ok("transition on an unknown id returns an error", o.bad?.ok === false && /no such task/.test(o.bad?.error));
  ok("recordVerdict records", o.v === "pass");
  ok("recordVerdict refuses a gate that is not reviewer, qa or security", o.badGate?.ok === false);
  ok("mutate saves under the lock", o.mutateOk === true && o.saved === "via import");
  ok("the lock file is released", !existsSync(join(f.root, "docs", "board.json.lock")));
  rmSync(f.root, { recursive: true, force: true });
}

/* 3. lock ----------------------------------------------------------------- */
async function race(boardFile, n) {
  const f = fixture(boardFile);
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(
      new Promise((res) => {
        const p = spawn("node", [join(f.ops, "board.mjs"), "note", "T-001", `n${i}`], { cwd: f.root });
        p.on("close", res);
      }),
    );
  }
  await Promise.all(runs);
  const note = JSON.parse(readFileSync(join(f.root, "docs", "board.json"), "utf8")).phases[1].tasks[0].note ?? "";
  const kept = new Set(note.split(" — "));
  const got = [...Array(n).keys()].filter((i) => kept.has(`n${i}`)).length;
  rmSync(f.root, { recursive: true, force: true });
  return got;
}
{
  const N = 12;
  const got = await race(join(HERE, "board.mjs"), N);
  ok(`${N} parallel \`note\` commands keep all ${N} notes`, got === N, `kept ${got}`);
}
{
  // A stale lock left by a dead process is taken over, not waited on forever.
  const f = fixture(join(HERE, "board.mjs"));
  writeFileSync(join(f.root, "docs", "board.json.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: "2020-01-01" }));
  const t0 = Date.now();
  const r = spawnSync("node", [join(f.ops, "board.mjs"), "note", "T-001", "after a crash"], { cwd: f.root, encoding: "utf8" });
  ok("a lock held by a dead pid is taken over", r.status === 0 && Date.now() - t0 < 4000, r.stderr);
  ok("and released afterwards", !existsSync(join(f.root, "docs", "board.json.lock")));
  rmSync(f.root, { recursive: true, force: true });
}
{
  // Independent review: a holder that outlived LOCK_STALE_MS, whose lock the
  // next writer judged stale and took, deleted THAT writer's lock on release.
  const f = fixture(join(HERE, "board.mjs"));
  const { withLock } = await import(pathToFileURL(join(f.ops, "board.mjs")).href);
  const lock = join(f.root, "docs", "board.json.lock");
  withLock({ data: join(f.root, "docs", "board.json") }, () => {
    rmSync(lock);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: "the next writer" }));
  });
  ok("releasing never removes a lock the next writer took over", existsSync(lock) && readFileSync(lock, "utf8").includes("the next writer"));
  rmSync(f.root, { recursive: true, force: true });
}

{
  // CLAUDE.md: money, auth and ISOLATION need security. The old list was the
  // ticketing project's and had no word for this repo's isolation work.
  const { missingGates } = await import("./board.mjs");
  const needs = (title, note = "") => missingGates({ id: "X", title, note, owner: "backend" }).missing.some((m) => m.startsWith("security"));
  ok("isolation work needs security", needs("Prove the sandbox by attacking it") && needs("Egress allowlist proxy") && needs("Secrets reach the harness"));
  ok("auth and money still do", needs("serve: token exchanged for a cookie", "auth on every route") && needs("Billing export"));
  ok("the ticketing project's words no longer decide it", !needs("Stripe fee refund for a tenant"));
  ok("web auth and redaction work does, and so does a task whose note says it needs security", needs("serve: cookie, host/origin checks, CSP") && needs("archive with redacted transcripts") && needs("command endpoint", "Needs security: it is a write path."));
  const docs = { id: "D", title: "Write the onboarding doc", owner: "product-architect", ac: "prose" };
  ok("a docs-only task needs reviewer only…", missingGates(docs).missing.join() === "reviewer");
  ok("…but a qa FAIL recorded on it (a refutation) still blocks done", missingGates({ ...docs, gate: { reviewer: { verdict: "pass" }, qa: { verdict: "fail" } } }).missing.join() === "qa");
  ok("whole words only: author, tokens and escapement are not auth, secrets or escape", !needs("Author list", "estimate in tokens; escapement"));
}

{
  // H-4: done refuses while the drift gate's latest verdict for the task is a
  // fail. T-005 has every gate passed; only the drift gate stands in the way.
  const f = fixture(join(HERE, "board.mjs"));
  const ev = join(f.root, "ops", "caretaker", "events");
  mkdirSync(ev, { recursive: true });
  const line = (t, verdict, extra = {}) => `${JSON.stringify({ t, kind: "gate", level: verdict === "fail" ? "error" : "info", stage: "review", task: "T-005", verdict, detail: `drift ${verdict}`, ...extra })}\n`;
  writeFileSync(join(ev, "events-2026-09-29.jsonl"), line("2026-09-29T10:00:00Z", "fail"));
  const cli = (...a) => spawnSync("node", [join(f.ops, "board.mjs"), ...a], { cwd: f.root, encoding: "utf8" });
  const refused = cli("done", "T-005");
  ok("H-4: done is REFUSED while the drift gate is failing for the task", refused.status === 1 && /Missing: drift gate/.test(refused.stderr) && /drift\.mjs check --task T-005/.test(refused.stderr), refused.stderr);
  // A refutation is a qa verdict, not the drift gate, and does not count here.
  writeFileSync(join(ev, "events-2026-09-29.jsonl"), line("2026-09-29T10:00:00Z", "pass") + line("2026-09-29T11:00:00Z", "fail", { source: "refute" }));
  const passed = cli("done", "T-005");
  ok("…and allowed once its latest verdict passes (a refutation is not the drift gate)", passed.status === 0, passed.stderr);
  rmSync(f.root, { recursive: true, force: true });
}

console.log(failures ? `\n[board-lib] ${failures} FAILED` : "\n[board-lib] all checks passed");
process.exit(failures ? 1 : 0);
