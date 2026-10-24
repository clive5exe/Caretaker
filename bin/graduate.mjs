#!/usr/bin/env node
/**
 * GRADUATE — G-1, and P-4's "why is this like this". What a project looks like
 * when it is handed to someone else, generated from what actually happened
 * rather than from what a scaffolder guessed at `init`.
 *
 *   decisions  an index of docs/decisions/*.md: status, what supersedes what.
 *              A dangling `supersedes` is reported, not rendered as a link to
 *              nothing. Decisions are superseded, never edited (docs/memory.md):
 *              a decided ADR whose text changed in a later commit is reported,
 *              with the commit.
 *   why <path> the specs that govern a path and the decisions that explain it —
 *              answered from the decision record, without reading the log.
 *   ci         a workflow built from the checks this repo RAN (a passing
 *              verdict's `ran` list, or the drift gate's own events),
 *              each step carrying the evidence it was taken from. If there is no
 *              evidence of any check, no workflow is written: an empty or
 *              placeholder CI file claims a gate that does not exist.
 *   docs       a static site from the specs that really exist: each spec, what
 *              it governs, whether it can be trusted (freshness), and the
 *              decision index. No template text anywhere in the output.
 *
 * Output goes to a directory (default `graduate/`), never over the project's
 * own files: the project itself is refused as --out, and so is a directory
 * holding files graduate did not write. What to adopt is the person's call.
 *
 * Usage:
 *   node bin/graduate.mjs all  [--repo .] [--out graduate] [--specs specs]
 *   node bin/graduate.mjs why  <path> [--repo .]
 *   node bin/graduate.mjs decisions [--repo .]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOwnership, createGlobResolver, loadSpecs, norm } from "./drift.mjs";
import * as events from "./events.mjs";
import { freshness } from "./freshness.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DECISIONS_DIR = "docs/decisions";

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/* ------------------------------------------------------------ decisions */

/**
 * P-4's other tier rule: a SPEC carries current state only. A changelog, a
 * history section or a dated list of changes in a spec is the log leaking
 * into it, and a spec that grows one stops being read (docs/memory.md).
 * Declared shapes only: a heading named for history, or list items that
 * start with a date. [{ file, line, text }].
 */
