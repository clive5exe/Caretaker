#!/usr/bin/env node
/**
 * THE EVENT LOG. B-6. The shape is `docs/events.md`; this is the one writer
 * and the one reader, so nothing else has to know how a line is framed.
 *
 *     append(dir, events)  -> the files written
 *     parse(text)          -> { events, skipped }
 *     read(dir)            -> { events, skipped, files }
 *
 * One JSON object per line in `events-YYYY-MM-DD.jsonl`, rotated by the day in
 * each line's own `t`. The keys are FIELDS, never folders: `run`, `task`,
 * `stage`, `kind` and `level` are filtered on, not navigated to.
 *
 * ── two things a naive appender gets wrong, both measured ─────────────────
 *
 * 1. A HALF-WRITTEN LAST LINE SWALLOWS THE NEXT ONE. A writer killed mid-line
 *    leaves bytes with no newline, and the next append lands on the same line.
 *    Measured with jq 1.7 in the B-6 PR: `{"a":1}\n{"a":2` followed by an
 *    append of `{"a":9}\n` gives a reader `{"a":1}` and nothing else, so an
 *    intact event is lost to someone else's crash. `append` terminates a
 *    fragment before writing; the test "a fragment left by a killed writer
 *    does not swallow the next event" goes red without it.
 *
 * 2. PLAIN `jq` STOPS AT THE FRAGMENT. `jq 'select(...)' < file` prints the
 *    lines before a half-written one and then exits 5 with a parse error, so
 *    a live file read mid-write looks broken. `jq -R 'fromjson? | ...'`
 *    skips it. That is the form `docs/events.md` gives, and the form the test
 *    "the documented jq views read a file with a fragment in it" runs.
 *
 * ── what makes concurrent writers safe, and what does not ─────────────────
 *
 * Each call is ONE `write` to a file opened with O_APPEND, so the kernel puts
 * each call's bytes at the end of the file as a unit and two runs appending at
 * once do not interleave inside a line. That holds for a local filesystem; it
 * is not promised over NFS. The test "concurrent writers never interleave
 * inside a line" runs several processes at once and checks every line parses.
 *
 * Run: node bin/events.mjs --help
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where events go when nobody says: `ops/caretaker/events`, which is gitignored. */
export const DEFAULT_DIR = resolve(HERE, "..", "ops", "caretaker", "events");

export const KINDS = ["gate", "agent", "tool", "drift", "system"];
export const LEVELS = ["debug", "info", "warn", "error"];
export const STAGES = ["plan", "build", "review", "verify", "merge"];
export const VERDICTS = ["pass", "fail"];

export class EventError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventError";
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Validate one event and fill in `t`. Returns a new object; throws EventError.
 *
 * STRICT ON WRITE, LENIENT ON READ. A bad line refused here costs the caller
 * one error message; a bad line accepted here costs every future reader a
 * special case. `level` is required rather than defaulted, because
 * `docs/events.md` names it as the field that gets skipped and then missed.
 */
export function normalise(ev, { now = () => new Date().toISOString() } = {}) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
    throw new EventError(`an event is an object, got ${JSON.stringify(ev)}`);
  }
  const e = { t: ev.t ?? now(), ...ev };
  if (typeof e.t !== "string" || !ISO.test(e.t)) {
    throw new EventError(`t must be an ISO instant in UTC (…Z), got ${JSON.stringify(e.t)}`);
  }
  if (!KINDS.includes(e.kind)) {
    throw new EventError(`kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(e.kind)}`);
  }
  if (!LEVELS.includes(e.level)) {
    throw new EventError(`level must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(e.level)}`);
  }
  if (e.stage !== undefined && !STAGES.includes(e.stage)) {
    throw new EventError(`stage must be one of ${STAGES.join(", ")}, got ${JSON.stringify(e.stage)}`);
  }
  if (e.verdict !== undefined) {
    if (e.kind !== "gate") throw new EventError(`verdict belongs only on gate events, not ${e.kind}`);
    if (!VERDICTS.includes(e.verdict)) {
      throw new EventError(`verdict must be pass or fail, got ${JSON.stringify(e.verdict)}`);
    }
  }
  if (e.tokens !== undefined && e.tokens !== null && !(Number.isInteger(e.tokens) && e.tokens >= 0)) {
    throw new EventError(`tokens must be a non-negative integer or null, got ${JSON.stringify(e.tokens)}`);
  }
  for (const k of ["run", "task"]) {
    if (e[k] !== undefined && (typeof e[k] !== "string" || !e[k])) {
      throw new EventError(`${k} must be a non-empty string when present, got ${JSON.stringify(e[k])}`);
    }
  }
  if (typeof e.detail !== "string" || !e.detail.trim()) {
    throw new EventError("detail is one human-readable sentence, and it is required");
  }
  // One sentence, never a stack trace. A newline here would not break the
  // framing (JSON escapes it) but it is how a trace gets pasted in.
  if (/[\r\n]/.test(e.detail)) {
    throw new EventError("detail must be one line; put a stack trace in a file and name the file");
  }
  return e;
}

