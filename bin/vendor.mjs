#!/usr/bin/env node
/**
 * VENDOR — Warp's cloud factory, copied, never rewritten (docs/plan.md).
 *
 *   vendor/sources.json         which upstream repos, pinned to which commit,
 *                               which of their paths are copied, and where
 *                               each lands when installed into a repo
 *   vendor/<name>/              those paths, byte for byte as upstream has them
 *   vendor/manifest.json        the sha256 of every vendored file, written by
 *                               `sync` straight from the upstream checkout
 *   vendor/patches/*.patch      every change Caretaker makes to Warp's files,
 *                               as a reviewable diff against the INSTALLED
 *                               layout (.agents/skills/..., .github/workflows/...)
 *
 * The vendored copy is never edited. `check` fails if one byte of it differs
 * from what `sync` fetched, or if a patch no longer applies — so "we did not
 * hand-roll Warp's code" is a test, not a promise.
 *
 * Usage:
 *   node bin/vendor.mjs sync [name]          fetch upstream at the pinned commit (network)
 *   node bin/vendor.mjs check                offline: vendored == manifest, patches apply
 *   node bin/vendor.mjs build <outdir>       the installed layout, patches applied, into an empty dir
 * Exit: 0 ok, 1 check failed, 2 misuse.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDOR = resolve(HERE, "..", "vendor");
/** Caretaker's own part of the install: the action standing in for Oz. */
export const ACTION_SRC = resolve(HERE, "..", "factory", "caretaker-agent");
export const ACTION_DEST = ".github/actions/caretaker-agent";

/**
 * The bin/ files the action runs: agent-step.mjs and everything it imports,
 * followed through relative imports, plus egress.mjs, which the per-run
 * proxy runs from the same directory (netns.mjs mounts it).
 */
export function actionBin(bin = HERE) {
  const seen = new Set();
  const queue = ["agent-step.mjs", "egress.mjs"];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(join(bin, f), "utf8");
    for (const m of text.matchAll(/(?:\bimport\b[^"'`]*?|\bimport\s*\(\s*)["']\.\/([^"']+\.mjs)["']/g)) queue.push(m[1]);
  }
  return [...seen].sort();
}

export class VendorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VendorError";
    this.code = code;
  }
}

export const readSources = (vendor = VENDOR) => JSON.parse(readFileSync(join(vendor, "sources.json"), "utf8"));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under dir, as sorted '/'-separated relative paths. */
export function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

