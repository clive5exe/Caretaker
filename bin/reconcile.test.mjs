#!/usr/bin/env node
/**
 * H-7 and H-5: drift points the way the project says, and a reconciliation is
 * a proposal a human decides — nothing reaches a spec before that.
 *
 * Real harness, sandbox:none, fake CLIs, a real git repo with one governing
 * spec. The reconciler's "answer" is a file the fake CLI prints, so the test
 * controls exactly what the proposal says.
 *
 * Run: node bin/reconcile.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIRECTIONS, directionFor, gate } from "./drift.mjs";
import { ReconcileError, accept, parseProposal, patchTargets, propose, reject, status } from "./reconcile.mjs";
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
    return e instanceof ReconcileError && e.code === code;
  }
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/* ============================================================ H-7 direction */
const SPEC = { id: "specs/pricing.md", governs: ["src/**"], errors: [] };
{
  const spec = gate({ specs: [SPEC], changed: ["src/fee.js"] });
  ok("direction spec (the default): drift blocks", spec.ok === false && spec.direction === "spec" && spec.harvest.length === 0);
  const code = gate({ specs: [SPEC], changed: ["src/fee.js"], direction: "code" });
  ok("direction code: drift does not block", code.ok === true);
  ok("…but the behind spec is listed to harvest, never dropped", JSON.stringify(code.harvest) === '["specs/pricing.md"]' && code.drift.length === 1);
  const rec = gate({ specs: [SPEC], changed: ["src/fee.js"], direction: "reconcile" });
  ok("direction reconcile: drift blocks until reconciled", rec.ok === false && rec.notes.some((n) => /reconcile/.test(n)));
  const two = [SPEC, { id: "specs/other.md", governs: ["src/**"], errors: [] }];
  ok("a conflict blocks in every direction, code included", gate({ specs: two, changed: ["src/fee.js"], direction: "code" }).ok === false);
  ok("the three directions are exactly spec, code, reconcile", JSON.stringify(DIRECTIONS) === '["spec","code","reconcile"]');
  ok("directionFor: default is spec", directionFor({}, null) === "spec");
  ok("directionFor: the project's setting", directionFor({ drift: { direction: "code" } }, null) === "code");
  ok("directionFor: a task overrides the project", directionFor({ drift: { direction: "code" } }, { id: "T-1", driftDirection: "spec" }) === "spec");
  ok("directionFor: an unknown direction is refused, not defaulted", throws(() => directionFor({ drift: { direction: "whatever" } })));
  ok("gate: an unknown direction is refused", throws(() => gate({ specs: [SPEC], changed: [], direction: "sideways" })));
}

/* ------------------------------------------------------------ parse helpers */
{
  const p = parseProposal("thinking\n```diff\n--- a/specs/x.md\n+++ b/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n```\nDIRECTION: SPEC-BEHIND the fee moved on purpose");
  ok("a proposal's direction, reason and diff are read", p.direction === "spec-behind" && p.reason === "the fee moved on purpose" && p.patch.includes("+b"));
  ok("no direction line means no direction", parseProposal("```diff\n+x\n```").direction === null);
  ok("CODE-DRIFTED is read", parseProposal("DIRECTION: CODE-DRIFTED we decided 5%").direction === "code-drifted");
  // Targets are what `git apply` would write, asked of git (the reviewer's cases).
  const t = (patch) => patchTargets(patch, tmpdir());
  const hunk = "--- a/specs/x.md\n+++ b/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n";
  ok("patch targets are what git would write", JSON.stringify(t(`diff --git a/specs/x.md b/specs/x.md\n${hunk}`)) === '["specs/x.md"]', JSON.stringify(t(`diff --git a/specs/x.md b/specs/x.md\n${hunk}`)));
  ok("a rename names both sides", JSON.stringify(t("diff --git a/specs/x.md b/src/y.js\nsimilarity index 100%\nrename from specs/x.md\nrename to src/y.js\n")) === '["specs/x.md","src/y.js"]');
  ok("a new file with no ---/+++ headers, hidden after a spec hunk, is still a target", t(`diff --git a/specs/x.md b/specs/x.md\n${hunk}diff --git a/src/new.js b/src/new.js\nnew file mode 100644\nindex 0000000..e69de29\n`)?.includes("src/new.js"));
  ok("a header without the a/ prefix is read as git reads it (-p1 strips one part)", JSON.stringify(t("--- specs/x.md\n+++ specs/x.md\n@@ -1 +1 @@\n-a\n+b\n")) === '["x.md"]');
}