export const fileFor = (dir, t) => join(dir, `events-${String(t).slice(0, 10)}.jsonl`);

/** True when the file exists, is non-empty and its last byte is not a newline. */
function endsMidLine(fd) {
  const { size } = fstatSync(fd);
  if (size === 0) return false;
  const b = Buffer.alloc(1);
  readSync(fd, b, 0, 1, size - 1);
  return b[0] !== 0x0a;
}

/**
 * Append events. Each event goes to the file for ITS OWN day, so a batch that
 * straddles midnight splits rather than filing tomorrow's lines under today.
 * Returns the files written, in the order first written.
 */
export function append(dir, events, opts = {}) {
  const list = (Array.isArray(events) ? events : [events]).map((e) => normalise(e, opts));
  if (!list.length) return [];
  const byFile = new Map();
  for (const e of list) {
    const f = fileFor(dir, e.t);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(JSON.stringify(e));
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, lines] of byFile) {
    const fd = openSync(file, "a+");
    try {
      // A leading newline when the file ends mid-line. If another writer
      // finishes that line between this check and the write, the cost is one
      // blank line, which every reader skips.
      const lead = endsMidLine(fd) ? "\n" : "";
      writeSync(fd, `${lead}${lines.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
  }
  return [...byFile.keys()];
}

/**
 * Parse a log's text. A line that is blank, is not JSON, or is JSON but not an
 * object is SKIPPED AND COUNTED, never thrown: a half-written final line is
 * the normal state of a file something is appending to.
 */
export function parse(text) {
  const events = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) events.push(v);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/** Read every day's file in a directory, oldest day first. A missing dir is empty. */
export function read(dir = DEFAULT_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return { events: [], skipped: 0, files: [] };
    throw e;
  }
  const files = names.filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().map((n) => join(dir, n));
  const out = { events: [], skipped: 0, files };
  for (const f of files) {
    const r = parse(readFileSync(f, "utf8"));
    out.events.push(...r.events);
    out.skipped += r.skipped;
  }
  return out;
}

/* --------------------------------------------------------------------- CLI */

const USAGE = `usage: node bin/events.mjs emit --kind K --level L --detail "…" [--run r_x] [--task T-1]
                              [--stage S] [--verdict pass|fail] [--tokens N] [--dir D]
       node bin/events.mjs path [--dir D]      today's file, for tail -F

Reading is tail and jq, with no tool of its own:
  tail -F "$(node bin/events.mjs path)"
  jq -cR 'fromjson? | select(.task=="T-1")' ops/caretaker/events/events-*.jsonl
kinds: ${KINDS.join(" ")}   levels: ${LEVELS.join(" ")}   stages: ${STAGES.join(" ")}`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new EventError(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new EventError(`${a} needs a value`);
    flags[a.slice(2)] = v;
    i += 1;
  }
  return flags;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (!cmd || cmd === "--help" || cmd === "-h") {
      console.log(USAGE);
      process.exit(cmd ? 0 : 2);
    }
    const flags = parseFlags(rest);
    const dir = resolve(flags.dir ?? DEFAULT_DIR);
    if (cmd === "path") {
      console.log(fileFor(dir, new Date().toISOString()));
    } else if (cmd === "emit") {
      const known = ["kind", "level", "detail", "run", "task", "stage", "verdict", "tokens", "t", "dir"];
      const unknown = Object.keys(flags).filter((k) => !known.includes(k));
      if (unknown.length) throw new EventError(`unknown flag(s): ${unknown.map((k) => `--${k}`).join(" ")}`);
      const { dir: _d, tokens, ...fields } = flags;
      if (tokens !== undefined) {
        if (!/^\d+$/.test(tokens)) throw new EventError(`--tokens must be a non-negative integer, got ${tokens}`);
        fields.tokens = Number(tokens);
      }
      const [file] = append(dir, fields);
      console.log(file);
    } else {
      throw new EventError(`unknown command ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof EventError) {
      console.error(`events: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
