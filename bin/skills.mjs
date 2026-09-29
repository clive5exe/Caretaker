#!/usr/bin/env node
/**
 * SKILLS — S-1. Consume the existing standard; do not invent a second one.
 *
 * A skill is a directory holding a SKILL.md whose frontmatter carries `name`
 * and `description`, laid out as `skills/<category>/<name>/SKILL.md` in the
 * repos that publish them (and flat, `<name>/SKILL.md`, where `npx skills add`
 * installs them). This file reads exactly that. It adds no fields, no manifest
 * and no index: a skills repo that works with the tools that already exist
 * works here unchanged.
 *
 * A project names its sources in config:
 *
 *     "skills": ["./skills", "anthropics/skills", "owner/repo@v1.2"]
 *
 * A path is read in place. `owner/repo[@ref]` is fetched ONCE, by
 * `skills.mjs fetch`, into the state dir — never at run time. A run that
 * reached the network to fetch its own instructions would need the one thing
 * the sandbox exists to deny, and would get different instructions each time.
 * A source that has not been fetched is refused by name, with the command.
 *
 * Two skills with the same name are refused rather than one silently winning:
 * which instructions an agent followed must be answerable afterwards.
 *
 * For a run, the chosen skills are staged into a directory outside the
 * workspace and handed to the harness as `policy.skillsDir`:
 *   - the claude CLI gets it mounted READ-ONLY where it looks for user skills
 *   - the openai-compatible adapter lists them in its system prompt and offers
 *     a `read_skill` tool
 * Never copied into the workspace: anything written there is measured as the
 * agent's work, and a skill is not work the agent did.
 *
 * Usage:
 *   node bin/skills.mjs list  [--config ops/caretaker/config.json]
 *   node bin/skills.mjs fetch [--config ops/caretaker/config.json]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stateDirFor } from "./statedir.mjs";

export class SkillsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillsError";
    this.code = code;
  }
}

const REMOTE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/;
const isRemote = (s) => REMOTE.test(s) && !s.startsWith(".") && !s.startsWith("/");

/** `name` and `description` from a SKILL.md's frontmatter. */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return { name: null, description: null };
  const field = (k) => {
    const lines = m[1].split(/\r?\n/);
    const i = lines.findIndex((l) => new RegExp(`^${k}:`).test(l));
    if (i === -1) return null;
    let v = lines[i].slice(k.length + 1).trim();
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const cont = [];
      for (const l of lines.slice(i + 1)) {
        if (!/^\s+\S/.test(l)) break;
        cont.push(l.trim());
      }
      v = cont.join(v.startsWith(">") ? " " : "\n");
    }
    return v.replace(/^["']|["']$/g, "") || null;
  };
  return { name: field("name"), description: field("description") };
}

/**
 * Every skill under `root`: `root/skills/<cat>/<name>/SKILL.md`, or `root`
 * itself as a skills dir (`<cat>/<name>/SKILL.md` or `<name>/SKILL.md`).
 */
export function discover(root) {
  const base = existsSync(join(root, "skills")) && statSync(join(root, "skills")).isDirectory() ? join(root, "skills") : root;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const d = join(dir, e.name);
      if (existsSync(join(d, "SKILL.md"))) {
        const meta = parseSkill(readFileSync(join(d, "SKILL.md"), "utf8"));
        const rel = relative(base, d).split(/[\\/]/);
        found.push({ name: meta.name ?? e.name, description: meta.description, category: rel.length > 1 ? rel[0] : null, dir: d });
      } else walk(d, depth + 1);
    }
  };
  walk(base, 1);
  return found;
}

/** Where a source lives on disk. A remote one must already have been fetched. */
export function sourceDir(source, { root, cacheDir }) {
  const s = String(source);
  if (!isRemote(s)) return resolve(root, s);
  const [, owner, repo, ref] = REMOTE.exec(s);
  return join(cacheDir, owner, `${repo}@${ref ?? "HEAD"}`);
}

