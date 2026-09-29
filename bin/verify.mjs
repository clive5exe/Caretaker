#!/usr/bin/env node
/**
 * VERIFY — H-3. A run whose job is to REFUTE another run's result, and whose
 * verdict can fail the task rather than merely comment on it.
 *
 * Every defect worth finding in the project this came from was found by one
 * agent refusing to take another's word. That only works if the refusal has
 * teeth, so a refutation is recorded where the gate reads it: a `qa fail` on
 * the task, appended like any other verdict (P-2), with the refuting run named.
 *
 * THE ASYMMETRY IS DELIBERATE. A refuter that finds a problem fails the task.
 * A refuter that finds none does NOT pass it. Failing to break something is
 * absence of evidence, and a pass recorded from it would let "an agent looked
 * and shrugged" close work that nobody verified. `stands` is logged as an event
 * and nothing more. An answer the harness cannot read is `inconclusive`, which
 * is treated as neither, never as a pass.
 *
 * The refuter runs through runstore.runArchived, so it is an ordinary archived
 * run with `parent` set to the run it examines: run detail shows the pair.
 * It reads the parent's measured diff from the archive — the patch the harness
 * measured, not the parent's account of what it did.
 *
 * The verdict line is read from the transcript as text, the same way for every
 * vendor. Anything shaped like one vendor's JSON would put that vendor above
 * the harness seam, which CLAUDE.md forbids.
 *
 * Usage:
 *   node bin/verify.mjs refute --config ops/caretaker/config.json --parent r_0a1b2c3d
 *        --workspace DIR [--cli claude|codex] [--model M] [--sandbox podman|none]
 *        [--secret NAME ...] [--state-dir DIR] [--timeout MS]
 *
 * Exit: 0 the result stands, 1 refuted (qa fail recorded), 3 inconclusive,
 *       2 misuse or nothing to refute.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as events from "./events.mjs";
import { cliLabel } from "./harness.mjs";
import { load as loadHarnessSettings, policyFlags, policyFor } from "./harness-config.mjs";
import { RUN_ID, runArchived, stateDirFor } from "./runstore.mjs";
import { requireSecrets } from "./secrets.mjs";

export class RefuteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RefuteError";
    this.code = code;
  }
}

/** The one line a refuter must end with. Case-sensitive keyword, reason optional. */
const VERDICT_LINE = /^[ \t>*`_-]*VERDICT:[ \t]*(REFUTED|STANDS)\b[ \t:—-]*(.*)$/gm;

/**
 * Read the refuter's verdict from its transcript. The LAST verdict line wins,
 * because an agent may quote the instruction before answering it. A JSON line
 * is read as the strings it holds; any other line with `\n` escapes unfolded.
 * Both are properties of JSON, not of any vendor.
 */
export function parseVerdict(text) {
  const raw = String(text ?? "");
  let last = null;
  // A transcript line that is JSON is read as the strings it holds, in order —
  // whatever the field names, so no vendor's output shape is known here. A
  // reply that IS the verdict line then starts a line, as the rule requires,
  // instead of sitting after `"content":"`.
  const texts = [];
  const walk = (v) => {
    if (typeof v === "string") texts.push(v);
    else if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  for (const line of raw.split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") {
        walk(v);
        continue;
      }
    } catch {}
    texts.push(line.replace(/\\n/g, "\n"));
  }
  for (const t of texts) {
    for (const m of t.matchAll(VERDICT_LINE)) last = m;
  }
  if (!last) return { outcome: "inconclusive", reason: "no VERDICT: REFUTED or VERDICT: STANDS line in the transcript" };
  const reason = last[2].replace(/\\"/g, '"').replace(/["}\]]+$/, "").trim();
  return { outcome: last[1] === "REFUTED" ? "refuted" : "stands", reason: reason || null };
}

