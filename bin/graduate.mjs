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
 *   ci         a workflow built from the checks this repo REALLY runs, each
 *              step carrying the evidence it was taken from. If there is no
 *              evidence of any check, no workflow is written: an empty or
 *              placeholder CI file claims a gate that does not exist.
 *   docs       a static site from the specs that really exist: each spec, what
 *              it governs, whether it can be trusted (freshness), and the
 *              decision index. No template text anywhere in the output.
 *
 * Output goes to a directory (default `graduate/`), never over the project's
 * own files; what to adopt from it is the person's decision.
 *
 * Usage:
 *   node bin/graduate.mjs all  [--repo .] [--out graduate] [--specs specs]
 *   node bin/graduate.mjs why  <path> [--repo .]
 *   node bin/graduate.mjs decisions [--repo .]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Every ADR, with what supersedes it computed from the others, and problems named. */
export function decisions(root) {
  const dir = join(root, DECISIONS_DIR);
  if (!existsSync(dir)) return { list: [], problems: [] };
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
  const STATUSES = /^(draft|proposed|accepted|rejected|superseded(-by: ADR-\d{4})?)$/;
  for (const d of list) {
    if (!d.status) problems.push(`${d.id} has no status`);
    else if (!STATUSES.test(d.status)) problems.push(`${d.id} has status "${d.status}", which is not draft, accepted, rejected or superseded-by: ADR-NNNN`);
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
  for (const d of list) {
    for (const e of editsAfterDecided(root, d.file) ?? []) problems.push(`${d.id} was edited after it was decided (${e.status}): ${e.sha ? `${e.sha.slice(0, 8)} ${e.day} "${e.subject}"` : "uncommitted change in the working tree"}. Write a new decision that supersedes it instead`);
  }
  return { list, problems };
}

// A decision may still change while draft or proposed. After that only its
// `status:` (to superseded-by) and `updated:` lines may: superseding one has to
// rewrite its status, and nothing else.
const UNDECIDED = /^(draft|proposed)$/;
const decidedText = (text) => String(text).replace(/^(status|updated):.*$/gm, "");

/**
 * The commits (and a working-tree change) that altered a decision's text after
 * its status left draft/proposed. [] if none; null outside a git checkout.
 */
export function editsAfterDecided(root, file) {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return null;
  const log = git("log", "--reverse", "--format=%H%x09%cs%x09%s", "--", file);
  if (log.status !== 0) return null;
  const edits = [];
  let decided = null;
  const states = log.stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, day, ...subject] = l.split("\t");
    return { sha, day, subject: subject.join("\t"), text: git("show", `${sha}:${file}`).stdout };
  });
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
export function evidence(root, { specsDir = "specs" } = {}) {
  const steps = [];
  const has = (p) => existsSync(join(root, p));
  let tests = [];
  try {
    tests = readdirSync(join(root, "bin")).filter((f) => f.endsWith(".test.mjs")).sort();
  } catch {
    /* no bin/ */
  }
  if (tests.length) steps.push({ name: "tests", run: "for t in bin/*.test.mjs; do node \"$t\" || exit 1; done", evidence: `${tests.length} test file(s) under bin/` });
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) steps.push({ name: "npm test", run: "npm ci && npm test", evidence: `package.json scripts.test: ${pkg.scripts.test}` });
  }
  // The drift gate counts only if it has actually RUN here: a gate event in the log.
  const cfgPath = ["ops/caretaker/config.json"].find(has);
  const cfg = cfgPath ? JSON.parse(readFileSync(join(root, cfgPath), "utf8")) : {};
  const evDir = join(root, cfg.events ?? "ops/caretaker/events");
  const ev = existsSync(evDir) ? events.read(evDir).events : [];
  const driftRuns = ev.filter((e) => e.kind === "gate" && e.source === undefined && /drift|governed/.test(e.detail ?? ""));
  if (driftRuns.length) steps.push({ name: "drift gate", run: `node bin/drift.mjs check --no-events --specs ${specsDir}`, evidence: `${driftRuns.length} drift gate run(s) in the event log, last at ${driftRuns.at(-1).t}` });
  if (cfgPath && cfg.boardMarkdown && has(cfg.boardMarkdown)) {
    steps.push({ name: "board is current", run: `node ops/caretaker/board.mjs build && git diff --exit-code -- ${cfg.boardMarkdown}`, evidence: `${cfg.boardMarkdown} is generated by board.mjs from ${cfg.board}` });
  }
  return steps;
}

export function ciWorkflow(steps) {
  if (!steps.length) return null;
  const lines = [
    "# Generated by bin/graduate.mjs from what this repository was seen to run.",
    "# Each step names its evidence. Remove a step if its evidence is wrong.",
    "name: ci",
    "on:",
    "  push:",
    "    branches: [main]",
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
export function graduate(root, { out = "graduate", specsDir = "specs" } = {}) {
  const dir = resolve(root, out);
  const written = [];
  const skipped = [];
  mkdirSync(dir, { recursive: true });
  const wf = ciWorkflow(evidence(root, { specsDir }));
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
    const r = graduate(root, { out: opt.out, specsDir: opt.specs });
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
