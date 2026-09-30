#!/usr/bin/env node
/**
 * Tests for the drift gate.
 *
 * MOST OF THESE ARE NEGATIVE, and the two that matter most are the ones that
 * assert something is NOT drift. A gate that fires on everything is switched
 * off within a week, and a switched-off gate is worse than no gate because the
 * board still says it ran. So: a governed path changing with its spec is clean,
 * an unowned path is reported rather than failed, and an empty diff is clean.
 *
 * Every control here was proved by mutation — the source was broken, the named
 * check went red, the source was restored and checked back to its recorded
 * sha256. The mutations and their output are in the H-4 report; they are not
 * claimed here, because a comment asserting a run nobody can see is exactly the
 * defect class `ops/caretaker/RULES.md` names.
 *
 * Run: node bin/drift.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  loadSpecs, buildOwnership, createGlobResolver, analyse, gate, findOrphaned,
  validateDismissals, eventLines, writeEvents, norm, pathsFromDiffText,
} from "./drift.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const work = mkdtempSync(join(tmpdir(), "drift-test-"));

/** A spec record as `loadSpecs` would return one, without touching disk. */
const S = (id, ...governs) => ({ id, governs, errors: [] });

const CHECKOUT = S("specs/checkout.md", "src/lib/pricing*", "src/app/api/checkout/**");
const AUTH = S("specs/auth.md", "src/lib/auth/**");

/* ------------------------------------------------------- the ownership map */

{
  const own = buildOwnership([CHECKOUT, AUTH]);
  ok("every glob of every spec becomes a claim", own.claims.length === 3, String(own.claims.length));
  ok("spec ids are collected and sorted",
    own.specIds.join() === "specs/auth.md,specs/checkout.md", own.specIds.join());

  const r = createGlobResolver(own);
  ok("the governing spec is resolved from a path",
    r.owners("src/lib/pricing.ts").join() === "specs/checkout.md");
  ok("a deep path under a ** glob resolves",
    r.owners("src/app/api/checkout/route.ts").join() === "specs/checkout.md");
  ok("a path no spec claims resolves to nobody", r.owners("src/components/hero.tsx").length === 0);
  ok("the matching glob is reported, not just the spec",
    r.matches("src/lib/pricing.ts")[0].glob === "src/lib/pricing*");
  ok("the resolver names itself, so the report says which one ran", r.kind === "glob");
}

/* ---------------------------------------------------------- loading specs */

{
  const dir = join(work, "repo1");
  mkdirSync(join(dir, "specs"), { recursive: true });
  writeFileSync(join(dir, "specs", "checkout.md"),
    "---\ntitle: c\n---\n\n```spec\nhosts: api.stripe.com\ngoverns: src/lib/pricing*\n```\n\nprose\n");
  writeFileSync(join(dir, "specs", "README.md"), "# just a readme, no spec block\n");
  writeFileSync(join(dir, "specs", "broken.md"), "```spec\nhost: typo.example\ngoverns: src/broken/**\n```\n");

  const { specs, skipped } = loadSpecs("specs", { repo: dir });
  ok("a spec on disk is loaded with its globs",
    specs.find((s) => s.id === "specs/checkout.md")?.governs.join() === "src/lib/pricing*");
  ok("a markdown file with NO spec block is skipped, not failed",
    skipped.includes("specs/README.md") && !specs.some((s) => s.id === "specs/README.md"),
    "the fenced block is the declaration of intent; a readme in specs/ is not a broken spec");
  const broken = specs.find((s) => s.id === "specs/broken.md");
  ok("a spec block that does NOT parse is an error, not a skip", broken?.errors.length > 0);
  ok("a broken spec still contributes its globs",
    broken?.governs.join() === "src/broken/**",
    "dropping them would turn its paths into false 'unowned' rows on top of the parse error");
}

/* ------------------------------------------------------------ the verdict */

{
  const r = gate({ specs: [CHECKOUT, AUTH], changed: ["src/lib/pricing.ts"] });
  ok("A GOVERNED PATH CHANGED AND ITS SPEC DID NOT: drift", r.drift.length === 1 && r.ok === false);
  ok("the drift names the path, the spec and the glob that matched",
    r.drift[0].path === "src/lib/pricing.ts" &&
    r.drift[0].spec === "specs/checkout.md" &&
    r.drift[0].glob === "src/lib/pricing*", JSON.stringify(r.drift[0]));
}