/** The refuter's instructions. The acceptance criterion is the bar; the patch is the evidence. */
export function refutationPrompt({ task, parent, patch }) {
  const ac = Array.isArray(task.ac) ? task.ac.join("\n") : String(task.ac ?? "").trim();
  return [
    `You are checking someone else's work on task ${task.id}: ${task.title}.`,
    "",
    "Your job is to REFUTE it: find a concrete way in which the change below does not meet the acceptance",
    "criterion, is wrong, or breaks something. Run the code and its tests if you can. Do not fix anything;",
    "a refuter that edits the work is no longer checking it.",
    "",
    "Acceptance criterion:",
    ac || "(none recorded — say so; work with no finish line cannot be shown to meet one)",
    "",
    `The change, as measured by the harness for run ${parent.runId} (not as the builder described it):`,
    "```diff",
    patch.trim() || "(the run changed no files)",
    "```",
    "",
    "End your answer with exactly one line, either",
    "  VERDICT: REFUTED <the concrete failure, in one sentence>",
    "or",
    "  VERDICT: STANDS <what you tried that did not break it>",
  ].join("\n");
}

async function loadBoard(cfgPath) {
  const cfgAbs = resolve(cfgPath);
  const boardPath = join(dirname(cfgAbs), "board.mjs");
  if (!existsSync(boardPath)) throw new RefuteError("NO_BOARD", `no board.mjs beside ${cfgAbs}`);
  const board = await import(pathToFileURL(boardPath).href);
  if (board.API_VERSION !== 1) throw new RefuteError("OLD_BOARD", `${boardPath} predates API_VERSION 1; upgrade the installed tools`);
  return { board, ctx: board.loadConfig(cfgAbs, dirname(cfgAbs)) };
}

/**
 * Run a refuter against `parent` and act on what it says.
 *
 * Returns { outcome, reason, run, parent, task, recorded, refuterChangedFiles, warnings }.
 * `recorded` is true only when a qa fail was appended to the board.
 */
