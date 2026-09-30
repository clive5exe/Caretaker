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
{
  // Independent review: three ways to change a decided record that raised nothing.
  const S = join(TMP, "second");
  mkdirSync(join(S, "docs/decisions"), { recursive: true });
  const g = (...a) => spawnSync("git", ["-C", S, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-03-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-03-01T12:00:00Z" } });
  const put = (p, t) => writeFileSync(join(S, p), t);
  const snap = (msg) => (g("add", "-A"), g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg));
  g("init", "-q");
  g("config", "diff.renames", "false"); // a person's config may turn rename detection off; graduate must not depend on it
  const cache = (ttl) => `---\ntitle: Cache\nstatus: accepted\n---\n\nCache for ${ttl}.\nThe cache is warmed at start.\nIt is read on every request.\nA miss goes to the database.\nThe database is never read twice for one key.\n`;
  put("docs/decisions/0001-cache.md", cache("one hour"));
  put("docs/decisions/0002-queue.md", "---\ntitle: Queue\nstatus: accepted\n---\n\nUse one queue.\n");
  put("docs/decisions/0003-log.md", "---\ntitle: Log\nstatus: accepted\n---\n\nThe log format:\nupdated: when the row last changed\n");
  put("docs/decisions/0004-draft.md", "---\ntitle: Draft\nstatus: draft\n---\n\nMaybe.\n");
  put("docs/decisions/0005-auth.md", "---\ntitle: Auth\nstatus: accepted\n---\n\nTokens expire hourly.\n");
  put("docs/decisions/0006-names.md", "---\ntitle: Names\nstatus: accepted\n---\n\nNames are lower case.\nWords are joined by hyphens.\nNo name starts with a digit.\n");
  snap("init");
  g("mv", "docs/decisions/0001-cache.md", "docs/decisions/0001-cache-policy.md");
  put("docs/decisions/0001-cache-policy.md", cache("one day"));
  g("mv", "docs/decisions/0005-auth.md", "docs/decisions/0005-tokens.md");
  put("docs/decisions/0005-tokens.md", "---\ntitle: Session tokens are forever\nstatus: accepted\nupdated: 2026-03-01\n---\n\n## Context\n\nLogging in again annoys people.\n\n## Decision\n\nTokens never expire.\nThey are revoked by hand.\n");
  g("mv", "docs/decisions/0006-names.md", "docs/decisions/0006-naming.md");
  snap("rename cache");
  g("rm", "-q", "docs/decisions/0002-queue.md", "docs/decisions/0004-draft.md");
  snap("drop queue");
  put("docs/decisions/0003-log.md", "---\ntitle: Log\nstatus: accepted\n---\n\nThe log format:\nupdated: never\n");
  snap("log field");
  const { problems } = decisions(S);
  ok("a decided ADR renamed while its body changed is still an edit to it", problems.some((p) => /^ADR-0001 was edited after it was decided \(accepted\): [0-9a-f]{8} 2026-03-01 "rename cache"/.test(p)), JSON.stringify(problems));
  ok("a decided ADR deleted from history is a named problem, with the commit", problems.some((p) => /^docs\/decisions\/0002-queue\.md was DELETED after it was decided \(accepted\): [0-9a-f]{8} 2026-03-01 "drop queue"/.test(p)), JSON.stringify(problems));
  ok("deleting a draft is not deleting a decision", !problems.some((p) => /0004-draft/.test(p)));
  ok("a rename that rewrites past git's rename threshold reads as a deletion, and is still reported", problems.some((p) => /^docs\/decisions\/0005-auth\.md was DELETED/.test(p)), JSON.stringify(problems));
  ok("a plain rename is neither an edit nor a deletion", !problems.some((p) => /ADR-0006|0006-names/.test(p)), JSON.stringify(problems));
  ok("…nor is the renamed-and-edited record also reported as deleted", !problems.some((p) => /0001-cache\.md was DELETED/.test(p)), JSON.stringify(problems));
  ok("a BODY line starting 'updated:' is text: editing it is an edit", problems.some((p) => /^ADR-0003 was edited after it was decided \(accepted\): [0-9a-f]{8} 2026-03-01 "log field"/.test(p)), JSON.stringify(problems));
}

{
  // Independent re-review: deleting the LAST decision, and moving one out of
  // the record, were both silent; and nothing checked specs for history.
  for (const [name, move] of [["last", null], ["flat", "docs/decisions/cache.md"], ["archive", "docs/decisions/archive/0001-cache.md"]]) {
    const S = join(TMP, `third-${name}`);
    // archive/ only where it is the destination: an empty one left behind
    // would keep the directory alive, and hide the case being tested.
    mkdirSync(join(S, move?.includes("archive/") ? "docs/decisions/archive" : "docs/decisions"), { recursive: true });
    const g = (...a) => spawnSync("git", ["-C", S, ...a], { encoding: "utf8" });
    g("init", "-q");
    writeFileSync(join(S, "docs/decisions/0001-cache.md"), "---\ntitle: Cache\nstatus: accepted\n---\n\nCache for one hour.\nWarm it at start.\nRead it on every request.\n");
    g("add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    if (move) g("mv", "docs/decisions/0001-cache.md", move);
    else g("rm", "-q", "docs/decisions/0001-cache.md");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `gone ${name}`);
    const { problems } = decisions(S);
    ok(
      move ? `a decision moved out of the record (${move}) is named, with where it went` : "deleting the only decision is named, though the directory went with it",
      problems.some((p) => (move ? new RegExp(`^docs/decisions/0001-cache\\.md was MOVED OUT of the decision record \\(to ${move.replace(/[./]/g, "\\$&")}\\)`) : /^docs\/decisions\/0001-cache\.md was DELETED/).test(p)),
      JSON.stringify(problems),
    );
  }
  const H = join(TMP, "history");
  mkdirSync(join(H, "specs"), { recursive: true });
  writeFileSync(join(H, "specs", "a.md"), "# A\n\nWhat is true.\n\n## Changelog\n\n- 2026-01-02: added retries\n\n```\n## History inside a fence is code, not a section\n```\n");
  writeFileSync(join(H, "specs", "b.md"), "# B\n\nThe fee is 2%.\n");
  const hp = decisions(H).problems;
  ok("a spec carrying a changelog or dated entries is named, by line", hp.some((p) => /^specs\/a\.md:5 carries history/.test(p)) && hp.some((p) => /^specs\/a\.md:7 carries history/.test(p)), JSON.stringify(hp));
  ok("…text in a code fence, and a spec with none, are not", !hp.some((p) => /a\.md:10|specs\/b\.md/.test(p)));
}

{
  // Independent re-review, round 3: three more ways past P-4.
  const S = join(TMP, "fourth");
  mkdirSync(join(S, "docs/decisions/archive"), { recursive: true });
  mkdirSync(join(S, "specs"), { recursive: true });
  const g = (...a) => spawnSync("git", ["-C", S, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-04-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-04-01T12:00:00Z" } });
  const put = (p, t) => writeFileSync(join(S, p), t);
  const adr = (title, status, extra = "") => `---\ntitle: ${title}\nstatus: ${status}\n${extra}---\n\n${title} is decided.\n`;
  const snap = (msg) => (g("add", "-A"), g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg));
  g("init", "-q");
  put("docs/decisions/0001-a.md", adr("A", "accepted"));
  put("docs/decisions/0002-b.md", adr("B", "accepted"));
  put("docs/decisions/0003-c.md", adr("C", "accepted"));
  put("docs/decisions/0004-d.md", adr("D", "accepted"));
  put("docs/decisions/0006-f.md", adr("F", "accepted"));
  put("docs/decisions/0007-g.md", adr("G", "accepted"));
  put("docs/decisions/0008-h.md", adr("H", "draft"));
  put("docs/archive-keep.md", "keeps docs/ alive\n");
  snap("init");
  put("docs/decisions/0001-a.md", adr("A", "proposed"));
  put("docs/decisions/0002-b.md", adr("B", "rejected"));
  put("docs/decisions/0003-c.md", adr("C", "superseded"));
  put("docs/decisions/0004-d.md", adr("D", "superseded-by: ADR-0005"));
  put("docs/decisions/0005-e.md", adr("E", "accepted", "supersedes: ADR-0004\n"));
  snap("statuses");
  // Uncommitted: a decided ADR removed, one moved out, and a draft removed.
  rmSync(join(S, "docs/decisions/0006-f.md"));
  g("mv", "docs/decisions/0007-g.md", "docs/decisions/archive/0007-g.md");
  rmSync(join(S, "docs/decisions/0008-h.md"));
  const { problems } = decisions(S);
  const has = (re) => problems.some((p) => re.test(p));
  ok("accepted -> proposed after deciding is a named problem", has(/^ADR-0001 changed status from accepted to proposed after it was decided: [0-9a-f]{8} 2026-04-01 "statuses"/), JSON.stringify(problems));
  ok("accepted -> rejected after deciding is a named problem", has(/^ADR-0002 changed status from accepted to rejected/));
  ok("accepted -> bare superseded (nothing superseding it) is a named problem", has(/^ADR-0003 changed status from accepted to superseded/) && has(/^ADR-0003 has status "superseded"/));
  ok("accepted -> superseded-by with a record that supersedes it is allowed", !has(/ADR-0004|ADR-0005/), JSON.stringify(problems.filter((p) => /ADR-000[45]/.test(p))));
  ok("an uncommitted rm of a decided ADR is named as uncommitted", has(/^docs\/decisions\/0006-f\.md was DELETED after it was decided \(accepted\): uncommitted, in the working tree/), JSON.stringify(problems));
  ok("an uncommitted git mv out of the record is named, with where it went", has(/^docs\/decisions\/0007-g\.md was MOVED OUT of the decision record \(to docs\/decisions\/archive\/0007-g\.md\) after it was decided \(accepted\): uncommitted/), JSON.stringify(problems));
  ok("an uncommitted rm of a draft is not a problem", !has(/0008-h/));

  put("specs/c.md", "# C\n\nTrue now.\n\n## 2026-09-01\n\n## [1.0.0] - 2026-09-01\n\n## Change history\n\n| 2026-09-01 | added retries |\n\n1. 2026-09-02 removed retries\n");
  put("specs/d.md", "# D\n\n## Fields\n\n| Field | Type |\n|---|---|\n| created | 2026-09-01 is an example value |\n\n1. Step one\n2. Step two\n\nThe launch is on 2026-10-01.\n");
  const hp = decisions(S).problems.filter((p) => /carries history/.test(p));
  for (const [line, what] of [[5, "a date heading"], [7, "a keep-a-changelog heading"], [9, "a 'Change history' heading"], [11, "a table row starting with a date"], [13, "a numbered item starting with a date"]]) {
    ok(`a spec's history as ${what} is named (specs/c.md:${line})`, hp.some((p) => p.startsWith(`specs/c.md:${line} carries history`)), JSON.stringify(hp));
  }
  ok("ordinary tables, numbered steps and a date in a sentence are not history", !hp.some((p) => p.startsWith("specs/d.md")), JSON.stringify(hp));
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
  write("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));
  mkdirSync(join(R, "bin"), { recursive: true });
  write("bin/a.test.mjs", "");
  write("bin/b.test.mjs", "");
  write("bin/c.test.mjs", "");
  // Independent QA: steps came from file presence. None of this is evidence yet.
  ok("a test script or test files that no gate was seen to run are not evidence", evidence(R).length === 0, JSON.stringify(evidence(R)));
  write("ops/caretaker/config.json", JSON.stringify({ board: "docs/board.json", events: "ops/caretaker/events" }));
  const note = (t, gate, text, at = "2026-02-01") => ({ id: t, title: t, status: "doing", gate: { [gate]: { verdict: "pass", at, note: text } } });
  write("docs/board.json", JSON.stringify({ phases: [{ name: "P", tasks: [
    note("T-1", "qa", "ran node bin/a.test.mjs and npm test; node bin/gone.test.mjs passed too"),
    { id: "T-2", title: "T-2", status: "doing", gate: { reviewer: { verdict: "pass", at: "2026-02-03", note: "fine", history: [{ verdict: "pass", at: "2026-02-02", note: "npm run lint passed" }] } } },
    // Independent re-review: a mention is not a run. None of these may become a step.
    { id: "T-3", title: "T-3", status: "doing", gate: { qa: { verdict: "fail", at: "2026-02-04", note: "ran node bin/b.test.mjs, which passed" } } },
    note("T-4", "reviewer", "I did not run node bin/b.test.mjs. npm run build was never tried; do not run npm run deploy. Looks right."),
    note("T-5", "qa", "Independent QA (fresh agent, not the builder): node bin/c.test.mjs green."),
  ] }] }));
  const skipped = [];
  const ev = evidence(R, { skipped });
  const tests = ev.find((s) => s.name === "tests");
  ok("a test file a gate note names as run is a step, with where it was named", tests?.run === "node bin/a.test.mjs && node bin/c.test.mjs" && /T-1 qa 2026-02-01/.test(tests.evidence), JSON.stringify(ev));
  ok("…and one that is only present is not", !/b\.test/.test(tests?.run ?? ""));
  ok("…and a negative word about something else in the sentence does not hide a run", /node bin\/c\.test\.mjs/.test(tests?.run ?? ""), tests?.run);
  ok("a command named in a FAILING verdict, or in a sentence that says it did not run, is not a step", !/b\.test/.test(tests?.run ?? "") && !ev.some((x) => /build|deploy/.test(x.name)), JSON.stringify(ev.map((x) => x.run)));
  ok("a named test file the repo does not have is skipped, and said", skipped.some((x) => /node bin\/gone\.test\.mjs.*not in this repo/.test(x)) && !/gone/.test(tests?.run ?? ""), JSON.stringify(skipped));
  ok("an npm script a gate note names is a step, with the script it runs", ev.some((s) => s.name === "npm test" && /scripts\.test: node --test; named as run in 1 gate/.test(s.evidence)));
  ok("…including one named in an earlier verdict", ev.some((s) => s.name === "npm run lint" && /T-2 reviewer 2026-02-02/.test(s.evidence)), JSON.stringify(ev.map((s) => s.name)));
  write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }));
  const s2 = [];
  ok("npm's default 'no test specified' script is not a check, even when named", !evidence(R, { skipped: s2 }).some((s) => s.name === "npm test") && s2.some((x) => /no real test script/.test(x)));
  write("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));

  ok("a drift gate is NOT added just because drift.mjs could run", !evidence(R).some((s) => s.name === "drift gate"));
  events.append(join(R, "ops/caretaker/events"), { kind: "gate", level: "info", stage: "review", verdict: "pass", detail: "drift 0, dismissed 0, blocking conflicts 0, spec errors 0, unowned 0 of 1 governed-code path(s) changed" });
  events.append(join(R, "ops/caretaker/events"), { kind: "gate", level: "error", stage: "verify", verdict: "fail", source: "refute", detail: "refutation of r_00000000: refuted — the drift check misses governed files" });
  // Anchored: a gate event that merely mentions drift is not a drift gate run.
  events.append(join(R, "ops/caretaker/events"), { kind: "gate", level: "info", stage: "review", verdict: "pass", detail: "lint gate: no drift in formatting" });
  const s3 = [];
  ok("a drift gate that RAN, with no drift.mjs in the repo, is skipped and said", !evidence(R, { skipped: s3 }).some((s) => s.name === "drift gate") && s3.some((x) => /no drift\.mjs is in this repo/.test(x)), JSON.stringify(s3));
  write("bin/drift.mjs", "");
  const ev2 = evidence(R);
  const drift = ev2.find((s) => s.name === "drift gate");
  ok("a drift gate that RAN is included, counting only its own gate events", drift && /1 drift gate run\(s\)/.test(drift.evidence), JSON.stringify(ev2));
  ok("…and run with the drift.mjs the repo has", drift?.run.startsWith("node bin/drift.mjs check"));
  // Independent re-review: every npm step began with `npm ci`, which fails
  // with no lockfile, so a repo without one got a CI red on every push.
  ok("with no lockfile and no dependencies, an npm step installs nothing first", ev2.find((x) => x.name === "npm test")?.run === "npm test", JSON.stringify(ev2.find((x) => x.name === "npm test")));
  write("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." }, devDependencies: { eslint: "9" } }));
  ok("…with dependencies and no lockfile, it installs with npm install", evidence(R).find((x) => x.name === "npm test")?.run === "npm install && npm test");
  write("package-lock.json", "{}");
  ok("…and with a lockfile, npm ci", evidence(R).find((x) => x.name === "npm test")?.run === "npm ci && npm test");
  rmSync(join(R, "package-lock.json"));
  write("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));
  ok("the workflow runs on the branch it is given, not a fixed main", /branches: \["trunk"\]/.test(ciWorkflow(evidence(R), { branch: "trunk" }) ?? ""));
  const wf = ciWorkflow(ev2);
  ok("every step in the workflow carries its evidence line", (wf?.match(/# evidence:/g) ?? []).length === ev2.length && ev2.length >= 3);
  ok("no step calls a file the repo does not have", ev2.every((s) => [...s.run.matchAll(/node (\S+\.m?js)/g)].every((m) => existsSync(join(R, m[1])))));
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
  // Independent review: `--out .` wrote over the project's .github/workflows/ci.yml.
  const refused = (out) => {
    try {
      graduate(R, { out });
      return null;
    } catch (e) {
      return e.code ?? e.message;
    }
  };
  ok("the project itself is refused as --out", refused(".") === "OUT_IS_PROJECT" && refused(R) === "OUT_IS_PROJECT");
  ok("…and so is a directory above it", refused("..") === "OUT_IS_PROJECT");
  ok("a directory holding files graduate did not write is refused", refused("docs") === "OUT_NOT_OURS" && refused("bin") === "OUT_NOT_OURS");
  ok("a directory graduate wrote before is written again", refused("graduate") === null);
  ok("--out naming a file is refused by name, not a stack trace", existsSync(join(R, "src/other.js")) && refused("src/other.js") === "OUT_NOT_DIR");
  const cli = spawnSync("node", [join(HERE, "graduate.mjs"), "all", "--repo", R, "--out", "."], { encoding: "utf8" });
  ok("the CLI refuses --out . by name, and writes nothing", cli.status === 2 && /is the project/.test(cli.stderr) && !existsSync(join(R, ".graduate")), cli.stderr);
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