/** Fetch one remote source into the cache. `gitBase` is overridable for tests. */
export function fetchSource(source, { cacheDir, gitBase = "https://github.com" }) {
  const m = REMOTE.exec(String(source));
  if (!m || !isRemote(source)) throw new SkillsError("NOT_REMOTE", `${source} is a path, not owner/repo; nothing to fetch`);
  const [, owner, repo, ref] = m;
  const dest = join(cacheDir, owner, `${repo}@${ref ?? "HEAD"}`);
  if (existsSync(dest)) return { source, dest, fetched: false };
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync("git", ["clone", "-q", "--depth", "1", ...(ref ? ["--branch", ref] : []), `${gitBase}/${owner}/${repo}`, dest], { encoding: "utf8" });
  if (r.status !== 0) throw new SkillsError("FETCH_FAILED", `could not fetch ${source}: ${String(r.stderr).trim()}`);
  return { source, dest, fetched: true };
}

/** All skills from the config's sources, or a named refusal. */
export function collect(cfg, { root, cacheDir }) {
  const sources = cfg.skills ?? [];
  if (!Array.isArray(sources)) throw new SkillsError("BAD_CONFIG", '"skills" in config must be a list of paths and owner/repo entries');
  const byName = new Map();
  for (const source of sources) {
    const dir = sourceDir(source, { root, cacheDir });
    if (!existsSync(dir)) {
      throw new SkillsError(
        isRemote(source) ? "NOT_FETCHED" : "NO_SUCH_PATH",
        isRemote(source)
          ? `skills source ${source} has not been fetched. Runs never fetch; run: node bin/skills.mjs fetch`
          : `skills source ${source} does not exist at ${dir}`,
      );
    }
    for (const sk of discover(dir)) {
      const prior = byName.get(sk.name);
      if (prior) throw new SkillsError("DUPLICATE_SKILL", `skill "${sk.name}" is in both ${prior.source} and ${source}; remove one, so it is clear which instructions a run followed`);
      byName.set(sk.name, { ...sk, source });
    }
  }
  return [...byName.values()];
}

/** Copy the skills into `into/<name>/`, outside the workspace. Returns `into`. */
export function stage(skills, into) {
  mkdirSync(into, { recursive: true });
  for (const sk of skills) cpSync(sk.dir, join(into, sk.name), { recursive: true, filter: (src) => basename(src) !== ".git" });
  return into;
}

/** The skills a staged dir holds: [{ name, description }], for a system prompt. */
export function staged(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, description: parseSkill(readFileSync(join(dir, e.name, "SKILL.md"), "utf8")).description }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function context(cfgPath) {
  const cfgAbs = resolve(cfgPath);
  const cfg = existsSync(cfgAbs) ? JSON.parse(readFileSync(cfgAbs, "utf8")) : {};
  const root = resolve(dirname(cfgAbs), "..", "..", cfg.repo ?? ".");
  return { cfg, root, cacheDir: join(stateDirFor(root, cfg), "skills") };
}

/** Collect and stage a project's skills for one run. Returns the staged dir, or null if none. */
export function stageForRun(cfgPath, into) {
  const { cfg, root, cacheDir } = context(cfgPath);
  const skills = collect(cfg, { root, cacheDir });
  return skills.length ? stage(skills, into) : null;
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const i = argv.indexOf("--config");
  const cfgPath = i === -1 ? "ops/caretaker/config.json" : argv[i + 1];
  try {
    const { cfg, root, cacheDir } = context(cfgPath);
    if (cmd === "fetch") {
      for (const s of (cfg.skills ?? []).filter(isRemote)) {
        const r = fetchSource(s, { cacheDir });
        console.log(`${r.fetched ? "fetched" : "already here"}  ${s} -> ${r.dest}`);
      }
      process.exit(0);
    }
    if (cmd === "list") {
      const skills = collect(cfg, { root, cacheDir });
      for (const s of skills) console.log(`${s.name.padEnd(28)} ${s.source}  ${s.description ?? "(no description)"}`);
      console.error(`[skills] ${skills.length} skill(s) from ${(cfg.skills ?? []).length} source(s)`);
      process.exit(0);
    }
    console.error("usage: skills.mjs list|fetch [--config ops/caretaker/config.json]");
    process.exit(2);
  } catch (e) {
    console.error(`[skills] ${e.name}: ${e.message}`);
    process.exit(e.code === "NOT_FETCHED" || e.code === "DUPLICATE_SKILL" || e.code === "NO_SUCH_PATH" ? 1 : 2);
  }
}
