#!/usr/bin/env node
/**
 * ENVIRONMENT — E-5 and E-6. The container a run gets comes from the spec,
 * every time, and can be asked what it actually has.
 *
 * E-5: REBUILT FROM THE SPEC EVERY RUN. The answer to "environments change" at
 * this layer is that they do not. A run's container is `--rm`, its root is
 * read-only and its writable places are tmpfs (sandbox.mjs), so nothing an
 * agent installs survives it; the repo is the only thing that persists. What
 * this file adds is the image: devcontainer.json's `image` is used as named,
 * and its `build.dockerfile` is BUILT, on every run, with podman's layer cache
 * making an unchanged Dockerfile cost a cache hit. Building every run, rather
 * than keying a tag on a hash of the Dockerfile, is deliberate: a hash of the
 * Dockerfile misses a change to a file it COPYs, and podman's cache does not.
 * The image a run used is recorded by id, so "which environment did this run
 * in" has an answer after the tag has moved.
 *
 * Declared devcontainer `features` are NOT installed here — that is the
 * devcontainer CLI's job, and reimplementing it is out of scope. They are named
 * in a warning, and E-6 names any toolchain they promised and the image lacks.
 *
 * E-6: ASK THE CONTAINER. What was declared (the features' toolchains and
 * versions, compose services, the spec's hosts plus the registries the
 * features imply) is diffed against what a probe run inside the same sandbox
 * reports. Every difference is named: a declared toolchain missing, a version
 * that does not match, a toolchain present that nobody declared, a declared
 * service this runner does not start, a declared host that cannot be reached,
 * and — the one that matters most — an UNDECLARED host that can.
 *
 * Usage:
 *   node bin/environment.mjs image [--devcontainer .devcontainer/devcontainer.json]
 *   node bin/environment.mjs check [--devcontainer F] [--specs specs] [--image I]
 *        [--sandbox podman|none] [--egress] [--egress-network N] [--json]
 * Exit (check): 0 no differences, 1 differences named, 2 misuse or could not run.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildArgs } from "./sandbox.mjs";
import { readDevcontainer, toEgress, toLimits } from "./spec.mjs";

export class EnvironmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvironmentError";
    this.code = code;
  }
}

const defaultExec = (runtime) => (args, opts = {}) => spawnSync(runtime, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...opts });

/* ------------------------------------------------------------------- E-5 */

/** The local tag a devcontainer's Dockerfile is built under: stable per devcontainer file. */
export function buildTag(devcontainerPath) {
  return `localhost/caretaker-env-${createHash("sha256").update(resolve(devcontainerPath)).digest("hex").slice(0, 12)}`;
}

/** The `podman build` argv for a devcontainer's `build` section, paths resolved from its own directory. */
export function buildArgv(dev, devcontainerPath) {
  const base = dirname(resolve(devcontainerPath));
  const b = dev.build ?? {};
  const args = ["build", "-t", buildTag(devcontainerPath), "-f", resolve(base, b.dockerfile)];
  for (const [k, v] of Object.entries(b.args ?? {})) args.push("--build-arg", `${k}=${v}`);
  if (b.target) args.push("--target", String(b.target));
  args.push(resolve(base, b.context ?? "."));
  return args;
}

/**
 * The image for a run. `policy.image` wins; then devcontainer `image`; then
 * devcontainer `build`, built now. Returns { image, built, warnings }.
 */
