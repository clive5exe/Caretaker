#!/usr/bin/env node
/**
 * RECONCILE — H-5. A run that PROPOSES a spec change from a drifted diff, and
 * a human who accepts or rejects it. Nothing reaches a spec without that.
 *
 * THE DIRECTION IS THE POINT AND IT IS NEVER GUESSED. "We learned something,
 * the spec should change" and "the code drifted from what we decided" are
 * opposite events with opposite fixes. The reconciler must state which, as
 *
 *     DIRECTION: SPEC-BEHIND <why the spec should change>
 *     DIRECTION: CODE-DRIFTED <why the code is what is wrong>
 *
 * and a proposal with no stated direction is not a proposal. For SPEC-BEHIND
 * it includes the spec change as a ```diff block. That diff is only ever
 * STORED at propose time; `accept` is what applies it, and it records who did.
 * For CODE-DRIFTED there is nothing to apply: accepting it puts a note on the
 * task saying the code must change, and the spec is left alone.
 *
 * A proposal may touch only the specs that drifted. One that edits code, or a
 * spec that did not drift, is stored and marked invalid, and cannot be
 * accepted: a reconciler that rewrites whatever it likes is a mirror with extra
 * steps, which is what drift.mjs's header says a spec must not be.
 *
 * Decisions are appended (`decisions.jsonl` in the run's archive, plus an
 * event), never edited. A proposal is decided once.
 *
 * Usage:
 *   node bin/reconcile.mjs propose --config C --run r_… --workspace DIR [--cli …] [--model …] [--sandbox …]
 *   node bin/reconcile.mjs accept  --config C --proposal r_… [--by WHO]
 *   node bin/reconcile.mjs reject  --config C --proposal r_… --reason "why" [--by WHO]
 *   node bin/reconcile.mjs show    --config C --proposal r_…
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directionFor, gate, loadSpecs, norm } from "./drift.mjs";
import * as events from "./events.mjs";
import { load as loadHarnessSettings, policyFlags, policyFor } from "./harness-config.mjs";
import { RUN_ID, runArchived, stateDirFor } from "./runstore.mjs";
import { requireSecrets } from "./secrets.mjs";
import { transcriptTexts } from "./transcript.mjs";

export class ReconcileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}

const DIRECTION_LINE = /^[ \t>*`_-]*DIRECTION:[ \t]*(SPEC-BEHIND|CODE-DRIFTED)\b[ \t:—-]*(.*)$/gm;
const DIFF_BLOCK = /```diff[ \t]*\n([\s\S]*?)\n```/g;

/**
 * The stated direction and the proposed diff, read from transcript text. The
 * last of each wins, and `\n` escapes are unfolded because a CLI's JSON output
 * carries the model's text as a string — a property of JSON, not of a vendor.
 */