/* ================================================================ fixture */
const TMP = mkdtempSync(join(tmpdir(), "reconcile-test-"));
const REPO = join(TMP, "repo");
const OPS = join(REPO, "ops", "caretaker");
mkdirSync(OPS, { recursive: true });
mkdirSync(join(REPO, "docs"), { recursive: true });
mkdirSync(join(REPO, "specs"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(OPS, "board.mjs"));
copyFileSync(join(HERE, "dashboard.mjs"), join(OPS, "dashboard.mjs"));
const STATE = join(TMP, "state");
const CFG = join(OPS, "config.json");
writeFileSync(CFG, JSON.stringify({ name: "F", board: "docs/board.json", boardMarkdown: "docs/board.md", repo: ".", stateDir: STATE, events: "ops/caretaker/events", operator: "tester" }));
const BOARD = join(REPO, "docs", "board.json");
writeFileSync(BOARD, JSON.stringify({ meta: { name: "F" }, phases: [{ name: "P", tasks: [{ id: "T-001", title: "fees", status: "doing", owner: "b", est: "1h", ac: "a" }] }] }));
const SPEC_PATH = join(REPO, "specs", "pricing.md");
const SPEC_TEXT = "---\ntitle: Pricing\n---\n\n```spec\ngoverns: src/**\n```\n\n# Pricing\n\nThe fee is 5%.\n";
writeFileSync(SPEC_PATH, SPEC_TEXT);
writeFileSync(join(REPO, "src", "fee.js"), "export const FEE = 0.05;\n");
const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });
git("init", "-q");
git("add", "-A");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

let n = 0;
const cli = (body) => {
  const p = join(TMP, `cli-${n++}.sh`);
  writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return { argv: [p] };
};
const say = (text) => {
  const f = join(TMP, `say-${n++}.txt`);
  writeFileSync(f, text);
  return cli(`cat '${f}'`);
};
const policy = (c) => ({ adapter: "cli", cli: c, sandbox: "none", timeoutMs: 20_000, events: join(OPS, "events") });

// The parent: a run that changed governed code and left the spec alone.
const parent = await runArchived(REPO, "raise the fee", policy(cli("printf 'export const FEE = 0.07;\\n' > src/fee.js")), { stateDir: STATE, task: "T-001" });
const PARENT = parent.verdict.runId;
ok("the parent run drifted: it changed src/fee.js and not the spec", parent.diff.files.map((f) => f.path).join() === "src/fee.js");

// A real, applicable spec diff for the reconciler to "propose".
writeFileSync(join(TMP, "spec-new.md"), SPEC_TEXT.replace("The fee is 5%.", "The fee is 7%."));
const realDiff = spawnSync("git", ["diff", "--no-index", "--no-prefix", SPEC_PATH, join(TMP, "spec-new.md")], { encoding: "utf8" }).stdout;
const specPatch = `--- a/specs/pricing.md\n+++ b/specs/pricing.md\n${realDiff.split("\n").slice(realDiff.split("\n").findIndex((l) => l.startsWith("@@"))).join("\n")}`;