export function resolveImage({ image = null, dev, devcontainerPath, runtime = "podman", exec }) {
  const warnings = [];
  const features = Object.keys(dev?.features ?? {});
  if (features.length) {
    warnings.push(
      `devcontainer features are declared but NOT installed by this runner, which runs the image as built: ${features.join(", ")}. ` +
        "Bake them into the Dockerfile; `environment.mjs check` names any toolchain they promised that the image lacks.",
    );
  }
  if (image) return { image, built: false, warnings };
  if (dev?.image) return { image: dev.image, built: false, warnings };
  if (dev?.build?.dockerfile) {
    const run = exec ?? defaultExec(runtime);
    const args = buildArgv(dev, devcontainerPath);
    const r = run(args);
    if (r.status !== 0) {
      throw new EnvironmentError("BUILD_FAILED", `building the image from ${devcontainerPath} failed (exit ${r.status}): ${String(r.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`);
    }
    return { image: buildTag(devcontainerPath), built: true, warnings };
  }
  throw new EnvironmentError("NO_IMAGE", `no image: set policy.image, or an "image" or "build.dockerfile" in ${devcontainerPath}`);
}

/** The id of the image a tag points at now, or null. What a run records as "the environment it ran in". */
export function imageId(image, { runtime = "podman", exec } = {}) {
  const r = (exec ?? defaultExec(runtime))(["image", "inspect", "--format", "{{.Id}}", image]);
  return r.status === 0 ? String(r.stdout).trim() || null : null;
}

/* ------------------------------------------------------------------- E-6 */

/**
 * Toolchains a probe knows how to ask about. `match` recognises the feature id
 * that declares one; `cmd` asks the container. An unrecognised feature is
 * reported as unchecked, never guessed at.
 */
export const TOOLCHAINS = [
  { name: "node", match: /(^|\/)node(:|$)|javascript|typescript/i, cmd: "node --version" },
  { name: "python", match: /(^|\/)python(:|$)/i, cmd: "python3 --version" },
  { name: "go", match: /(^|\/)go(lang)?(:|$)/i, cmd: "go version" },
  { name: "rust", match: /(^|\/)rust(:|$)/i, cmd: "rustc --version" },
  { name: "ruby", match: /(^|\/)ruby(:|$)/i, cmd: "ruby --version" },
  // java prints JAVA_TOOL_OPTIONS, when set, before its version.
  { name: "java", match: /(^|\/)java(:|$)/i, cmd: "java -version 2>&1 | grep -v '^Picked up'" },
];
const ANY_VERSION = /^(latest|lts|os-provided|none|)$/i;