export function parseProposal(text) {
  // Read as transcript.mjs reads any transcript, so a reply that OPENS with
  // the DIRECTION line inside a JSON transcript line is found (independent
  // review: it returned null for both the API adapter and claude's result).
  let dir = null;
  let diff = null;
  for (const v of transcriptTexts(text)) {
    for (const m of v.matchAll(DIRECTION_LINE)) dir = m;
    for (const m of v.matchAll(DIFF_BLOCK)) diff = m[1];
  }
  return {
    direction: dir ? (dir[1] === "SPEC-BEHIND" ? "spec-behind" : "code-drifted") : null,
    reason: dir ? dir[2].replace(/["}\]]+$/, "").trim() || null : null,
    patch: diff ? `${diff.trimEnd()}\n` : null,
  };
}

/**
 * The paths `git apply` WOULD write, asked of git itself (`--numstat -z`, the
 * same -p1 that accept uses), both sides of a rename included. Reading only
 * the ---/+++ headers let a binary patch or a rename hide behind a normal
 * spec hunk, and assumed the a/ b/ prefix git strips whether it is there or
 * not, so a header naming specs/x.md wrote x.md (independent review).
 * Returns null when git cannot read the patch.
 */
export function patchTargets(patch, root) {
  const r = spawnSync("git", ["apply", "--numstat", "-z", "-"], { cwd: root, input: String(patch ?? ""), encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = new Set();
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const cols = parts[i].split("\t");
    if (cols.length < 3) continue;
    if (cols[2] === "") {
      // A rename: the two paths follow as their own NUL-separated fields.
      if (parts[i + 1]) out.add(norm(parts[i + 1]));
      if (parts[i + 2]) out.add(norm(parts[i + 2]));
      i += 2;
    } else out.add(norm(cols[2]));
  }
  // numstat names a rename or copy by its NEW path only; the old one is in the
  // patch's own `rename from` / `copy from` line, which git takes literally.
  for (const m of String(patch ?? "").matchAll(/^(?:rename|copy) from (.+)$/gm)) out.add(norm(m[1]));
  return [...out].sort();
}

export function reconcilePrompt({ task, projectDirection, drift, patch, specTexts }) {
  return [
    `Task ${task.id}: ${task.title}.`,
    "",
    "A change touched code that a spec governs, and the spec was not updated. Your job is to decide WHICH",
    "SIDE IS WRONG, and to say so. Do not edit any file; a proposal you write into the tree is not a proposal.",
    "",
    `This project's default is "${projectDirection}" (spec: the spec is the authority; code: the code leads;`,
    "reconcile: neither). Treat that as context, not as the answer: decide from the evidence.",
    "",
    "Drift:",
    ...drift.map((d) => `  ${d.path} changed; it is governed by ${d.spec}`),
    "",
    "The change, as measured by the harness:",
    "```diff",
    patch.trim() || "(no patch recorded)",
    "```",
    "",
    ...specTexts.flatMap(({ spec, text }) => [`Current text of ${spec}:`, "````markdown", text.trimEnd(), "````", ""]),
    "End with exactly one line, either",
    "  DIRECTION: SPEC-BEHIND <what was learned, so the spec should change>",
    "or",
    "  DIRECTION: CODE-DRIFTED <what was decided, so the code should change>",
    "For SPEC-BEHIND, put the spec change before that line as ONE ```diff block, a unified diff with",
    `--- a/<spec path> and +++ b/<spec path> headers, touching only: ${[...new Set(drift.map((d) => d.spec))].join(", ")}.`,
  ].join("\n");
}

async function context(cfgPath) {
  const cfgAbs = resolve(cfgPath);
  const boardPath = join(dirname(cfgAbs), "board.mjs");
  if (!existsSync(boardPath)) throw new ReconcileError("NO_BOARD", `no board.mjs beside ${cfgAbs}`);
  const board = await import(pathToFileURL(boardPath).href);
  if (board.API_VERSION !== 1) throw new ReconcileError("OLD_BOARD", `${boardPath} predates API_VERSION 1`);
  const ctx = board.loadConfig(cfgAbs, dirname(cfgAbs));
  return {
    board,
    ctx,
    root: ctx.root,
    cfg: ctx.cfg,
    eventsDir: join(ctx.root, ctx.cfg.events ?? "ops/caretaker/events"),
  };
}

const runDir = (stateDir, id) => join(stateDir, "runs", id);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const decisionsOf = (dir) =>
  existsSync(join(dir, "decisions.jsonl"))
    ? readFileSync(join(dir, "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/**
 * Propose. Runs a reconciler against archived run `run`, stores what it says
 * in the reconciler's own archive, and applies nothing.
 */
export async function propose({ cfgPath, run, workspace, policy = {}, secrets = {}, stateDir: stateOverride, harness }) {
  if (!RUN_ID.test(String(run))) throw new ReconcileError("BAD_RUN", `${JSON.stringify(run)} is not a run id`);
  const c = await context(cfgPath);
  const stateDir = stateOverride ? resolve(stateOverride) : stateDirFor(c.root, c.cfg);
  const pdir = runDir(stateDir, run);
  if (!existsSync(join(pdir, "run.json"))) throw new ReconcileError("NO_RUN", `no archived run ${run} under ${stateDir}`);
  const parent = readJson(join(pdir, "run.json"));
  const changed = (parent.diff?.files ?? []).map((f) => norm(f.path));
  const specsDir = c.cfg.specs ?? "specs";
  const { specs } = loadSpecs(specsDir, { repo: c.root });
  const report = gate({ specs, changed, ignore: [`${norm(specsDir)}/**`], task: parent.task ?? null });
  if (!report.drift.length) {
    throw new ReconcileError("NOTHING_TO_RECONCILE", `run ${run} changed no governed path without its spec; there is nothing to reconcile`);
  }
  const task = parent.task ? c.board.find(c.board.load(c.ctx), parent.task)?.t ?? null : null;
  const driftedSpecs = [...new Set(report.drift.map((d) => d.spec))].sort();
  const specTexts = driftedSpecs.map((spec) => ({ spec, text: readFileSync(join(c.root, spec), "utf8") }));
  const patch = existsSync(join(pdir, "diff.patch")) ? readFileSync(join(pdir, "diff.patch"), "utf8") : "";

  const out = await runArchived(
    workspace,
    reconcilePrompt({
      task: task ?? { id: parent.task ?? "(none)", title: "(no task)" },
      projectDirection: directionFor(c.cfg, task),
      drift: report.drift,
      patch,
      specTexts,
    }),
    { ...policy, stage: "review", events: policy.events ?? c.eventsDir },
    { stateDir, task: parent.task ?? null, parent: run, secrets, harness },
  );
  const child = out.verdict.runId;
  const cdir = runDir(stateDir, child);
  // Read from the ARCHIVED transcript, which is redacted: a proposal can quote
  // the change, and the change can carry a secret.
  const parsed = parseProposal(out.verdict.finalText ?? readFileSync(join(cdir, "transcript.log"), "utf8"));
  const problems = [];
  if (!out.verdict.ok) problems.push(`the reconciling run did not complete (${out.verdict.state})`);
  // A reconciler PROPOSES. One that edited the workspace, a spec included,
  // changed what it was asked only to describe, and no one accepted it
  // (independent review: such a run was marked valid).
  const edited = out.diff?.measured ? out.diff.files.map((f) => f.path) : [];
  if (edited.length) problems.push(`the reconciling run changed ${edited.join(", ")} in the workspace; a reconciler proposes, it does not apply. Review and revert those changes`);
  if (!parsed.direction) problems.push("no DIRECTION line: a proposal must say which side is wrong");
  let targets = [];
  let applies = null;
  if (parsed.direction === "spec-behind") {
    if (!parsed.patch) problems.push("SPEC-BEHIND with no ```diff block: there is nothing to accept");
    else {
      targets = patchTargets(parsed.patch, c.root) ?? [];
      const stray = targets.filter((t) => !driftedSpecs.includes(t));
      if (!targets.length) problems.push("the diff names no file git can apply");
      if (stray.length) problems.push(`the diff touches ${stray.join(", ")}, which did not drift; a proposal may change only ${driftedSpecs.join(", ")}`);
      const chk = spawnSync("git", ["apply", "--check", "-"], { cwd: c.root, input: parsed.patch, encoding: "utf8" });
      applies = chk.status === 0;
      if (!applies) problems.push(`the diff does not apply to the current spec: ${String(chk.stderr).trim().split("\n")[0]}`);
    }
  }
  const proposal = {
    proposal: child,
    run,
    task: parent.task ?? null,
    direction: parsed.direction,
    reason: parsed.reason,
    drifted: report.drift,
    specs: driftedSpecs,
    targets,
    applies,
    valid: problems.length === 0,
    problems,
    proposedAt: new Date().toISOString(),
  };
  if (parsed.direction === "spec-behind" && parsed.patch) writeFileSync(join(cdir, "proposal.patch"), parsed.patch);
  writeFileSync(join(cdir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`);
  events.append(c.eventsDir, {
    run: child,
    ...(parent.task ? { task: parent.task } : {}),
    stage: "review",
    kind: "drift",
    source: "reconcile",
    level: proposal.valid ? "info" : "warn",
    detail: `reconciliation proposed for ${run}: ${parsed.direction ?? "no direction"}${proposal.valid ? "" : ` (invalid: ${problems[0]})`}`.replace(/[\r\n]+/g, " "),
  });
  return proposal;
}

/** The proposal and its decisions, for `show` and for deciding. */
export async function status({ cfgPath, proposal, stateDir: stateOverride }) {
  if (!RUN_ID.test(String(proposal))) throw new ReconcileError("BAD_RUN", `${JSON.stringify(proposal)} is not a run id`);
  const c = await context(cfgPath);
  const stateDir = stateOverride ? resolve(stateOverride) : stateDirFor(c.root, c.cfg);
  const dir = runDir(stateDir, proposal);
  if (!existsSync(join(dir, "proposal.json"))) throw new ReconcileError("NO_PROPOSAL", `run ${proposal} holds no proposal`);
  return { c, dir, proposal: readJson(join(dir, "proposal.json")), decisions: decisionsOf(dir) };
}

function record(c, dir, p, entry) {
  appendFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify(entry)}\n`);
  events.append(c.eventsDir, {
    run: p.proposal,
    ...(p.task ? { task: p.task } : {}),
    stage: "review",
    kind: "drift",
    source: "reconcile",
    level: "info",
    detail: `${entry.decision} reconciliation ${p.proposal} (${p.direction}) by ${entry.by}${entry.reason ? `: ${entry.reason}` : ""}`.replace(/[\r\n]+/g, " "),
  });
}

/** Accept. Applies a SPEC-BEHIND diff; notes a CODE-DRIFTED one on the task. */
export async function accept({ cfgPath, proposal, by, stateDir }) {
  const { c, dir, proposal: p, decisions } = await status({ cfgPath, proposal, stateDir });
  if (decisions.length) throw new ReconcileError("DECIDED", `${proposal} was already ${decisions[0].decision} by ${decisions[0].by} at ${decisions[0].at}`);
  if (!p.valid) throw new ReconcileError("INVALID", `${proposal} is not acceptable: ${p.problems.join("; ")}`);
  const who = by ?? c.board.operator(c.cfg);
  if (p.direction === "spec-behind") {
    const patch = readFileSync(join(dir, "proposal.patch"), "utf8");
    // Checked again now: the spec may have moved since the proposal was made.
    const r = spawnSync("git", ["apply", "-"], { cwd: c.root, input: patch, encoding: "utf8" });
    if (r.status !== 0) throw new ReconcileError("STALE", `the proposal no longer applies: ${String(r.stderr).trim().split("\n")[0]}`);
  } else if (p.task) {
    c.board.mutate(c.ctx, (d) => c.board.transition(d, p.task, "note",
      `CODE DRIFTED from ${p.specs.join(", ")} (reconciliation ${p.proposal}, accepted by ${who}): ${p.reason ?? "no reason given"}. The code changes, not the spec.`));
  }
  const entry = { decision: "accepted", by: who, at: new Date().toISOString(), direction: p.direction };
  record(c, dir, p, entry);
  return { ...entry, applied: p.direction === "spec-behind" ? p.targets : [] };
}

/** Reject, with a reason. A rejection without one is an off-switch. */
export async function reject({ cfgPath, proposal, by, reason, stateDir }) {
  if (!String(reason ?? "").trim()) throw new ReconcileError("NO_REASON", "a rejection needs a reason; the record of why is the only thing that makes it a decision");
  const { c, dir, proposal: p, decisions } = await status({ cfgPath, proposal, stateDir });
  if (decisions.length) throw new ReconcileError("DECIDED", `${proposal} was already ${decisions[0].decision} by ${decisions[0].by} at ${decisions[0].at}`);
  const entry = { decision: "rejected", by: by ?? c.board.operator(c.cfg), at: new Date().toISOString(), direction: p.direction, reason: String(reason).trim() };
  record(c, dir, p, entry);
  return entry;
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set(["config", "run", "proposal", "workspace", "adapter", "cli", "model", "endpoint", "api-key-env", "max-turns", "sandbox", "image", "net", "timeout", "secret", "state-dir", "by", "reason", "harness-config"]);
  const flags = { secret: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!KNOWN.has(key)) {
      console.error(`reconcile.mjs: unknown flag --${key}`);
      process.exit(2);
    }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (key === "secret") flags.secret.push(val);
    else flags[key] = val;
  }
  const cfgPath = flags.config ?? "ops/caretaker/config.json";
  const stateDir = flags["state-dir"];
  try {
    if (cmd === "propose") {
      if (!flags.run || !flags.workspace) throw new ReconcileError("USAGE", "propose needs --run r_… and --workspace DIR");
      const workspace = resolve(flags.workspace);
      const secrets = flags.secret.length ? Object.fromEntries(requireSecrets(flags.secret, { repoRoot: workspace }).values) : {};
      const { policy } = policyFor("reconciler", loadHarnessSettings({ path: flags["harness-config"], workspace }), policyFlags(flags));
      const p = await propose({ cfgPath, run: flags.run, workspace, policy, secrets, stateDir });
      console.log(JSON.stringify(p, null, 2));
      console.error(`[reconcile] ${p.proposal}: ${p.direction ?? "no direction"} — ${p.valid ? `accept with: node bin/reconcile.mjs accept --proposal ${p.proposal}` : `not acceptable: ${p.problems.join("; ")}`}`);
      process.exit(p.valid ? 0 : 1);
    }
    if (cmd === "accept" || cmd === "reject" || cmd === "show") {
      if (!flags.proposal) throw new ReconcileError("USAGE", `${cmd} needs --proposal r_…`);
      if (cmd === "show") {
        const s = await status({ cfgPath, proposal: flags.proposal, stateDir });
        console.log(JSON.stringify({ ...s.proposal, decisions: s.decisions }, null, 2));
        process.exit(0);
      }
      const r = cmd === "accept"
        ? await accept({ cfgPath, proposal: flags.proposal, by: flags.by, stateDir })
        : await reject({ cfgPath, proposal: flags.proposal, by: flags.by, reason: flags.reason, stateDir });
      console.log(`[reconcile] ${flags.proposal} ${r.decision} by ${r.by}${r.applied?.length ? `; applied to ${r.applied.join(", ")} (not committed)` : ""}`);
      process.exit(0);
    }
    throw new ReconcileError("USAGE", "usage: reconcile.mjs propose|accept|reject|show --config C (--run r_… --workspace DIR | --proposal r_…)");
  } catch (e) {
    console.error(`[reconcile] ${e.name}: ${e.message}`);
    process.exit(2);
  }
}
