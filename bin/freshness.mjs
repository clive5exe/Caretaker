#!/usr/bin/env node
/**
 * FRESHNESS — P-5 and B-3. Whether a document is current is COMPUTED from git,
 * never declared by a flag someone stops updating the first time they are in
 * a hurry (docs/memory.md, "Status should be DERIVED, not declared").
 *
 * Two different checks, because they catch two different lies:
 *
 *   stale   a SPEC whose `updated:` is older than the last commit touching the
 *           paths it GOVERNS. The code under it moved and it did not. This is
 *           the stronger check: a spec can be untouched and true while the code
 *           it describes changes underneath it.
 *   lying   ANY doc whose `updated:` is older than the last commit touching the
 *           doc ITSELF. Someone edited it and left the date claiming otherwise.
 *
 * Plus the two the drift gate already knows, reported here so one command
 * answers "which documents can I trust":
 *
 *   orphaned  a governs-glob that matches nothing in the tree
 *   unowned   a tracked path no spec claims
 *
 * Dates are compared by DAY, because `updated:` is a date. A commit on the same
 * day as the claimed date is not a lie: the frontmatter cannot say which came
 * first, and a check that guesses would cry wolf on every same-day edit.
 *
 * A doc with no `updated:` is listed as undated, not as stale: it makes no
 * claim, so it cannot be caught lying, and that absence is itself worth seeing.
 *
 * Usage:
 *   node bin/freshness.mjs [--repo .] [--specs specs] [--docs docs,specs] [--json]
 * Exit: 0 nothing stale or lying, 1 something is, 2 misuse.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOwnership, createGlobResolver, findOrphaned, loadSpecs, norm, treeFromGit } from "./drift.mjs";

/** The `updated:` field from a leading `---` frontmatter block, or null. */
export function claimedUpdated(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return null;
  const u = /^updated:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(m[1]);
  return u ? u[1] : null;
}

const gitOut = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

/**
 * The MAIN LINE, with each merge's changes: `--first-parent` walks the branch
 * the repo is on, and `--diff-merges=first-parent` gives a merge the files it
 * brought in. Without them a merge listed no files, and a change that
 * reached the main line by a merge was dated by its branch commit, which can
 * be older than the claim it broke (independent re-review, reproduced in
 * bin/freshness.test.mjs).
 */
const MAIN_LINE = ["--first-parent", "--diff-merges=first-parent"];

/** The last main-line commit touching any of `paths`: { day, sha, subject }, or null if none. */
export function lastCommit(repo, paths) {
  if (!paths.length) return null;
  const out = gitOut(repo, ["log", "-1", ...MAIN_LINE, "--format=%cs%x09%h%x09%s", "--", ...paths]).trim();
  if (!out) return null;
  const [day, sha, ...rest] = out.split("\t");
  return { day, sha, subject: rest.join("\t") };
}

/**
 * The last main-line commit touching anything each spec governs, from the WHOLE history
 * and matched with the SAME resolver ownership uses. History, because a
 * governed file that was deleted is a change the spec should know about.
 * The same resolver, because git's own glob pathspecs matched differently:
 * `src/**.js` owned src/a/b.js yet never made its spec stale, and a directory
 * glob read as both orphaned and stale (independent re-review).
 * Returns Map(specId -> { day, sha, subject }).
 */
export function lastCommitsBySpec(repo, specIds, resolver) {
  const want = new Set(specIds);
  const out = new Map();
  if (!want.size) return out;
  const log = gitOut(repo, ["log", ...MAIN_LINE, "--no-renames", "--name-only", "--format=%x00%cs%x09%h%x09%s"]);
  for (const chunk of log.split("\0")) {
    if (!chunk.trim()) continue;
    const [head, ...files] = chunk.split("\n");
    const [day, sha, ...subject] = head.split("\t");
    for (const f of files.map((x) => x.trim()).filter(Boolean)) {
      for (const m of resolver.matches(f)) {
        if (want.has(m.spec) && !out.has(m.spec)) out.set(m.spec, { day, sha, subject: subject.join("\t") });
      }
    }
    if (out.size === want.size) break;
  }
  return out;
}

