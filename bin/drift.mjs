#!/usr/bin/env node
/**
 * DRIFT — a governed path changed and its spec did not.
 *
 * H-4. This tool DETECTS and REFUSES. It never edits a spec, and that is the
 * whole design rather than a missing feature: a spec that auto-follows the code
 * is a mirror, and a mirror can never say the code is wrong. Proposing a spec
 * change from a diff is a separate run with a human acceptance step (H-5).
 *
 * NO MODEL IS IN THIS PATH, AND THAT IS A REQUIREMENT, NOT A COST SAVING. A gate
 * must answer the same way twice on the same input, or the first time it is
 * inconvenient somebody re-rolls it until it passes. Noticing that `pricing.ts`
 * changed and `pricing.md` did not is set arithmetic over a diff; the evidence
 * the harness already returns is sufficient. `drift.test.mjs` asserts this file
 * imports no network module and no vendor SDK, and that two runs over the same
 * input produce byte-identical JSON.
 *
 * ---------------------------------------------------------------- the seam
 *
 * Ownership is resolved behind a two-member interface:
 *
 *     resolver = {
 *       kind: string,                       // named in the report
 *       owners(path) -> string[],           // spec ids, sorted, deduped
 *       matches?(path) -> [{spec, glob}],   // optional, only for reporting
 *     }
 *
 * `createGlobResolver` is the crude one and is knowingly crude: **ownership by
 * glob is wrong whenever a spec governs a BEHAVIOUR rather than a directory**,
 * which is most of the time. Concrete cases this gets wrong are listed at the
 * bottom of this comment. A code-graph resolver — call graph, imports, symbol
 * references — resolves them properly and is a later task. It implements the
 * same two members; `analyse()` below takes a resolver and never a glob, so the
 * swap does not touch the gate. That is the extent of the preparation made for
 * it here. The graph is NOT built in this file.
 *
 * What the glob resolver gets wrong in practice, enumerated from this repo and
 * the project this tooling came from (this list is examples, not the full set):
 *
 *   1. SPREAD BEHAVIOUR — a fee rule lives in `lib/pricing.ts`, is re-derived in
 *      a display component and asserted in a QA script. `governs: src/lib/*`
 *      catches one of the three, so changing the other two is silent drift and
 *      the gate reports PASS on the change that actually moved the money.
 *   2. THE INVERSE: A DIRECTORY GLOB OVER-CLAIMS — `src/app/api/checkout/**`
 *      owns the route's whitespace, its imports and its logging as firmly as it
 *      owns the price. Every no-op edit under it demands a spec edit, which is
 *      the noise that gets a gate switched off, which is worse than not having
 *      one. This is why dismissal exists.
 *   3. A MOVE READS AS TWO EVENTS — `git` reports a rename as a delete plus an
 *      add. Moving a governed file out of its glob makes the new path unowned
 *      and leaves the old glob orphaned; the behaviour did not change at all.
 *   4. NEW FILES DEFAULT TO UNGOVERNED — a glob claims what exists when it was
 *      written. The file added today that implements the governed behaviour is
 *      unowned, so the gate is quietest exactly when the code is newest.
 *   5. GENERATED AND VENDORED PATHS match globs as readily as authored ones.
 *   6. TWO SPECS, ONE PATH — an ambiguous owner means the gate cannot name the
 *      document that should have changed, so it refuses rather than picks. A
 *      graph does not fix this one; it is a defect in the spec set.
 *
 * ---------------------------------------------------------------- what blocks
 *
 *   drift              a governed path changed, its governing spec did not.   BLOCKS
 *   conflict (changed) two specs claim a changed path; owner ambiguous.       BLOCKS
 *   spec error         a spec block that does not parse. Its globs cannot be
 *                      trusted, so paths it should own read as unowned and the
 *                      gate silently under-reports. Failing loudly is the only
 *                      safe direction.                                        BLOCKS
 *   unowned            changed path no spec claims.                           reports
 *   orphaned           a glob matching nothing in the tree.                    reports
 *
 * Unowned deliberately does NOT block: on any real repo most files are
 * ungoverned, so blocking on it fails every task from day one and teaches the
 * team to pass `--no-gate`. It is printed because it is the more alarming
 * direction to READ, not the safer one to enforce.
 *
 * ------------------------------------------------------------- dismissal
 *
 * A gate that cries wolf and cannot be dismissed gets switched off, and then
 * there is nothing. So drift can be dismissed — with a reason, never without —
 * and the dismissal lands in the append-only event log (`docs/events.md`). If no
 * event log can be written, a dismissal is REFUSED: an unrecorded dismissal is
 * an off-switch, and the recording is the only thing separating the two.
 *
 * Known weakness, not solved here: a dismissal matches by path glob, so it also
 * silences the NEXT unrelated change to that path until it is removed. `task:`
 * narrows one to a single board item, which is the mitigation on offer.
 *
 * Usage:
 *   node bin/drift.mjs check [--specs specs] [--repo .] [--git HEAD|A..B]
 *                            [--diff FILE|-] [--path P ...] [--task T-1] [--run r_x]
 *                            [--dismiss GLOB --reason "..." [--by who] [--dismiss-task T-1]]
 *                            [--dismiss-file F] [--events DIR | --no-events]
 *                            [--tree-file F | --no-tree] [--ignore GLOB ...] [--quiet]
 *   node bin/drift.mjs map     [--specs specs] [--repo .]
 *   node bin/drift.mjs explain <path> [--specs specs] [--repo .]
 *
 * JSON on stdout, one summary line on stderr. Exit 0 clean, 1 blocked, 2 misuse.
 */