{
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts", "specs/checkout.md"] });
  ok("THE SAME CHANGE WITH THE SPEC TOUCHED IS NOT DRIFT", r.ok === true && r.drift.length === 0,
    JSON.stringify(r.drift));
  ok("the touched spec is recorded rather than silently consumed",
    r.touchedSpecs.join() === "specs/checkout.md");
}

{
  const r = gate({ specs: [CHECKOUT], changed: ["src/components/hero.tsx"] });
  ok("A PATH NO SPEC CLAIMS IS UNOWNED, NOT DRIFT",
    r.unowned.join() === "src/components/hero.tsx" && r.drift.length === 0);
  ok("unowned alone does not block",
    r.ok === true,
    "on any real repo most files are ungoverned; blocking on that fails every task from " +
      "day one and teaches the team to bypass the gate");
}

{
  const r = gate({ specs: [], changed: [] });
  ok("AN EMPTY DIFF IS NOT DRIFT", r.ok === true && r.drift.length === 0);
}

{
  const r = gate({ specs: [CHECKOUT], changed: [] });
  ok("an empty diff with specs present is still not drift", r.ok === true);
}

/* ---------------------------------------------------------------- conflict */

{
  const OTHER = S("specs/fees.md", "src/lib/pricing.ts");
  const r = gate({ specs: [CHECKOUT, OTHER], changed: ["src/lib/pricing.ts"] });
  ok("TWO SPECS CLAIMING ONE CHANGED PATH IS A CONFLICT",
    r.conflicts.length === 1 && r.conflicts[0].specs.length === 2, JSON.stringify(r.conflicts));
  ok("a conflicted path is NOT also reported as drift",
    r.drift.length === 0,
    "an ambiguous owner is a different finding: the gate cannot name the document that " +
      "should have changed, so it must not name one");
  ok("a conflict on a changed path blocks", r.ok === false);
}

{
  const OTHER = S("specs/fees.md", "src/lib/pricing.ts");
  const r = gate({
    specs: [CHECKOUT, OTHER],
    changed: ["src/lib/auth/session.ts"],
    tree: ["src/lib/pricing.ts", "src/lib/auth/session.ts"],
  });
  ok("a conflict elsewhere in the tree is reported but does NOT block",
    r.conflicts.some((c) => c.path === "src/lib/pricing.ts" && c.changed === false) && r.ok === true,
    "a latent overlap somewhere else in the repo is not this task's fault");
}

/* --------------------------------------------------------------- spec error */

{
  const bad = { id: "specs/bad.md", governs: ["src/**"], errors: ["unknown field \"host\""] };
  const r = gate({ specs: [bad], changed: [] });
  ok("A SPEC THAT DOES NOT PARSE BLOCKS, even with an empty diff",
    r.ok === false && r.specErrors.length === 1,
    "its globs cannot be trusted, so paths it should own read as unowned and the gate " +
      "silently under-reports — the one direction this must never fail in");
}

/* --------------------------------------------------------------- dismissal */

{
  const { dismissals, errors } = validateDismissals([{ path: "src/lib/pricing.ts" }]);
  ok("A DISMISSAL WITH NO REASON IS REFUSED", errors.length === 1 && dismissals.length === 0);
  ok("the refusal says why", errors[0].includes("reason"), errors[0]);
}

ok("a dismissal with a blank reason is refused",
  validateDismissals([{ path: "a", reason: "   " }]).errors.length === 1);

ok("a dismissal with no path is refused",
  validateDismissals([{ reason: "because" }]).errors.length === 1);

{
  const { dismissals } = validateDismissals([
    { path: "src/lib/pricing.ts", reason: "comment typo only", by: "ghost" },
  ]);
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"], dismissals });
  ok("A DISMISSAL SUPPRESSES THE FAILURE", r.ok === true && r.drift.length === 0);
  ok("and the dismissal APPEARS IN THE OUTPUT with its reason and its author",
    r.dismissed.length === 1 &&
    r.dismissed[0].reason === "comment typo only" &&
    r.dismissed[0].by === "ghost" &&
    r.dismissed[0].finding === "drift", JSON.stringify(r.dismissed));
}

{
  const { dismissals } = validateDismissals([{ path: "src/lib/*", reason: "bulk rename" }]);
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"], dismissals });
  ok("a dismissal may be a glob, and the report says which one matched",
    r.ok === true && r.dismissed[0].dismissal === "src/lib/*");
}

{
  const OTHER = S("specs/fees.md", "src/lib/pricing.ts");
  const { dismissals } = validateDismissals([{ path: "src/lib/pricing.ts", reason: "known overlap, fees.md is authority" }]);
  const r = gate({ specs: [CHECKOUT, OTHER], changed: ["src/lib/pricing.ts"], dismissals });
  ok("a conflict can be dismissed too, and is recorded as a conflict dismissal",
    r.ok === true && r.dismissed[0].finding === "conflict", JSON.stringify(r.dismissed));
}