export async function refute({ cfgPath, parent, workspace, policy = {}, secrets = {}, stateDir: stateOverride, harness }) {
  if (!RUN_ID.test(String(parent))) throw new RefuteError("BAD_PARENT", `parent ${JSON.stringify(parent)} is not a run id`);
  const { board, ctx } = await loadBoard(cfgPath);
  const stateDir = stateOverride ? resolve(stateOverride) : stateDirFor(ctx.root, ctx.cfg);
  const dir = join(stateDir, "runs", parent);
  if (!existsSync(join(dir, "run.json"))) {
    throw new RefuteError("NO_PARENT", `no archived run ${parent} under ${stateDir}; only an archived run has a measured diff to check`);
  }
  const parentRec = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  if (!parentRec.task) throw new RefuteError("NO_TASK", `run ${parent} names no task, so a refutation would have nothing to fail`);
  const hit = board.find(board.load(ctx), parentRec.task);
  if (!hit) throw new RefuteError("NO_TASK", `run ${parent} names task ${parentRec.task}, which is not on the board`);
  const patch = existsSync(join(dir, "diff.patch")) ? readFileSync(join(dir, "diff.patch"), "utf8") : "";

  const warnings = [];
  // Same CLI and same model as the builder is allowed, and named. Two runs of
  // one model share its blind spots, which is most of what a refuter is for.
  // Named the way the harness names it in the verdict (cliLabel), and with the
  // adapter: the claude CLI and an API endpoint are different builders even
  // when neither names a cli.
  const who = (adapter, cli, endpoint) => ((adapter ?? "cli") === "cli" ? `cli ${cli ?? "claude"}` : `${adapter} ${endpoint ?? ""}`);
  const sameCli =
    who(policy.adapter, cliLabel(policy.cli), policy.endpoint) === who(parentRec.adapter, parentRec.cli, parentRec.policy?.endpoint);
  const sameModel = (policy.model ?? null) === (parentRec.model ?? null);
  if (sameCli && sameModel) warnings.push(`the refuter runs the same cli and model as ${parent}; they share blind spots`);

  const eventsDir = join(ctx.root, ctx.cfg.events ?? "ops/caretaker/events");
  const out = await runArchived(
    workspace,
    refutationPrompt({ task: hit.t, parent: parentRec, patch }),
    { ...policy, stage: "verify", events: policy.events ?? eventsDir },
    { stateDir, task: parentRec.task, parent, secrets, harness },
  );
  const child = out.verdict.runId;
  const transcript = readFileSync(join(out.archived, "transcript.log"), "utf8");
  let { outcome, reason } = parseVerdict(transcript);
  if (!out.verdict.ok && outcome !== "refuted") {
    // A refuter that crashed or was killed checked nothing, whatever it printed first.
    outcome = "inconclusive";
    reason = `the refuting run did not complete (${out.verdict.state}${out.verdict.reason ? `: ${out.verdict.reason}` : ""})`;
  }
  const refuterChangedFiles = out.diff?.measured ? out.diff.files.length : null;
  if (refuterChangedFiles) warnings.push(`the refuting run changed ${refuterChangedFiles} file(s) in the workspace; those are not the work under review`);

  let recorded = false;
  if (outcome === "refuted") {
    const note = `refuted by run ${child}, checking run ${parent}: ${reason ?? "no reason given"}`;
    const res = board.mutate(ctx, (d) => board.recordVerdict(d, parentRec.task, "qa", "fail", note));
    recorded = Boolean(res?.ok);
    if (!recorded) warnings.push(`the qa fail could not be recorded: ${res?.error ?? "unknown error"}`);
    try {
      board.build(ctx);
    } catch {
      /* the verdict is saved; a failed markdown rebuild must not report it was not */
    }
  }
  try {
    events.append(eventsDir, {
      run: child,
      task: parentRec.task,
      stage: "verify",
      kind: "gate",
      // `source` keeps a refutation from being read as the drift gate. A
      // verdict appears only on a refutation: `stands` is not a pass.
      source: "refute",
      level: outcome === "refuted" ? "error" : outcome === "stands" ? "info" : "warn",
      ...(outcome === "refuted" ? { verdict: "fail" } : {}),
      detail: `refutation of ${parent}: ${outcome}${reason ? ` — ${reason}` : ""}`.replace(/[\r\n]+/g, " "),
    });
  } catch (e) {
    warnings.push(`the event log was not written: ${e.message}`);
  }
  return { outcome, reason, run: child, parent, task: parentRec.task, recorded, refuterChangedFiles, warnings };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set(["config", "parent", "workspace", "adapter", "cli", "model", "endpoint", "api-key-env", "max-turns", "sandbox", "secret", "state-dir", "timeout", "image", "net", "harness-config"]);
  const flags = { secret: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!KNOWN.has(key)) {
      console.error(`verify.mjs: unknown flag --${key}`);
      process.exit(2);
    }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (key === "secret") flags.secret.push(val);
    else flags[key] = val;
  }
  if (cmd !== "refute" || !flags.parent || !flags.workspace) {
    console.error("usage: verify.mjs refute --config ops/caretaker/config.json --parent r_… --workspace DIR [--cli …] [--model …]");
    process.exit(2);
  }
  try {
    const workspace = resolve(flags.workspace);
    // Harness settings (who refutes) under this run's flags; isolation flags
    // are only ever from the command line.
    const { policy } = policyFor("refuter", loadHarnessSettings({ path: flags["harness-config"], workspace }), policyFlags(flags));
    const secrets = flags.secret.length ? Object.fromEntries(requireSecrets(flags.secret, { repoRoot: workspace }).values) : {};
    const r = await refute({
      cfgPath: flags.config ?? "ops/caretaker/config.json",
      parent: flags.parent,
      workspace,
      policy,
      secrets,
      stateDir: flags["state-dir"],
    });
    console.log(`[verify] ${r.parent} ${r.outcome}${r.reason ? `: ${r.reason}` : ""}  (refuter ${r.run}${r.recorded ? `, qa fail recorded on ${r.task}` : ""})`);
    for (const w of r.warnings) console.log(`  WARNING  ${w}`);
    process.exit(r.outcome === "stands" ? 0 : r.outcome === "refuted" ? 1 : 3);
  } catch (e) {
    console.error(`[verify] ${e.name}: ${e.message}`);
    process.exit(2);
  }
}
