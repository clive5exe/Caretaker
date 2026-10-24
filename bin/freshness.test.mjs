#!/usr/bin/env node
/**
 * P-5 and B-3: staleness and lying dates are computed from git, and the check
 * names each one.
 *
 * A scratch repo with commits at chosen dates (GIT_AUTHOR_DATE and
 * GIT_COMMITTER_DATE), so every comparison is against a date this file set.
 *
 * Run: node bin/freshness.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimedUpdated, freshness, lastCommit } from "./freshness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

ok("updated: is read from frontmatter", claimedUpdated("---\ntitle: x\nupdated: 2026-03-04\n---\nbody") === "2026-03-04");
ok("a quoted date is read", claimedUpdated('---\nupdated: "2026-03-04"\n---\n') === "2026-03-04");
ok("no frontmatter means no claim", claimedUpdated("# title\nupdated: 2026-03-04\n") === null);
ok("an updated: in the body is not a claim", claimedUpdated("---\ntitle: x\n---\nupdated: 2026-03-04\n") === null);

const TMP = mkdtempSync(join(tmpdir(), "freshness-test-"));
const R = join(TMP, "repo");
mkdirSync(join(R, "specs"), { recursive: true });
mkdirSync(join(R, "docs"), { recursive: true });
mkdirSync(join(R, "src", "fees"), { recursive: true });
mkdirSync(join(R, "src", "tax"), { recursive: true });
spawnSync("git", ["init", "-q", R]);
const commit = (day, msg, ...paths) => {
  const env = { ...process.env, GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z` };
  spawnSync("git", ["-C", R, "add", ...paths], { env });
  const r = spawnSync("git", ["-C", R, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
const spec = (updated, governs) => `---\ntitle: t\nupdated: ${updated}\n---\n\n\`\`\`spec\ngoverns: ${governs}\n\`\`\`\n\nbody\n`;

// fees: spec claims Jan; the code under it moved in Feb → STALE.
writeFileSync(join(R, "specs", "fees.md"), spec("2026-01-10", "src/fees/**"));
writeFileSync(join(R, "src", "fees", "a.js"), "1\n");
commit("2026-01-10", "fees", "specs/fees.md", "src/fees/a.js");
writeFileSync(join(R, "src", "fees", "a.js"), "2\n");
commit("2026-02-01", "fees moved", "src/fees/a.js");
// tax: code changed the SAME day as the claim → not stale.
writeFileSync(join(R, "specs", "tax.md"), spec("2026-02-05", "src/tax/**"));
writeFileSync(join(R, "src", "tax", "t.js"), "1\n");
commit("2026-02-05", "tax", "specs/tax.md", "src/tax/t.js");
// A spec whose glob matches nothing → orphaned.
writeFileSync(join(R, "specs", "ghost.md"), spec("2026-03-01", "src/ghost/**")); // committed the day it claims
// docs: one edited after its claimed date (LYING), one honest, one undated.
writeFileSync(join(R, "docs", "honest.md"), "---\nupdated: 2026-03-01\n---\nx\n");
writeFileSync(join(R, "docs", "liar.md"), "---\nupdated: 2026-01-01\n---\nx\n");
writeFileSync(join(R, "docs", "nodate.md"), "# no frontmatter\n");
writeFileSync(join(R, "README.txt"), "not governed\n");
commit("2026-03-01", "docs", "specs/ghost.md", "docs", "README.txt");

const r = freshness({ repo: R });
ok("a spec older than the code it governs is stale", r.stale.map((s) => s.spec).join() === "specs/fees.md", JSON.stringify(r.stale));
ok("…and the report names the commit that moved it", r.stale[0]?.lastGoverned?.day === "2026-02-01" && r.stale[0]?.lastGoverned?.subject === "fees moved");
ok("a same-day change is not stale", !r.stale.some((s) => s.spec === "specs/tax.md"));
ok("a doc edited after its claimed date is lying", r.lying.map((l) => l.doc).join() === "docs/liar.md", JSON.stringify(r.lying));
ok("an honest doc is not", !r.lying.some((l) => l.doc === "docs/honest.md"));
ok("a doc making no claim is undated, not stale or lying", r.undated.includes("docs/nodate.md"));
ok("a glob matching nothing is orphaned", (r.orphaned ?? []).some((o) => o.spec === "specs/ghost.md" && o.glob === "src/ghost/**"));
ok("a path no spec claims is unowned", r.unowned.includes("README.txt") && !r.unowned.includes("src/fees/a.js"));
ok("docs themselves are not counted as unowned code", !r.unowned.some((p) => p.startsWith("docs/")));
ok("ok is false while anything is stale or lying", r.ok === false);
ok("lastCommit of paths no commit touched is null", lastCommit(R, ["src/nothing-here"]) === null);

// Fix both: bump the claims and the check goes quiet.
writeFileSync(join(R, "specs", "fees.md"), spec("2026-03-02", "src/fees/**"));
writeFileSync(join(R, "docs", "liar.md"), "---\nupdated: 2026-03-02\n---\nx\n");
commit("2026-03-02", "catch up", "specs/fees.md", "docs/liar.md");
const fixed = freshness({ repo: R });
ok("once each claim is true again, nothing is stale or lying", fixed.ok && fixed.stale.length === 0 && fixed.lying.length === 0, JSON.stringify({ s: fixed.stale, l: fixed.lying }));

const cli = spawnSync("node", [join(HERE, "freshness.mjs"), "--repo", R], { encoding: "utf8" });
ok("the CLI exits 0 when nothing lies", cli.status === 0, cli.stdout + cli.stderr);
writeFileSync(join(R, "docs", "honest.md"), "---\nupdated: 2026-03-01\n---\nchanged\n");
commit("2026-04-01", "edit without bumping", "docs/honest.md");
const cli2 = spawnSync("node", [join(HERE, "freshness.mjs"), "--repo", R], { encoding: "utf8" });
ok("the CLI exits 1 and names the lying doc", cli2.status === 1 && /LYING\s+docs\/honest\.md/.test(cli2.stdout), cli2.stdout);
ok("an unknown flag exits 2", spawnSync("node", [join(HERE, "freshness.mjs"), "--nope"], { encoding: "utf8" }).status === 2);

{
  // The reviewer's case: a governed file DELETED after the spec's date.
  writeFileSync(join(R, "specs", "tax.md"), spec("2026-04-02", "src/tax/**"));
  commit("2026-04-02", "tax claim", "specs/tax.md");
  spawnSync("git", ["-C", R, "rm", "-q", "src/tax/t.js"]);
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-05-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-05-01T12:00:00Z" };
  spawnSync("git", ["-C", R, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "drop tax"], { env });
  const d = freshness({ repo: R });
  ok("deleting a governed file makes its spec stale", d.stale.some((x) => x.spec === "specs/tax.md" && x.lastGoverned?.subject === "drop tax"), JSON.stringify(d.stale));
}
{
  // "Every spec is checked for a lying date, wherever it lives": one outside --docs.
  mkdirSync(join(R, "design"), { recursive: true });
  writeFileSync(join(R, "design", "api.md"), spec("2026-01-01", "src/api/**"));
  commit("2026-06-01", "design spec", "design/api.md");
  const d = freshness({ repo: R, specsDir: "design", docDirs: ["docs"] });
  ok("a spec outside the doc dirs is still checked for a lying date", d.lying.some((x) => x.doc === "design/api.md"), JSON.stringify(d.lying));
}

{
  // Independent re-review: staleness asked git's own glob pathspecs, ownership
  // used drift's resolver, and they disagreed.
  mkdirSync(join(R, "lib", "a"), { recursive: true });
  writeFileSync(join(R, "specs", "lib.md"), spec("2026-07-01", "lib/**.js"));
  writeFileSync(join(R, "lib", "a", "b.js"), "1\n");
  commit("2026-07-01", "lib", "specs/lib.md", "lib/a/b.js");
  writeFileSync(join(R, "lib", "a", "b.js"), "2\n");
  commit("2026-07-02", "lib moved", "lib/a/b.js");
  mkdirSync(join(R, "pay", "fees"), { recursive: true });
  writeFileSync(join(R, "specs", "pay.md"), spec("2026-07-01", "pay/fees"));
  writeFileSync(join(R, "pay", "fees", "x.js"), "1\n");
  commit("2026-07-01", "pay", "specs/pay.md", "pay/fees/x.js");
  writeFileSync(join(R, "pay", "fees", "x.js"), "2\n");
  commit("2026-07-02", "pay moved", "pay/fees/x.js");
  const d = freshness({ repo: R });
  const lib = d.governed.find((g) => g.spec === "specs/lib.md");
  ok("a file ownership says a spec governs makes that spec stale when it moves", lib?.governedPaths >= 1 && d.stale.some((x) => x.spec === "specs/lib.md" && x.lastGoverned?.subject === "lib moved"), JSON.stringify(lib));
  const payOrphan = (d.orphaned ?? []).some((o) => o.spec === "specs/pay.md");
  const payStale = d.stale.some((x) => x.spec === "specs/pay.md");
  ok("a spec is never reported both orphaned (governs nothing) and stale (what it governs moved)", !(payOrphan && payStale), JSON.stringify({ payOrphan, payStale }));
}

{
  // P-5, independent re-review: a change that reached the main line by a
  // MERGE was dated by its branch commit, and `git log --name-only` lists no
  // files for the merge itself. A branch commit older than the spec's claim,
  // merged after it, left the spec looking current.
  const at = (day) => ({ ...process.env, GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z` });
  const g = (day, ...a) => spawnSync("git", ["-C", R, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { env: at(day), encoding: "utf8" });
  const main = g("2026-08-10", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  mkdirSync(join(R, "mg"), { recursive: true });
  writeFileSync(join(R, "specs", "merge.md"), spec("2026-08-10", "mg/**"));
  writeFileSync(join(R, "mg", "x.js"), "1\n");
  writeFileSync(join(R, "docs", "merged.md"), "---\nupdated: 2026-08-10\n---\nx\n");
  commit("2026-08-10", "mg", "specs/merge.md", "mg/x.js", "docs/merged.md");
  g("2026-08-10", "checkout", "-q", "-b", "feat");
  writeFileSync(join(R, "mg", "x.js"), "2\n");
  writeFileSync(join(R, "docs", "merged.md"), "---\nupdated: 2026-08-10\n---\nedited\n");
  g("2026-08-09", "add", "mg/x.js", "docs/merged.md");
  g("2026-08-09", "commit", "-qm", "branch work, dated before the claim");
  g("2026-08-20", "checkout", "-q", main);
  const m = g("2026-08-20", "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
  ok("(setup) the branch merged", m.status === 0, m.stderr);
  const d = freshness({ repo: R });
  const st = d.stale.find((x) => x.spec === "specs/merge.md");
  ok("code that arrived by a merge after the claim makes the spec stale, dated by the merge", st?.lastGoverned?.day === "2026-08-20" && st.lastGoverned.subject === "merge feat", JSON.stringify(st ?? d.governed.find((x) => x.spec === "specs/merge.md")));
  const ly = d.lying.find((x) => x.doc === "docs/merged.md");
  ok("a doc edited on a branch and merged after its claim is caught lying, dated by the merge", ly?.lastCommit?.day === "2026-08-20", JSON.stringify(ly));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[freshness] ${failures} FAILED` : "\n[freshness] all checks passed");
process.exit(failures ? 1 : 0);