import {
  readFileSync, readdirSync, existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSpec, extractBlock, globToRegExp } from "./spec.mjs";
import { append as appendEvents } from "./events.mjs";

/* ------------------------------------------------------------------- paths */

/** One spelling of a path, so a Set can be trusted. Posix, no `./`, no trailing slash. */
export const norm = (p) =>
  String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

const uniqSort = (xs) => [...new Set(xs)].sort();

/* ------------------------------------------------------------------ specs */

/**
 * Every spec under `specsDir`, as `{ id, governs, errors }`.
 *
 * A markdown file with NO ```spec block is not a spec and is skipped rather than
 * failed — a README in the specs directory is not a broken spec. The fenced
 * block is the declaration of intent, so its presence is what makes a file
 * subject to the parser. A file that HAS one and does not parse is an error.
 */
export function loadSpecs(specsDir, { repo = "." } = {}) {
  const root = resolve(repo);
  const dir = resolve(root, specsDir);
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mdx?$/.test(e.name)) files.push(p);
    }
  };
  walk(dir);

  const specs = [];
  const skipped = [];
  for (const p of files) {
    const id = norm(relative(root, p));
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch (err) {
      specs.push({ id, governs: [], errors: [`unreadable: ${err.message}`] });
      continue;
    }
    if (extractBlock(text) === null) {
      skipped.push(id);
      continue;
    }
    const { ok, errors, spec } = parseSpec(text);
    // The globs are used even when the parse failed: a spec with one bad line
    // still tells us what it claims, and dropping its claims would turn its
    // paths into false "unowned" rows on top of the error already reported.
    specs.push({ id, governs: (spec?.governs ?? []).map(norm), errors: ok ? [] : errors });
  }
  return { specs, skipped };
}

/** Flatten specs into claims. One claim is one glob from one spec. */
export function buildOwnership(specs) {
  const claims = [];
  for (const s of specs) {
    for (const glob of s.governs) {
      claims.push({ spec: s.id, glob, re: globToRegExp(glob) });
    }
  }
  return {
    claims,
    specIds: uniqSort(specs.map((s) => s.id)),
    errors: specs.flatMap((s) => s.errors.map((error) => ({ spec: s.id, error }))),
  };
}

/**
 * The crude resolver. See the seam note in the file header for what it gets
 * wrong and why it is still what ships first.
 */
export function createGlobResolver(ownership) {
  return {
    kind: "glob",
    owners(path) {
      const p = norm(path);
      return uniqSort(ownership.claims.filter((c) => c.re.test(p)).map((c) => c.spec));
    },
    matches(path) {
      const p = norm(path);
      return ownership.claims
        .filter((c) => c.re.test(p))
        .map(({ spec, glob }) => ({ spec, glob }))
        .sort((a, b) => (a.spec + a.glob < b.spec + b.glob ? -1 : 1));
    },
  };
}

