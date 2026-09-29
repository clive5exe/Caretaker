#!/usr/bin/env node
/**
 * RUNSTORE — C-4. A run gets an identity, and what the harness measured about
 * it outlives the temp directory it was measured in.
 *
 * `harness.run()` returns diff, transcript, verdict and cost and persists none
 * of them; its transcript sits in `$TMPDIR` and is raw CLI stdout. This file is
 * the writer the read model (`readmodel.mjs`, RUN_FILES) already reads:
 *
 *     <stateDir>/runs/<runId>/run.json            verdict, cost, diff summary, task,
 *                                                 parent, adapter, cli, model, policy
 *                            diff.patch           the measured patch
 *                            transcript.log       REDACTED
 *                            stderr.log           REDACTED
 *                            transcript.live.log  REDACTED, appended while the run is in flight
 *
 * `shadow/` — the harness's copy of the workspace — is never archived.
 *
 * WHY stateDir IS REFUSED INSIDE THE WORKSPACE. Not because the harness
 * refuses an in-workspace log dir; that rule is about logs written DURING a
 * run landing in the diff, and `allowLogDirInWorkspace` overrides it. This is a
 * different reason: the workspace is bind-mounted into the next agent's
 * container at /work (sandbox.mjs), gitignored files included, so an archive
 * under the repo — transcripts and all — is readable by the next agent.
 *
 * REDACTION HAPPENS HERE, WITH THE RUN'S OWN SECRET VALUES, on whole lines.
 * `secrets.makeRedactor` replaces each value in its encodings plus the known
 * key shapes. The server's KEY_SHAPES pass is a second net, not the first. The
 * live mirror only ever writes complete lines, because a key split across two
 * reads is two harmless halves to a regex and one secret to a reader.
 *
 * Usage:
 *   node bin/runstore.mjs run --workspace DIR (--prompt-file F | --prompt T)
 *        [--config ops/.../config.json | --state-dir DIR] [--task T-1] [--parent r_…]
 *        [--secret NAME ...] [--adapter cli] [--cli claude] [--model M]
 *        [--sandbox podman|none] [--net NET] [--timeout MS]
 *        [--egress host,host [--egress-network NET]]   per-run proxy, log in the archive (C-5)
 *        [--skills yes]                                 stage the config's skills for the run (S-1)
 *   node bin/runstore.mjs where [--config F]      print the state dir
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { makeRedactor, requireSecrets } from "./secrets.mjs";
import { stateDirFor } from "./statedir.mjs";

export const RUN_ID = /^r_[0-9a-f]{8}$/;
export const newRunId = () => `r_${randomBytes(4).toString("hex")}`;

export class RunStoreError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
    Object.assign(this, fields);
  }
}

/** The state directory for a repo; defined in statedir.mjs (see there for why). */
export { stateDirFor };

const inside = (p, root) => {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Refuse a state dir the next agent could read. See the header for why. */
export function checkStateDir(stateDir, workspace) {
  if (workspace && inside(stateDir, workspace)) {
    throw new RunStoreError(
      "STATE_IN_WORKSPACE",
      `state dir ${stateDir} is inside the workspace ${workspace}. The workspace is mounted into the next ` +
        "agent's container at /work, gitignored files included, so an archive there — transcripts and all — " +
        "is readable by the next agent. Put stateDir outside the repo.",
      { stateDir, workspace },
    );
  }
}

/** Build the redactor for a run. `secrets` is { NAME: value }. */
export const redactorFor = (secrets = {}) => makeRedactor(secrets);

/* ------------------------------------------------------------ live mirror */

/**
 * Tail `from` into `to`, redacting COMPLETE lines only, until stopped.
 *
 * A partial final line is held back until its newline arrives, or until
 * `stop()` flushes it as the run's last line. Polling rather than fs.watch:
 * the file is written by another process through a pipe, and a missed watch
 * event must never mean a gap in the mirror.
 */
export function startMirror({ from, to, redact, intervalMs = 200 }) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, "");
  let offset = 0;
  let pending = "";
  const pump = () => {
    let size;
    try {
      size = statSync(from).size;
    } catch {
      return; // not created yet
    }
    if (size <= offset) return;
    const fd = openSync(from, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      pending += buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const cut = pending.lastIndexOf("\n");
    if (cut === -1) return;
    const complete = pending.slice(0, cut + 1);
    pending = pending.slice(cut + 1);
    appendFileSync(to, complete.split("\n").map((l) => (l ? redact(l) : l)).join("\n"));
  };
  const timer = setInterval(pump, intervalMs);
  return {
    pump,
    stop() {
      clearInterval(timer);
      pump();
      if (pending) {
        appendFileSync(to, `${redact(pending)}\n`);
        pending = "";
      }
    },
  };
}

