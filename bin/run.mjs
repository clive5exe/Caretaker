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
const KNOWN = new Set(["name", "task", "tokens", "state", "note", "src", "at", "config"]);
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

const cfgPath = flags.config ? resolve(flags.config) : join(HERE, "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const ROOT = resolve(dirname(cfgPath), "..", "..", cfg.repo ?? ".");
const logPath = join(ROOT, cfg.runs ?? "ops/foreman/runs.jsonl");

const tokens = flags.tokens === undefined ? undefined : Number(flags.tokens);
if (tokens !== undefined && !Number.isFinite(tokens)) {
  console.error(`run.mjs: --tokens must be a number, got ${flags.tokens}`);
  process.exit(2);
}

const row = {
  t: flags.at ?? new Date().toISOString(),
  kind,
  name: flags.name,
  // `start` implies running; `end` defaults to done unless told otherwise.
  state: flags.state ?? (kind === "start" ? "running" : "done"),
  ...(flags.task ? { task: flags.task } : {}),
  ...(tokens !== undefined ? { tokens } : {}),
  ...(flags.note ? { note: flags.note } : {}),
  src: flags.src ?? "live",
};

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, JSON.stringify(row) + "\n");
console.log(
  `[run] ${row.kind} ${row.name}${row.task ? ` ${row.task}` : ""} ${row.state}` +
    `${row.tokens ? ` ${row.tokens} tok` : ""}${row.src === "live" ? "" : ` (${row.src})`}`,
);