/* ------------------------------------------------------------- dismissals */

/**
 * A dismissal is `{ path, reason, by?, task? }`. `path` is a glob.
 *
 * A reason is mandatory and is checked here rather than at the call site,
 * because every entry point — flag, file, or library caller — must go through
 * the same refusal. "Dismissed" with no reason is indistinguishable from the
 * gate being off.
 */
export function validateDismissals(list) {
  const errors = [];
  const clean = [];
  list.forEach((d, i) => {
    const where = `dismissal ${i + 1}`;
    if (!d || typeof d !== "object") return void errors.push(`${where}: not an object`);
    if (!d.path) return void errors.push(`${where}: needs a path (a glob) to dismiss`);
    if (!d.reason || !String(d.reason).trim()) {
      return void errors.push(
        `${where}: "${d.path}" has no reason. A dismissal without a recorded reason is ` +
          "an off-switch, and the record is the only thing that distinguishes them.",
      );
    }
    clean.push({
      path: norm(d.path),
      reason: String(d.reason).trim(),
      ...(d.by ? { by: String(d.by) } : {}),
      ...(d.task ? { task: String(d.task) } : {}),
    });
  });
  return { dismissals: clean, errors };
}

/* ----------------------------------------------------------------- decide */

/**
 * The gate. Pure: no fs, no git, no clock — so the same input gives the same
 * report, which is the property `--json` consumers depend on.
 *
 * `tree` is the full file listing when one is available, and `null` when it is
 * not. It is not defaulted to `[]`: with no listing, "which globs match nothing"
 * is unanswerable, and `orphaned: []` would assert an empty set that was never
 * enumerated. `null` plus a note says so instead.
 */
export function analyse({
  resolver,
  changed = [],
  specIds = [],
  tree = null,
  dismissals = [],
  ignore = [],
  task = null,
  specErrors = [],
}) {
  const ignoreRes = ignore.map((g) => globToRegExp(norm(g)));
  const ignored = (p) => ignoreRes.some((re) => re.test(p));

  const changedSet = new Set(changed.map(norm));
  const specSet = new Set(specIds.map(norm));
  const notes = [];

  // A changed spec is a touched DOCUMENT, not governed code, so it is not itself
  // examined for drift. Consequence, stated because it is a real gap: if spec A
  // governs the path of spec B, editing B without editing A is not reported.
  const touchedSpecs = [...changedSet].filter((p) => specSet.has(p)).sort();
  const considered = [...changedSet].filter((p) => !specSet.has(p) && !ignored(p)).sort();

  const used = new Set();
  const findDismissal = (p) => {
    for (let i = 0; i < dismissals.length; i++) {
      const d = dismissals[i];
      if (d.task && d.task !== task) continue; // scoped to another board item
      if (globToRegExp(d.path).test(p)) {
        used.add(i);
        return d;
      }
    }
    return null;
  };

  const drift = [];
  const dismissed = [];
  const conflicts = [];
  const unowned = [];

  for (const path of considered) {
    const owners = resolver.owners(path);
    if (owners.length === 0) {
      unowned.push(path);
      continue;
    }
    if (owners.length > 1) {
      const d = findDismissal(path);
      const row = { path, specs: owners, changed: true };
      conflicts.push(d ? { ...row, dismissed: true } : row);
      if (d) {
        dismissed.push({
          path, finding: "conflict", specs: owners,
          reason: d.reason, ...(d.by ? { by: d.by } : {}), dismissal: d.path,
        });
      }
      continue;
    }
    const spec = owners[0];
    if (changedSet.has(spec)) continue; // the governing document moved with it
    const glob = resolver.matches?.(path)?.find((m) => m.spec === spec)?.glob ?? null;
    const d = findDismissal(path);
    if (d) {
      dismissed.push({
        path, finding: "drift", spec, glob,
        reason: d.reason, ...(d.by ? { by: d.by } : {}), dismissal: d.path,
      });
    } else {
      drift.push({ path, spec, glob });
    }
  }

  // Census over the whole tree: conflicts that have not been touched yet, and
  // the unowned inverse. Non-blocking — a latent overlap somewhere else in the
  // repo is not this task's fault and must not fail it.
  let unownedTree = null;
  if (tree) {
    const all = uniqSort(tree.map(norm)).filter((p) => !specSet.has(p) && !ignored(p));
    unownedTree = [];
    for (const path of all) {
      const owners = resolver.owners(path);
      if (owners.length === 0) unownedTree.push(path);
      else if (owners.length > 1 && !changedSet.has(path)) {
        conflicts.push({ path, specs: owners, changed: false });
      }
    }
  } else {
    notes.push(
      "no file listing was supplied, so orphaned globs and repo-wide unowned code " +
        "were not computed — they are null rather than empty",
    );
  }

  const blockingConflicts = conflicts.filter((c) => c.changed && !c.dismissed);
  const ok =
    drift.length === 0 && blockingConflicts.length === 0 && specErrors.length === 0;

  return {
    ok,
    resolver: resolver.kind,
    counts: {
      specs: specSet.size,
      changed: changedSet.size,
      considered: considered.length,
      touchedSpecs: touchedSpecs.length,
    },
    drift: drift.sort((a, b) => (a.path < b.path ? -1 : 1)),
    dismissed: dismissed.sort((a, b) => (a.path < b.path ? -1 : 1)),
    conflicts: conflicts.sort((a, b) => (a.path < b.path ? -1 : 1)),
    unowned,
    unownedTree,
    // Filled by `gate()` from `findOrphaned`. `null` here means NOT COMPUTED,
    // which is a different claim from "there are none" and is why it is not [].
    orphaned: null,
    touchedSpecs,
    unusedDismissals: dismissals
      .filter((_, i) => !used.has(i))
      .map(({ path, reason }) => ({ path, reason })),
    specErrors,
    notes,
  };
}