/* ---------------------------------------------------------------- archive */

const writeAtomic = (path, data) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
};

const redactLines = (text, redact) => String(text ?? "").split("\n").map((l) => (l ? redact(l) : l)).join("\n");

/** The policy as recorded: env VALUES removed, names kept. */
function recordedPolicy(policy = {}) {
  const { env, ...rest } = policy;
  return { ...rest, ...(env ? { env: Object.fromEntries(Object.keys(env).map((k) => [k, "[not recorded]"])) } : {}) };
}

/**
 * Write one finished harness result into the archive. Returns the run dir.
 *
 * `result` is what `harness.run()` returned. The transcript and stderr are read
 * from the paths it names, redacted line by line, and written beside run.json.
 */
export function archive(result, { stateDir, workspace = null, task = null, parent = null, model = null, policy = {}, redact, egress = null }) {
  const runId = result?.verdict?.runId;
  if (!RUN_ID.test(String(runId))) {
    throw new RunStoreError("BAD_RUN_ID", `run id ${JSON.stringify(runId)} is not r_ plus eight hex digits`);
  }
  if (parent !== null && !RUN_ID.test(String(parent))) {
    throw new RunStoreError("BAD_PARENT", `parent ${JSON.stringify(parent)} is not a run id`);
  }
  if (typeof redact !== "function") {
    // No default. An archive written without redaction is the leak this file
    // exists to prevent, and "I forgot to pass it" must fail, not pass quietly.
    throw new RunStoreError("NO_REDACTOR", "archive() needs a redact function; build one with redactorFor(secrets)");
  }
  checkStateDir(stateDir, workspace);
  const dir = join(stateDir, "runs", runId);
  mkdirSync(dir, { recursive: true });

  const { patch, ...diffSummary } = result.diff ?? {};
  const read = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");
  const transcript = read(result.transcript?.path);
  const stderr = read(result.transcript?.stderrPath);

  writeAtomic(join(dir, "diff.patch"), patch ?? "");
  // The proxy writes egress.jsonl straight into this directory (C-5), unredacted:
  // it has no secrets to redact with. A hostname can carry data — a key smuggled
  // out as a subdomain is still a refused CONNECT with the key in `host` — so it
  // gets the same line-by-line pass as the transcript.
  const egressLog = join(dir, "egress.jsonl");
  if (existsSync(egressLog)) writeAtomic(egressLog, redactLines(readFileSync(egressLog, "utf8"), redact));
  writeAtomic(join(dir, "transcript.log"), redactLines(transcript, redact));
  writeAtomic(join(dir, "stderr.log"), redactLines(stderr, redact));

  const record = {
    runId,
    task,
    parent,
    adapter: result.verdict.adapter ?? null,
    cli: result.verdict.cli ?? null,
    model: model ?? policy.model ?? null,
    verdict: result.verdict,
    cost: result.cost ?? null,
    diff: diffSummary,
    transcript: { bytes: Buffer.byteLength(transcript), lines: transcript ? transcript.split("\n").length : 0 },
    policy: recordedPolicy(policy),
    // null when no proxy was attached — the read model then says "not recorded"
    // for egress, which is the truth for a net:none run.
    egress,
    archivedAt: new Date().toISOString(),
  };
  // run.json goes through the redactor too: a verdict reason or a warning can
  // quote CLI output, and that is text an agent controlled.
  writeAtomic(join(dir, "run.json"), `${redact(JSON.stringify(record, null, 2))}\n`);
  return dir;
}

/**
 * Run through the harness and archive the result, with a live mirror while it
 * runs. The run id and the harness log dir are chosen here, up front, so the
 * mirror knows where the transcript is before the first byte is written.
 */