const HISTORY_HEADING = /^#{1,6}\s*(change ?log|change history|history|revision history|revisions?|changes|release notes)\b/i;
// A heading holding a date: "## 2026-09-01", keep-a-changelog's
// "## [1.0.0] - 2026-09-01". A version alone is not taken: "## 1.2.3 Retry"
// is how numbered specs title sections.
const DATED_HEADING = /^#{1,6}\s.*\b\d{4}-\d{2}-\d{2}\b/;
// A bulleted or numbered item, or a table row, that STARTS with a date. A
// date later in the line is a value, not an entry.
const DATED_ITEM = /^\s*(?:[-*+]|\d+[.)])\s*[*_[]*\d{4}-\d{2}-\d{2}\b/;
const DATED_ROW = /^\s*\|\s*[*_[]*\d{4}-\d{2}-\d{2}\b/;
export function specHistory(root, specsDir = "specs") {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(join(root, d), { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const rel = `${d}/${n.name}`;
      if (n.isDirectory()) walk(rel);
      else if (/\.mdx?$/.test(n.name)) {
        const lines = readFileSync(join(root, rel), "utf8").split(/\r?\n/);
        let fence = false;
        lines.forEach((l, i) => {
          if (/^\s*```/.test(l)) fence = !fence;
          if (!fence && [HISTORY_HEADING, DATED_HEADING, DATED_ITEM, DATED_ROW].some((re) => re.test(l))) out.push({ file: rel, line: i + 1, text: l.trim() });
        });
      }
    }
  };
  walk(specsDir);
  return out;
}

/** Every ADR, with what supersedes it computed from the others, and problems named. */
export function decisions(root, { specsDir = "specs" } = {}) {
  const dir = join(root, DECISIONS_DIR);
  // Removals first: deleting the LAST decision takes the directory with it,
  // and returning early on that hid the deletion (independent re-review).
  const where = (g) => (g.sha ? `${g.sha.slice(0, 8)} ${g.day} "${g.subject}"` : "uncommitted, in the working tree");
  const removed = deletedDecisions(root).map((g) =>
    g.movedTo
      ? `${g.file} was MOVED OUT of the decision record (to ${g.movedTo}) after it was decided (${g.status}): ${where(g)}. A decision is superseded, never removed`
      : `${g.file} was DELETED after it was decided (${g.status}): ${where(g)}. A decision is superseded, never removed`,
  );
  // A spec that carries history belongs in the same report: both are one
  // tier holding what another tier should (independent re-review).
  for (const h of specHistory(root, specsDir)) removed.push(`${h.file}:${h.line} carries history ("${h.text.slice(0, 60)}"). A spec says what is true now; what changed belongs in the log or a decision`);
  if (!existsSync(dir)) return { list: [], problems: removed };
  const list = readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const fm = frontmatter(text);
      const id = `ADR-${f.slice(0, 4)}`;
      const sup = [...String(fm.supersedes ?? "").matchAll(/ADR-\d{4}/g)].map((m) => m[0]);
      return { id, file: `${DECISIONS_DIR}/${f}`, title: fm.title ?? f, status: fm.status ?? null, updated: fm.updated ?? null, supersedes: sup, supersedesText: fm.supersedes ?? null, supersededBy: [], text };
    });
  const byId = new Map(list.map((d) => [d.id, d]));
  const problems = [];
  // Bare "superseded" is not a status: what superseded it has to be named,
  // or the record points nowhere (independent re-review).
  const STATUSES = /^(draft|proposed|accepted|rejected|superseded-by: ADR-\d{4})$/;
  for (const d of list) {
    if (!d.status) problems.push(`${d.id} has no status`);
    else if (!STATUSES.test(d.status)) problems.push(`${d.id} has status "${d.status}", which is not draft, proposed, accepted, rejected or superseded-by: ADR-NNNN`);
    for (const s of d.supersedes) {
      const target = byId.get(s);
      if (!target) problems.push(`${d.id} supersedes ${s}, which does not exist`);
      else target.supersededBy.push(d.id);
    }
  }
  for (const d of list) {
    const says = /^superseded-by: (ADR-\d{4})$/.exec(d.status ?? "");
    if (says && !byId.has(says[1])) problems.push(`${d.id} says it is superseded by ${says[1]}, which does not exist`);
    if (says && !d.supersededBy.includes(says[1])) problems.push(`${d.id} says it is superseded by ${says[1]}, but ${says[1]} does not say it supersedes ${d.id}`);
  }
  problems.push(...removed);
  for (const d of list) {
    for (const e of editsAfterDecided(root, d.file) ?? []) {
      const at = e.sha ? `${e.sha.slice(0, 8)} ${e.day} "${e.subject}"` : "uncommitted change in the working tree";
      problems.push(
        e.statusTo !== undefined
          ? `${d.id} changed status from ${e.status} to ${e.statusTo || "(none)"} after it was decided: ${at}. Once decided, a record's status only moves to superseded-by: ADR-NNNN`
          : `${d.id} was edited after it was decided (${e.status}): ${at}. Write a new decision that supersedes it instead`,
      );
    }
  }
  return { list, problems };
}

// A decision may still change while draft or proposed. After that only its
// `status:` (to superseded-by) and `updated:` lines may: superseding one has to
// rewrite its status, and nothing else.
const UNDECIDED = /^(draft|proposed)$/;
// Only the FRONTMATTER's status and updated lines may change: a body line that
// happens to start "updated:" is text like any other (independent review).
const decidedText = (text) =>
  String(text).replace(/^---\r?\n[\s\S]*?\r?\n---/, (fm) => fm.replace(/^(status|updated):.*$/gm, ""));

/**
 * Decision records deleted after they were decided, or renamed to a path that
 * is no longer a decision record (docs/decisions/x.md, or a subdirectory like
 * archive/), which drops them from the index as surely as deleting them.
 * [] outside git.
 */
export function deletedDecisions(root) {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return [];
  // -M: a rename is not a deletion, even where a person's config turns
  // rename detection off. A rewrite past git's rename threshold still reads
  // as a deletion, and is reported as one.
  const log = git("log", "-M", "--diff-filter=DR", "--name-status", "--format=%x00%H%x09%cs%x09%s", "--", DECISIONS_DIR);
  const RECORD = /^docs\/decisions\/\d{4}-[^/]*\.md$/;
  const out = [];
  for (const chunk of log.stdout.split("\0").filter((c) => c.trim())) {
    const [head, ...rest] = chunk.split("\n");
    const [sha, day, ...subject] = head.split("\t");
    for (const line of rest.map((l) => l.trim()).filter(Boolean)) {
      const [kind, file, to] = line.split("\t");
      if (!RECORD.test(file ?? "")) continue;
      if (kind.startsWith("R") && RECORD.test(to ?? "")) continue; // still a record; --follow checks its text
      const before = git("show", `${sha}^:${file}`).stdout;
      const status = frontmatter(before).status ?? "";
      if (status && !UNDECIDED.test(status)) out.push({ file, sha, day, subject: subject.join("\t"), status, ...(kind.startsWith("R") ? { movedTo: to } : {}) });
    }
  }
  // Not yet committed: HEAD against the working tree, staged or not. An
  // uncommitted edit was already reported and an uncommitted rm or git mv was
  // silent (independent re-review). No HEAD yet means nothing was decided.
  if (git("rev-parse", "--verify", "-q", "HEAD").status === 0) {
    const wt = git("diff", "-M", "--diff-filter=DR", "--name-status", "HEAD", "--", DECISIONS_DIR);
    for (const line of wt.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [kind, file, to] = line.split("\t");
      if (!RECORD.test(file ?? "")) continue;
      if (kind.startsWith("R") && RECORD.test(to ?? "")) continue;
      const status = frontmatter(git("show", `HEAD:${file}`).stdout).status ?? "";
      if (status && !UNDECIDED.test(status)) out.push({ file, sha: null, day: null, subject: null, status, ...(kind.startsWith("R") ? { movedTo: to } : {}) });
    }
  }
  return out;
}

/**
 * The commits (and a working-tree change) that altered a decision's text after
 * its status left draft/proposed. [] if none; null outside a git checkout.
 */
export function editsAfterDecided(root, file) {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return null;
  // --follow: a decision renamed while it was rewritten is still that decision
  // (independent review: a rename plus a body change raised nothing). Each
  // commit's own path is read from --name-only, since it changes at the rename.
  // Not --reverse: git ignores the rename with --follow --reverse, so the
  // oldest-first order is made here.
  const log = git("log", "--follow", "--name-only", "--format=%x00%H%x09%cs%x09%s", "--", file);
  if (log.status !== 0) return null;
  const edits = [];
  let decided = null;
  const states = log.stdout.split("\0").filter((c) => c.trim()).map((chunk) => {
    const [head, ...rest] = chunk.split("\n");
    const [sha, day, ...subject] = head.split("\t");
    const path = rest.map((l) => l.trim()).filter(Boolean).at(-1) ?? file;
    return { sha, day, subject: subject.join("\t"), text: git("show", `${sha}:${path}`).stdout };
  }).reverse();
  const abs = join(root, file);
  if (existsSync(abs)) {
    const now = readFileSync(abs, "utf8");
    if (!states.length || now !== states.at(-1).text) states.push({ sha: null, day: null, subject: null, text: now });
  }
  for (const st of states) {
    const status = frontmatter(st.text).status ?? "";
    if (decided === null) {
      if (status && !UNDECIDED.test(status)) decided = { text: decidedText(st.text), status };
      continue;
    }
    // The status may move once, to superseded-by. Any other change of it
    // after deciding rewrites the decision (independent re-review: accepted ->
    // proposed, -> rejected and -> bare superseded all passed).
    if (status !== decided.status) {
      const superseding = /^superseded-by: ADR-\d{4}$/.test(status) && !/^superseded-by:/.test(decided.status);
      if (!superseding) edits.push({ sha: st.sha, day: st.day, subject: st.subject, status: decided.status, statusTo: status });
      decided.status = status;
    }
    const t = decidedText(st.text);
    if (t !== decided.text) {
      edits.push({ sha: st.sha, day: st.day, subject: st.subject, status: decided.status });
      decided.text = t;
    }
  }
  return edits;
}

/**
 * Why is `path` like this? The governing specs, the decisions they cite, and
 * the decisions that name the path or its spec. Each answer says how it was
 * found, so a reader can check the link rather than trust it.
 */
export function why(root, path, { specsDir = "specs" } = {}) {
  const p = norm(path);
  const { specs } = loadSpecs(specsDir, { repo: root });
  const own = buildOwnership(specs);
  const resolver = createGlobResolver(own);
  const governing = resolver.matches(p).map((m) => ({ spec: m.spec, glob: m.glob }));
  const { list } = decisions(root);
  const found = new Map();
  const add = (d, how) => {
    if (!found.has(d.id)) found.set(d.id, { id: d.id, title: d.title, status: d.status, file: d.file, supersededBy: d.supersededBy, how: [] });
    found.get(d.id).how.push(how);
  };
  for (const g of governing) {
    const specText = readFileSync(join(root, g.spec), "utf8");
    for (const ref of new Set(specText.match(/ADR-\d{4}/g) ?? [])) {
      const d = list.find((x) => x.id === ref);
      if (d) add(d, `cited by ${g.spec}, which governs ${p}`);
    }
    for (const d of list) if (d.text.includes(g.spec)) add(d, `names ${g.spec}, which governs ${p}`);
  }
  for (const d of list) if (d.text.includes(p)) add(d, `names ${p}`);
  // Decisions name files the way people say them — `egress.mjs`, not
  // `bin/egress.mjs`. The bare name counts only when it is specific (has an
  // extension), and the answer says that is how it matched.
  const base = p.split("/").pop();
  if (base !== p && /\.[A-Za-z0-9]+$/.test(base) && base.length > 4) {
    for (const d of list) if (!d.text.includes(p) && new RegExp(`(^|[^A-Za-z0-9_./-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(d.text)) add(d, `names ${base} (the file's name, not its path)`);
  }
  return { path: p, governing, decisions: [...found.values()] };
}

/* ------------------------------------------------------------------- ci */

/**
 * The checks this repo really runs, each with where the evidence came from.
 * Nothing is included on the strength of a convention alone.
 */
/*
 * A step is written only for a check this repo RAN, and only with a script
 * the repo has (independent QA: steps came from file presence, and called
 * bin/drift.mjs and ops/caretaker/board.mjs in repos without them):
 *   - a test file or npm script a passing gate verdict lists in `ran`
 *     (board.mjs <gate> <id> pass "note" --ran "node bin/x.test.mjs");
 *   - the drift gate, from its own gate events, run with this repo's drift.mjs.
 * Anything seen but not runnable here goes to `skipped`, with the reason.
 *
 * NOT FROM PROSE. Commands were read out of a verdict's note, and no wording
 * rule holds: "passes, but I skipped npm run deploy and node bin/b.test.mjs is
 * broken" put deploy and a failing test in CI on every push (independent
 * re-review, three rounds). A note is for people; `ran` is the record.
 */
const DRIFT_SUMMARY = /^drift \d+, dismissed \d+, blocking conflicts \d+, spec errors \d+, unowned \d+ of \d+ governed-code path\(s\) changed$/;
// The whole entry, not a fragment of it: `npm run deploy && rm -rf /` is not
// an npm script, and nothing is cut out of a longer command.
const RUNNABLE = /^(?:node\s+([\w./-]+\.test\.m?js)|npm\s+(?:run\s+)?([\w:-]+))$/;

/** Commands passing verdicts list as run: Map(cmd -> {file?, script?, where}). Others go to `skipped`. */
function ranInGates(board, skipped = []) {
  const out = new Map();
  for (const ph of board?.phases ?? []) {
    for (const t of ph.tasks ?? []) {
      for (const [gate, rec] of Object.entries(t.gate ?? {})) {
        for (const v of [...(rec.history ?? []), rec]) {
          if (v.verdict !== "pass" || !Array.isArray(v.ran)) continue;
          const where = `${t.id} ${gate}${v.at ? ` ${v.at}` : ""}`;
          for (const raw of v.ran) {
            const cmd = String(raw).trim().replace(/\s+/g, " ");
            const m = RUNNABLE.exec(cmd);
            if (!m) {
              skipped.push(`ci: \`${cmd}\` is listed as run by ${where}, but only \`node <file>.test.mjs\` and \`npm [run] <script>\` become steps`);
              continue;
            }
            const script = m[2] ?? null;
            const key = m[1] ? `node ${m[1]}` : `npm ${script === "test" ? "test" : `run ${script}`}`;
            const cur = out.get(key) ?? { file: m[1] ?? null, script, where: [] };
            cur.where.push(where);
            out.set(key, cur);
          }
        }
      }
    }
  }
  return out;
}

export function evidence(root, { specsDir = "specs", skipped = [] } = {}) {
  const steps = [];
  const has = (p) => existsSync(join(root, p));
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const cfgPath = ["ops/caretaker/config.json"].find(has);
  const cfg = cfgPath ? read(cfgPath) : {};
  const boardPath = cfg.board ?? "docs/board.json";
  const named = ranInGates(has(boardPath) ? read(boardPath) : null, skipped);
  const scripts = has("package.json") ? (read("package.json").scripts ?? {}) : {};
  const seen = (w) => `${w.length} gate verdict(s): ${w.slice(0, 3).join(", ")}${w.length > 3 ? ", …" : ""}`;

  const tests = [...named].filter(([, n]) => n.file);
  const runnable = tests.filter(([, n]) => has(n.file));
  for (const [cmd] of tests.filter(([, n]) => !has(n.file))) skipped.push(`ci: \`${cmd}\` is listed as run in a gate verdict, but the file is not in this repo`);
  if (runnable.length) {
    steps.push({
      name: "tests",
      run: runnable.map(([cmd]) => cmd).join(" && "),
      evidence: `${runnable.length} test file(s) listed as run in ${seen(runnable.flatMap(([, n]) => n.where))}`,
    });
  }
  for (const [cmd, n] of [...named].filter(([, x]) => x.script)) {
    if (!scripts[n.script] || /no test specified/.test(scripts[n.script])) {
      skipped.push(`ci: \`${cmd}\` is listed as run in a gate verdict, but package.json has no real ${n.script} script`);
      continue;
    }
    // Install only the way the repo can: `npm ci` needs a lockfile, and
    // without one it fails every build (independent re-review).
    const pkg = read("package.json");
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    const install = has("package-lock.json") ? "npm ci && " : deps ? "npm install && " : "";
    steps.push({ name: cmd, run: `${install}${cmd}`, evidence: `package.json scripts.${n.script}: ${scripts[n.script]}; listed as run in ${seen(n.where)}${install ? `; installed with ${install.slice(0, -4)}` : ""}` });
  }

  // The drift gate counts only if it has RUN here: its own gate event, whose
  // detail is drift.mjs's summary line, not any gate that mentions drift.
  const evDir = join(root, cfg.events ?? "ops/caretaker/events");
  const ev = existsSync(evDir) ? events.read(evDir).events : [];
  const driftRuns = ev.filter((e) => e.kind === "gate" && e.source === undefined && DRIFT_SUMMARY.test(e.detail ?? ""));
  const driftScript = ["bin/drift.mjs", "ops/caretaker/drift.mjs"].find(has);
  if (driftRuns.length && driftScript) {
    steps.push({ name: "drift gate", run: `node ${driftScript} check --no-events --specs ${specsDir}`, evidence: `${driftRuns.length} drift gate run(s) in the event log, last at ${driftRuns.at(-1).t}` });
  } else if (driftRuns.length) skipped.push("ci: the drift gate ran here, but no drift.mjs is in this repo to run it in CI");
  return steps;
}

/** The branch pushes are checked on: the remote's default, else the one checked out, else main. */
export function defaultBranch(root) {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const remote = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.trim().replace(/^origin\//, "");
  if (remote) return remote;
  const here = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  return here && here !== "HEAD" ? here : "main";
}

export function ciWorkflow(steps, { branch = "main" } = {}) {
  if (!steps.length) return null;
  const lines = [
    "# Generated by bin/graduate.mjs from what this repository was seen to run.",
    "# Each step names its evidence. Remove a step if its evidence is wrong.",
    "name: ci",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(branch)}]`,
    "  pull_request:",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: actions/setup-node@v5",
    "        with:",
    "          node-version: 22",
  ];
  for (const s of steps) {
    lines.push(`      # evidence: ${s.evidence.replace(/\n/g, " ")}`);
    lines.push(`      - name: ${JSON.stringify(s.name)}`);
    lines.push(`        run: ${JSON.stringify(s.run)}`);
  }
  return `${lines.join("\n")}\n`;
}

/* ----------------------------------------------------------------- docs */

/** Just enough markdown for specs and ADRs: headings, fences, lists, paragraphs. No dependency. */
export function mdToHtml(md) {
  const body = String(md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out = [];
  const lines = body.split(/\r?\n/);
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^(`{3,})/.exec(l);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (para.length) flush();
      list.push(l.replace(/^\s*[-*]\s+/, ""));
    } else if (/^\s+\S/.test(l) && list.length) list[list.length - 1] += ` ${l.trim()}`;
    else if (!l.trim()) flush();
    else {
      if (list.length) flush();
      para.push(l.trim());
    }
  }
  flush();
  return out.join("\n");
}

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<style>body{font:16px/1.55 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}code,pre{font:13px ui-monospace,monospace}pre{background:#f4f4f2;padding:.8rem;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.35rem .5rem;text-align:left;vertical-align:top}.bad{color:#b3261e}.ok{color:#1e7a34}nav a{margin-right:1rem}</style>` +
  `</head><body><nav><a href="index.html">Specs</a><a href="decisions.html">Decisions</a></nav>${body}</body></html>\n`;

export function site(root, { specsDir = "specs" } = {}) {
  const { specs } = loadSpecs(specsDir, { repo: root });
  let fresh = null;
  try {
    fresh = freshness({ repo: root, specsDir });
  } catch {
    fresh = null;
  }
  const staleOf = new Set((fresh?.stale ?? []).map((s) => s.spec));
  const lyingOf = new Set((fresh?.lying ?? []).map((l) => l.doc));
  const files = {};
  const slug = (id) => id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rows = specs.map((s) => {
    const fm = frontmatter(readFileSync(join(root, s.id), "utf8"));
    const trust = fresh === null ? "unknown (not a git checkout)" : staleOf.has(s.id) ? '<span class="bad">stale</span>' : lyingOf.has(s.id) ? '<span class="bad">date lies</span>' : '<span class="ok">current</span>';
    files[`${slug(s.id)}.html`] = page(fm.title ?? s.id, `<p><code>${esc(s.id)}</code> · governs <code>${esc(s.governs.join(", ") || "nothing")}</code> · ${trust}</p>${mdToHtml(readFileSync(join(root, s.id), "utf8"))}`);
    return `<tr><td><a href="${slug(s.id)}.html">${esc(fm.title ?? s.id)}</a></td><td><code>${esc(s.governs.join(", "))}</code></td><td>${esc(fm.status ?? "")}</td><td>${trust}</td></tr>`;
  });
  files["index.html"] = page("Specs", `<h1>Specs</h1><table><tr><th>Spec</th><th>Governs</th><th>Status</th><th>Trust</th></tr>${rows.join("")}</table>`);
  const { list, problems } = decisions(root);
  const drow = list.map((d) => {
    files[`${d.id}.html`] = page(d.title, `<p><code>${esc(d.file)}</code> · ${esc(d.status ?? "no status")}${d.supersededBy.length ? ` · superseded by ${d.supersededBy.map((x) => `<a href="${x}.html">${x}</a>`).join(", ")}` : ""}</p>${mdToHtml(d.text)}`);
    return `<tr><td><a href="${d.id}.html">${d.id}</a></td><td>${esc(d.title)}</td><td>${esc(d.status ?? "")}</td><td>${d.supersedes.map((x) => `<a href="${x}.html">${x}</a>`).join(", ")}</td><td>${d.supersededBy.join(", ")}</td></tr>`;
  });
  files["decisions.html"] = page("Decisions", `<h1>Decisions</h1><table><tr><th>ADR</th><th>Title</th><th>Status</th><th>Supersedes</th><th>Superseded by</th></tr>${drow.join("")}</table>${problems.length ? `<h2>Problems</h2><ul>${problems.map((p) => `<li class="bad">${esc(p)}</li>`).join("")}</ul>` : ""}`);
  return files;
}

export function decisionIndexMd(root) {
  const { list, problems } = decisions(root);
  const lines = ["# Decisions", "", "| ADR | Title | Status | Supersedes | Superseded by |", "|---|---|---|---|---|"];
  for (const d of list) lines.push(`| [${d.id}](${d.file}) | ${d.title.replace(/\|/g, "\\|")} | ${d.status ?? ""} | ${d.supersedes.join(", ")} | ${d.supersededBy.join(", ")} |`);
  if (problems.length) lines.push("", "## Problems", "", ...problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}

/** Write everything under `out`. Returns what was written, and what was not and why. */
export class GraduateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GraduateError";
    this.code = code;
  }
}

/** Written into the output dir, so a later run knows the directory is its own. */
export const MARK = ".graduate";

export function graduate(root, { out = "graduate", specsDir = "specs" } = {}) {
  const dir = resolve(root, out);
  const top = resolve(root);
  // Never over the project's own files (independent review: `--out .` wrote
  // over .github/workflows/ci.yml). The output is the repo itself or above it,
  // or a directory with something in it that graduate did not write: refused.
  if (dir === top || top.startsWith(dir + sep)) throw new GraduateError("OUT_IS_PROJECT", `--out ${out} is the project (or holds it); graduate writes beside the project's files, never over them`);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new GraduateError("OUT_NOT_DIR", `--out ${out} is a file, not a directory`);
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARK))) {
    throw new GraduateError("OUT_NOT_OURS", `${out} already holds files graduate did not write; choose an empty or new directory`);
  }
  const written = [];
  const skipped = [];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARK), "written by bin/graduate.mjs; delete the directory to regenerate it elsewhere\n");
  const wf = ciWorkflow(evidence(root, { specsDir, skipped }), { branch: defaultBranch(root) });
  if (wf) {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), wf);
    written.push(`${out}/.github/workflows/ci.yml`);
  } else skipped.push("ci: no evidence of any check running here, so no workflow was written");
  writeFileSync(join(dir, "DECISIONS.md"), decisionIndexMd(root));
  written.push(`${out}/DECISIONS.md`);
  const files = site(root, { specsDir });
  mkdirSync(join(dir, "site"), { recursive: true });
  for (const [f, html] of Object.entries(files)) {
    writeFileSync(join(dir, "site", f), html);
    written.push(`${out}/site/${f}`);
  }
  return { written, skipped };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = { repo: ".", out: "graduate", specs: "specs" };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const m = /^--(repo|out|specs)(?:=(.*))?$/.exec(rest[i]);
    if (m) opt[m[1]] = m[2] ?? rest[++i];
    else if (rest[i].startsWith("--")) {
      console.error(`graduate: unknown flag ${rest[i]}`);
      process.exit(2);
    } else pos.push(rest[i]);
  }
  const root = resolve(opt.repo);
  if (cmd === "all") {
    let r;
    try {
      r = graduate(root, { out: opt.out, specsDir: opt.specs });
    } catch (e) {
      if (!(e instanceof GraduateError)) throw e;
      console.error(`graduate: ${e.message}`);
      process.exit(2);
    }
    for (const w of r.written) console.log(`wrote   ${w}`);
    for (const s of r.skipped) console.log(`skipped ${s}`);
    process.exit(0);
  }
  if (cmd === "why" && pos[0]) {
    const r = why(root, pos[0], { specsDir: opt.specs });
    console.log(`${r.path}`);
    if (!r.governing.length) console.log("  governed by no spec");
    for (const g of r.governing) console.log(`  governed by ${g.spec} (${g.glob})`);
    if (!r.decisions.length) console.log("  no recorded decision explains it");
    for (const d of r.decisions) console.log(`  ${d.id} ${d.status ?? ""}${d.supersededBy.length ? ` (superseded by ${d.supersededBy.join(", ")})` : ""}: ${d.title}\n      ${d.how.join("; ")}`);
    process.exit(0);
  }
  if (cmd === "decisions") {
    process.stdout.write(decisionIndexMd(root));
    process.exit(decisions(root).problems.length ? 1 : 0);
  }
  console.error("usage: graduate.mjs all [--repo .] [--out graduate] | why <path> | decisions");
  process.exit(2);
}
