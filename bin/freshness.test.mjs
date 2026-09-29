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

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[freshness] ${failures} FAILED` : "\n[freshness] all checks passed");
process.exit(failures ? 1 : 0);
