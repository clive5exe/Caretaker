#!/usr/bin/env node
/**
 * SPEC — the two declarations no existing standard provides.
 *
 * A spec is a markdown file with a fenced `spec` block near the top and prose
 * underneath:
 *
 *     ```spec
 *     hosts:   api.stripe.com
 *     governs: src/lib/pricing*, src/app/api/checkout/**
 *     ```
 *
 * TWO FIELDS, BECAUSE EVERYTHING ELSE ALREADY EXISTS. An earlier version of this
 * file also declared `runtime`, `services`, `memory` and `cpus`, which was
 * reinvention: devcontainer.json already carries `image`, `features`,
 * `hostRequirements.cpus` and `hostRequirements.memory`, and has real adoption
 * behind it. The container half is read from there.
 *
 * What devcontainer.json does NOT have, checked against its own reference:
 *
 *   hosts    No egress or allowlist property exists in the spec at all. It is
 *            about setting up a dev environment, not about network policy. This
 *            is the control the whole sandbox argument rests on.
 *   governs  Nothing maps a path to the DOCUMENT that governs it. CODEOWNERS
 *            maps paths to people, which is a different question.
 *
 * Usage:
 *   node spec.mjs check   <file> [devcontainer.json]
 *   node spec.mjs egress  <file> [devcontainer.json]
 *   node spec.mjs limits  <file> <devcontainer.json>
 *   node spec.mjs owns    <file> <path>
 *   node spec.mjs parse   <file>
 */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ parsing */

/**
 * The FIRST fenced `spec` block, as raw text. Later ones are ignored rather than
 * merged: a spec carrying two declarations has a bug, and merging would hide it.
 */
export function extractBlock(markdown) {
  const m = /^```spec[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(markdown);
  return m ? m[1] : null;
}

const list = (v) =>
  String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const KNOWN = new Set(["hosts", "governs"]);

/**
 * Parse the block. An unknown key is an ERROR, not ignored — a typo'd `host:`
 * would leave a project believing it had declared an allowlist entry it had
 * not, and it would find out either when something it needed was blocked, or
 * worse, never.
 */
export function parseSpec(markdown) {
  const raw = extractBlock(markdown);
  if (raw === null) return { ok: false, errors: ["no ```spec block found"], spec: null };

  const spec = {};
  const errors = [];
  raw.split("\n").forEach((line, i) => {
    const text = line.replace(/#.*$/, "").trim();
    if (!text) return;
    const colon = text.indexOf(":");
    if (colon === -1) return void errors.push(`line ${i + 1}: "${text}" is not key: value`);
    const key = text.slice(0, colon).trim();
    if (!KNOWN.has(key)) {
      return void errors.push(
        `line ${i + 1}: unknown field "${key}". This block carries only ${[...KNOWN].join(" and ")}; ` +
          "runtime, services and resource limits belong in devcontainer.json",
      );
    }
    if (key in spec) return void errors.push(`line ${i + 1}: "${key}" declared twice`);
    spec[key] = list(text.slice(colon + 1));
  });

  if (!spec.governs?.length) {
    errors.push(
      "governs is required — a spec that governs no paths cannot take part in drift " +
        "detection, which makes it decoration",
    );
  }
  return { ok: errors.length === 0, errors, spec };
}

/* ------------------------------------------------------- devcontainer.json */

/**
 * Read the container half. JSONC in practice — devcontainer.json permits
 * comments and trailing commas, and real ones use both, so a strict JSON.parse
 * fails on files that every other tool accepts.
 */
export function readDevcontainer(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { __error: String(e.message) };
  }
}

/**
 * Limits, from devcontainer.json's own `hostRequirements`, with a floor.
 *
 * A DECLARED CEILING IS NOT OPTIONAL. devcontainer.json treats hostRequirements
 * as a MINIMUM for the host; here it is read as a maximum for the container,
 * which is a deliberate reinterpretation and is why it is written down. A run
 * with no ceiling takes the box down, and "the file did not say" is not a reason
 * to allow it.
 */
export function toLimits(dev) {
  const hr = dev?.hostRequirements ?? {};
  return {
    memory: hr.memory ?? "2gb",
    cpus: String(hr.cpus ?? 2),
    // A `build.dockerfile` is not an image name; it is built by
    // environment.mjs (E-5), which is the one place that resolves an image.
    image: dev?.image ?? null,
    features: Object.keys(dev?.features ?? {}),
    readOnlyRoot: true,
    // Never. Mounting the container socket is root on the host, and it is how
    // most "sandboxed" agent tools are quietly not sandboxed.
    containerSocket: false,
  };
}

