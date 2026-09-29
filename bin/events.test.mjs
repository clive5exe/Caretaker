#!/usr/bin/env node
/**
 * Tests for the event log (B-6).
 *
 * The ones that matter are about lines that are NOT clean: a half-written last
 * line, a writer that dies mid-line and is followed by another, two writers at
 * once. A log is only ever read when something went wrong, which is exactly
 * when those states are on disk.
 *
 * Run: node bin/events.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DIR, EventError, KINDS, LEVELS, STAGES, append, fileFor, normalise, parse, read } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS = join(HERE, "events.mjs");

let failures = 0;
let skipped = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const skip = (name, why) => {
  console.log(`SKIP ${name} — ${why}`);
  skipped += 1;
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

const TMP = mkdtempSync(join(tmpdir(), "events-test-"));
let dirN = 0;
const freshDir = () => join(TMP, `d${dirN++}`);

const T = "2026-08-30T14:22:01Z";
const base = { t: T, run: "r_8f2c", task: "T-001", stage: "review", kind: "gate", level: "warn", verdict: "fail", detail: "pricing.ts changed, pricing.md did not", tokens: 1240 };

/* ============================================================ the fields */

ok("the vocabularies are the ones docs/events.md names",
  KINDS.join() === "gate,agent,tool,drift,system" &&
  LEVELS.join() === "debug,info,warn,error" &&
  STAGES.join() === "plan,build,review,verify,merge");

ok("the example line from docs/events.md is valid as written", !throws(() => normalise(base)));

{
  const { level, ...noLevel } = base;
  const e = throws(() => normalise(noLevel));
  ok("an event with NO LEVEL is refused, not defaulted", e instanceof EventError && /level/.test(e.message), e?.message);
}
ok("an unknown kind is refused by name", /kind/.test(throws(() => normalise({ ...base, kind: "chatter" }))?.message ?? ""));
ok("an unknown stage is refused by name", /stage/.test(throws(() => normalise({ ...base, stage: "deploy" }))?.message ?? ""));
ok("a verdict on a non-gate event is refused", /only on gate/.test(throws(() => normalise({ ...base, kind: "agent" }))?.message ?? ""));
ok("a verdict other than pass or fail is refused", /pass or fail/.test(throws(() => normalise({ ...base, verdict: "maybe" }))?.message ?? ""));
ok("a local time with no Z is refused, because rotation reads the UTC day from t",
  /ISO/.test(throws(() => normalise({ ...base, t: "2026-08-30T14:22:01+02:00" }))?.message ?? ""));
ok("fractional or negative tokens are refused", !!throws(() => normalise({ ...base, tokens: 1.5 })) && !!throws(() => normalise({ ...base, tokens: -1 })));
ok("tokens:null is allowed — unknown, not zero", !throws(() => normalise({ ...base, tokens: null })));
ok("a detail with a newline is refused — a stack trace goes in a file",
  /one line/.test(throws(() => normalise({ ...base, detail: "Error: x\n    at y" }))?.message ?? ""));
ok("an empty detail is refused", !!throws(() => normalise({ ...base, detail: "  " })));
{
  const { t, ...noT } = base;
  ok("t is filled in when absent", normalise(noT, { now: () => T }).t === T);
}
ok("extra fields are kept, because the keys are fields", normalise({ ...base, pr: 42 }).pr === 42);

/* ============================================================ rotation */

{
  const dir = freshDir();
  const f = append(dir, base);
  ok("one event goes to the file for its own day", f.length === 1 && f[0] === join(dir, "events-2026-08-30.jsonl"), JSON.stringify(f));
  const files = append(dir, [
    { ...base, t: "2026-08-30T23:59:59Z", detail: "before midnight" },
    { ...base, t: "2026-08-31T00:00:01Z", detail: "after midnight" },
  ]);
  ok("a batch that straddles midnight is split by each line's own day",
    files.length === 2 && files[1].endsWith("events-2026-08-31.jsonl") &&
    readFileSync(files[1], "utf8").includes("after midnight") &&
    !readFileSync(files[0], "utf8").includes("after midnight"),
    JSON.stringify(files));
  ok("nothing written is nothing returned", append(dir, []).length === 0);
  const refused = throws(() => append(dir, [{ ...base, detail: "good" }, { ...base, level: "loud" }]));
  ok("one bad event in a batch refuses the WHOLE batch before anything is written",
    refused instanceof EventError && !readFileSync(files[0], "utf8").includes('"good"'));
  const r = read(dir);
  ok("read returns every day, oldest first", r.files.length === 2 && r.events.length === 3 && r.events[2].detail === "after midnight", JSON.stringify(r.events.map((e) => e.detail)));
  ok("a directory that does not exist reads as empty, not as an error", read(join(TMP, "never-made")).events.length === 0);
}

/* ======================================================= damaged lines */

{
  const txt = `${JSON.stringify(base)}\n\n[1,2]\n"just a string"\nnot json\n${JSON.stringify({ ...base, detail: "second" })}\n{"t":"2026-08-30T14:2`;
  const r = parse(txt);
  ok("a half-written final line is SKIPPED AND COUNTED, not thrown",
    r.events.length === 2 && r.skipped === 4, JSON.stringify({ n: r.events.length, skipped: r.skipped }));
}

