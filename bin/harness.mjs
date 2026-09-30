#!/usr/bin/env node
/**
 * HARNESS — the seam. H-1.
 *
 *     run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
 *
 * Nothing above this layer may import a vendor's SDK or know a vendor's name.
 * Everything vendor-shaped lives in an ADAPTER behind that one call.
 *
 * ── the two adapters ──────────────────────────────────────────────────────
 *
 * `cli` (DEFAULT) shells out to an agent CLI, INSIDE the dev-environment
 * container unless sandbox is none. It is the default because the CLI is where
 * subscription auth lives (a Claude Pro or Max plan).
 *
 * WHAT REACHES THAT CLI, stated because the default's reason depends on it:
 * on the host (sandbox none) it is your own login. In the container, HOME is a
 * fresh tmpfs and nothing of your ~/.claude is mounted. A subscription reaches
 * it as a long-lived token from `claude setup-token`, given to the run BY NAME
 * (`--secret CLAUDE_CODE_OAUTH_TOKEN`): the name goes on podman's argv, the
 * value through its environment, never into `ps`, and the transcript is
 * redacted with it. An API key goes the same way (`--secret ANTHROPIC_API_KEY`).
 * Either way the CLI reaches the API only through the run's egress proxy
 * (`--egress api.anthropic.com`); the default network is none, which has no
 * route. runstore says so before a run that has no credential or no route
 * (credentialAdvice). The agent can read the token it runs with, as with any
 * credential a CLI uses; the allowlist is what keeps it from going elsewhere.
 *
 * `openai-compatible` makes the model call from the harness, above the
 * container, and runs the tools inside it. `sdk` is registered and NOT
 * IMPLEMENTED, and says so rather than returning a plausible empty result.
 *
 * ── what this costs, stated rather than hidden ────────────────────────────
 *
 * `docs/architecture.md` argues the harness should hook at the SDK level, and
 * gives three reasons. Two of them are given up by running a CLI in the
 * container, and pretending otherwise would be the expensive kind of comment:
 *
 *   lost   the container no longer needs egress only for what the PROJECT does
 *          — the agent's own model traffic now originates inside it, so
 *          `api.anthropic.com` (or whichever) has to be on the allowlist.
 *   lost   tool execution is the CLI's, not ours, so it cannot be placed
 *          somewhere else. The CLI spans harness and dev environment.
 *   kept   the seam. Both hook points return the same four things, which is the
 *          entire reason the seam was put at `run()` and not at an LLM
 *          interface.
 *
 * ── measured facts this file depends on ───────────────────────────────────
 *
 * Both were measured on this box on 2026-08-30 with podman 5.x, because both
 * are load-bearing and both are the kind of thing that gets assumed wrong.
 *
 *   1. `echo X | podman run --rm IMAGE sh -c cat` printed NOTHING;
 *      `echo X | podman run --rm -i IMAGE sh -c cat` printed X.
 *      So stdin needs `-i`. `sandbox.mjs` builds neither `-i` nor `-t` and its
 *      comment speaks only of the tty; the harness splices `-i` in. This
 *      matters because stdin is how the prompt gets in — see `PROMPT_VIA_STDIN`.
 *
 *   2. `podman run --rm --name N IMAGE sleep 45 &` then `kill -9` on the podman
 *      CLIENT left the container reported by `podman ps -a` as "Up 6 seconds".
 *      So `--rm` does NOT clean up after a killed client, and killing the
 *      process tree is not enough to kill the container. Hence `--name` and an
 *      explicit `rm -f` on the timeout path. `podman rm -f` then took ~10s
 *      (SIGQUIT, then SIGKILL), which is why the cleanup has its own timeout.
 *
 * Usage:
 *   node bin/harness.mjs run --workspace DIR --prompt-file F [--adapter cli]
 *                            [--cli claude|codex] [--timeout MS] [--json]
 *   node bin/harness.mjs run --workspace DIR --prompt-file F --adapter openai-compatible
 *                            --endpoint http://localhost:11434/v1 --model M
 *                            [--api-key-env VAR] [--max-turns N]
 *   node bin/harness.mjs adapters
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DEFAULT_DIR as DEFAULT_EVENTS_DIR, STAGES, append as appendEvents } from "./events.mjs";
import { buildArgs, checkLimits, delegatedControllers } from "./sandbox.mjs";
import { readDevcontainer, toLimits } from "./spec.mjs";
import { openaiCompatibleAdapter } from "./openai-compatible.mjs";
import { EnvironmentError, imageId, resolveImage } from "./environment.mjs";
import { within } from "./paths.mjs";
import { ToolsError, checkTools, claudeArgs, unreachable } from "./tools.mjs";

/**
 * The seam, as data. Exported so a test can assert the shape rather than trust
 * a comment, and so a future adapter has one place to check itself against.
 */
export const SEAM_KEYS = ["diff", "transcript", "verdict", "cost"];

/** The four states a run can end in. Nothing else is returned. */
export const VERDICT_STATES = ["completed", "failed", "killed", "unavailable"];

export class HarnessError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "HarnessError";
    Object.assign(this, fields);
  }
}

/* ------------------------------------------------------------------ policy */

/**
 * Defaults, and the reasoning for the ones that are not obvious.
 *
 * `net: "none"` is the sandbox's default and it means A REAL CLI RUN CANNOT
 * REACH ITS MODEL. That is not a bug to paper over with a friendlier default —
 * opening the network by default is exactly the failure the egress work (E-2)
 * exists to prevent. The harness runs anyway and puts the contradiction in
 * `verdict.warnings`, where it is visible, instead of choosing for you.
 */
const DEFAULTS = {
  adapter: "cli",
  cli: "claude",
  model: null,
  timeoutMs: 15 * 60 * 1000,
  graceMs: 5000,
  sandbox: "podman",
  net: "none",
  // E-5: the network an image BUILD gets. None: the Dockerfile is agent-editable
  // (environment.mjs buildArgv says why). Per run, on the command line only.
  buildNetwork: "none",
  image: null,
  devcontainer: ".devcontainer/devcontainer.json",
  logDir: null,
  billing: null,
  env: {},
  extraRunFlags: [],
  extraCliArgs: [],
  allowLogDirInWorkspace: false,
  // The event log (B-6, `bin/events.mjs`). null is its default directory;
  // false turns it off. `task` and `stage` are copied onto both events.
  events: null,
  task: null,
  stage: "build",
  // The openai-compatible adapter (H-2): the server's base URL, the NAME of an
  // environment variable holding a key (never the key), and a turn ceiling
  // so a model that never stops is a failed run, not a hung one.
  endpoint: null,
  apiKeyEnv: null,
  maxTurns: 50,
  // S-1: a HOST directory of staged skills (<name>/SKILL.md), from
  // `skills.mjs`. Mounted read-only for a CLI that reads skills, offered as a
  // tool by the openai-compatible adapter. Never copied into the workspace.
  skillsDir: null,
  // Tool control (bin/tools.mjs): which tools, your own, your yes before a
  // call, and the claude CLI's tool flags. null is the adapter's defaults.
  tools: null,
  // A library caller's function(name, args) -> { allow, always?, why? } that
  // answers `tools.approve` instead of the terminal. A function, so it is
  // never in a settings file and never in a recorded policy (JSON drops it).
  approver: null,
  // A library caller's function() -> [{ text, by? }]: the operator's messages
  // since the last call, handed to the model before each turn (bin/steer.mjs).
  steer: null,
};