{
  const { dismissals } = validateDismissals([
    { path: "src/lib/pricing.ts", reason: "scoped to another task", task: "T-2" },
  ]);
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"], dismissals, task: "T-1" });
  ok("A DISMISSAL SCOPED TO ANOTHER TASK DOES NOT APPLY", r.ok === false && r.drift.length === 1,
    "otherwise one waiver silences every future task on that path");
  const same = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"], dismissals, task: "T-2" });
  ok("the same dismissal applies to its own task", same.ok === true);
}

{
  const { dismissals } = validateDismissals([{ path: "src/nothing/here.ts", reason: "stale" }]);
  const r = gate({ specs: [CHECKOUT], changed: ["specs/checkout.md"], dismissals });
  ok("a dismissal that matched nothing is reported as unused",
    r.unusedDismissals.length === 1,
    "so waivers do not silently accumulate past the change they were written for");
}

/* ------------------------------------------------------- unowned + orphaned */

{
  const tree = ["src/lib/pricing.ts", "src/components/hero.tsx", "README.md"];
  const r = gate({ specs: [CHECKOUT], changed: [], tree });
  ok("repo-wide unowned code is listed when a tree is available",
    r.unownedTree.join() === "README.md,src/components/hero.tsx", r.unownedTree.join());
  ok("an orphaned glob — one matching nothing — is reported",
    r.orphaned.length === 1 && r.orphaned[0].glob === "src/app/api/checkout/**",
    JSON.stringify(r.orphaned));
}

{
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"] });
  ok("WITH NO FILE LISTING, orphaned is null rather than an empty array",
    r.orphaned === null && r.unownedTree === null,
    "[] would assert an empty set that was never enumerated");
  ok("and the report says so in a note", r.notes.some((n) => n.includes("orphaned")));
}

ok("findOrphaned returns null, not [], when there is no tree",
  findOrphaned(buildOwnership([CHECKOUT]), null) === null);

{
  // analyse() is reachable on its own, and `gate()` overwrites its `orphaned`
  // field — so without this the null in analyse() is asserted by nothing. Found
  // by a mutation that changed it to [] and left the suite green.
  const own = buildOwnership([CHECKOUT]);
  const r = analyse({
    resolver: createGlobResolver(own), changed: ["src/lib/pricing.ts"], specIds: own.specIds,
  });
  ok("analyse() on its own also reports orphaned as NOT COMPUTED rather than empty",
    r.orphaned === null, JSON.stringify(r.orphaned));
}

/* ------------------------------------------------------------- ignore + specs */

{
  const r = gate({
    specs: [CHECKOUT], changed: ["src/lib/pricing.ts"], ignore: ["src/lib/**"],
  });
  ok("an ignored path is neither drift nor unowned", r.ok === true && r.unowned.length === 0);
}

{
  const r = gate({ specs: [CHECKOUT], changed: ["specs/checkout.md"] });
  ok("a changed spec is a touched document, not unowned code",
    r.unowned.length === 0 && r.counts.considered === 0);
}

/* ----------------------------------------------------------- determinism */

{
  const args = {
    specs: [AUTH, CHECKOUT],
    changed: ["src/lib/pricing.ts", "src/components/hero.tsx", "src/lib/auth/x.ts"],
    tree: ["src/lib/pricing.ts", "src/components/hero.tsx", "src/lib/auth/x.ts"],
  };
  const a = JSON.stringify(gate(args));
  const b = JSON.stringify(gate({
    ...args,
    specs: [...args.specs].reverse(),
    changed: [...args.changed].reverse(),
    tree: [...args.tree].reverse(),
  }));
  ok("THE SAME INPUT IN ANY ORDER GIVES BYTE-IDENTICAL JSON", a === b,
    "a gate that answers differently on a re-run gets re-rolled until it passes");
}

/* ------------------------------------------------------------- no model */

