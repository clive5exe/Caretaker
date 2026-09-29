#!/usr/bin/env node
/**
 * G-1 and P-4: graduate emits only what the repository's own record supports,
 * and `why` answers from the decisions.
 *
 * A scratch git repo with specs, a supersession chain, a dangling reference,
 * dated commits (for freshness) and a chosen set of evidence.
 *
 * Run: node bin/graduate.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciWorkflow, decisions, editsAfterDecided, evidence, graduate, mdToHtml, why } from "./graduate.mjs";
import * as events from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "graduate-test-"));
const R = join(TMP, "repo");
for (const d of ["specs", "docs/decisions", "src/fees", "ops/caretaker"]) mkdirSync(join(R, d), { recursive: true });
const write = (p, t) => writeFileSync(join(R, p), t);
write("specs/fees.md", "---\ntitle: Fees\nstatus: accepted\nupdated: 2026-01-10\n---\n\n```spec\ngoverns: src/fees/**\n```\n\n# Fees\n\nDecided in ADR-0002. A <script>alert(1)</script> is text here.\n\n- one\n- two\n");
write("src/fees/calc.js", "1\n");
write("src/other.js", "1\n");
write("docs/decisions/0001-flat-fee.md", "---\ntitle: Flat fee\nstatus: superseded-by: ADR-0002\nupdated: 2026-01-01\n---\n\nA flat fee.\n");
write("docs/decisions/0002-percentage-fee.md", "---\ntitle: Percentage fee\nstatus: accepted\nupdated: 2026-01-05\nsupersedes: ADR-0001\n---\n\nThe fee is a percentage. See calc.js.\n");
write("docs/decisions/0003-orphan.md", "---\ntitle: Orphan\nstatus: accepted\nsupersedes: ADR-0009\n---\n\nNames src/other.js directly.\n");
write("docs/decisions/0004-bad-status.md", "---\ntitle: Bad\nstatus: maybe\n---\n\nx\n");
write("docs/decisions/0005-retry.md", "---\ntitle: Retry\nstatus: draft\nsupersedes: ADR-0006\n---\n\nRetry twice.\n");
write("docs/decisions/0006-no-retry.md", "---\ntitle: No retry\nstatus: accepted\nupdated: 2026-01-01\n---\n\nNever retry.\n");
write("docs/decisions/0007-rounding.md", "---\ntitle: Rounding\nstatus: accepted\n---\n\nRound half up.\n");
const git = (env, ...a) => spawnSync("git", ["-C", R, ...a], { encoding: "utf8", env: { ...process.env, ...env } });
git({}, "init", "-q");
const commit = (day, msg) => {
  const env = { GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z` };
  git(env, "add", "-A");
  git(env, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
};
commit("2026-01-10", "init");
write("src/fees/calc.js", "2\n");
write("docs/decisions/0005-retry.md", "---\ntitle: Retry\nstatus: draft\nsupersedes: ADR-0006\n---\n\nRetry three times.\n");
commit("2026-02-01", "fees moved"); // fees.md is now STALE; ADR-0005 edited while still a draft
write("docs/decisions/0005-retry.md", "---\ntitle: Retry\nstatus: accepted\nupdated: 2026-02-02\nsupersedes: ADR-0006\n---\n\nRetry three times.\n");
write("docs/decisions/0006-no-retry.md", "---\ntitle: No retry\nstatus: superseded-by: ADR-0005\nupdated: 2026-02-02\n---\n\nNever retry.\n");
commit("2026-02-02", "accept retry"); // ADR-0006 superseded: only its status and date change
write("docs/decisions/0007-rounding.md", "---\ntitle: Rounding\nstatus: accepted\n---\n\nRound half even.\n");
commit("2026-02-03", "round half even"); // an accepted decision rewritten in place

/* -------------------------------------------------------------- decisions */
{
  const { list, problems } = decisions(R);
  const byId = Object.fromEntries(list.map((d) => [d.id, d]));
  ok("every ADR is indexed", list.map((d) => d.id).join() === "ADR-0001,ADR-0002,ADR-0003,ADR-0004,ADR-0005,ADR-0006,ADR-0007");
  ok("superseded-by is computed from the superseding record", JSON.stringify(byId["ADR-0001"].supersededBy) === '["ADR-0002"]');
  ok("a supersedes pointing at nothing is a named problem", problems.some((p) => /ADR-0003 supersedes ADR-0009, which does not exist/.test(p)));
  ok("a status outside draft/accepted/rejected/superseded-by is a named problem", problems.some((p) => /ADR-0004 has status "maybe"/.test(p)));
  ok("a consistent supersession raises no problem", !problems.some((p) => /ADR-0001|ADR-0002/.test(p)), JSON.stringify(problems));
  ok("a decided ADR rewritten in a later commit is a named problem, with the commit", problems.some((p) => /^ADR-0007 was edited after it was decided \(accepted\): [0-9a-f]{8} 2026-02-03 "round half even"/.test(p)), JSON.stringify(problems));
  ok("editing a draft is not an edit to a decision", !problems.some((p) => /ADR-0005/.test(p)));
  ok("superseding changes only status and date, and is not an edit", !problems.some((p) => /ADR-0006/.test(p)));
  write("docs/decisions/0006-no-retry.md", "---\ntitle: No retry\nstatus: superseded-by: ADR-0005\nupdated: 2026-02-02\n---\n\nNever retry, ever.\n");
  const wt = editsAfterDecided(R, "docs/decisions/0006-no-retry.md");
  ok("an uncommitted edit to a decided ADR is reported as such", wt?.length === 1 && wt[0].sha === null);
  write("docs/decisions/0006-no-retry.md", "---\ntitle: No retry\nstatus: superseded-by: ADR-0005\nupdated: 2026-02-02\n---\n\nNever retry.\n");
  ok("outside a git checkout the question is unanswered (null), not answered 'no edits'", editsAfterDecided(TMP, "x.md") === null);
}