/**
 * Everything, computed. `docDirs` are the directories whose markdown is checked
 * for lying dates; every spec is checked too, wherever it lives.
 */
export function freshness({ repo = ".", specsDir = "specs", docDirs = ["docs", "specs"] } = {}) {
  const root = resolve(repo);
  const tree = treeFromGit(root);
  const { specs } = loadSpecs(specsDir, { repo: root });
  const own = buildOwnership(specs);
  const resolver = createGlobResolver(own);

  const stale = [];
  const governed = [];
  const lastBySpec = lastCommitsBySpec(root, specs.filter((s) => s.governs?.length).map((s) => s.id), resolver);
  for (const s of specs) {
    if (!s.governs?.length) continue;
    const paths = tree.filter((p) => resolver.matches(p).some((m) => m.spec === s.id));
    const text = readFileSync(resolve(root, s.id), "utf8");
    const updated = claimedUpdated(text);
    const last = lastBySpec.get(s.id) ?? null;
    const row = { spec: s.id, updated, lastGoverned: last, governedPaths: paths.length };
    governed.push(row);
    if (updated && last && last.day > updated) stale.push(row);
  }

  const inDocs = (p) => /\.mdx?$/.test(p) && docDirs.some((d) => p === norm(d) || p.startsWith(`${norm(d)}/`));
  const specFiles = new Set(specs.map((x) => x.id));
  const lying = [];
  const undated = [];
  for (const p of tree.filter((x) => inDocs(x) || specFiles.has(x))) {
    const updated = claimedUpdated(readFileSync(resolve(root, p), "utf8"));
    if (!updated) {
      undated.push(p);
      continue;
    }
    const last = lastCommit(root, [p]);
    if (last && last.day > updated) lying.push({ doc: p, updated, lastCommit: last });
  }

  const specIds = new Set(own.specIds);
  const unowned = tree.filter((p) => !specIds.has(p) && !inDocs(p) && resolver.owners(p).length === 0);
  return {
    stale,
    lying,
    orphaned: findOrphaned(own, tree),
    unowned,
    undated,
    governed,
    ok: stale.length === 0 && lying.length === 0,
  };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.replace(/^--/, "").split("=")[0];
    if (!["repo", "specs", "docs", "json"].includes(key) || !a.startsWith("--")) {
      console.error(`freshness: unknown argument ${a}\nusage: freshness.mjs [--repo .] [--specs specs] [--docs docs,specs] [--json]`);
      process.exit(2);
    }
    if (key === "json") opt.json = true;
    else opt[key] = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
  }
  let r;
  try {
    r = freshness({ repo: opt.repo ?? ".", specsDir: opt.specs ?? "specs", docDirs: (opt.docs ?? "docs,specs").split(",").map((s) => s.trim()).filter(Boolean) });
  } catch (e) {
    console.error(`freshness: ${e.message}`);
    process.exit(2);
  }
  if (opt.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const s of r.stale) console.log(`STALE   ${s.spec}  says ${s.updated}; code it governs changed ${s.lastGoverned.day} (${s.lastGoverned.sha} ${s.lastGoverned.subject})`);
    for (const l of r.lying) console.log(`LYING   ${l.doc}  says ${l.updated}; last edited ${l.lastCommit.day} (${l.lastCommit.sha})`);
    for (const o of r.orphaned ?? []) console.log(`ORPHAN  ${o.spec}  governs ${o.glob}, which matches nothing`);
    if (r.undated.length) console.log(`UNDATED ${r.undated.length} doc(s) make no updated: claim: ${r.undated.join(", ")}`);
    console.log(`UNOWNED ${r.unowned.length} tracked path(s) no spec claims`);
    console.error(`[freshness] ${r.ok ? "ok" : "FAIL"} — ${r.stale.length} stale, ${r.lying.length} lying`);
  }
  process.exit(r.ok ? 0 : 1);
}