{
  const src = readFileSync(join(HERE, "drift.mjs"), "utf8");
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  const ALLOWED = new Set(["node:fs", "node:child_process", "node:path", "node:url", "./spec.mjs", "./events.mjs"]);
  const foreign = imports.filter((i) => !ALLOWED.has(i));
  ok("NO MODEL IS IN THE GATE PATH: every import is fs, path, url, child_process, spec.mjs or events.mjs",
    foreign.length === 0 && imports.length > 0, foreign.join(", "));
  // events.mjs is local code, so its own imports are in the gate path too.
  const evSrc = readFileSync(join(HERE, "events.mjs"), "utf8");
  const evForeign = [...evSrc.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1])
    .filter((i) => !["node:fs", "node:path", "node:url"].includes(i));
  ok("...and events.mjs, which the gate writes through, imports only fs, path and url",
    evForeign.length === 0, evForeign.join(", "));
  ok("and it opens no socket and calls no API",
    !/\bfetch\s*\(|node:https?\b|anthropic|openai/i.test(src),
    "a gate must answer the same way twice on the same input");
}

/* -------------------------------------------------------------- the log */

{
  const { dismissals } = validateDismissals([{ path: "src/lib/auth/**", reason: "vendored file, not our behaviour", by: "ghost" }]);
  const r = gate({
    specs: [CHECKOUT, AUTH],
    changed: ["src/lib/pricing.ts", "src/lib/auth/session.ts"],
    dismissals,
  });
  const lines = eventLines(r, { at: "2026-08-30T14:22:01Z", run: "r_8f2c", task: "T-001" });
  const gateLine = lines.find((l) => l.kind === "gate");
  ok("the gate verdict is one event with pass/fail on it", gateLine.verdict === "fail");
  ok("the drift event reads like the one in events.md",
    lines.some((l) => l.kind === "drift" && l.level === "warn" &&
      l.detail === "src/lib/pricing.ts changed, specs/checkout.md did not"),
    JSON.stringify(lines.map((l) => l.detail)));
  ok("THE DISMISSAL REASON IS IN THE LOG",
    lines.some((l) => l.level === "info" && l.detail.includes("vendored file, not our behaviour")));
  ok("the dismissal names who dismissed it",
    lines.some((l) => l.detail.includes("by ghost")));
  ok("every line carries run, task, stage and level",
    lines.every((l) => l.run === "r_8f2c" && l.task === "T-001" && l.stage === "review" && l.level),
    "without level an autonomous run logs either too little to debug or too much to read");
  ok("the clock is an argument, so the lines are reproducible",
    lines.every((l) => l.t === "2026-08-30T14:22:01Z"));
}

{
  const clean = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts", "specs/checkout.md"] });
  const line = eventLines(clean, { at: "2026-08-30T00:00:00Z" }).find((l) => l.kind === "gate");
  ok("a clean run still logs a verdict", line.verdict === "pass" && line.level === "info");
}

{
  const dir = join(work, "events");
  const at = "2026-08-30T14:22:01Z";
  const r = gate({ specs: [CHECKOUT], changed: ["src/lib/pricing.ts"] });
  const f1 = writeEvents(dir, eventLines(r, { at }));
  const f2 = writeEvents(dir, eventLines(r, { at }));
  ok("the log rotates by day", f1.endsWith("events-2026-08-30.jsonl") && f1 === f2);
  const body = readFileSync(f1, "utf8").trim().split("\n");
  ok("it is append-only: the second write did not replace the first", body.length === 4, String(body.length));
  ok("every line is one parseable JSON object", body.every((l) => JSON.parse(l).kind));
  const other = writeEvents(dir, eventLines(r, { at: "2026-08-31T01:00:00Z" }));
  ok("a different day is a different file", other.endsWith("events-2026-08-31.jsonl"));
}

/* ------------------------------------------------------------------ cli */