/* -------------------------------------------------------------------- why */
{
  const w = why(R, "src/fees/calc.js");
  ok("why names the governing spec", w.governing.map((g) => g.spec).join() === "specs/fees.md");
  const d2 = w.decisions.find((d) => d.id === "ADR-0002");
  ok("why finds the decision the spec cites, and says so", d2 && d2.how.some((h) => /cited by specs\/fees\.md/.test(h)));
  ok("…and a decision naming the file by its bare name, labelled as such", d2 && d2.how.some((h) => /names calc\.js \(the file's name/.test(h)));
  ok("a decision naming the full path is found", why(R, "src/other.js").decisions.some((d) => d.id === "ADR-0003" && d.how.includes("names src/other.js")));
  const none = why(R, "README.md");
  ok("an ungoverned, unexplained path says so rather than guessing", none.governing.length === 0 && none.decisions.length === 0);
}

/* --------------------------------------------------------------------- ci */
{
  ok("no evidence, no workflow: an empty repo gets null, not a placeholder", ciWorkflow(evidence(R)) === null);
  write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  ok("npm's default 'no test specified' script is not evidence of a test", evidence(R).length === 0);
  write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  const withNpm = evidence(R);
  ok("a real test script is evidence", withNpm.some((s) => s.name === "npm test" && /node --test/.test(s.evidence)));
  write("ops/caretaker/config.json", JSON.stringify({ board: "docs/board.json", boardMarkdown: "docs/board.md", events: "ops/caretaker/events" }));
  ok("a drift gate is NOT added just because drift.mjs could run", !evidence(R).some((s) => s.name === "drift gate"));
  events.append(join(R, "ops/caretaker/events"), { kind: "gate", level: "info", stage: "review", verdict: "pass", detail: "drift 0, dismissed 0, blocking conflicts 0, spec errors 0, unowned 0 of 1 governed-code path(s) changed" });
  events.append(join(R, "ops/caretaker/events"), { kind: "gate", level: "error", stage: "verify", verdict: "fail", source: "refute", detail: "refutation of r_00000000: refuted — the drift check misses governed files" });
  // A refutation's reason is free text and can name drift; it is not a drift gate run.
  const ev = evidence(R);
  const drift = ev.find((s) => s.name === "drift gate");
  ok("a drift gate that RAN (in the event log) is included, with its evidence", drift && /1 drift gate run\(s\)/.test(drift.evidence), JSON.stringify(ev));
  const wf = ciWorkflow(ev);
  ok("every step in the workflow carries its evidence line", (wf.match(/# evidence:/g) ?? []).length === ev.length && ev.length >= 2);
}

/* ------------------------------------------------------------------- docs */
{
  const out = graduate(R, { out: "graduate" });
  const site = join(R, "graduate", "site");
  ok("graduate writes the workflow, the decision index and the site", out.written.some((w) => w.endsWith("ci.yml")) && existsSync(join(R, "graduate", "DECISIONS.md")) && existsSync(join(site, "index.html")));
  const index = readFileSync(join(site, "index.html"), "utf8");
  ok("the site marks a spec older than the code it governs as stale", /Fees<\/a>.*stale/s.test(index), index.slice(0, 400));
  const spec = readFileSync(join(site, "specs-fees-md.html"), "utf8");
  ok("spec text is escaped, never rendered as HTML", spec.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !spec.includes("<script>alert"));
  ok("lists and headings render", spec.includes("<ul><li>one</li><li>two</li></ul>") && spec.includes("<h1>Fees</h1>"));
  const decs = readFileSync(join(site, "decisions.html"), "utf8");
  ok("the decision page lists the problems", decs.includes("ADR-0009, which does not exist"));
  const all = [...readdirSync(site).map((f) => readFileSync(join(site, f), "utf8")), readFileSync(join(R, "graduate", "DECISIONS.md"), "utf8"), readFileSync(join(R, "graduate", ".github", "workflows", "ci.yml"), "utf8")].join("\n");
  ok("nothing in the output is template placeholder text", !/TODO|TBD|FIXME|lorem ipsum|\{\{|<placeholder>|your-project/i.test(all));
  ok("it writes under the output dir, never over the project's own files", !existsSync(join(R, ".github")) && !existsSync(join(R, "DECISIONS.md")));
}
{
  const bare = join(TMP, "bare");
  mkdirSync(bare, { recursive: true });
  spawnSync("git", ["init", "-q", bare]);
  const out = graduate(bare, { out: "g" });
  ok("a repo with no evidence gets no workflow, and is told why", !existsSync(join(bare, "g", ".github")) && out.skipped.some((s) => /no evidence of any check/.test(s)));
}
ok("markdown fences keep their content verbatim and escaped", mdToHtml("```\n<b>x</b>\n```") === "<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>");
{
  const cli = spawnSync("node", [join(HERE, "graduate.mjs"), "decisions", "--repo", R], { encoding: "utf8" });
  ok("`graduate decisions` exits 1 while the record has problems", cli.status === 1 && /## Problems/.test(cli.stdout));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[graduate] ${failures} FAILED` : "\n[graduate] all checks passed");
process.exit(failures ? 1 : 0);
