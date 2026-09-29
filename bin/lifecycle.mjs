/**
 * LIFECYCLE — where a work item is, and what may be done to it now. C-3.
 *
 *     stageOf(task, ctx)     -> { stage, reason, rework?, blocked?, missing }
 *     commandsFor(task, ctx) -> [{ cmd, fixed?, needs?, optional? }]
 *
 * The stage is DERIVED, never declared: there is no `stage` field for anyone to
 * forget to update, and every stage comes with the recorded fact that put the
 * item there (specs/caretaker-web/PRODUCT.md §The lifecycle, TECH.md §Lifecycle).
 * The rules live here and nowhere else; the web client and the TUI display
 * what this returns and compute none of it.
 *
 * WHICH GATES APPLY is not decided here. The only notion of it is
 * `missingGates` from board.mjs, and the required set is what missingGates
 * reports for the task with no verdicts at all. A list of gate names in this
 * file would be a fifth definition, and TECH.md §0 already counts four that
 * disagree. `bin/lifecycle.test.mjs` fails if one appears.
 *
 * ctx:
 *   cfg           the board config; `staleRunHours` (default 24)
 *   runs          this task's runs, folded: { id, start, end, files, noEndRecorded }
 *   spec          board.specInfo(root, task), or null
 *   now           a Date, for the staleness check
 *   missingGates  the function to use; defaults to this checkout's board.mjs.
 *                 The server passes the TARGET repo's own, so the stage uses
 *                 exactly the rules that repo's CLI enforces.
 *
 * Pure: no file, no clock (ctx.now), no process.
 */
import { missingGates as localMissingGates } from "./board.mjs";

export const STAGES = ["intake", "triage", "spec", "build", "verify", "review", "human", "done"];

const gateName = (label) => String(label).split(" ")[0];

/** The gates missingGates requires of this task, whatever has been recorded. */
export function requiredGates(task, mg = localMissingGates) {
  return mg({ ...task, gate: {} }).missing.map(gateName);
}

const attempts = (rec) => (rec ? [...(rec.history ?? []), rec] : []);
const hasAc = (t) => {
  const a = t.ac ?? t.accept;
  return Array.isArray(a) ? a.some((x) => String(x).trim()) : !!String(a ?? "").trim();
};

/** The latest review of the spec as it is now, or null. */
function currentSpecReview(task, spec) {
  if (!spec?.blob) return null;
  const mine = (task.specReview ?? []).filter((r) => r.path === spec.path && r.blob === spec.blob);
  return mine[mine.length - 1] ?? null;
}

export function specApprovalNeeded(task, spec) {
  if (!spec?.governing) return false;
  return currentSpecReview(task, spec)?.decision !== "approve";
}

const openQuestions = (t) => (t.questions ?? []).filter((q) => !q.answer);

/**
 * The first rule that matches wins. The numbers are the rows of TECH.md
 * §Lifecycle, so a reviewer can check each branch against its row.
 */