export async function runArchived(workspace, prompt, policy = {}, { stateDir, task = null, parent = null, secrets = {}, harness, egress = null } = {}) {
  const h = harness ?? (await import("./harness.mjs"));
  const runId = policy.runId ?? newRunId();
  if (!RUN_ID.test(runId)) throw new RunStoreError("BAD_RUN_ID", `run id ${runId} is not r_ plus eight hex digits`);
  checkStateDir(stateDir, workspace);
  if (egress && policy.sandbox === "none") {
    // The proxy guards a NETWORK. An agent on the host is on no such network,
    // so a per-run proxy would record nothing and imply it had been watched.
    throw new RunStoreError("EGRESS_NEEDS_SANDBOX", "egress attribution needs the agent in a container; sandbox:none runs on the host network");
  }
  const redact = redactorFor(secrets);
  const logDir = policy.logDir ?? join(tmpdir(), "caretaker-runs", runId);
  const dir = join(stateDir, "runs", runId);
  const mirror = startMirror({ from: join(logDir, "transcript.log"), to: join(dir, "transcript.live.log"), redact });
  const harnessPolicy = { ...policy, runId, logDir, ...(task ? { task } : {}) };
  let result;
  let egressRecord = null;
  try {
    if (egress) {
      mkdirSync(dir, { recursive: true });
      const netns = egress.netns ?? (await import("./netns.mjs"));
      const out = await netns.withRunEgress(
        { runId, allow: egress.allow, logDir: dir, egressNetwork: egress.egressNetwork, image: egress.image, exec: egress.exec, binDir: egress.binDir },
        ({ net, extraRunFlags, env }) =>
          h.run(workspace, prompt, {
            ...harnessPolicy,
            net,
            extraRunFlags: [...(policy.extraRunFlags ?? []), ...extraRunFlags],
            env: { ...(policy.env ?? {}), ...env },
          }),
      );
      result = out.result;
      const names = netns.perRunNames(runId);
      egressRecord = { network: names.internalNetwork, proxy: names.proxyName, allow: egress.allow, cleanup: out.cleanup };
    } else {
      result = await h.run(workspace, prompt, harnessPolicy);
    }
  } finally {
    mirror.stop();
  }
  const archived = archive(result, {
    stateDir, workspace, task, parent, model: policy.model ?? null, policy: harnessPolicy, redact, egress: egressRecord,
  });
  return { ...result, archived };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set([
    "workspace", "prompt-file", "prompt", "config", "state-dir", "task", "parent", "secret",
    "adapter", "cli", "model", "sandbox", "net", "timeout", "image", "egress", "egress-network",
    "endpoint", "api-key-env", "max-turns", "skills", "harness-config",
  ]);
  const flags = { secret: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!KNOWN.has(key)) {
      console.error(`runstore.mjs: unknown flag --${key}`);
      process.exit(2);
    }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (key === "secret") flags.secret.push(val);
    else flags[key] = val;
  }
  const stateDirFromFlags = () => {
    if (flags["state-dir"]) return resolve(flags["state-dir"]);
    const cfgPath = resolve(flags.config ?? "ops/caretaker/config.json");
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
    return stateDirFor(resolve(dirname(cfgPath), "..", "..", cfg.repo ?? "."), cfg);
  };

  if (cmd === "where") {
    console.log(stateDirFromFlags());
    process.exit(0);
  }
  if (cmd === "run") {
    const workspace = resolve(flags.workspace ?? process.cwd());
    const prompt = flags["prompt-file"] ? readFileSync(flags["prompt-file"], "utf8") : (flags.prompt ?? null);
    if (!prompt) {
      console.error("usage: runstore.mjs run --workspace DIR (--prompt-file F | --prompt TEXT) [...]");
      process.exit(2);
    }
    try {
      // Harness settings (who builds) under this run's flags; isolation flags
      // are only ever from the command line.
      const { load: loadHarnessSettings, policyFlags, policyFor } = await import("./harness-config.mjs");
      const { policy } = policyFor("builder", loadHarnessSettings({ path: flags["harness-config"], workspace }), policyFlags(flags));
      // --skills yes: stage the project's configured skills (S-1) into a fresh
      // directory OUTSIDE the workspace, for this run only.
      if (flags.skills === "yes") {
        const { stageForRun } = await import("./skills.mjs");
        const dir = stageForRun(resolve(flags.config ?? "ops/caretaker/config.json"), join(tmpdir(), `caretaker-skills-${process.pid}-${Date.now()}`));
        if (dir) policy.skillsDir = dir;
      }
      const secrets = flags.secret.length ? Object.fromEntries(requireSecrets(flags.secret, { repoRoot: workspace }).values) : {};
      const out = await runArchived(workspace, prompt, policy, {
        stateDir: stateDirFromFlags(),
        task: flags.task ?? null,
        parent: flags.parent ?? null,
        secrets,
        // --egress "a.com,b.com" gives the run its own network and proxy (C-5);
        // --egress "" is a deliberate deny-all, and is still attributed.
        egress: flags.egress !== undefined
          ? { allow: flags.egress.split(",").map((h) => h.trim()).filter(Boolean), egressNetwork: flags["egress-network"] }
          : null,
      });
      console.log(`[runstore] ${out.verdict.runId} ${out.verdict.state} -> ${out.archived}`);
      process.exit(out.verdict.ok ? 0 : 1);
    } catch (e) {
      console.error(`[runstore] ${e.name}: ${e.message}`);
      process.exit(2);
    }
  }
  console.error("usage: runstore.mjs run --workspace DIR --prompt-file F [...] | runstore.mjs where [--config F]");
  process.exit(2);
}