{
  const dir = freshDir();
  const file = fileFor(dir, T);
  append(dir, { ...base, detail: "before the crash" });
  appendFileSync(file, '{"t":"2026-08-30T14:22:02Z","kind":"age'); // a writer killed mid-line
  append(dir, { ...base, detail: "after the crash" });
  const r = read(dir);
  ok("a fragment left by a killed writer does not swallow the next event",
    r.events.map((e) => e.detail).join("|") === "before the crash|after the crash" && r.skipped === 1,
    `${JSON.stringify(r.events.map((e) => e.detail))} skipped=${r.skipped} — without the leading newline the next append lands on the fragment's line and both are lost`);
}

/* ================================================================== jq */

{
  const hasJq = spawnSync("jq", ["--version"]).status === 0;
  if (!hasJq) {
    skip("the documented jq views read a file with a fragment in it", "jq not on PATH");
  } else {
    const dir = freshDir();
    append(dir, [
      { ...base, detail: "a" },
      { t: T, run: "r_other", kind: "agent", level: "debug", detail: "b" },
      { t: T, run: "r_8f2c", task: "T-002", kind: "gate", level: "info", verdict: "pass", detail: "c" },
    ]);
    const file = fileFor(dir, T);
    appendFileSync(file, '{"t":"2026-08-30T14:2');
    const jq = (filter) => {
      const r = spawnSync("jq", ["-cR", `fromjson? | ${filter}`, file], { encoding: "utf8" });
      return { status: r.status, details: r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).detail).join("") };
    };
    // The five views docs/events.md lists, in its own jq -R form.
    const views = {
      'select(.task=="T-001")': "a",
      'select(.run=="r_8f2c")': "ac",
      'select(.verdict=="fail")': "a",
      'select(.level!="debug")': "ac",
      ".": "abc",
    };
    const got = Object.fromEntries(Object.keys(views).map((f) => [f, jq(f)]));
    ok("the documented jq views read a file with a fragment in it",
      Object.entries(views).every(([f, want]) => got[f].status === 0 && got[f].details === want),
      JSON.stringify(got));
    const plain = spawnSync("jq", ["-c", 'select(.level!="debug")', file], { encoding: "utf8" });
    ok("...and PLAIN jq does not, which is why the docs say -R 'fromjson?'",
      plain.status !== 0 && /parse error/.test(plain.stderr),
      `status=${plain.status} — if this starts passing, jq changed and the docs can be simplified`);
  }
}

/* ======================================================== concurrency */

{
  const dir = freshDir();
  const WRITERS = 8;
  const EACH = 200;
  // Long lines, so a torn write would be likely to show if appends could tear.
  const pad = "x".repeat(3000);
  const script = `
    import { append } from ${JSON.stringify(EVENTS)};
    const [dir, w, n, pad] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) {
      append(dir, { t: "2026-08-30T00:00:00Z", run: "r_" + w, kind: "system", level: "info", detail: w + ":" + i + ":" + pad });
    }`;
  const procs = Array.from({ length: WRITERS }, (_, w) =>
    new Promise((res) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script, dir, String(w), String(EACH), pad], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => res({ code, err }));
    }));
  const results = await Promise.all(procs);
  const r = read(dir);
  const perWriter = new Map();
  for (const e of r.events) perWriter.set(e.run, (perWriter.get(e.run) ?? 0) + 1);
  ok(`concurrent writers never interleave inside a line (${WRITERS} processes, ${EACH} events each)`,
    results.every((x) => x.code === 0) && r.skipped === 0 && r.events.length === WRITERS * EACH &&
      [...perWriter.values()].every((n) => n === EACH),
    `exit=${results.map((x) => x.code)} skipped=${r.skipped} events=${r.events.length} ${results.map((x) => x.err).join("").slice(0, 300)}`);
}

/* ================================================================= CLI */

{
  const dir = freshDir();
  const cli = (...a) => spawnSync(process.execPath, [EVENTS, ...a], { encoding: "utf8" });
  const good = cli("emit", "--dir", dir, "--kind", "system", "--level", "info", "--detail", "loop pass started", "--tokens", "12");
  const r = read(dir);
  ok("emit appends one line from a shell script", good.status === 0 && r.events.length === 1 && r.events[0].tokens === 12, good.stderr);
  const bad = cli("emit", "--dir", dir, "--kind", "system", "--detail", "no level");
  ok("emit with no level exits 2 and names the field", bad.status === 2 && /level/.test(bad.stderr), bad.stderr);
  const typo = cli("emit", "--dir", dir, "--kind", "system", "--level", "info", "--detail", "x", "--taks", "T-1");
  ok("a misspelt flag is refused rather than dropped", typo.status === 2 && /--taks/.test(typo.stderr), typo.stderr);
  const path = cli("path", "--dir", dir);
  ok("path prints today's file for tail -F", path.status === 0 && /events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(path.stdout.trim()), path.stdout);
}

ok("the default directory is the gitignored ops/caretaker/events", DEFAULT_DIR.endsWith(join("ops", "caretaker", "events")));
{
  const ignored = spawnSync("git", ["check-ignore", "-q", join(DEFAULT_DIR, "events-2026-08-30.jsonl")], { cwd: join(HERE, "..") });
  ok("...and git really does ignore it", ignored.status === 0, `git check-ignore exit ${ignored.status}`);
}

console.log(
  failures === 0
    ? `\n[events] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[events] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
