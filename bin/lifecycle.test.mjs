#!/usr/bin/env node
/**
 * C-3: lifecycle.stageOf and commandsFor.
 *
 *   1. One fixture per row of TECH.md §Lifecycle, asserting the stage and
 *      that the reason names the fact that put it there.
 *   2. commandsFor offers what core accepts, and never a verdict.
 *   3. lifecycle.mjs defines no gate list of its own: the required gates come
 *      from missingGates, so swapping in another missingGates moves the stage.
 *
 * Run: node bin/lifecycle.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandsFor, requiredGates, stageOf } from "./lifecycle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const NOW = new Date("2026-09-29T12:00:00Z");
const base = { id: "T-1", title: "plain", owner: "builder", est: "2h", status: "todo", ac: "it works" };
const pass = (at = "2026-09-20") => ({ verdict: "pass", at });
const fail = (at = "2026-09-20", history) => ({ verdict: "fail", at, ...(history ? { history } : {}) });
const SPEC = { path: "specs/x.md", exists: true, governing: true, blob: "b".repeat(40) };

const rows = [
  ["1 dropped", { ...base, status: "dropped", dropped: { why: "not needed" } }, {}, "dropped", /not needed/],
  ["2 done", { ...base, status: "done", completed: "2026-09-01" }, {}, "done", /2026-09-01/],
  ["3 human", { ...base, gate: { reviewer: pass(), qa: pass() }, pr: { url: "https://x/pr/1" } }, {}, "human", /all required gates passed; PR https:\/\/x\/pr\/1/],
  ["4 build (rework)", { ...base, status: "doing", gate: { reviewer: pass(), qa: fail("2026-09-21", [{ verdict: "fail", at: "2026-09-19" }]) } }, {}, "build", /qa failed on 2026-09-21 \(attempt 2\)/],
  ["4 skipped once a run started after the fail", { ...base, gate: { qa: fail("2026-09-21") } }, { runs: [{ id: "r_00000001", start: "2026-09-22T10:00:00Z" }] }, "ready", /triaged/],
  ["5 review", { ...base, status: "doing", gate: { reviewer: pass() } }, {}, "review", /waiting on qa/],
  ["6 verify", { ...base, status: "doing" }, { runs: [{ id: "r_0000abcd", start: "2026-09-28T10:00:00Z", end: "2026-09-28T11:00:00Z", files: 3 }] }, "verify", /r_0000abcd changed 3 files/],
  ["6 not verify when the run changed nothing", { ...base, status: "doing" }, { runs: [{ id: "r_0000abcd", start: "2026-09-28T10:00:00Z", end: "2026-09-28T11:00:00Z", files: 0 }] }, "build", /in progress/],
  ["7 build (doing)", { ...base, status: "doing" }, {}, "build", /in progress/],
  ["7 build (open run)", { ...base }, { runs: [{ id: "r_000000ff", start: "2026-09-29T11:00:00Z" }] }, "build", /r_000000ff open/],
  ["7 a stale open run is not build", { ...base }, { runs: [{ id: "r_000000ff", start: "2026-09-20T11:00:00Z" }] }, "ready", /triaged/],
  ["8 spec", { ...base }, { spec: SPEC }, "spec", /specs\/x.md at bbbbbbb is not approved/],
  ["8 approved for this blob", { ...base, specReview: [{ path: "specs/x.md", blob: SPEC.blob, decision: "approve" }] }, { spec: SPEC }, "ready", /triaged/],
  ["8 approval of an older blob does not count", { ...base, specReview: [{ path: "specs/x.md", blob: "a".repeat(40), decision: "approve" }] }, { spec: SPEC }, "spec", /not approved/],
  ["8 a context doc (no spec block) needs no approval", { ...base }, { spec: { ...SPEC, governing: false } }, "ready", /triaged/],
  ["9 triage (rejected)", { ...base, triage: [{ decision: "reject", why: "too big" }] }, {}, "triage", /rejected: too big/],
  ["9 triage (no owner, no estimate)", { id: "T-1", title: "t", status: "todo", ac: "x" }, {}, "triage", /no owner, no estimate/],
  ["9 triage (accepted, no ac)", { ...base, ac: undefined, triage: [{ decision: "accept" }] }, {}, "triage", /no acceptance criterion/],
  ["10 intake", { id: "T-1", title: "t", status: "todo" }, {}, "intake", /no triage record/],
  ["11 ready (a legacy task with ac, owner and est counts as triaged)", { ...base }, {}, "ready", /triaged/],
];
for (const [name, task, ctx, stage, reason] of rows) {
  const s = stageOf(task, { now: NOW, ...ctx });
  ok(`row ${name} -> ${stage}`, s.stage === stage && reason.test(s.reason), JSON.stringify(s));
}
{
  const s = stageOf({ ...base, status: "blocked", blockedReason: "needs a key" }, { now: NOW });
  ok("blocked is a badge at the stage, not a stage", s.stage === "ready" && s.blocked === "needs a key");
  const r = stageOf({ ...base, status: "doing", gate: { qa: fail("2026-09-21", [{ verdict: "fail", at: "2026-09-19" }]) } }, { now: NOW });
  ok("rework counts the fails on that gate", r.rework === 2);
  const sec = stageOf({ ...base, title: "rotate the auth token", gate: { reviewer: pass(), qa: pass() } }, { now: NOW });
  ok("an auth task with reviewer and qa passed is in review, waiting on security", sec.stage === "review" && /security/.test(sec.reason));
}

/* 2. commandsFor ----------------------------------------------------------- */
const cmds = (t, ctx = {}) => commandsFor(t, { now: NOW, ...ctx }).map((c) => c.cmd + (c.fixed?.decision ? `:${c.fixed.decision}` : "") + (c.fixed?.qid ? `:${c.fixed.qid}` : ""));
{
  const todo = cmds(base);
  ok("todo offers start, block, ask, pr, note, drop", ["start", "block", "ask", "pr", "note", "drop"].every((c) => todo.includes(c)), todo.join());
  ok("done is not offered while gates are missing", !todo.includes("done"));
  const human = cmds({ ...base, status: "doing", gate: { reviewer: pass(), qa: pass() } });
  ok("done is offered once every required gate passed", human.includes("done"));
  const closed = cmds({ ...base, status: "done", completed: "2026-09-01" });
  ok("a closed task offers only todo (reopen) and note", closed.join() === "todo,note", closed.join());
  const dropped = cmds({ ...base, status: "dropped" });
  ok("a dropped task offers only note", dropped.join() === "note", dropped.join());
  const q = cmds({ ...base, questions: [{ id: "q1", q: "?" }, { id: "q2", q: "?", answer: { text: "y" } }] });
  ok("an open question offers its answer, an answered one does not", q.includes("answer:q1") && !q.includes("answer:q2"));
  const intake = cmds({ id: "T-1", title: "t", status: "todo" });
  ok("intake offers triage accept and reject", intake.includes("triage:accept") && intake.includes("triage:reject"));
  ok("a triaged task does not offer triage", !todo.some((c) => c.startsWith("triage")));
  const spec = cmds(base, { spec: SPEC });
  ok("an unapproved governing spec offers approve and reject", spec.includes("spec-approve") && spec.includes("spec-reject"));
  ok("an approved spec does not", !cmds({ ...base, specReview: [{ path: SPEC.path, blob: SPEC.blob, decision: "approve" }] }, { spec: SPEC }).includes("spec-approve"));
  const all = new Set([base, { ...base, status: "doing" }, { ...base, status: "blocked" }].flatMap((t) => cmds(t)));
  ok("no verdict is ever offered", !["reviewer", "qa", "security"].some((g) => all.has(g)));
  const needs = commandsFor(base, { now: NOW }).find((c) => c.cmd === "block");
  ok("commands say what input they need", JSON.stringify(needs.needs) === '["text"]');
}

