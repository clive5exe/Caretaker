#!/usr/bin/env node
/**
 * RUN LOG — append one line about a piece of work that executed.
 *
 * WHY A SEPARATE TINY TOOL. The dashboard has two gaps it cannot close by
 * reading the board or git: what is executing RIGHT NOW, and what a task cost in
 * tokens. Neither is derivable after the fact — an agent reports its token use
 * once, when it finishes, and if nothing writes that down the number is gone.
 * This is the thing that writes it down.
 *
 * APPEND-ONLY, ONE JSON OBJECT PER LINE. No rewrites, no compaction, no state
 * machine. A `start` line and a matching `end` line are two facts, not one
 * mutable record, and keeping them separate means a crashed run leaves a start
 * with no end — which is exactly what you want to see — rather than a row that
 * quietly says "running" forever with no way to tell the difference.
 *
 * PROVENANCE IS A FIELD, and it is not decoration. `src:"live"` means this line
 * was written as the work happened. `src:"reconstructed"` means someone wrote it
 * afterwards from a transcript or a memory. Those are different epistemic
 * objects and a dashboard that averages them without saying so is inventing
 * precision. The renderer labels reconstructed rows.
 *
 * Usage:
 *   node ops/foreman/run.mjs start --name qa --task T-277 --note "money gates"
 *   node ops/foreman/run.mjs end   --name qa --task T-277 --tokens 356251 --state done
 *   node ops/foreman/run.mjs end   --name qa --task T-277 --state failed --note "OOM"
 *
 * Flags: --name (required), --task, --tokens, --state, --note, --src, --at,
 *        --run r_…, --parent r_…, --adapter, --cli,
 *        --config (defaults to config.json beside this file).
 */
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const kind = argv[0];

if (!kind || !["start", "end"].includes(kind)) {
  console.error("usage: run.mjs start|end --name <agent> [--task T-123] [--tokens N] " +
    "[--state running|done|failed] [--note ...] [--src live|reconstructed] [--at ISO]");
  process.exit(2);
}

/** Flags, tolerating `--k v` and `--k=v`. Unknown flags are an error, not a shrug. */
/*
 * THE BREAKDOWN IS THE POINT, not the total. A run reporting 400k tokens tells
 * you nothing actionable; the same run reported as 380k of cache reads, 15k of
 * fresh input and 5k of output tells you immediately that the cost is context
 * replay rather than work. Those want completely different fixes — better
 * context selection versus a smaller task — and the total cannot distinguish
 * them.
 *
 *   in       fresh input tokens, billed at full rate
 *   cached   cache READS: context re-sent and matched. Cheap, and usually most
 *            of the volume.
 *   write    cache CREATION: context sent that could not be matched. Churn.
 *            High write against low cached means the context keeps changing
 *            shape, which is the expensive failure.
 *   out      generated tokens. The expensive ones per unit, and usually a small
 *            fraction of the total.
 *   turns    how many round trips. A run with eighty turns is a loop that did
 *            not converge, and the turn count says so where the total does not.
 */
const KNOWN = new Set([
  "name", "task", "tokens", "state", "note", "src", "at", "config",
  "in", "cached", "write", "out", "turns", "model",
  // C-4: a row can name its run and the run it examines, so the read model can
  // fold start/end rows into one run instead of pairing them by guesswork.
  "run", "parent", "adapter", "cli",
]);
const NUMERIC = new Set(["tokens", "in", "cached", "write", "out", "turns"]);
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
  if (!KNOWN.has(key)) {
    console.error(`run.mjs: unknown flag --${key}`);
    process.exit(2);
  }
  flags[key] = eq === -1 ? argv[++i] : a.slice(eq + 1);
}