/* ------------------------------------------------------ SPEC-BEHIND, accept */
{
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say(`The fee rise was intended.\n\`\`\`diff\n${specPatch.trimEnd()}\n\`\`\`\nDIRECTION: SPEC-BEHIND the fee was raised on purpose\n`)), stateDir: STATE });
  ok("a SPEC-BEHIND proposal is valid when it touches only the drifted spec and applies", p.valid && p.direction === "spec-behind" && p.applies === true, JSON.stringify(p.problems));
  ok("proposing changes NOTHING in the spec", readFileSync(SPEC_PATH, "utf8") === SPEC_TEXT);
  ok("the proposal is stored in the reconciler's archive", existsSync(join(STATE, "runs", p.proposal, "proposal.patch")) && existsSync(join(STATE, "runs", p.proposal, "proposal.json")));
  ok("the reconciler is a child of the run it reconciles", JSON.parse(readFileSync(join(STATE, "runs", p.proposal, "run.json"), "utf8")).parent === PARENT);
  const a = await accept({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE });
  ok("accepting applies the diff to the spec", readFileSync(SPEC_PATH, "utf8").includes("The fee is 7%.") && JSON.stringify(a.applied) === '["specs/pricing.md"]');
  ok("…and records who accepted it", a.by === "tester" && (await status({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE })).decisions[0].decision === "accepted");
  ok("…and does not commit it: that stays a human step", git("status", "--porcelain", "specs/pricing.md").stdout.trim().startsWith("M"));
  ok("a decided proposal cannot be decided again", await rejects(() => accept({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE }), "DECIDED"));
  const ev = events.read(join(OPS, "events")).events.filter((e) => e.source === "reconcile");
  ok("the proposal and the decision are both in the event log", ev.some((e) => /proposed/.test(e.detail)) && ev.some((e) => /accepted/.test(e.detail) && /tester/.test(e.detail)));
  writeFileSync(SPEC_PATH, SPEC_TEXT); // back to the drifted state for the cases below
}

/* ------------------------------------------------ a proposal that overreaches */
{
  const stray = `${specPatch.trimEnd()}\n--- a/src/fee.js\n+++ b/src/fee.js\n@@ -1 +1 @@\n-export const FEE = 0.07;\n+export const FEE = 0.05;\n`;
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say(`\`\`\`diff\n${stray}\`\`\`\nDIRECTION: SPEC-BEHIND and I fixed the code too\n`)), stateDir: STATE });
  ok("a proposal that touches code is invalid, by name", !p.valid && p.problems.some((x) => /src\/fee\.js, which did not drift/.test(x)), JSON.stringify(p.problems));
  ok("…and cannot be accepted", await rejects(() => accept({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE }), "INVALID"));
  ok("…and nothing changed on disk", readFileSync(SPEC_PATH, "utf8") === SPEC_TEXT && readFileSync(join(REPO, "src", "fee.js"), "utf8").includes("0.07"));
}
{
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say("```diff\n--- a/specs/pricing.md\n+++ b/specs/pricing.md\n@@ -99 +99 @@\n-nope\n+yes\n```\nDIRECTION: SPEC-BEHIND x\n")), stateDir: STATE });
  ok("a diff that does not apply is invalid", !p.valid && p.applies === false);
}
{
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say("I am not sure which side is wrong.\n")), stateDir: STATE });
  ok("no stated direction is not a proposal", !p.valid && p.problems.some((x) => /no DIRECTION line/.test(x)));
}

{
  // The reviewer's case: a reconciler that edits the spec itself and then
  // says CODE-DRIFTED was marked valid, and the spec had changed unaccepted.
  const spec = join(REPO, "specs", "pricing.md");
  const before = readFileSync(spec, "utf8");
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(cli(`printf '\\nedited by the reconciler\\n' >> specs/pricing.md; echo 'DIRECTION: CODE-DRIFTED nothing to see'`)), stateDir: STATE });
  ok("a reconciler that EDITED the workspace makes no valid proposal, and says what it changed", !p.valid && p.problems.some((x) => /changed specs\/pricing\.md in the workspace; a reconciler proposes/.test(x)), JSON.stringify(p.problems));
  writeFileSync(spec, before);
}
{
  // A reply that OPENS with the direction, inside claude's JSON result.
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say('{"type":"result","result":"DIRECTION: CODE-DRIFTED the fee is 5% by decision"}\n')), stateDir: STATE });
  ok("a DIRECTION line that opens a JSON reply is read", p.direction === "code-drifted" && p.valid, JSON.stringify(p.problems));
}