/** What the spec and devcontainer declare. */
export function declared({ dev, specs = [] }) {
  const tools = [];
  const unknownFeatures = [];
  for (const [id, opts] of Object.entries(dev?.features ?? {})) {
    const tc = TOOLCHAINS.find((t) => t.match.test(id));
    if (!tc) unknownFeatures.push(id);
    else tools.push({ name: tc.name, version: String(opts?.version ?? "latest"), feature: id });
  }
  const services = dev?.runServices ?? (dev?.dockerComposeFile && dev?.service ? [dev.service] : []);
  const merged = { hosts: [...new Set(specs.flatMap((s) => s.hosts ?? []))] };
  const egress = toEgress(merged, dev);
  return { image: dev?.image ?? (dev?.build?.dockerfile ? `build: ${dev.build.dockerfile}` : null), tools, unknownFeatures, services, hosts: egress.allow };
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * A POSIX sh script that reports, one line each:
 *   tool <name> <first line of its version output>   or   tool <name> -
 *   host <host> yes|no|noprobe
 * Hosts are probed with curl or wget, through whatever proxy the environment
 * sets. Any HTTP answer counts as reachable: the question is the network.
 */
export function probeScript({ hosts, canary }) {
  const lines = ["#!/bin/sh"];
  for (const t of TOOLCHAINS) {
    const bin = t.cmd.split(" ")[0];
    lines.push(`if command -v ${bin} >/dev/null 2>&1; then echo "tool ${t.name} $(${t.cmd} 2>&1 | head -n 1)"; else echo "tool ${t.name} -"; fi`);
  }
  for (const h of [...hosts, canary]) {
    const url = shq(`https://${h}/`);
    lines.push(
      `if command -v curl >/dev/null 2>&1; then if curl -s -m 5 -o /dev/null ${url}; then r=yes; else r=no; fi; ` +
        `elif command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null ${url} >/dev/null 2>&1; c=$?; if [ $c -eq 0 ] || [ $c -eq 8 ]; then r=yes; else r=no; fi; ` +
        `else r=noprobe; fi; echo "host ${h} $r"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseProbe(stdout) {
  const tools = {};
  const hosts = {};
  for (const line of String(stdout).split("\n")) {
    const t = /^tool (\S+) (.*)$/.exec(line);
    if (t) tools[t[1]] = t[2].trim() === "-" ? null : t[2].trim();
    const h = /^host (\S+) (yes|no|noprobe)$/.exec(line);
    if (h) hosts[h[1]] = h[2] === "yes" ? true : h[2] === "no" ? false : null;
  }
  return { tools, hosts };
}

/** "22" matches "v22.3.0"; "3.12" matches "Python 3.12.1"; "3.1" does not match "3.12.1". */
export function versionMatches(want, got) {
  if (ANY_VERSION.test(want)) return true;
  const w = String(want).match(/\d+/g) ?? [];
  const g = String(got ?? "").match(/\d+(\.\d+)*/)?.[0]?.split(".") ?? [];
  return w.length > 0 && w.every((n, i) => g[i] === n);
}

/**
 * Every difference between the declaration and the probe. `net` is the
 * network the probe ran on: with none, reachability was not tested and says so
 * once, rather than as one "unreachable" per host.
 */
export function compare(decl, obs, { net = "none", canary } = {}) {
  const diffs = [];
  const add = (kind, message) => diffs.push({ kind, message });
  for (const t of decl.tools) {
    const got = obs.tools[t.name];
    if (got === undefined) add("tool-unchecked", `${t.name} is declared (${t.feature}) but the probe did not report it`);
    else if (got === null) add("tool-missing", `${t.name} ${t.version} is declared (${t.feature}) but not in the environment`);
    else if (!versionMatches(t.version, got)) add("tool-version", `${t.name} ${t.version} is declared (${t.feature}) but the environment has ${got}`);
  }
  for (const [name, got] of Object.entries(obs.tools)) {
    if (got !== null && !decl.tools.some((t) => t.name === name)) add("tool-undeclared", `${name} is in the environment (${got}) but nothing declares it`);
  }
  for (const f of decl.unknownFeatures) add("feature-unchecked", `feature ${f} is declared, and this check does not know how to ask for it`);
  for (const s of decl.services) add("service-not-run", `service ${s} is declared, and this runner starts no services; nothing checked it`);
  if (net === "none") {
    if (decl.hosts.length) add("hosts-unchecked", `no network (net none): none of the ${decl.hosts.length} declared host(s) can be reached, so reachability was not checked. Run with --egress`);
  } else {
    if (Object.values(obs.hosts).some((v) => v === null)) {
      add("hosts-unchecked", "hosts not checked: the image has neither curl nor wget");
    } else {
      for (const h of decl.hosts) if (obs.hosts[h] === false) add("host-unreachable", `${h} is declared but cannot be reached from the environment`);
      if (canary && obs.hosts[canary] === true) add("host-undeclared-reachable", `${canary} is NOT declared and WAS reached: egress is open`);
    }
  }
  return diffs;
}

/** A host that no spec declares, to prove the undeclared are refused. */
export function canaryFor(hosts) {
  return ["example.com", "example.net", "example.org"].find((h) => !hosts.includes(h));
}

/**
 * Run the probe in the same sandbox a run gets (or, with sandbox "none", on
 * this host) and compare. `egress` is { allow, egressNetwork } or null.
 */
export async function check({ devcontainerPath, specs, image = null, sandbox = "podman", egress = null, exec, netns, runtime = "podman" }) {
  const dev = readDevcontainer(devcontainerPath);
  if (dev?.__error) throw new EnvironmentError("BAD_DEVCONTAINER", `${devcontainerPath} is not readable JSON: ${dev.__error}`);
  const decl = declared({ dev, specs });
  const canary = canaryFor(decl.hosts);
  const script = probeScript({ hosts: decl.hosts, canary });
  const run = exec ?? defaultExec(runtime);

  if (sandbox === "none") {
    // On the host, "reachable" is this machine's network, not a sandbox's.
    const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    const obs = parseProbe(r.stdout);
    return { declared: decl, observed: obs, image: null, net: "host", differences: compare(decl, obs, { net: "host", canary }) };
  }
  const { image: img, warnings } = resolveImage({ image, dev, devcontainerPath, runtime, exec: run });
  const limits = toLimits(dev);
  const probeIn = (net, extraRunFlags = [], env = {}) => {
    const args = buildArgs({ image: img, limits, workdir: mkdtempSync(join(tmpdir(), "envcheck-")), net, cmd: ["sh", "-c", script], runtime });
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const r = run([args[0], ...extraRunFlags, ...envFlags, ...args.slice(1)]);
    if (r.status !== 0 && !String(r.stdout).includes("tool ")) {
      throw new EnvironmentError("PROBE_FAILED", `the probe did not run in ${img} (exit ${r.status}): ${String(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
    }
    return parseProbe(r.stdout);
  };
  let obs;
  let net = "none";
  if (egress) {
    const n = netns ?? (await import("./netns.mjs"));
    const runId = `r_${randomBytes(4).toString("hex")}`;
    const logDir = mkdtempSync(join(tmpdir(), "envcheck-egress-"));
    const out = await n.withRunEgress({ runId, allow: decl.hosts, logDir, egressNetwork: egress.egressNetwork, exec: egress.exec }, ({ net: nn, extraRunFlags, env }) => {
      net = nn;
      return probeIn(nn, extraRunFlags, env);
    });
    obs = out.result;
  } else obs = probeIn("none");
  return { declared: decl, observed: obs, image: img, imageId: imageId(img, { runtime, exec: run }), net, warnings, differences: compare(decl, obs, { net, canary }) };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set(["devcontainer", "specs", "image", "sandbox", "egress", "egress-network", "json"]);
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !KNOWN.has(key)) {
      console.error(`environment.mjs: unknown argument ${argv[i]}`);
      process.exit(2);
    }
    f[key] = key === "egress" || key === "json" ? true : argv[++i];
  }
  const devcontainerPath = f.devcontainer ?? ".devcontainer/devcontainer.json";
  try {
    if (cmd === "image") {
      const r = resolveImage({ image: f.image ?? null, dev: readDevcontainer(devcontainerPath), devcontainerPath });
      for (const w of r.warnings) console.error(`WARNING  ${w}`);
      console.log(`${r.image}${r.built ? "  (built now)" : ""}  id ${imageId(r.image) ?? "unknown"}`);
      process.exit(0);
    }
    if (cmd === "check") {
      const { loadSpecs } = await import("./drift.mjs");
      const specsDir = f.specs ?? "specs";
      const specs = existsSync(specsDir) ? loadSpecs(specsDir).specs : [];
      const r = await check({ devcontainerPath, specs, image: f.image ?? null, sandbox: f.sandbox ?? "podman", egress: f.egress ? { egressNetwork: f["egress-network"] } : null });
      if (f.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const w of r.warnings ?? []) console.log(`WARNING  ${w}`);
        for (const d of r.differences) console.log(`DIFF  ${d.kind.padEnd(26)} ${d.message}`);
        console.log(`[environment] ${r.image ?? "this host"} on ${r.net}: ${r.differences.length} difference(s) from the declaration`);
      }
      process.exit(r.differences.length ? 1 : 0);
    }
    console.error("usage: environment.mjs image|check [--devcontainer F] [--specs D] [--image I] [--sandbox podman|none] [--egress] [--json]");
    process.exit(2);
  } catch (e) {
    console.error(`[environment] ${e.name}: ${e.message}`);
    process.exit(2);
  }
}