const git = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new VendorError("GIT", `git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
};

/** Fetch one source at its pinned commit and copy its included paths. */
export function sync(name, { vendor = VENDOR } = {}) {
  const sources = readSources(vendor);
  const src = sources[name];
  if (!src) throw new VendorError("UNKNOWN", `no source named ${name}; they are ${Object.keys(sources).join(", ")}`);
  const tmp = mkdtempSync(join(tmpdir(), `vendor-${name}-`));
  try {
    git(["init", "-q", tmp]);
    git(["-C", tmp, "fetch", "-q", "--depth", "1", src.repo, src.commit]);
    git(["-C", tmp, "checkout", "-q", "FETCH_HEAD"]);
    const got = git(["-C", tmp, "rev-parse", "HEAD"]).trim();
    if (got !== src.commit) throw new VendorError("COMMIT", `fetched ${got}, pinned ${src.commit}`);
    const dest = join(vendor, name);
    rmSync(dest, { recursive: true, force: true });
    for (const p of src.include) {
      const from = join(tmp, p);
      if (!existsSync(from)) throw new VendorError("MISSING", `${name}: ${p} is not in upstream at ${src.commit}`);
      mkdirSync(dirname(join(dest, p)), { recursive: true });
      cpSync(from, join(dest, p), { recursive: true });
    }
    const manifestPath = join(vendor, "manifest.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    manifest[name] = { commit: src.commit, files: Object.fromEntries(walk(dest).map((f) => [f, sha(join(dest, f))])) };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return Object.keys(manifest[name].files).length;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The patches, in the order they apply. */
export const patches = (vendor = VENDOR) =>
  existsSync(join(vendor, "patches")) ? readdirSync(join(vendor, "patches")).filter((f) => f.endsWith(".patch")).sort() : [];

/** Offline. Returns a list of problems; empty means the vendored copy is exactly upstream's. */
export function check({ vendor = VENDOR } = {}) {
  const problems = [];
  const sources = readSources(vendor);
  const manifest = existsSync(join(vendor, "manifest.json")) ? JSON.parse(readFileSync(join(vendor, "manifest.json"), "utf8")) : {};
  for (const [name, src] of Object.entries(sources)) {
    const m = manifest[name];
    if (!m) {
      problems.push(`${name}: not synced (no manifest entry); run node bin/vendor.mjs sync ${name}`);
      continue;
    }
    if (m.commit !== src.commit) problems.push(`${name}: manifest is from ${m.commit}, sources.json pins ${src.commit}; run sync`);
    const dir = join(vendor, name);
    const have = new Set(walk(dir));
    for (const [f, h] of Object.entries(m.files)) {
      if (!have.has(f)) problems.push(`${name}/${f}: missing`);
      else if (sha(join(dir, f)) !== h) problems.push(`${name}/${f}: EDITED — vendored files are never changed by hand; put the change in vendor/patches/`);
      have.delete(f);
    }
    for (const f of have) problems.push(`${name}/${f}: not from upstream — Caretaker files do not go in vendor/`);
  }
  if (!problems.length) {
    const out = mkdtempSync(join(tmpdir(), "vendor-check-"));
    try {
      build(out, { vendor });
    } catch (e) {
      problems.push(e.message);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  return problems;
}

/**
 * The installed layout, into `outdir` (which must be empty or absent): each
 * source's `install` map applied, then every patch, in order. Returns the
 * files written.
 */
export function build(outdir, { vendor = VENDOR, withAction = true } = {}) {
  const out = resolve(outdir);
  if (existsSync(out) && readdirSync(out).length) throw new VendorError("NOT_EMPTY", `${out} is not empty`);
  mkdirSync(out, { recursive: true });
  for (const [name, src] of Object.entries(readSources(vendor))) {
    const dir = join(vendor, name);
    for (const f of walk(dir)) {
      const prefix = Object.keys(src.install).filter((k) => f === k || (k.endsWith("/") && f.startsWith(k))).sort((a, b) => b.length - a.length)[0];
      if (prefix === undefined) continue; // kept for reference only (README, vision, Warp's own installer)
      const to = join(out, src.install[prefix] + f.slice(prefix.length));
      if (existsSync(to)) throw new VendorError("CLASH", `${name}/${f} would overwrite ${relative(out, to)}, which another source installed`);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(dir, f), to);
    }
  }
  // Caretaker's action, with its own copy of the bin/ files it runs, so the
  // repo it is installed into needs nothing else from Caretaker.
  if (withAction) {
    for (const f of walk(ACTION_SRC)) {
      mkdirSync(dirname(join(out, ACTION_DEST, f)), { recursive: true });
      cpSync(join(ACTION_SRC, f), join(out, ACTION_DEST, f));
    }
    mkdirSync(join(out, ACTION_DEST, "bin"), { recursive: true });
    for (const f of actionBin()) cpSync(join(HERE, f), join(out, ACTION_DEST, "bin", f));
  }
  for (const p of patches(vendor)) {
    const r = spawnSync("git", ["apply", "--whitespace=nowarn", join(vendor, "patches", p)], { cwd: out, encoding: "utf8" });
    if (r.status !== 0) throw new VendorError("PATCH", `patch ${p} does not apply: ${(r.stderr || "").trim()}`);
  }
  return walk(out);
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "sync") {
      for (const name of arg ? [arg] : Object.keys(readSources())) console.log(`[vendor] ${name}: ${sync(name)} file(s) at ${readSources()[name].commit.slice(0, 8)}`);
    } else if (cmd === "check") {
      const problems = check();
      for (const p of problems) console.log(`FAIL  ${p}`);
      console.error(`[vendor] ${problems.length ? `FAIL — ${problems.length} problem(s)` : `ok — vendored files match upstream, ${patches().length} patch(es) apply`}`);
      process.exit(problems.length ? 1 : 0);
    } else if (cmd === "build" && arg) {
      console.log(`[vendor] ${build(arg).length} file(s) -> ${resolve(arg)}`);
    } else {
      console.error("usage: vendor.mjs sync [name] | check | build <outdir>");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[vendor] ${e.message}`);
    process.exit(e instanceof VendorError ? 1 : 2);
  }
}