/* 3. no gate list of its own ----------------------------------------------- */
{
  const src = readFileSync(join(HERE, "lifecycle.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  ok("lifecycle.mjs names no gate in code (comments aside)", !/["'`](reviewer|qa|security)["'`]/.test(src));
  ok("required gates come from missingGates", requiredGates(base).join() === "reviewer,qa");
  // Mutate the rule by substitution: a missingGates that also demands security
  // for everything. The stage must follow it by name, with nothing else changed.
  const strict = (t) => {
    const g = t.gate ?? {};
    const missing = ["reviewer", "qa", "security"].filter((k) => g[k]?.verdict !== "pass");
    return { missing, docsOnly: false };
  };
  const t = { ...base, status: "doing", gate: { reviewer: pass(), qa: pass() } };
  ok("with the real rule, reviewer + qa is human", stageOf(t, { now: NOW }).stage === "human");
  const moved = stageOf(t, { now: NOW, missingGates: strict });
  ok("with a stricter missingGates, the same task is in review, waiting on security", moved.stage === "review" && /security/.test(moved.reason));
  ok("and done stops being offered", !commandsFor(t, { now: NOW, missingGates: strict }).some((c) => c.cmd === "done"));
}

console.log(failures ? `\n[lifecycle] ${failures} FAILED` : "\n[lifecycle] all checks passed");
process.exit(failures ? 1 : 0);