/**
 * The name a run's CLI is recorded under: a preset's name, or `custom:<name>`
 * for one defined in harness settings, so the record says which program ran.
 */
export const cliLabel = (cli) =>
  cli === undefined ? DEFAULTS.cli : typeof cli === "string" ? cli : cli?.name ? `custom:${cli.name}` : "custom";

/**
 * The image a containerised run uses (E-5): policy.image, else devcontainer
 * `image`, else its `build.dockerfile` built now. Returns the id it resolved
 * to as well, so the run records the environment it actually ran in.
 */
export function imageFor(policy, dev, warnings, { exec } = {}) {
  try {
    const r = resolveImage({ image: policy.image ?? null, dev, devcontainerPath: policy.devcontainer, runtime: policy.sandbox, exec, buildNetwork: policy.buildNetwork ?? "none" });
    warnings.push(...r.warnings);
    return { image: r.image, built: r.built, imageId: imageId(r.image, { runtime: policy.sandbox, exec }) };
  } catch (e) {
    if (e instanceof EnvironmentError) throw new HarnessError(e.message, { code: e.code });
    throw e;
  }
}

const newRunId = () => `r_${randomBytes(4).toString("hex")}`;

export function normalisePolicy(policy = {}) {
  const unknown = Object.keys(policy).filter((k) => !(k in DEFAULTS) && k !== "runId");
  if (unknown.length) {
    // An ignored policy key is a policy somebody believes they set. Same
    // argument spec.mjs makes for rejecting an unknown spec field.
    throw new HarnessError(
      `unknown policy field(s): ${unknown.join(", ")}. Known: ${Object.keys(DEFAULTS).join(", ")}`,
      { unknown },
    );
  }
  const p = { ...DEFAULTS, ...policy };
  p.runId = policy.runId ?? newRunId();
  if (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) {
    throw new HarnessError(`timeoutMs must be a positive number, got ${policy.timeoutMs}`);
  }
  // Checked here, not left to the event writer: a bad stage there would only
  // turn into a warning on every run, and nobody reads warnings they expect.
  if (p.stage !== null && !STAGES.includes(p.stage)) {
    throw new HarnessError(`stage must be one of ${STAGES.join(", ")} or null, got ${JSON.stringify(p.stage)}`);
  }
  if (p.task !== null && (typeof p.task !== "string" || !p.task)) {
    throw new HarnessError(`task must be a non-empty string or null, got ${JSON.stringify(p.task)}`);
  }
  if (p.tools !== null) {
    try {
      checkTools("tools", p.tools);
    } catch (e) {
      if (e instanceof ToolsError) throw new HarnessError(e.message, { code: e.code });
      throw e;
    }
  }
  if (p.approver !== null && typeof p.approver !== "function") {
    throw new HarnessError("approver must be a function or null");
  }
  if (p.steer !== null && typeof p.steer !== "function") {
    throw new HarnessError("steer must be a function or null");
  }
  return p;
}

/* -------------------------------------------------------------- the adapters */

/**
 * Vendor CLI presets.
 *
 * FLAGS VERIFIED BY `claude --help` AND `codex exec --help` ON THIS BOX,
 * 2026-08-30. That verifies the flags exist and what they mean; it does NOT
 * verify the JSON these produce at run time, which needs a live model call.
 * See `parseUsage` for where that distinction is kept.
 *
 * `--print` / `exec` are the non-interactive modes. A TUI in a container with
 * no tty hangs rather than failing, which is the worst shape of failure here.
 */
export const CLI_PRESETS = {
  claude: {
    bin: "claude",
    /** stdin carries the prompt; `-` is not needed, --print reads stdin. */
    // stream-json, not json: json prints one result AT EXIT, so a killed run
    // left nothing for the live mirror or the decision harvest (B-5,
    // independent re-review). stream-json writes each event as it happens,
    // and ends with the same `result` event json would have printed alone.
    // --print needs --verbose to stream.
    argv: ({ model }) => [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model ? ["--model", model] : []),
    ],
    /**
     * The CLI writes its own state under $HOME. The sandbox root is read-only
     * and only /tmp and /run are writable, so HOME has to move or the CLI dies
     * on its first write with an error that reads like a permissions bug.
     */
    env: { HOME: "/tmp/agent-home" },
    /** Where this CLI reads user-level skills, given the HOME above (S-1). */
    skillsPath: "/tmp/agent-home/.claude/skills",
  },
  codex: {
    bin: "codex",
    /** `codex exec` reads instructions from stdin when no prompt argument is given. */
    argv: ({ model }) => ["codex", "exec", "--json", ...(model ? ["--model", model] : [])],
    env: { HOME: "/tmp/agent-home" },
  },
};

/**
 * THE PROMPT GOES IN ON STDIN, NEVER ON ARGV AND NEVER INTO THE WORKSPACE.
 *
 * argv is visible in `ps` and in `podman inspect`, and a prompt routinely
 * carries repository detail. Writing it to a file in the workspace is worse in
 * a different way: the diff is measured by comparing the workspace before and
 * after, so a prompt file dropped in there would show up as work the agent did.
 */
export const PROMPT_VIA_STDIN = true;

/* ------------------------------------------------------------------- argv */

/**
 * Splice extra flags into the argv `sandbox.mjs` built.
 *
 * WHY SPLICE RATHER THAN EXTEND `buildArgs`. `bin/sandbox.mjs` is not this
 * task's file. The alternative — a second, harness-local copy of the container
 * flags — is how a security control quietly forks and one copy stops getting
 * fixed. So the sandbox stays the single source of the isolation flags and the
 * harness adds only what it needs on top.
 *
 * It asserts the shape it is splicing into. If `buildArgs` ever stops putting
 * the subcommand first, this throws instead of building a command that means
 * something else.
 */
export function spliceRunFlags(args, extra) {
  if (args[0] !== "run") {
    throw new HarnessError(
      `sandbox.buildArgs no longer starts with "run" (starts with "${args[0]}"), ` +
        "so the harness cannot know where its own flags belong",
    );
  }
  return [args[0], ...extra, ...args.slice(1)];
}