if (!flags.name) {
  console.error("run.mjs: --name is required (which agent or job this was)");
  process.exit(2);
}
// The shape the harness mints (`r_` + 8 hex). Anything else would be written,
// then silently dropped by the read model as legacy, which is worse than a no.
for (const k of ["run", "parent"]) {
  if (flags[k] !== undefined && !/^r_[0-9a-f]{8}$/.test(flags[k])) {
    console.error(`run.mjs: --${k} must be a run id like r_0a1b2c3d, got ${flags[k]}`);
    process.exit(2);
  }
}

/*
 * CONFIG IS OPTIONAL, and that is deliberate. This tool is the thing that
 * records what a run cost, so it must not be the thing that fails because a
 * config file was not where it expected. A missing config means a sensible
 * default path, not an exception — losing the cost record of a run that already
 * happened is unrecoverable, and it is exactly when something is misconfigured
 * that you most want the log.
 */
const candidates = [
  flags.config,
  join(HERE, "config.json"),
  join(HERE, "..", "ops", "foreman", "config.json"),
  join(process.cwd(), "ops", "foreman", "config.json"),
].filter(Boolean);

let cfg = null;
let cfgFrom = null;
for (const c of candidates) {
  try {
    cfg = JSON.parse(readFileSync(resolve(c), "utf8"));
    cfgFrom = resolve(c);
    break;
  } catch {
    /* try the next */
  }
}
if (flags.config && !cfgFrom) {
  console.error(`run.mjs: --config ${flags.config} could not be read`);
  process.exit(2);
}
const ROOT = cfgFrom
  ? resolve(dirname(cfgFrom), "..", "..", cfg.repo ?? ".")
  : process.cwd();
const logPath = join(ROOT, cfg?.runs ?? "ops/foreman/runs.jsonl");

const nums = {};
for (const k of NUMERIC) {
  if (flags[k] === undefined) continue;
  const n = Number(flags[k]);
  if (!Number.isFinite(n)) {
    console.error(`run.mjs: --${k} must be a number, got ${flags[k]}`);
    process.exit(2);
  }
  nums[k] = n;
}
/*
 * A total is DERIVED when the parts are given, never both trusted. Two numbers
 * that should agree and are stored separately will disagree eventually, and the
 * one a reader believes is whichever they looked at first.
 */
const parts = ["in", "cached", "write", "out"].filter((k) => k in nums);
if (parts.length && nums.tokens === undefined) {
  nums.tokens = parts.reduce((n, k) => n + nums[k], 0);
} else if (parts.length && nums.tokens !== undefined) {
  const sum = parts.reduce((n, k) => n + nums[k], 0);
  if (sum !== nums.tokens) {
    console.error(
      `run.mjs: --tokens ${nums.tokens} does not equal ${parts.join(" + ")} = ${sum}. ` +
        "Give the parts and let the total be derived, or give only the total.",
    );
    process.exit(2);
  }
}
const tokens = nums.tokens;

const row = {
  t: flags.at ?? new Date().toISOString(),
  kind,
  name: flags.name,
  // `start` implies running; `end` defaults to done unless told otherwise.
  state: flags.state ?? (kind === "start" ? "running" : "done"),
  ...(flags.run ? { run: flags.run } : {}),
  ...(flags.parent ? { parent: flags.parent } : {}),
  ...(flags.adapter ? { adapter: flags.adapter } : {}),
  ...(flags.cli ? { cli: flags.cli } : {}),
  ...(flags.task ? { task: flags.task } : {}),
  ...(tokens !== undefined ? { tokens } : {}),
  ...Object.fromEntries(
    ["in", "cached", "write", "out", "turns"].filter((k) => k in nums).map((k) => [k, nums[k]]),
  ),
  ...(flags.model ? { model: flags.model } : {}),
  ...(flags.note ? { note: flags.note } : {}),
  src: flags.src ?? "live",
};

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, JSON.stringify(row) + "\n");
console.log(
  `[run] ${row.kind} ${row.name}${row.task ? ` ${row.task}` : ""} ${row.state}` +
    `${row.tokens ? ` ${row.tokens} tok` : ""}${row.src === "live" ? "" : ` (${row.src})`}`,
);