export function stageOf(task, ctx = {}) {
  const mg = ctx.missingGates ?? localMissingGates;
  const cfg = ctx.cfg ?? {};
  const runs = ctx.runs ?? [];
  const now = ctx.now ?? new Date();
  const staleMs = (cfg.staleRunHours ?? 24) * 3600 * 1000;
  const { missing } = mg(task);
  const required = requiredGates(task, mg);
  const gate = task.gate ?? {};
  const blocked = task.status === "blocked" ? { blocked: task.blockedReason ?? "no reason recorded" } : {};
  const out = (stage, reason, extra = {}) => ({ stage, reason, missing: missing.map(gateName), ...blocked, ...extra });

  // 1. dropped: outside the lifecycle
  if (task.status === "dropped") return out("dropped", task.dropped?.why ? `dropped: ${task.dropped.why}` : "dropped");
  // 2. done: only reachable through core `done`
  if (task.status === "done") return out("done", task.completed ? `closed ${task.completed}` : "closed");
  // 3. human: every required gate has passed
  if (!missing.length) {
    return out("human", `all required gates passed${task.pr?.url ? `; PR ${task.pr.url}` : ""}`);
  }
  // 4. build (rework): the latest verdict on a required gate is a fail, and no
  //    run started after it. Verdicts carry a date only, so "after" means a
  //    later day; a run the same day cannot be ordered against it.
  for (const g of required) {
    const rec = gate[g];
    if (rec?.verdict !== "fail") continue;
    const rerun = runs.some((r) => r.start && rec.at && r.start.slice(0, 10) > rec.at);
    if (rerun) continue;
    const fails = attempts(rec).filter((a) => a.verdict === "fail").length;
    const tries = attempts(rec).length;
    return out("build", `${g} failed on ${rec.at ?? "an undated attempt"} (attempt ${tries})`, { rework: fails });
  }
  // 5. review: some required verdicts passed, none failing, some outstanding
  const passed = required.filter((g) => gate[g]?.verdict === "pass");
  const failing = required.filter((g) => gate[g]?.verdict === "fail");
  if (passed.length && !failing.length) return out("review", `waiting on ${missing.map(gateName).join(", ")}`);
  // 6. verify: a run ended with a measured diff, and no verdict yet
  const anyVerdict = Object.values(gate).some((r) => r?.verdict);
  const measured = runs.filter((r) => r.end && Number(r.files) > 0);
  if (measured.length && !anyVerdict) {
    const r = measured[measured.length - 1];
    return out("verify", `run ${r.id} changed ${r.files} file${r.files === 1 ? "" : "s"}`);
  }
  // 7. build: in progress, or an open run that is not stale
  const open = runs.filter((r) => r.start && !r.end && !r.noEndRecorded && now - Date.parse(r.start) < staleMs);
  if (task.status === "doing") return out("build", open.length ? `in progress; run ${open[open.length - 1].id} open` : "in progress");
  if (open.length) return out("build", `run ${open[open.length - 1].id} open`);
  // 8. spec: a governing spec whose current content is not approved
  if (specApprovalNeeded(task, ctx.spec)) {
    const cur = currentSpecReview(task, ctx.spec);
    return out(
      "spec",
      cur?.decision === "reject"
        ? `${ctx.spec.path} rejected at ${ctx.spec.blob.slice(0, 7)}: ${cur.why ?? ""}`.trim()
        : `${ctx.spec.path} at ${ctx.spec.blob ? ctx.spec.blob.slice(0, 7) : "an unhashable version"} is not approved`,
    );
  }
  // 10 before 9: rule 9's "ac missing" would otherwise swallow every intake
  // item. Intake is the narrower case: nothing looked at it at all.
  const triageRecs = task.triage ?? [];
  if (!triageRecs.length && !hasAc(task)) return out("intake", "no triage record and no acceptance criterion");
  // 9. triage: triage not accepted, or the finish line, owner or estimate missing
  const lastTriage = triageRecs[triageRecs.length - 1];
  if (lastTriage && lastTriage.decision !== "accept") {
    return out("triage", `triage ${lastTriage.decision}ed${lastTriage.why ? `: ${lastTriage.why}` : ""}`);
  }
  const lacking = [!hasAc(task) && "acceptance criterion", !task.owner && "owner", !task.est && "estimate"].filter(Boolean);
  if (lacking.length) return out("triage", `no ${lacking.join(", no ")}`);
  // 11. ready: queued at the head of the build column
  return out("ready", "triaged and waiting to start");
}

/**
 * What core would accept for this task right now. Every button in the web
 * client and every entry in the command menu comes from this list, and core
 * checks again on the click, so a stale page is harmless.
 *
 * Verdicts are never offered: a one-click pass is the rubber stamp ADR-0001
 * rejects, so they come from gate runs and the CLI.
 *
 * { cmd, fixed?: args the command is bound to, needs?: args the user must
 *   supply, optional?: args the user may supply }
 */
export function commandsFor(task, ctx = {}) {
  const mg = ctx.missingGates ?? localMissingGates;
  const st = task.status;
  const live = st !== "done" && st !== "dropped";
  const cmds = [];
  if (st === "todo" || st === "blocked") cmds.push({ cmd: "start" });
  if (live && !mg(task).missing.length) cmds.push({ cmd: "done" });
  if (st === "todo" || st === "doing") cmds.push({ cmd: "block", needs: ["text"] });
  if (st === "doing" || st === "blocked" || st === "done") cmds.push({ cmd: "todo" });
  for (const q of openQuestions(task)) if (live) cmds.push({ cmd: "answer", fixed: { qid: q.id }, needs: ["text"] });
  if (live) cmds.push({ cmd: "ask", needs: ["text"] });
  if (live) {
    const { stage } = stageOf(task, ctx);
    if (stage === "intake" || stage === "triage") {
      cmds.push({ cmd: "triage", fixed: { decision: "accept" }, optional: ["text"] });
      cmds.push({ cmd: "triage", fixed: { decision: "reject" }, needs: ["text"] });
    }
    if (specApprovalNeeded(task, ctx.spec) && ctx.spec?.blob) {
      cmds.push({ cmd: "spec-approve" });
      cmds.push({ cmd: "spec-reject", needs: ["text"] });
    }
    cmds.push({ cmd: "pr", needs: ["url"] });
  }
  cmds.push({ cmd: "note", needs: ["text"] });
  if (live) cmds.push({ cmd: "drop", needs: ["text"] });
  return cmds;
}

/** The task's unanswered questions, oldest first. */
export { openQuestions };