/**
 * The full container argv for one CLI run. Pure, so a test can assert every
 * flag without podman, an image, a CLI or a model — the same split
 * `sandbox.test.mjs` makes, and for the same reason.
 */
export function buildContainerArgv({
  image,
  limits,
  workspace,
  net = "none",
  runtime = "podman",
  containerName,
  cliArgv,
  env = {},
  extraRunFlags = [],
}) {
  const base = buildArgs({ image, limits, workdir: workspace, net, cmd: cliArgv, runtime });
  const extra = [
    // Measured: without -i the container's stdin is empty. The prompt arrives
    // on stdin, so without this the agent is handed nothing and answers it.
    "-i",
    // Measured: --rm does not remove a container whose client was killed. A
    // name is the handle the timeout path needs to reach it.
    "--name",
    containerName,
  ];
  // NAMES ONLY. `-e NAME` makes podman take the value from its own
  // environment (execWithTimeout's `env`), so a key never sits in argv, where
  // `ps` and `podman inspect` show it to every user on the box. secrets.mjs
  // measured that leak; this path used to reproduce it.
  for (const k of Object.keys(env)) extra.push("-e", k);
  extra.push(...extraRunFlags);
  return spliceRunFlags(base, extra);
}

/* -------------------------------------------------------------------- diff */

/**
 * DIFF IS MEASURED, NEVER REPORTED.
 *
 * An agent's account of what it changed is a claim by the thing under test. It
 * is wrong in both directions in practice — files touched and not mentioned,
 * files mentioned and not touched — and the second kind reads as success.
 *
 * The mechanism is a SHADOW GIT DIRECTORY outside the workspace: index the
 * workspace into it before the run, again after, and diff the two trees. Three
 * properties come from that choice, all of which the obvious alternatives lack:
 *
 *   - The workspace's own `.git` is never touched. No stash, no commit, no
 *     index write, so a run cannot destroy uncommitted work, and a concurrent
 *     `git status` in that workspace is unaffected.
 *   - PRE-EXISTING DIRTY STATE IS NOT ATTRIBUTED TO THE AGENT. The delta is
 *     between two snapshots, so a file that was already modified and that the
 *     agent never touched does not appear. Diffing against HEAD would report it.
 *   - A workspace that is not a git repository at all still works.
 *
 * WHAT IT DOES NOT SEE, stated because a measurement's blind spot is part of
 * the measurement: anything matched by the workspace's `.gitignore` is not
 * indexed, so a change under an ignored path is invisible here. That is
 * deliberate — indexing `node_modules` on every run is not viable — and it is
 * why `diff.ignoredPathsNotMeasured` is a field on the result rather than a
 * remark in this comment.
 */