/**
 * The whole gate in one call, for anything that already has the specs in hand.
 * The CLI and the tests both go through here so they cannot drift apart.
 */
export function gate({ specs, changed = [], tree = null, dismissals = [], ignore = [], task = null }) {
  const ownership = buildOwnership(specs);
  const resolver = createGlobResolver(ownership);
  const report = analyse({
    resolver,
    changed,
    specIds: ownership.specIds,
    tree,
    dismissals,
    ignore,
    task,
    specErrors: ownership.errors,
  });
  report.orphaned = findOrphaned(ownership, tree);
  return report;
}

/**
 * Orphaned globs — claims matching nothing in the tree. Separate from
 * `analyse()` because it is a property of the ownership map and the tree, not of
 * the diff, and folding it in would have made the pure function need the claims.
 */
export function findOrphaned(ownership, tree) {
  if (!tree) return null;
  const paths = tree.map(norm);
  return ownership.claims
    .filter((c) => !paths.some((p) => c.re.test(p)))
    .map(({ spec, glob }) => ({ spec, glob }))
    .sort((a, b) => (a.spec + a.glob < b.spec + b.glob ? -1 : 1));
}

/* ------------------------------------------------------------------ events */

const summary = (r) =>
  `drift ${r.drift.length}, dismissed ${r.dismissed.length}, ` +
  `blocking conflicts ${r.conflicts.filter((c) => c.changed && !c.dismissed).length}, ` +
  `spec errors ${r.specErrors.length}, unowned ${r.unowned.length} ` +
  `of ${r.counts.considered} governed-code path(s) changed`;

/**
 * The report as event-log lines (`docs/events.md` shape). Pure; the clock is an
 * argument so this is testable and so two callers cannot disagree about `t`.
 *
 * The dismissal lines are the point of this function. The gate verdict alone
 * cannot answer "who waved this through and why", and that question is asked
 * months later, which is exactly when nothing but the log survives.
 */
