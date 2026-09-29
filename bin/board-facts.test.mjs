#!/usr/bin/env node
/**
 * C-6: questions, triage, spec review, PR links and drops are core commands.
 *
 *   1. Each command records its fact with `by` and a full ISO `at`, through
 *      the CLI, and refuses what it should refuse.
 *   2. Spec approval is keyed on the spec's git blob, so editing the spec
 *      leaves the recorded approval pointing at the old content.
 *   3. BACKWARD COMPATIBLE. The pre-C-1 board.mjs (testdata) reads, builds and
 *      mutates a board that carries every new field, and keeps them.
 *
 * Run: node bin/board-facts.test.mjs
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

function fixture(boardFile = join(HERE, "board.mjs")) {
  const root = mkdtempSync(join(tmpdir(), "caretaker-facts-"));
  const ops = join(root, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  copyFileSync(boardFile, join(ops, "board.mjs"));
  writeFileSync(
    join(ops, "config.json"),
    JSON.stringify({ name: "Fixture", board: "docs/board.json", repo: ".", activePhase: "P", operator: "five" }),
  );
  writeFileSync(join(root, "specs", "gov.md"), "# Gov\n\n```spec\ngoverns: src/**\n```\n");
  writeFileSync(join(root, "docs", "context.md"), "# Just context\n");
  writeFileSync(
    join(root, "docs", "board.json"),
    `${JSON.stringify(
      {
        meta: { name: "Fixture" },
        phases: [
          {
            name: "P",
            tasks: [
              { id: "T-1", title: "one", owner: "b", est: "1h", status: "todo", ac: "x", spec: "specs/gov.md" },
              { id: "T-2", title: "two", owner: "b", est: "1h", status: "todo", spec: "docs/context.md" },
              { id: "T-3", title: "three", owner: "b", est: "1h", status: "done", completed: "2026-01-01" },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  spawnSync("git", ["-C", root, "init", "-q"]);
  return { root, ops, cli: (...a) => spawnSync("node", [join(ops, "board.mjs"), ...a], { cwd: root, encoding: "utf8" }) };
}
const task = (f, id) => JSON.parse(readFileSync(join(f.root, "docs", "board.json"), "utf8")).phases[0].tasks.find((t) => t.id === id);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/;

/* 0. B-3: the spec on a card --------------------------------------------- */
{
  const f = fixture();
  const b = JSON.parse(readFileSync(join(f.root, "docs", "board.json"), "utf8"));
  b.phases[0].tasks.push(
    { id: "T-4", title: "four", owner: "b", status: "todo", spec: "https://evil.example/x" },
    { id: "T-5", title: "five", owner: "b", status: "todo", spec: "../outside.md" },
    { id: "T-6", title: "six", owner: "b", status: "todo", spec: 'specs/"><script>x</script>.md' },
    { id: "T-7", title: "seven", owner: "b", status: "todo", spec: "docs/javascript:alert(document.cookie)" },
  );
  writeFileSync(join(f.root, "docs", "board.json"), JSON.stringify(b));
  const r = f.cli("build");
  const md = readFileSync(join(f.root, "docs", "board.md"), "utf8");
  // Independent review: the spec was on no card, and plain text where it was shown.
  ok("a card links its spec, relative to board.md", r.status === 0 && md.includes('spec <a href="../specs/gov.md">specs/gov.md</a>') && md.includes('<a href="context.md">docs/context.md</a>'), md.slice(0, 600));
  ok("a URL, an absolute path or one climbing out with .. is text, not a link", md.includes("spec https://evil.example/x</span>") && md.includes("spec ../outside.md</span>") && !md.includes('href="https:') && !md.includes('href="../../'));
  ok("a spec path is escaped, in the text and in the href", !md.includes("<script>x") && md.includes("&lt;script&gt;x"));
  // Independent re-review: the scheme check ran before the relative path
  // stripped "docs/", so this became href="javascript:…".
  ok("a scheme that only appears after the relative path is taken is not a link either", !/href="javascript/i.test(md) && md.includes("spec docs/javascript:alert(document.cookie)</span>"));
  rmSync(f.root, { recursive: true, force: true });
}

/* 1. commands ------------------------------------------------------------- */
{
  const f = fixture();
  let r = f.cli("ask", "T-1", "which", "port?");
  ok("ask records a question and names its id", r.status === 0 && /asked q1/.test(r.stdout), r.stderr);
  r = f.cli("ask", "T-1", "and the host?");
  let t = task(f, "T-1");
  ok("questions get q1, q2 in order", t.questions.map((q) => q.id).join() === "q1,q2");
  ok("a question carries by (the configured operator) and an ISO at", t.questions[0].by === "five" && ISO.test(t.questions[0].at) && t.questions[0].via === "cli");
  ok("ask with no text is refused", f.cli("ask", "T-1").status === 1);
  ok("ask on a done task is refused", f.cli("ask", "T-3", "why?").status === 1);

  r = f.cli("answer", "T-1", "q1", "7420");
  t = task(f, "T-1");
  ok("answer records on the question", r.status === 0 && t.questions[0].answer.text === "7420" && t.questions[0].answer.by === "five");
  ok("a question is answered once", f.cli("answer", "T-1", "q1", "again").status === 1);
  ok("an unknown question is refused", f.cli("answer", "T-1", "q9", "x").status === 1);
  ok("q2 stays open", !task(f, "T-1").questions[1].answer);

  ok("triage reject needs a reason", f.cli("triage", "T-1", "reject").status === 1);
  ok("triage takes only accept or reject", f.cli("triage", "T-1", "maybe").status === 1);
  f.cli("triage", "T-1", "reject", "no", "owner");
  f.cli("triage", "T-1", "accept");
  t = task(f, "T-1");
  ok("triage appends, newest last", t.triage.map((x) => x.decision).join() === "reject,accept" && t.triage[0].why === "no owner");

  ok("pr needs an http(s) url", f.cli("pr", "T-1", "not-a-url").status === 1);
  f.cli("pr", "T-1", "https://github.com/o/r/pull/9");
  ok("pr records the url", task(f, "T-1").pr.url === "https://github.com/o/r/pull/9");
  const firstPr = task(f, "T-1").pr;
  f.cli("pr", "T-1", "https://github.com/o/r/pull/10");
  const pr = task(f, "T-1").pr;
  // Independent QA: a second pr overwrote the first, and its by and at with it.
  ok("a later pr is current, and the one it replaced is kept with its by and at", pr.url.endsWith("/10") && pr.history?.length === 1 && pr.history[0].url === firstPr.url && pr.history[0].by === "five" && pr.history[0].at === firstPr.at, JSON.stringify(pr));

  ok("drop needs a reason", f.cli("drop", "T-2").status === 1);
  r = f.cli("drop", "T-2", "out", "of", "scope");
  t = task(f, "T-2");
  ok("drop sets status dropped and records why", r.status === 0 && t.status === "dropped" && t.dropped.why === "out of scope");
  ok("a dropped task cannot be dropped again", f.cli("drop", "T-2", "again").status === 1);
  const firstDrop = task(f, "T-2").dropped;
  f.cli("todo", "T-2");
  r = f.cli("drop", "T-2", "gone", "for", "good");
  t = task(f, "T-2");
  ok("a task reopened and dropped again keeps the earlier drop, with its by and at", r.status === 0 && t.dropped.why === "gone for good" && t.dropped.history?.[0]?.why === "out of scope" && t.dropped.history[0].at === firstDrop.at, JSON.stringify(t.dropped));
  ok("an unknown task is refused", f.cli("ask", "T-404", "x").status === 1);
  // B-8: a verdict carries its instant beside its date, and history keeps it.
  f.cli("qa", "T-2", "fail", "x");
  f.cli("qa", "T-2", "pass", "y");
  const qa = task(f, "T-2").gate.qa;
  ok("a verdict records the instant (t) beside the date (at), and history keeps the earlier one's", ISO.test(qa.t) && qa.at === qa.t.slice(0, 10) && ISO.test(qa.history?.[0]?.t ?? "") && qa.history[0].t <= qa.t, JSON.stringify(qa));
  // W-4: a transition records who, when and from where; a refused one records nothing.
  f.cli("start", "T-1");
  const refused = f.cli("done", "T-1");
  const moves = task(f, "T-1").transitions ?? [];
  ok("a CLI transition records by the operator, an ISO at, via cli", moves.length === 1 && moves[0].cmd === "start" && moves[0].by === "five" && moves[0].via === "cli" && ISO.test(moves[0].at), JSON.stringify(moves));
  ok("a refused done records no transition", refused.status === 1 && moves.every((m) => m.cmd !== "done"));
  ok("the usage lists the new commands", /spec-approve/.test(f.cli("help").stdout));
  rmSync(f.root, { recursive: true, force: true });
}

/* 2. spec approval is keyed on content ------------------------------------- */
{
  const f = fixture();
  ok("a spec with no ```spec block cannot be approved", f.cli("spec-approve", "T-2").status === 1);
  ok("spec-reject needs a reason", f.cli("spec-reject", "T-1").status === 1);
  let r = f.cli("spec-approve", "T-1");
  const first = task(f, "T-1").specReview?.[0];
  ok("spec-approve records path and blob", r.status === 0 && first?.path === "specs/gov.md" && /^[0-9a-f]{40}$/.test(first?.blob ?? ""), r.stderr);
  const hash = spawnSync("git", ["-C", f.root, "hash-object", "specs/gov.md"], { encoding: "utf8" }).stdout.trim();
  ok("the blob is git's hash of the file's content", first?.blob === hash);
  writeFileSync(join(f.root, "specs", "gov.md"), "# Gov, edited\n\n```spec\ngoverns: src/**\n```\n");
  f.cli("spec-reject", "T-1", "the", "edit", "widened", "it");
  const second = task(f, "T-1").specReview?.[1];
  ok("after an edit the next review carries a different blob", second && second.blob !== first.blob && second.decision === "reject");
  rmSync(f.root, { recursive: true, force: true });
}

/* 3. an older board.mjs keeps the new fields ------------------------------ */
{
  const f = fixture();
  f.cli("ask", "T-1", "q?");
  f.cli("triage", "T-1", "accept");
  f.cli("spec-approve", "T-1");
  f.cli("pr", "T-1", "https://example.com/pr/1");
  f.cli("drop", "T-2", "gone");
  const before = task(f, "T-1");
  copyFileSync(join(HERE, "testdata", "board.pre-c1.mjs"), join(f.ops, "board.mjs"));
  const s = f.cli("status");
  const b = f.cli("build");
  const n = f.cli("note", "T-1", "old tool was here");
  const after = task(f, "T-1");
  ok("the old CLI reads a board carrying C-6 fields", s.status === 0 && b.status === 0 && n.status === 0, s.stderr + b.stderr + n.stderr);
  ok(
    "and a mutation by the old CLI keeps every new field",
    ["questions", "triage", "specReview", "pr"].every((k) => JSON.stringify(after[k]) === JSON.stringify(before[k])) && task(f, "T-2").dropped?.why === "gone",
  );
  rmSync(f.root, { recursive: true, force: true });
}

console.log(failures ? `\n[board-facts] ${failures} FAILED` : "\n[board-facts] all checks passed");
process.exit(failures ? 1 : 0);