function git(gitDir, workspace, args, opts = {}) {
  return spawnSync("git", ["--git-dir", gitDir, "--work-tree", workspace, ...args], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

export function openShadow(shadowRoot, workspace) {
  mkdirSync(shadowRoot, { recursive: true });
  const init = spawnSync("git", ["init", "-q", shadowRoot], { encoding: "utf8" });
  if (init.error || init.status !== 0) {
    return { ok: false, gitDir: null, reason: `git init failed: ${init.error?.message ?? init.stderr?.trim()}` };
  }
  return { ok: true, gitDir: join(shadowRoot, ".git"), workspace };
}

export function snapshot(shadow) {
  if (!shadow.ok) return { ok: false, tree: null, reason: shadow.reason };
  const add = git(shadow.gitDir, shadow.workspace, ["add", "-A"]);
  if (add.status !== 0) {
    return { ok: false, tree: null, reason: `git add -A failed: ${add.stderr?.trim() || add.error?.message}` };
  }
  const tree = spawnSync("git", ["--git-dir", shadow.gitDir, "write-tree"], { encoding: "utf8" });
  if (tree.status !== 0) {
    return { ok: false, tree: null, reason: `git write-tree failed: ${tree.stderr?.trim()}` };
  }
  return { ok: true, tree: tree.stdout.trim(), reason: null };
}

const PATCH_CAP = 2 * 1024 * 1024;

export function measureDiff(shadow, before, after) {
  const unmeasured = (reason) => ({
    measured: false,
    method: "shadow-git",
    reason,
    before: before?.tree ?? null,
    after: after?.tree ?? null,
    files: [],
    filesChanged: null,
    insertions: null,
    deletions: null,
    patch: null,
    patchBytes: null,
    truncated: false,
    ignoredPathsNotMeasured: true,
  });
  if (!before?.ok) return unmeasured(`the pre-run snapshot failed: ${before?.reason ?? "not taken"}`);
  if (!after?.ok) return unmeasured(`the post-run snapshot failed: ${after?.reason ?? "not taken"}`);

  const numstat = spawnSync(
    "git",
    ["--git-dir", shadow.gitDir, "diff", "--numstat", "--find-renames", before.tree, after.tree],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (numstat.status !== 0) return unmeasured(`git diff --numstat failed: ${numstat.stderr?.trim()}`);

  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    // "-" is git's marker for a binary file: it has no line counts, and
    // reporting 0 would read as "changed nothing".
    const added = a === "-" ? null : Number(a);
    const removed = d === "-" ? null : Number(d);
    if (added !== null) insertions += added;
    if (removed !== null) deletions += removed;
    files.push({ path, added, deleted: removed, binary: a === "-" });
  }

  const patchRun = spawnSync(
    "git",
    ["--git-dir", shadow.gitDir, "diff", "--find-renames", before.tree, after.tree],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const full = patchRun.status === 0 ? patchRun.stdout : "";
  const truncated = full.length > PATCH_CAP;

  return {
    measured: true,
    method: "shadow-git",
    reason: null,
    before: before.tree,
    after: after.tree,
    files,
    filesChanged: files.length,
    insertions,
    deletions,
    patch: truncated ? full.slice(0, PATCH_CAP) : full,
    patchBytes: Buffer.byteLength(full),
    truncated,
    // Not a caveat in prose: a caller deciding whether the run "did nothing"
    // needs to know this measurement has a blind spot.
    ignoredPathsNotMeasured: true,
  };
}

/* -------------------------------------------------------------------- cost */

/**
 * NULL IS NOT ZERO, and this is the whole reason cost is a structure rather
 * than a number.
 *
 * Two runs can both cost no money and mean opposite things. A subscription run
 * and a self-hosted run spend real tokens as EFFORT with no marginal charge; a
 * run whose CLI told us nothing spent an unknown amount. Folding both to `0`
 * loses the only fact that distinguishes "this was cheap" from "we are not
 * measuring". So every field starts null and is only filled from something that
 * was actually read.
 *
 * `money` is always null, deliberately. `docs/vendors.md`: record tokens and
 * let money be a projection, because the token-to-money rate is per-deployment
 * — a hosted API bills per token, a self-hosted model has a GPU bill and no
 * per-token price at all.
 */
export function emptyCost(billing = null) {
  return {
    tokens: { in: null, cached: null, write: null, out: null, total: null },
    turns: null,
    reported: false,
    source: "none",
    billing,
    money: null,
    note: "the CLI reported no usage; null means unknown, which is not the same as zero",
  };
}

/**
 * Key names to look for. These are the names the two CLIs' JSON modes use.
 *
 * THIS LIST IS NOT CLAIMED TO BE EXHAUSTIVE and is not claimed to be verified
 * against a live run — verifying the run-time shape costs a model call, which
 * no test here makes. The fixtures in `harness.test.mjs` pin the PARSER against
 * objects of this shape, which proves the parser and says nothing about the
 * CLI. If a CLI's shape differs, the parser finds nothing and cost stays null,
 * which is the safe direction: unknown, not fabricated.
 */
const USAGE_KEYS = {
  in: ["input_tokens", "prompt_tokens", "inputTokens"],
  cached: ["cache_read_input_tokens", "cached_input_tokens", "cache_read_tokens"],
  write: ["cache_creation_input_tokens", "cache_write_tokens", "cache_creation_tokens"],
  out: ["output_tokens", "completion_tokens", "outputTokens"],
};
const TURN_KEYS = ["num_turns", "turns", "turn_count"];

/** Every JSON value the text holds: the whole thing, or one object per line. */
function jsonCandidates(text) {
  const out = [];
  const whole = text.trim();
  if (whole) {
    try {
      out.push(JSON.parse(whole));
    } catch {
      /* not a single document; try line by line */
    }
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a partial final line is normal in a file something is appending to */
    }
  }
  return out;
}

/**
 * The agent's OWN final message, from a CLI's JSON output, or null when the
 * output has no shape this knows. Read here, in the harness, because it is
 * vendor shape: claude prints `{"type":"result","result":"..."}`; codex
 * `--json` ends with an `agent_message` item. Anything the agent merely READ
 * (a file, a tool's output) is not in it, which is the point: a verdict or a
 * decision an agent quotes from the work it is checking is not its own.
 */
export function finalTextOf(transcriptText) {
  const docs = jsonCandidates(String(transcriptText ?? ""));
  for (let i = docs.length - 1; i >= 0; i--) {
    const d = docs[i];
    if (typeof d?.result === "string") return d.result;
    if (d?.item?.type === "agent_message" && typeof d.item.text === "string") return d.item.text;
  }
  return null;
}

/**
 * The agent's OWN words from a transcript, in order: what the model wrote,
 * never what a tool returned or a file held. Harvested decisions, a refuter's
 * VERDICT and a reconciler's DIRECTION are the agent's statements; a line it
 * merely READ is not (independent re-review, B-5: a Bash tool's output holding
 * "DECISION: disable the egress proxy" was harvested as the agent's decision).
 *
 * Read here, in the harness, because it is vendor shape:
 *   claude stream-json   "assistant" message text parts, and the "result"
 *                        ("user" events carry tool results: skipped)
 *   codex exec --json    an item of type "agent_message"
 *                        (command_execution and other items: skipped)
 *   openai-compatible    "assistant" content ("tool", "approval", "steer": skipped)
 * A JSON line of no known shape (a custom CLI's) is read as every string it
 * holds, as before: its tool output cannot be told apart, and dropping it
 * would lose what that agent said. Plain lines are kept, consecutive ones as
 * one text.
 */
export function agentTexts(raw) {
  const texts = [];
  let plain = [];
  const flush = () => {
    if (plain.length) texts.push(plain.join("\n"));
    plain = [];
  };
  const walk = (v) => {
    if (typeof v === "string") texts.push(v);
    else if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  // "steer" is the operator's own message: never the agent's statement.
  const NOT_THE_AGENT = new Set(["user", "system", "tool", "approval", "steer"]);
  for (const line of String(raw ?? "").split("\n")) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      v = undefined;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      plain.push(line.replace(/\\n/g, "\n"));
      continue;
    }
    flush();
    if (v.type === "assistant") {
      const c = v.message?.content ?? v.content;
      if (typeof c === "string") texts.push(c);
      else if (Array.isArray(c)) for (const part of c) if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    } else if (v.type === "result") {
      if (typeof v.result === "string") texts.push(v.result);
    } else if (v.item && typeof v.item === "object") {
      if (v.item.type === "agent_message" && typeof v.item.text === "string") texts.push(v.item.text);
    } else if (!NOT_THE_AGENT.has(v.type)) walk(v);
  }
  flush();
  return texts;
}

/** Deep search for the first numeric value under any of `names`. */
function findNumber(node, names, depth = 0) {
  if (node === null || typeof node !== "object" || depth > 6) return null;
  for (const n of names) {
    if (typeof node[n] === "number") return node[n];
  }
  for (const v of Object.values(node)) {
    const hit = findNumber(v, names, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export function parseUsage(transcriptText, { billing = null, source = "transcript-json" } = {}) {
  const cost = emptyCost(billing);
  // A streamed transcript carries usage per message as well as the run's
  // total on its final `result` event: the result is read first, so a
  // message's own usage is never taken for the run's.
  const all = jsonCandidates(transcriptText ?? "");
  const docs = [...all.filter((d) => d?.type === "result").reverse(), ...all.filter((d) => d?.type !== "result")];
  if (!docs.length) return cost;

  let found = false;
  for (const [field, names] of Object.entries(USAGE_KEYS)) {
    for (const doc of docs) {
      const n = findNumber(doc, names);
      if (n !== null) {
        cost.tokens[field] = n;
        found = true;
        break;
      }
    }
  }
  for (const doc of docs) {
    const t = findNumber(doc, TURN_KEYS);
    if (t !== null) {
      cost.turns = t;
      found = true;
      break;
    }
  }

  if (!found) return cost;

  /*
   * The total is DERIVED from the parts that were found, never read from a
   * `total_tokens` field alongside them. run.mjs makes the same call for the
   * same reason: two numbers that should agree and are stored separately
   * disagree eventually, and the reader believes whichever they saw first.
   * A part that was not reported stays null and is not counted as zero.
   */
  const parts = Object.values(cost.tokens).filter((v) => typeof v === "number");
  cost.tokens.total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  cost.reported = true;
  cost.source = source;
  cost.note =
    "tokens read from the CLI's JSON output; a null field is one the CLI did not report. " +
    "total is the sum of the reported parts only.";
  return cost;
}

/* ------------------------------------------------------- process execution */

/**
 * Run a process with a WALL-CLOCK CEILING and no path to the terminal.
 *
 * `detached: true` puts the child in its own process group, which is what makes
 * `kill(-pid)` reach the whole tree. Without it, killing the podman client
 * leaves whatever it spawned, and a run that hangs holds its lock forever.
 *
 * stdout and stderr go to files. Two writers on one terminal produce shredded
 * output, and the TUI's job is to tail the file — so nothing here writes the
 * agent's bytes to this process's stdout.
 */
function execWithTimeout({ file, args, cwd, env, stdinData, stdoutPath, stderrPath, timeoutMs, graceMs, onKill }) {
  return new Promise((res) => {
    const startedAt = Date.now();
    /*
     * SETTLE EXACTLY ONCE, and settle on `error` as well as on `close`. Whether
     * node emits `close` after a failed spawn is a detail of the failure mode,
     * and a promise that waits for an event that never arrives is the same hang
     * the timeout exists to prevent — one layer up, where no timer is watching.
     */
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      res(v);
    };
    let child;
    try {
      child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : undefined, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      return finish({ spawnError: e, exitCode: null, signal: null, killed: false, durationMs: 0, startedAt });
    }

    const outStream = createWriteStream(stdoutPath, { flags: "a" });
    const errStream = createWriteStream(stderrPath, { flags: "a" });
    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);
    /*
     * WAIT FOR THE LOG TO FLUSH BEFORE SETTLING. `close` on the child says the
     * process is gone, not that its last bytes have reached the file, and the
     * caller reads the transcript the instant this resolves. Caught by the
     * "the boast is still in the transcript" assertion going red on a short
     * run while the same assertion passed on a longer one — a race that would
     * have read as a flaky test rather than as truncated evidence.
     */
    const flushed = Promise.all(
      [outStream, errStream].map(
        (st) => new Promise((r) => st.on("finish", r).on("error", r)),
      ),
    );

    if (stdinData !== undefined && stdinData !== null) {
      child.stdin.on("error", () => {
        /* the child can exit before reading; EPIPE here is not the run's failure */
      });
      child.stdin.end(stdinData);
    } else {
      child.stdin.end();
    }

    let killed = false;
    let killReason = null;
    let hardTimer = null;

    const killTree = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // The group is already gone. Fall back to the single pid so a partial
        // teardown still tries.
        try {
          process.kill(child.pid, sig);
        } catch {
          /* already reaped */
        }
      }
    };

    let finalTimer = null;

    /*
     * TWO CONTROLS, AND THE MEASURED 60s HANG WAS THE FIRST ONE MISSING.
     *
     * `close` fires when the child has exited AND its stdio pipes are closed.
     * Every descendant inherits those pipes, so any descendant still alive
     * holds `close` back for as long as it lives.
     *
     * 1. THE GROUP KILL (`killTree` signals `-child.pid`). Before d502820 it
     *    signalled `child.pid` alone: the fixture's shell died and its two
     *    `sleep 60`s kept the pipes open, so an 800ms ceiling returned after
     *    60112ms. That was recorded as a 2-in-5 flake; it is deterministic.
     *    `git show d502820^:bin/harness.mjs` run against the current
     *    harness.test.mjs fails "returns near the ceiling" 3 runs in 3
     *    (60037, 60043, 60038ms). Mutating only this line on the current file
     *    fails "THE WHOLE PROCESS TREE IS DEAD".
     *
     * 2. THE BOUNDED SETTLE (`finalTimer` below). A descendant that calls
     *    `setsid` leaves the group, so no group kill reaches it and `close`
     *    waits out its sleep. After SIGKILL the result settles on a timer
     *    whatever the pipes are doing, with the exit code reported as unknown
     *    and the verdict as `killed`. Mutating `done(null, "SIGKILL")` out
     *    fails "a descendant that ESCAPED the process group cannot hold the
     *    result hostage"; before that test existed, the same mutant passed
     *    the whole suite.
     */
    const softTimer = setTimeout(() => {
      killed = true;
      killReason = "timeout";
      killTree("SIGTERM");
      hardTimer = setTimeout(() => {
        killTree("SIGKILL");
        finalTimer = setTimeout(() => {
          // Stop reading from pipes a dead process's children may still hold,
          // then settle. `done` is idempotent via `finish`, so a late `close`
          // that does arrive changes nothing.
          try {
            child.stdout?.unpipe(outStream);
            child.stderr?.unpipe(errStream);
          } catch {
            /* already torn down */
          }
          done(null, "SIGKILL");
        }, graceMs);
      }, graceMs);
      // The container outlives the client — measured, see the header. Killing
      // the tree is necessary and NOT sufficient.
      if (onKill) onKill();
    }, timeoutMs);

    let spawnError = null;
    const done = (code, signal) => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (finalTimer) clearTimeout(finalTimer);
      outStream.end();
      errStream.end();
      flushed.then(() =>
        finish({
          spawnError,
          exitCode: code,
          signal,
          killed,
          killReason,
          durationMs: Date.now() - startedAt,
          startedAt,
        }),
      );
    };

    child.on("error", (e) => {
      spawnError = e;
      // If the process never existed there is nothing to wait for.
      if (child.pid === undefined) done(null, null);
    });

    child.on("close", done);
  });
}