export function eventLines(report, { at, run = null, task = null, stage = "review" } = {}) {
  const base = {
    t: at ?? new Date().toISOString(),
    ...(run ? { run } : {}),
    ...(task ? { task } : {}),
    stage,
  };
  const lines = [];
  for (const d of report.drift) {
    lines.push({ ...base, kind: "drift", level: "warn",
      detail: `${d.path} changed, ${d.spec} did not` });
  }
  for (const c of report.conflicts.filter((x) => x.changed && !x.dismissed)) {
    lines.push({ ...base, kind: "drift", level: "error",
      detail: `${c.path} is claimed by ${c.specs.length} specs (${c.specs.join(", ")}), so the gate cannot name the document that should have changed` });
  }
  for (const e of report.specErrors) {
    lines.push({ ...base, kind: "drift", level: "error",
      detail: `${e.spec} does not parse: ${e.error}` });
  }
  for (const d of report.dismissed) {
    lines.push({ ...base, kind: "drift", level: "info",
      detail: `dismissed ${d.finding} on ${d.path}${d.by ? ` by ${d.by}` : ""}: ${d.reason}` });
  }
  lines.push({ ...base, kind: "gate", level: report.ok ? "info" : "error",
    verdict: report.ok ? "pass" : "fail", detail: summary(report) });
  return lines;
}

/**
 * Append through the one event writer (`bin/events.mjs`), which validates each
 * line and rotates it by its own `t`. Returns the first file written, or null.
 *
 * A spec's parse error or a dismissal's reason can span lines, and the writer
 * refuses a multi-line `detail`. Folding them here keeps a dismissal from
 * being refused over its formatting, which the CLI would report as "could not
 * be recorded".
 */
export function writeEvents(dir, lines) {
  const oneLine = lines.map((l) => ({ ...l, detail: String(l.detail).replace(/\s*[\r\n]+\s*/g, " ") }));
  return appendEvents(dir, oneLine)[0] ?? null;
}

/* --------------------------------------------------------------------- git */

const git = (repo, args) =>
  execFileSync("git", ["-C", resolve(repo), ...args], { encoding: "utf8" })
    .split("\n")
    .map(norm)
    .filter(Boolean);

/**
 * Changed paths. With no ref: everything uncommitted, PLUS untracked files —
 * `git diff` does not list a new file, and a new governed file with no spec
 * change is drift by exactly the same argument as an edited one.
 */
export function changedFromGit(repo, ref = null) {
  const diff = ref ? git(repo, ["diff", "--name-only", ref]) : git(repo, ["diff", "--name-only", "HEAD"]);
  const untracked = ref ? [] : git(repo, ["ls-files", "--others", "--exclude-standard"]);
  return uniqSort([...diff, ...untracked]);
}

export function treeFromGit(repo) {
  return uniqSort(git(repo, ["ls-files"]));
}

/* --------------------------------------------------------------------- cli */