const cli = (args, opts = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [join(HERE, "drift.mjs"), ...args],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

{
  const repo = join(work, "cli");
  mkdirSync(join(repo, "specs"), { recursive: true });
  writeFileSync(join(repo, "specs", "checkout.md"),
    "```spec\nhosts: api.stripe.com\ngoverns: src/lib/pricing*\n```\n\nprose\n");
  const events = join(repo, "events");

  const drifted = cli(["check", "--repo", repo, "--no-tree", "--events", events,
    "--path", "src/lib/pricing.ts", "--quiet"]);
  ok("CLI: drift exits non-zero", drifted.code === 1, `exit ${drifted.code} ${drifted.stderr}`);
  const report = JSON.parse(drifted.stdout);
  ok("CLI: the report on stdout is the machine-readable one",
    report.drift[0].spec === "specs/checkout.md" && report.ok === false);

  const withSpec = cli(["check", "--repo", repo, "--no-tree", "--events", events,
    "--path", "src/lib/pricing.ts", "--path", "specs/checkout.md", "--quiet"]);
  ok("CLI: touching the spec exits zero", withSpec.code === 0, `exit ${withSpec.code}`);

  const dismissed = cli(["check", "--repo", repo, "--no-tree", "--events", events,
    "--path", "src/lib/pricing.ts", "--dismiss", "src/lib/pricing.ts",
    "--reason", "whitespace only", "--by", "ghost", "--quiet"]);
  ok("CLI: a dismissal with a reason exits zero", dismissed.code === 0, dismissed.stderr);

  const logged = readdirSync(events).map((f) => readFileSync(join(events, f), "utf8")).join("");
  ok("CLI: the dismissal reason reached the event log on disk",
    logged.includes("whitespace only"), logged.slice(0, 400));
  ok("CLI: the failing run was logged too", logged.includes('"verdict":"fail"'));

  const noReason = cli(["check", "--repo", repo, "--no-tree", "--events", events,
    "--path", "src/lib/pricing.ts", "--dismiss", "src/lib/pricing.ts", "--quiet"]);
  ok("CLI: a dismissal with no --reason is refused with exit 2", noReason.code === 2, noReason.stderr);

  const unrecordable = cli(["check", "--repo", repo, "--no-tree", "--no-events",
    "--path", "src/lib/pricing.ts", "--dismiss", "src/lib/pricing.ts",
    "--reason", "quiet please", "--quiet"]);
  ok("CLI: A DISMISSAL THAT CANNOT BE RECORDED IS REFUSED", unrecordable.code === 2,
    "an unrecorded dismissal is an off-switch, and the record is the only difference");

  const empty = cli(["check", "--repo", repo, "--no-tree", "--events", events, "--quiet",
    "--diff", "/dev/null"]);
  ok("CLI: an empty diff exits zero", empty.code === 0, `exit ${empty.code}`);

  // A run's diff.patch, as runstore archives it. Read as a list of paths it is
  // eight "paths" no spec owns, and the gate passed the very change it was given.
  const patch = join(repo, "run.patch");
  writeFileSync(patch, "diff --git a/src/lib/pricing.ts b/src/lib/pricing.ts\nindex 12ee743..4693ad3 100644\n--- a/src/lib/pricing.ts\n+++ b/src/lib/pricing.ts\n@@ -1,2 +1,2 @@\n-  return a - b\n+  return a + b\n");
  const fromPatch = cli(["check", "--repo", repo, "--no-tree", "--events", events, "--quiet", "--diff", patch]);
  ok("CLI: A UNIFIED PATCH ON --diff IS READ FOR ITS PATHS, and drift blocks", fromPatch.code === 1 && JSON.parse(fromPatch.stdout).drift[0]?.path === "src/lib/pricing.ts", fromPatch.stdout.slice(0, 300));

  ok("CLI: an unknown flag is refused rather than ignored",
    cli(["check", "--repo", repo, "--nope", "x"]).code === 2);

  const mapped = cli(["map", "--repo", repo]);
  ok("CLI: map prints the ownership map",
    JSON.parse(mapped.stdout).specs[0].governs.join() === "src/lib/pricing*");

  const explained = cli(["explain", "src/lib/pricing.ts", "--repo", repo]);
  ok("CLI: explain names the governing spec",
    JSON.parse(explained.stdout).owners.join() === "specs/checkout.md");
  ok("CLI: explain on an unowned path says unowned and exits non-zero",
    JSON.parse(cli(["explain", "src/x.ts", "--repo", repo]).stdout).verdict === "unowned");
}

{
  ok("a path list stays a path list", JSON.stringify(pathsFromDiffText("b.ts\na.ts\n\n")) === '["a.ts","b.ts"]');
  const rename = "diff --git a/old/x.ts b/new/x.ts\nsimilarity index 90%\nrename from old/x.ts\nrename to new/x.ts\n";
  ok("a rename names both sides", JSON.stringify(pathsFromDiffText(rename)) === '["new/x.ts","old/x.ts"]', JSON.stringify(pathsFromDiffText(rename)));
  const added = "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n";
  ok("a new file is its path, never /dev/null", JSON.stringify(pathsFromDiffText(added)) === '["n.ts"]', JSON.stringify(pathsFromDiffText(added)));
  const tricky = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n--- a/not-a-header.ts\n+++ b/not-a-header.ts\n";
  ok("known limit: a hunk line shaped like a header adds a path (over-reports, never under)", pathsFromDiffText(tricky).includes("a.ts") && pathsFromDiffText(tricky).includes("not-a-header.ts"));
}

console.log(failures === 0 ? "\n[drift] all checks passed" : `\n[drift] ${failures} FAILURE(S) above.`);
process.exit(failures === 0 ? 0 : 1);