/* ------------------------------------------------------ CODE-DRIFTED, accept */
{
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say("DIRECTION: CODE-DRIFTED the fee is 5% by decision; the change is wrong\n")), stateDir: STATE });
  ok("a CODE-DRIFTED proposal is valid with no diff", p.valid && p.direction === "code-drifted");
  await accept({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE });
  const note = JSON.parse(readFileSync(BOARD, "utf8")).phases[0].tasks[0].note ?? "";
  ok("accepting it leaves the spec alone", readFileSync(SPEC_PATH, "utf8") === SPEC_TEXT);
  ok("…and notes on the task that the code must change", /CODE DRIFTED from specs\/pricing\.md/.test(note) && note.includes(p.proposal), note);
}

/* ----------------------------------------------------------------- reject */
{
  const p = await propose({ cfgPath: CFG, run: PARENT, workspace: REPO, policy: policy(say("DIRECTION: CODE-DRIFTED x\n")), stateDir: STATE });
  ok("a rejection needs a reason", await rejects(() => reject({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE, reason: "  " }), "NO_REASON"));
  const r = await reject({ cfgPath: CFG, proposal: p.proposal, stateDir: STATE, reason: "the product changed its mind" });
  ok("a rejection with a reason is recorded", r.decision === "rejected" && r.reason === "the product changed its mind");
}

/* --------------------------------------------------------------- refusals */
{
  const clean = await runArchived(REPO, "x", policy(cli("printf 'notes\\n' > README.txt")), { stateDir: STATE, task: "T-001" });
  ok("a run with no drift has nothing to reconcile", await rejects(() => propose({ cfgPath: CFG, run: clean.verdict.runId, workspace: REPO, policy: policy(cli("true")), stateDir: STATE }), "NOTHING_TO_RECONCILE"));
  ok("an unknown run is refused", await rejects(() => propose({ cfgPath: CFG, run: "r_ffffffff", workspace: REPO, stateDir: STATE }), "NO_RUN"));
}

/* ------------------------------------------------- the CLI reads direction */
{
  const b = JSON.parse(readFileSync(BOARD, "utf8"));
  b.phases[0].tasks[0].driftDirection = "code";
  writeFileSync(BOARD, JSON.stringify(b));
  const run = (...a) => spawnSync("node", [join(HERE, "drift.mjs"), "check", "--repo", REPO, "--path", "src/fee.js", "--no-events", "--no-tree", ...a], { encoding: "utf8" });
  ok("drift check with no direction blocks", run().status === 1);
  {
    // The reviewer's case: a project that declared code as the authority, and
    // the CI step graduate writes, which passes no --config.
    const cfgFile = join(REPO, "ops", "caretaker", "config.json");
    const cfgBefore = readFileSync(cfgFile, "utf8");
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(cfgBefore), drift: { direction: "code" } }));
    const r = run();
    writeFileSync(cfgFile, cfgBefore);
    ok("with no --config, the project's own config sets the direction", r.status === 0, r.stderr.slice(0, 300));
  }
  const viaTask = run("--config", CFG, "--task", "T-001");
  ok("drift check --config honours the task's own direction", viaTask.status === 0 && JSON.parse(viaTask.stdout).direction === "code", viaTask.stderr);
  ok("--direction wins over config", run("--config", CFG, "--task", "T-001", "--direction", "spec").status === 1);
  ok("an unknown --direction is refused", run("--direction", "up").status === 2);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[reconcile] ${failures} FAILED` : "\n[reconcile] all checks passed");
process.exit(failures ? 1 : 0);