const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntry) {
  const USAGE = `usage:
  drift.mjs check   [--specs DIR] [--repo DIR] [--git REF] [--diff FILE|-] [--path P ...]
                    [--dismiss GLOB --reason TEXT [--by WHO] [--dismiss-task T-1]]
                    [--dismiss-file F] [--events DIR | --no-events] [--task T-1] [--run r_x]
                    [--tree-file F | --no-tree] [--ignore GLOB ...] [--quiet]
  drift.mjs map     [--specs DIR] [--repo DIR]
  drift.mjs explain <path> [--specs DIR] [--repo DIR]`;

  const die = (msg, code = 2) => {
    console.error(`drift: ${msg}`);
    process.exit(code);
  };

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || !["check", "map", "explain"].includes(cmd)) die(USAGE);

  const VALUE = new Set([
    "specs", "repo", "git", "diff", "path", "task", "run", "events",
    "dismiss", "reason", "by", "dismiss-task", "dismiss-file", "tree-file", "ignore",
  ]);
  const BOOL = new Set(["no-events", "no-tree", "quiet", "staged"]);

  const opt = { path: [], ignore: [], dismiss: [] };
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const val = eq === -1 ? undefined : a.slice(eq + 1);
    if (BOOL.has(key)) {
      opt[key] = true;
      continue;
    }
    if (!VALUE.has(key)) die(`unknown flag --${key}\n${USAGE}`);
    const v = val ?? argv[++i];
    if (v === undefined) die(`--${key} needs a value`);
    if (key === "path" || key === "ignore") opt[key].push(v);
    else if (key === "dismiss") opt.dismiss.push({ path: v });
    else if (key === "reason" || key === "by" || key === "dismiss-task") {
      const last = opt.dismiss[opt.dismiss.length - 1];
      if (!last) die(`--${key} must follow a --dismiss`);
      last[key === "dismiss-task" ? "task" : key] = v;
    } else opt[key] = v;
  }

  const repo = opt.repo ?? ".";
  const specsDir = opt.specs ?? "specs";
  const { specs, skipped } = loadSpecs(specsDir, { repo });
  const ownership = buildOwnership(specs);
  const resolver = createGlobResolver(ownership);

  if (cmd === "map") {
    console.log(JSON.stringify({
      resolver: resolver.kind,
      specs: specs.map((s) => ({ spec: s.id, governs: s.governs, errors: s.errors })),
      skipped,
    }, null, 2));
    process.exit(ownership.errors.length ? 1 : 0);
  }

  if (cmd === "explain") {
    const p = positional[0];
    if (!p) die("explain needs a path");
    const owners = resolver.owners(p);
    console.log(JSON.stringify({
      path: norm(p), owners, matched: resolver.matches(p),
      verdict: owners.length === 0 ? "unowned" : owners.length > 1 ? "conflict" : "owned",
    }, null, 2));
    process.exit(owners.length === 1 ? 0 : 1);
  }

  /* ------------------------------------------------------------- check */

  let changed;
  if (opt.diff) {
    const raw = opt.diff === "-" ? readFileSync(0, "utf8") : readFileSync(opt.diff, "utf8");
    changed = uniqSort(raw.split("\n").map(norm).filter(Boolean));
  } else if (opt.path.length) {
    changed = uniqSort(opt.path.map(norm));
  } else {
    try {
      changed = changedFromGit(repo, opt.git ?? null);
    } catch (e) {
      die(`no --diff/--path given and git failed: ${e.message}`);
    }
  }

  let tree = null;
  if (opt["tree-file"]) {
    tree = uniqSort(readFileSync(opt["tree-file"], "utf8").split("\n").map(norm).filter(Boolean));
  } else if (!opt["no-tree"]) {
    try {
      tree = treeFromGit(repo);
    } catch {
      tree = null; // analyse() reports this as a note rather than an empty set
    }
  }

  const fileDismissals = [];
  if (opt["dismiss-file"]) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(opt["dismiss-file"], "utf8"));
    } catch (e) {
      die(`--dismiss-file ${opt["dismiss-file"]}: ${e.message}`);
    }
    const arr = Array.isArray(parsed) ? parsed : parsed?.dismissals;
    if (!Array.isArray(arr)) die("--dismiss-file must hold an array, or { dismissals: [...] }");
    fileDismissals.push(...arr);
  }
  const { dismissals, errors: dErrors } = validateDismissals([...fileDismissals, ...opt.dismiss]);
  if (dErrors.length) die(dErrors.join("\n        "));

  // An unrecorded dismissal is an off-switch. Refuse rather than proceed.
  if (dismissals.length && opt["no-events"]) {
    die("a dismissal must be recorded, so --no-events cannot be combined with --dismiss");
  }

  const report = gate({
    specs,
    changed,
    tree,
    dismissals,
    ignore: [...opt.ignore, `${norm(specsDir)}/**`],
    task: opt.task ?? null,
  });
  report.skippedFiles = skipped;

  let logged = null;
  if (!opt["no-events"]) {
    const dir = opt.events ?? join(resolve(repo), "ops", "caretaker", "events");
    try {
      logged = writeEvents(dir, eventLines(report, { run: opt.run ?? null, task: opt.task ?? null }));
    } catch (e) {
      if (dismissals.length) die(`a dismissal could not be recorded (${e.message}); refusing`);
      console.error(`drift: warning — could not write the event log (${e.message})`);
    }
  }
  report.eventLog = logged;

  console.log(JSON.stringify(report, null, 2));
  if (!opt.quiet) {
    console.error(`[drift] ${report.ok ? "pass" : "FAIL"} — ${summary(report)}` +
      (logged ? ` → ${logged}` : ""));
  }
  process.exit(report.ok ? 0 : 1);
}