/* ------------------------------------------------------------------ egress */

/**
 * Registry hosts a runtime needs to install anything at all. Derived from
 * devcontainer FEATURES rather than a hand-written runtime field, because the
 * features are already declared and already say which toolchain is present.
 */
const FEATURE_REGISTRY = [
  [/node|javascript|typescript/i, ["registry.npmjs.org"]],
  [/python/i, ["pypi.org", "files.pythonhosted.org"]],
  [/\bgo\b|golang/i, ["proxy.golang.org", "sum.golang.org"]],
  [/rust/i, ["static.crates.io", "index.crates.io"]],
  [/ruby/i, ["rubygems.org"]],
  [/java|maven|gradle/i, ["repo1.maven.org"]],
];

/**
 * The allowlist: the hosts the spec declared, plus the registries the declared
 * toolchains need.
 *
 * AN UNRECOGNISED FEATURE IMPLIES NOTHING. Guessing a registry for a toolchain
 * we do not know would open a host nobody declared, which is the one direction
 * this must never fail in.
 */
export function toEgress(spec, dev) {
  const declared = spec.hosts ?? [];
  const names = [
    ...Object.keys(dev?.features ?? {}),
    dev?.image ?? "",
    dev?.name ?? "",
  ].join(" ");
  const implicit = [
    ...new Set(FEATURE_REGISTRY.filter(([re]) => re.test(names)).flatMap(([, hosts]) => hosts)),
  ];
  return {
    allow: [...new Set([...implicit, ...declared])].sort(),
    // Stated rather than implied: a proxy that silently drops is
    // indistinguishable from a network fault and gets debugged as one.
    denyByDefault: true,
    logRefusals: true,
    implicit,
    declared,
  };
}

/* ----------------------------------------------------------------- governs */

/** Glob to RegExp. `**`, `*`, `?`; everything else literal. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") {
          out += "/?";
          i++;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function governs(spec, path) {
  return (spec.governs ?? []).some((g) => globToRegExp(g).test(path));
}

/* --------------------------------------------------------------------- cli */

/*
 * ONLY WHEN RUN DIRECTLY. Without this guard the CLI executes on IMPORT, so the
 * test file printed usage and exited before its first assertion. Caught by the
 * tests on their first run, which is the argument for writing them.
 */
const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!isEntry) {
  // imported as a module: export only, run nothing
} else {

const [, , cmd, file, arg] = process.argv;
const usage = `usage:
  spec.mjs check  <file> [devcontainer.json]
  spec.mjs egress <file> [devcontainer.json]
  spec.mjs limits <file> <devcontainer.json>
  spec.mjs owns   <file> <path>
  spec.mjs parse  <file>`;

if (!cmd || !file) {
  console.error(usage);
  process.exit(2);
}

let markdown;
try {
  markdown = readFileSync(file, "utf8");
} catch {
  console.error(`cannot read ${file}`);
  process.exit(1);
}

const { ok, errors, spec } = parseSpec(markdown);

if (cmd === "check") {
  const dev = readDevcontainer(arg);
  const problems = [...errors];
  if (arg && !dev) problems.push(`${arg} not found`);
  if (dev?.__error) problems.push(`${arg} is not parseable: ${dev.__error}`);
  if (problems.length) {
    console.error(`${file}: ${problems.length} problem(s)`);
    for (const e of problems) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`${file}: ok`);
  console.log(`  governs ${spec.governs.length} path pattern(s)`);
  console.log(`  allows  ${toEgress(spec, dev).allow.length} host(s)`);
  if (!arg) console.log("  (no devcontainer.json given — limits and registries not derived)");
  process.exit(0);
}

if (!ok) {
  console.error(`${file} is not a valid spec:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

if (cmd === "parse") console.log(JSON.stringify(spec, null, 2));
else if (cmd === "egress") console.log(JSON.stringify(toEgress(spec, readDevcontainer(arg)), null, 2));
else if (cmd === "limits") {
  const dev = readDevcontainer(arg);
  if (!dev || dev.__error) {
    console.error(`limits needs a readable devcontainer.json${dev?.__error ? `: ${dev.__error}` : ""}`);
    process.exit(1);
  }
  console.log(JSON.stringify(toLimits(dev), null, 2));
} else if (cmd === "owns") {
  if (!arg) {
    console.error("owns needs a path");
    process.exit(2);
  }
  const yes = governs(spec, arg);
  console.log(`${yes ? "yes" : "no"}  ${file} ${yes ? "governs" : "does not govern"} ${arg}`);
  process.exit(yes ? 0 : 1);
} else {
  console.error(usage);
  process.exit(2);
}

}