/* ---------------------------------------------------------------- adapters */

/** Remove a named container. Best effort, bounded, and the outcome is recorded. */
function removeContainer(runtime, name) {
  if (!name) return { attempted: false, removed: false };
  // Measured: `podman rm -f` sent SIGQUIT, waited 10s, then SIGKILL. A cleanup
  // that can itself hang is a second hang, so it gets its own ceiling.
  const r = spawnSync(runtime, ["rm", "-f", "-t", "2", name], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { attempted: true, removed: r.status === 0, detail: r.status === 0 ? null : (r.stderr ?? "").trim() };
}

/**
 * Exit 127 means the shell could not find the command. Inside a container that
 * means the CLI is not in the image; on the host it means it is not installed.
 * Either way it is UNAVAILABLE, not FAILED — a caller that cannot tell those
 * apart will read a missing binary as the model declining the work.
 */
const LAUNCH_FAILURE_EXITS = new Set([125, 126, 127]);
function looksUnavailable(exitCode, stderrText) {
  if (exitCode === 127) return true;
  // THE STDERR TEXT IS ONLY CONSULTED ON THE LAUNCH-FAILURE EXIT CODES. podman
  // uses 125 for its own errors, 126 for "not executable", 127 for "not found".
  // Matching that phrasing on ANY exit code would file a real run that died on
  // a missing project file as "the CLI is missing" — the same conflation this
  // function exists to prevent, pointing the other way.
  if (!LAUNCH_FAILURE_EXITS.has(exitCode)) return false;
  return /executable file not found|command not found|not executable|no such file or directory/i.test(
    stderrText ?? "",
  );
}

/**
 * The read-only mount that hands a CLI its skills (S-1), or nothing. A preset
 * that names no skills location gets a warning rather than a guessed path: a
 * mount the CLI never reads would look like skills were given when they were not.
 */
export function skillsMount(policy, preset, warnings) {
  if (!policy.skillsDir) return [];
  if (!preset.skillsPath) {
    warnings.push(`skills were staged but NOT attached: the ${cliLabel(policy.cli)} CLI has no known skills location`);
    return [];
  }
  return ["-v", `${resolve(policy.skillsDir)}:${preset.skillsPath}:ro,Z`];
}

/**
 * The CLI flags and environment `tools.claude` asks for. bypassPermissions
 * lets claude act without asking: in the container the container is the
 * boundary, and the CLI needs IS_SANDBOX=1 to accept the mode as root; on the
 * HOST there is no boundary at all, so it is refused.
 */
export function cliToolSetup(policy, cliName) {
  if (cliName !== "claude") return { toolArgs: [], toolEnv: {} };
  const bypass = policy.tools?.claude?.permissionMode === "bypassPermissions";
  if (bypass && policy.sandbox === "none") {
    throw new HarnessError('tools.claude.permissionMode "bypassPermissions" is refused with sandbox:none: on the host it would let the agent act on this machine without asking. Use it in the container, or choose acceptEdits');
  }
  return { toolArgs: claudeArgs(policy.tools), toolEnv: bypass ? { IS_SANDBOX: "1" } : {} };
}

async function cliAdapter({ workspace, prompt, policy, paths, warnings }) {
  const preset =
    typeof policy.cli === "string"
      ? CLI_PRESETS[policy.cli]
      : policy.cli && typeof policy.cli === "object"
        ? policy.cli
        : null;
  if (!preset) {
    throw new HarnessError(
      `unknown cli "${policy.cli}" — available: ${Object.keys(CLI_PRESETS).join(", ")}`,
      { cli: policy.cli },
    );
  }
  // tools.claude reaches the built-in claude preset only; anything else in
  // `tools` is named as not applied rather than silently dropped.
  const cliName = cliLabel(policy.cli);
  warnings.push(...unreachable(policy.tools, "cli", cliName));
  if (policy.steer) warnings.push(`steering NOT applied: the ${cliName} CLI runs its own loop, so messages sent to this run are not delivered`);
  const { toolArgs, toolEnv } = cliToolSetup(policy, cliName);
  const cliArgv = [
    ...(typeof preset.argv === "function" ? preset.argv({ model: policy.model }) : preset.argv),
    ...policy.extraCliArgs,
    ...toolArgs,
  ];
  const env = { ...(preset.env ?? {}), ...toolEnv, ...policy.env };

  const containerName = `caretaker-${policy.runId}`;
  let file;
  let args;
  let container = null;

  if (policy.sandbox === "none") {
    /*
     * NO CONTAINER. This exists so the seam is testable without podman, an
     * image or a model, and it is a real escape hatch for a box that has no
     * container runtime. It also means the agent runs on the host with the
     * host's filesystem and the host's network, which is everything layer 1
     * was built to prevent, so it is never the default and it always warns.
     */
    warnings.push(
      "sandbox:none — the CLI ran on the HOST, not in a container. No filesystem " +
        "isolation, no resource ceiling and no egress control applied to this run.",
    );
    if (policy.skillsDir) {
      // On the host the CLI reads the operator's own skills directory; there is
      // nowhere to mount these without writing into it, so they are not given.
      warnings.push("skills were staged but NOT attached: with sandbox:none there is no container to mount them into");
    }
    file = cliArgv[0];
    args = cliArgv.slice(1);
  } else {
    const dev = readDevcontainer(policy.devcontainer);
    const limits = toLimits(dev);
    const { image, imageId, built } = imageFor(policy, dev, warnings);
    if (policy.net === "none") {
      warnings.push(
        "net:none — the container has no route off the host, so a real agent CLI cannot " +
          "reach its model API. Point --net at an internal podman network with the egress " +
          "proxy on it (E-2), or this run can only fail.",
      );
    }
    /*
     * THE CGROUP PREFLIGHT HAS TO HAPPEN HERE TOO.
     *
     * `sandbox.mjs` refuses to pass a limit the kernel cannot enforce — but
     * that check lives inside its CLI entry block, so it does not exist for a
     * programmatic caller of `buildArgs`. Measured on this box:
     * `delegatedControllers()` returns `memory pids`, no `cpu`, so a harness
     * that skipped this would emit `--cpus 2` and the run would die with an
     * OCI error about a controller that is not available — which reads like a
     * podman bug and is not.
     *
     * DROPPING A LIMIT IS NOT FREE, and it is recorded rather than swallowed:
     * a ceiling you believe in and do not have is worse than none, so it goes
     * into verdict.warnings where the caller sees it.
     */
    const missing = checkLimits(["memory", "cpus", "pids"], delegatedControllers().controllers);
    for (const m of missing) {
      limits[m.limit] = null;
      warnings.push(
        `not limiting ${m.limit} — this user has no "${m.controller}" cgroup controller ` +
          "delegated, so the flag is omitted rather than passed and refused. This run is " +
          `NOT bounded on ${m.limit}.`,
      );
    }
    args = buildContainerArgv({
      image,
      limits,
      workspace,
      net: policy.net,
      runtime: policy.sandbox,
      containerName,
      cliArgv,
      env,
      extraRunFlags: [...policy.extraRunFlags, ...skillsMount(policy, preset, warnings)],
    });
    file = policy.sandbox;
    container = { runtime: policy.sandbox, name: containerName, image, imageId, built };
  }

  const exec = await execWithTimeout({
    file,
    args,
    // In container mode podman sets the working directory (-w /work). In
    // sandbox:none there is nothing to do it, and a CLI started in the wrong
    // directory edits the wrong repository.
    cwd: policy.sandbox === "none" ? workspace : undefined,
    // Values reach the container through podman's own environment (the argv
    // carries names only). On the host, only the run's own env applies: the
    // preset's HOME is the container's, and would lose the host CLI its login.
    env: policy.sandbox === "none" ? policy.env : env,
    stdinData: PROMPT_VIA_STDIN ? prompt : undefined,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    timeoutMs: policy.timeoutMs,
    graceMs: policy.graceMs,
    onKill: container ? () => removeContainer(container.runtime, container.name) : undefined,
  });

  // Cleanup runs on every non-clean exit, not only on the timeout: a container
  // whose client crashed is in exactly the state the kill probe measured.
  if (container && (exec.killed || exec.exitCode !== 0 || exec.spawnError)) {
    container.cleanup = removeContainer(container.runtime, container.name);
  }

  return { exec, container, cliArgv, argv: args, file, env };
}

/**
 * SDK ADAPTER — NOT IMPLEMENTED, and it says so instead of returning something
 * that looks like a run.
 *
 * A stub that returned an empty diff and a zero cost would be indistinguishable
 * from a real run that did nothing, which is a worse outcome than an error: the
 * caller records a completed run, the board moves, and no model was ever
 * called. So this throws.
 *
 * What is missing, rather than "TODO": no vendor SDK is a dependency of this
 * repo, and adding one here is the decision H-10 exists to make deliberately
 * rather than as a side effect. The API-key half now exists (runstore hands a
 * run the secrets it names as environment variables, by name, never in argv
 * or the archive), and the openai-compatible adapter already makes model calls
 * from the harness with its tools routed into the container, which is what an
 * sdk adapter would need to reuse.
 */
async function sdkAdapter() {
  throw new HarnessError(
    "adapter \"sdk\" is not implemented. It is registered so it fails by name rather than " +
      "silently falling back to cli. For an API model use adapter \"openai-compatible\".",
    { adapter: "sdk", implemented: false },
  );
}

export const ADAPTERS = {
  cli: cliAdapter,
  sdk: sdkAdapter,
  "openai-compatible": (args) => {
    args.warnings.push(...unreachable(args.policy.tools, "openai-compatible", null));
    return openaiCompatibleAdapter({ ...args, HarnessError, imageFor });
  },
};

/** Which adapters exist, for an error message and for the CLI. */
export const adapterNames = () => Object.keys(ADAPTERS);

/* --------------------------------------------------------------- the seam */

function ensureLogDir(policy, workspace) {
  const dir = policy.logDir
    ? resolve(policy.logDir)
    : join(tmpdir(), "caretaker-runs", policy.runId);
  if (within(dir, workspace) && !policy.allowLogDirInWorkspace) {
    /*
     * REFUSED, not warned. The transcript is written while the run is in
     * flight, so a log inside the workspace lands between the two snapshots and
     * is measured as work the agent did. That corrupts the one number this
     * layer exists to produce, and it corrupts it in the direction that looks
     * like success.
     */
    throw new HarnessError(
      `logDir ${dir} is inside the workspace ${workspace}. The transcript is written during ` +
        "the run, so it would be measured as part of the diff. Put it elsewhere, or set " +
        "allowLogDirInWorkspace if you have a reason and accept the contamination.",
      { logDir: dir, workspace },
    );
  }
  // PRIVATE TO THIS USER. The raw transcript (unredacted) and the shadow copy
  // of the workspace live here; under a shared /tmp at the default umask every
  // user on the box could read both (independent review).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const readIfExists = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/**
 * THE SEAM.
 *
 * @param {string} workspace absolute path to the repository the agent works on
 * @param {string} prompt    what to ask it
 * @param {object} policy    see DEFAULTS
 * @returns {Promise<{diff:object, transcript:object, verdict:object, cost:object}>}
 *
 * `verdict` here is the RUN's outcome — did it finish, was it killed, was the
 * CLI even there. It is NOT a judgment on the quality of the work. Those are
 * different questions and conflating them costs you the ability to tell a hung
 * run from a bad answer, which are the two failures that look most alike from
 * above.
 */
export async function run(workspace, prompt, policy = {}) {
  const p = normalisePolicy(policy);
  const ws = resolve(workspace);
  if (!existsSync(ws) || !statSync(ws).isDirectory()) {
    throw new HarnessError(`workspace ${ws} is not a directory`, { workspace: ws });
  }
  const adapter = ADAPTERS[p.adapter];
  if (!adapter) {
    // Fails BY NAME. A harness that fell back to the default here would run a
    // different vendor than the caller asked for and report success.
    throw new HarnessError(
      `unknown adapter "${p.adapter}" — available: ${adapterNames().join(", ")}`,
      { adapter: p.adapter, available: adapterNames() },
    );
  }

  const logDir = ensureLogDir(p, ws);
  const paths = {
    stdout: join(logDir, "transcript.log"),
    stderr: join(logDir, "stderr.log"),
  };
  const warnings = [];

  /*
   * THE RUN'S TWO EVENTS, placed around the snapshots on purpose. `start` is
   * written BEFORE the first snapshot and `end` AFTER the second, so if the
   * event directory is inside the workspace neither line lands between them
   * and neither is measured as the agent's work. `start` is what makes a run
   * whose harness process died visible at all: a start with no end.
   *
   * A log that cannot be written does not fail the run. The run happened, and
   * losing its result over a full disk would be the worse outcome, so the
   * failure goes into verdict.warnings where the caller sees it.
   */
  const eventBase = {
    run: p.runId,
    ...(p.task ? { task: p.task } : {}),
    ...(p.stage ? { stage: p.stage } : {}),
    kind: "agent",
  };
  const logEvent = (ev) => {
    if (p.events === false) return;
    try {
      appendEvents(p.events ?? DEFAULT_EVENTS_DIR, { ...eventBase, ...ev });
    } catch (e) {
      warnings.push(`the event log was not written (${e.message}); this run has no ${ev.phase} event`);
    }
  };
  logEvent({
    phase: "start",
    level: "info",
    detail: `run started: adapter ${p.adapter}, cli ${cliLabel(p.cli)}, sandbox ${p.sandbox}, ceiling ${p.timeoutMs}ms`,
  });

  // Snapshot BEFORE anything runs. Everything after this point is the delta.
  const shadow = openShadow(join(logDir, "shadow"), ws);
  const before = snapshot(shadow);

  const startedAt = new Date().toISOString();
  /*
   * No try/finally here, and that is deliberate rather than an omission. An
   * earlier version wrapped this in one with the comment "the diff is measured
   * whether the run finished, failed or was killed" — which was FALSE: the
   * finally block did nothing, and a throwing adapter skipped the snapshot
   * anyway. The property is real and comes from somewhere else: a run that
   * failed or was killed is an OUTCOME, so the adapter returns normally and the
   * snapshot below covers it. The adapter throws only when nothing ran at all
   * (an unknown CLI, no image), and then there is no diff to report.
   */
  // A workspace with no .git has nothing to mount read-only (sandbox.mjs), so
  // an agent could create one; git on this host would then run its hooks and
  // config. The shadow diff never sees a .git, so it is checked for here.
  const hadGit = existsSync(join(ws, ".git"));
  let result;
  try {
    result = await adapter({ workspace: ws, prompt, policy: p, paths, warnings });
  } catch (e) {
    // The adapter throws only when nothing ran (see above). Without this line
    // the log would hold a start with no end, which reads as a dead harness.
    logEvent({ phase: "end", level: "error", state: "not-started", detail: `run did not start: ${e.message}`.replace(/[\r\n]+/g, " ") });
    throw e;
  }

  const after = snapshot(shadow);
  const diff = measureDiff(shadow, before, after);
  if (!hadGit && existsSync(join(ws, ".git"))) {
    warnings.push(
      `the run CREATED ${join(ws, ".git")} in a workspace that had none. Git on this host runs a repository's hooks and ` +
        "config, so do not run git there until you have looked at it or deleted it; it is not in the measured diff",
    );
  }

  const stdoutText = readIfExists(paths.stdout);
  const stderrText = readIfExists(paths.stderr);
  const { exec, container } = result;

  let state;
  let reason;
  if (exec.spawnError) {
    state = "unavailable";
    reason = `could not start ${result.file}: ${exec.spawnError.code ?? exec.spawnError.message}`;
  } else if (exec.killed) {
    // NEVER "completed". A killed run that reports completion is the specific
    // lie this field exists to prevent.
    state = "killed";
    reason = `killed after the ${p.timeoutMs}ms wall-clock ceiling (${exec.killReason})`;
  } else if (looksUnavailable(exec.exitCode, stderrText)) {
    state = "unavailable";
    reason = `the agent CLI was not found (exit ${exec.exitCode}); it is not on PATH ${
      container ? `inside the image ${container.image}` : "on this host"
    }`;
  } else if (exec.exitCode === 0) {
    state = "completed";
    reason = null;
  } else {
    state = "failed";
    reason = `exited ${exec.exitCode}${exec.signal ? ` on ${exec.signal}` : ""}`;
  }

  const verdict = {
    state,
    ok: state === "completed",
    reason,
    exitCode: exec.exitCode,
    signal: exec.signal ?? null,
    killed: Boolean(exec.killed),
    killedBy: exec.killReason ?? null,
    timeoutMs: p.timeoutMs,
    durationMs: exec.durationMs,
    startedAt,
    endedAt: new Date().toISOString(),
    adapter: p.adapter,
    // Only the cli adapter runs a CLI. Naming the default ("claude") on a run
    // that went through another adapter would record a vendor that never ran.
    cli: p.adapter === "cli" ? cliLabel(p.cli) : null,
    runId: p.runId,
    container: container
      ? { runtime: container.runtime, name: container.name, image: container.image, imageId: container.imageId ?? null, built: container.built ?? false, cleanup: container.cleanup ?? null }
      : null,
    warnings,
    // Only adapters that drive the tool loop themselves can score it; for a
    // CLI the loop is inside the vendor's binary and this stays absent.
    ...(result.toolUse ? { toolUse: result.toolUse } : {}),
    // The agent's own final message (see finalTextOf), or null when the
    // adapter's output has no known shape. Capped: it is for reading a
    // declared last line, not for holding the transcript twice.
    finalText: ((f) => (f === null ? null : f.slice(-8000)))(result.finalText !== undefined ? result.finalText : p.adapter === "cli" ? finalTextOf(stdoutText) : null),
  };

  const cost = parseUsage(stdoutText, {
    billing: p.billing,
    source: verdict.cli ? `${verdict.cli}-json` : `${p.adapter}-usage`,
  });
  if (!cost.reported) {
    cost.note =
      `${verdict.cli ?? p.adapter} reported no usage in its output; null means unknown, not zero. ` +
      "The run still spent tokens as effort.";
  }

  const transcript = {
    path: paths.stdout,
    stderrPath: paths.stderr,
    bytes: Buffer.byteLength(stdoutText),
    lines: stdoutText ? stdoutText.split("\n").length : 0,
    // A tail, not the body. The transcript can be megabytes and the caller has
    // the path; inlining it is how a log ends up in an event log.
    tail: stdoutText.slice(-4000),
    stderrTail: stderrText.slice(-4000),
  };

  logEvent({
    phase: "end",
    level: state === "completed" ? "info" : state === "killed" ? "warn" : "error",
    state,
    tokens: Number.isInteger(cost.tokens.total) ? cost.tokens.total : null,
    files: diff.measured ? diff.files.length : null,
    durationMs: exec.durationMs,
    detail: `run ${state}${reason ? `: ${reason}` : ""}`.replace(/[\r\n]+/g, " "),
  });

  return { diff, transcript, verdict, cost };
}

/* --------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const eq = argv[i].indexOf("=");
    const key = eq === -1 ? argv[i].slice(2) : argv[i].slice(2, eq);
    const val = eq === -1 ? (argv[i + 1]?.startsWith("--") ? "1" : argv[++i]) : argv[i].slice(eq + 1);
    flags[key] = val;
  }

  if (cmd === "adapters") {
    for (const name of adapterNames()) {
      console.log(`${name}${name === DEFAULTS.adapter ? "  (default)" : ""}`);
    }
    process.exit(0);
  }

  if (cmd === "run") {
    const workspace = flags.workspace ?? process.cwd();
    const prompt = flags["prompt-file"]
      ? readFileSync(flags["prompt-file"], "utf8")
      : (flags.prompt ?? null);
    if (!prompt) {
      console.error("usage: harness.mjs run --workspace DIR (--prompt-file F | --prompt TEXT)");
      process.exit(2);
    }
    const policy = {
      ...(flags.adapter ? { adapter: flags.adapter } : {}),
      ...(flags.cli ? { cli: flags.cli } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.timeout ? { timeoutMs: Number(flags.timeout) } : {}),
      ...(flags.sandbox ? { sandbox: flags.sandbox } : {}),
      ...(flags.net ? { net: flags.net } : {}),
      ...(flags.image ? { image: flags.image } : {}),
      ...(flags.devcontainer ? { devcontainer: flags.devcontainer } : {}),
      ...(flags["log-dir"] ? { logDir: flags["log-dir"] } : {}),
      ...(flags.billing ? { billing: flags.billing } : {}),
      ...(flags.endpoint ? { endpoint: flags.endpoint } : {}),
      ...(flags["api-key-env"] ? { apiKeyEnv: flags["api-key-env"] } : {}),
      ...(flags["max-turns"] ? { maxTurns: Number(flags["max-turns"]) } : {}),
    };
    try {
      const out = await run(workspace, prompt, policy);
      if ("json" in flags) {
        // The patch is the large field and the caller has the tree ids; the
        // summary stays readable in a pipe.
        console.log(JSON.stringify({ ...out, diff: { ...out.diff, patch: undefined } }, null, 2));
      } else {
        console.log(`[harness] ${out.verdict.state}  ${out.verdict.reason ?? ""}`);
        console.log(`  diff       ${out.diff.measured ? `${out.diff.filesChanged} file(s), +${out.diff.insertions}/-${out.diff.deletions}` : `NOT MEASURED — ${out.diff.reason}`}`);
        console.log(`  transcript ${out.transcript.path} (${out.transcript.bytes} bytes)`);
        console.log(`  cost       ${out.cost.reported ? JSON.stringify(out.cost.tokens) : "unknown (null, not zero)"}`);
        for (const w of out.verdict.warnings) console.log(`  WARNING    ${w}`);
      }
      process.exit(out.verdict.ok ? 0 : 1);
    } catch (e) {
      console.error(`[harness] ${e.name}: ${e.message}`);
      process.exit(2);
    }
  }

  console.error("usage: harness.mjs run --workspace DIR --prompt-file F | harness.mjs adapters");
  process.exit(2);
}
