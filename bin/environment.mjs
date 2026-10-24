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
 *   node bin/environment.mjs image [--devcontainer .devcontainer/devcontainer.json] [--build-network NET]
 *   node bin/environment.mjs check [--devcontainer F] [--specs specs] [--image I]
 *        [--sandbox podman|none] [--egress] [--egress-network N] [--json]
 * Exit (check): 0 no differences, 1 differences named, 2 misuse or could not run.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { within } from "./paths.mjs";
import { buildArgs, checkLimits, delegatedControllers } from "./sandbox.mjs";
import { HOST, readDevcontainer, toEgress, toLimits } from "./spec.mjs";

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

/**
 * The `podman build` argv for a devcontainer's `build` section, paths resolved
 * from its own directory.
 *
 * THE DOCKERFILE AND CONTEXT MUST BE INSIDE THE WORKSPACE, and this refuses
 * them otherwise (BUILD_OUTSIDE_WORKSPACE). Both come from a file the last
 * run's agent could edit, and the build runs on the host as the operator:
 * a `context` of `/` or enough `..` would hand podman any directory the
 * operator can read as the build context, `COPY` needs no network to bring
 * it into the image, and the next run reads it from inside the sandbox
 * (independent security review, E-5, reproduced).
 *
 * The bound is the project the devcontainer file belongs to. When the file
 * is inside the workspace, which is the case that matters (the agent could
 * edit it), that is the workspace. When the operator points a run at a file
 * OUTSIDE the workspace (`--devcontainer`, the live tests), the agent never
 * had it, and its project by the devcontainer convention is the bound: the
 * parent of a `.devcontainer/` directory, else the file's own directory.
 * The workspace is never the bound for a file that is not in it, because a
 * build context must contain its own Dockerfile's neighbours to be useful.
 *
 * THE BUILD'S RUN STEPS HAVE NO NETWORK unless one is named. A build's RUN
 * steps are a container too: with the host's network they would reach the
 * internet with the repo as their build context, around the egress proxy the
 * run itself is held to. A RUN that downloads needs `buildNetwork`, given per
 * run on the command line and named in the run's warnings.
 *
 * `podman build --network` covers RUN ONLY (podman-build(1)): `ADD <url>` and
 * every image pull (`FROM`, `COPY --from=`, `RUN --mount from=`) happen on
 * the host regardless, from a Dockerfile the agent could have edited. What
 * holds that is not a check of the file's text, which four rounds of review
 * got past, but acceptance: resolveImage builds a Dockerfile inside the
 * workspace only when a human has accepted its digest (BUILD_NOT_ACCEPTED
 * otherwise). checkDockerfile reads the file for what it would fetch, as
 * advice printed with the refusal, so the human accepts knowing.
 */
export function buildArgv(dev, devcontainerPath, { network = "none", workspace = null } = {}) {
  const base = dirname(resolve(devcontainerPath));
  const ownProject = basename(base) === ".devcontainer" ? dirname(base) : base;
  const bound = workspace && within(base, workspace) ? resolve(workspace) : ownProject;
  const b = dev.build ?? {};
  const dockerfile = resolve(base, b.dockerfile);
  const context = resolve(base, b.context ?? ".");
  for (const [what, p] of [["dockerfile", dockerfile], ["context", context]]) {
    if (!within(p, bound)) {
      throw new EnvironmentError(
        "BUILD_OUTSIDE_WORKSPACE",
        `${devcontainerPath}: build.${what} resolves to ${p}, outside the workspace ${bound}. The build runs on the host with that path as its input; only a path inside the workspace is built.`,
      );
    }
  }
  const args = ["build", "--network", network, "-t", buildTag(devcontainerPath), "-f", dockerfile];
  for (const [k, v] of Object.entries(b.args ?? {})) args.push("--build-arg", `${k}=${v}`);
  if (b.target) args.push("--target", String(b.target));
  args.push(context);
  return args;
}

/** Registries a base image may be pulled from with no build network named. */
export const BASE_IMAGE_REGISTRIES = new Set(["docker.io", "localhost"]);

/**
 * The fetches a Dockerfile would make ON THE HOST, as a list of findings
 * (empty when it finds none). THIS IS ADVICE, NOT A CONTROL: it is printed
 * with a BUILD_NOT_ACCEPTED refusal so the human who accepts the build knows
 * what they are accepting, and recorded in the run's warnings afterwards.
 * Four rounds of independent review got past every version of it (heredoc
 * detection, shell quoting, ENV shadowing ARG, ONBUILD, the escape directive's
 * scope), which is why acceptance of the digest is the control instead.
 *
 * podman-build(1) names four places an image or URL is fetched outside the
 * RUN network: `FROM`, `COPY --from=<image>`, `RUN --mount=...,from=<image>`
 * and `ADD <url>` (including its JSON form). An image not written out in full
 * to a registry in BASE_IMAGE_REGISTRIES is reported: an unqualified name
 * (`node:22`) goes wherever the host's registries.conf points. A stage, by
 * alias or index, is not a pull. `args` are the build args the devcontainer
 * declares; `ARG NAME=default` above a FROM and the `${X:-default}` forms
 * resolve; a variable nothing sets is reported.
 */
export function checkDockerfile(text, { args = {} } = {}) {
  const findings = [];
  const vars = { ...Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) };
  const stages = new Set();

  // The Dockerfile's own line rules (containerfile(5)): an `# escape=` directive
  // on the first lines may change the continuation character; comment lines
  // are dropped BEFORE continuations are joined, so a comment inside a
  // continued instruction does not end it; a heredoc body (`<<EOF` … `EOF`)
  // is data for the instruction that opened it, not instructions.
  const raw = String(text ?? "").split(/\r?\n/);
  let esc = "\\";
  for (const l of raw) {
    const d = /^#\s*escape\s*=\s*(\S)\s*$/i.exec(l);
    if (d) esc = d[1];
    else if (l.trim() && !l.trim().startsWith("#")) break;
  }
  const noComments = raw.filter((l) => !/^\s*#/.test(l));
  const joined = [];
  let acc = null;
  for (const l of noComments) {
    const cont = l.trimEnd().endsWith(esc);
    const body = cont ? l.trimEnd().slice(0, -1) : l;
    acc = acc === null ? body : `${acc} ${body.trimStart()}`;
    if (!cont) {
      joined.push(acc.trim());
      acc = null;
    }
  }
  if (acc !== null) joined.push(acc.trim());

  // `${X:-d}` and `${X-d}` take d when X is unset; `${X:+a}` and `${X+a}` take a
  // when it is set. A variable nothing sets stays as written, and the caller
  // refuses what it cannot resolve rather than guessing.
  const expand = (s) =>
    s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name, mod, word, bare) => {
      const v = vars[name ?? bare];
      if (mod === undefined) return v ?? m;
      const set = mod.startsWith(":") ? v !== undefined && v !== "" : v !== undefined;
      if (mod.endsWith("-")) return set ? v : word;
      return set ? word : "";
    });
  const words = (s) => {
    const t = s.trim();
    if (t.startsWith("[")) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
      } catch {
        /* not the JSON form: fall through to whitespace */
      }
    }
    return t.split(/\s+/).filter(Boolean);
  };
  // An image named as a pull source: a stage (by alias or index) is not one;
  // anything else is judged by its registry, which must be written out.
  const judgeImage = (where, written) => {
    const image = expand(written);
    if (!image) return findings.push(`${where} names no image`);
    if (/\$/.test(image)) return findings.push(`${where} ${written} cannot be resolved: no ARG or build arg sets it`);
    const low = image.toLowerCase();
    if (stages.has(low) || low === "scratch" || /^\d+$/.test(low)) return;
    const first = image.split("/")[0];
    const qualified = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
    if (!qualified) return findings.push(`${where} ${image} is not fully qualified: an unqualified name goes wherever this host's registries.conf points (write docker.io/library/${image.split("/").pop()})`);
    const registry = first.replace(/:\d+$/, "");
    if (!BASE_IMAGE_REGISTRIES.has(registry)) findings.push(`${where} ${image} pulls from ${registry}`);
  };
  const mountFrom = (flag) => (flag.slice(8).split(",").map((kv) => kv.split("=")).find(([k]) => k === "from") ?? [])[1];

  let heredoc = null;
  for (const line of joined) {
    if (heredoc !== null) {
      if (line === heredoc) heredoc = null;
      continue;
    }
    if (!line) continue;
    const [instr, ...restWords] = line.split(/\s+/);
    const rest = line.slice(instr.length).trim();
    const op = instr.toUpperCase();
    const hd = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(rest);
    if (hd && ["RUN", "COPY", "ADD"].includes(op)) heredoc = hd[1];
    if (op === "ARG") {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(rest);
      if (m && m[2] !== undefined && !(m[1] in vars)) vars[m[1]] = expand(m[2].replace(/^"(.*)"$/, "$1"));
    } else if (op === "FROM") {
      const w = restWords.filter((x) => !x.startsWith("--"));
      const asIdx = w.findIndex((x) => x.toUpperCase() === "AS");
      judgeImage("FROM", w[0] ?? "");
      if (asIdx !== -1 && w[asIdx + 1]) stages.add(w[asIdx + 1].toLowerCase());
    } else if (op === "ADD" || op === "COPY") {
      const flags = restWords.filter((x) => x.startsWith("--"));
      for (const f of flags) {
        if (f.startsWith("--from=")) judgeImage(`${op} --from=`, f.slice(7));
      }
      if (op === "ADD" && !hd) {
        const w = words(restWords.filter((x) => !x.startsWith("--")).join(" "));
        const srcs = w.length > 1 ? w.slice(0, -1) : w;
        for (const s of srcs) {
          const v = expand(s);
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^git@/i.test(v)) findings.push(`ADD ${s} fetches a URL`);
          else if (/\$/.test(v)) findings.push(`ADD ${s} cannot be resolved: no ARG or build arg sets it`);
        }
      }
    } else if (op === "RUN") {
      for (const f of restWords.filter((x) => x.startsWith("--mount="))) {
        const from = mountFrom(f);
        if (from !== undefined) judgeImage("RUN --mount from=", from);
      }
    }
  }
  return findings;
}

/**
 * The image for a run. `policy.image` wins; then devcontainer `image`; then
 * devcontainer `build`, built now. Returns { image, built, warnings }.
 */
/**
 * What a human accepts when they accept a build: the Dockerfile's bytes and
 * the devcontainer's whole `build` section (args feed ARG, which feeds FROM;
 * context and target choose what is built). sha256, hex. Null when there is
 * no Dockerfile to read yet, which the build itself will then report.
 */
export function buildDigest(dev, devcontainerPath) {
  const base = dirname(resolve(devcontainerPath));
  const b = dev?.build ?? {};
  const df = resolve(base, String(b.dockerfile ?? "Dockerfile"));
  if (!existsSync(df)) return null;
  const h = createHash("sha256");
  h.update(readFileSync(df));
  h.update("\0");
  h.update(JSON.stringify({ dockerfile: b.dockerfile ?? null, context: b.context ?? null, args: b.args ?? null, target: b.target ?? null }));
  return h.digest("hex");
}

/** Is this devcontainer file one the agent could have edited: inside the workspace? */
export const agentEditable = (devcontainerPath, workspace) => Boolean(workspace) && within(dirname(resolve(devcontainerPath)), workspace);

export function resolveImage({ image = null, dev, devcontainerPath, runtime = "podman", exec, buildNetwork = "none", workspace = null, acceptBuilds = [] }) {
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
    const args = buildArgv(dev, devcontainerPath, { network: buildNetwork, workspace });
    /*
     * AN AGENT-EDITED DOCKERFILE IS NOT BUILT UNTIL A HUMAN ACCEPTS IT.
     *
     * The build runs on the host, as the operator, from a file in the
     * workspace that the last run's agent could have written. Four rounds of
     * independent review found a way past every check that read the file
     * (context escapes, ADD URLs, COPY --from, heredocs, quoting, ONBUILD,
     * ENV shadowing ARG): a parser of someone else's grammar is a claim, not
     * a control. So the control is the one that needs no parser: the digest
     * of the Dockerfile and the build section must be on the accepted list,
     * which lives outside the workspace and grows only by the operator's
     * `--accept-build <digest>`. The refusal prints the digest and what the
     * reader found, so the human accepts with their eyes open. A file the
     * operator keeps outside the workspace was never the agent's, and needs
     * no acceptance. The residual is a human accepting without reading.
     */
    const digest = buildDigest(dev, devcontainerPath);
    if (agentEditable(devcontainerPath, workspace) && digest !== null && !acceptBuilds.includes(digest)) {
      let found = [];
      try {
        found = checkDockerfile(readFileSync(resolve(dirname(resolve(devcontainerPath)), dev.build.dockerfile), "utf8"), { args: dev.build.args ?? {} });
      } catch {
        /* the reader is advice; the digest is the control */
      }
      throw new EnvironmentError(
        "BUILD_NOT_ACCEPTED",
        `${devcontainerPath} builds an image from a Dockerfile inside the workspace, which the last run's agent could have edited, and this version has not been accepted. ` +
          `Read ${resolve(dirname(resolve(devcontainerPath)), dev.build.dockerfile)}, then accept it once with --accept-build ${digest}. ` +
          (found.length ? `What it would fetch on the host: ${found.join("; ")}.` : "The reader found no host fetch in it, which is advice, not proof."),
      );
    }
    if (buildNetwork !== "none") {
      warnings.push(`the image was built with network "${buildNetwork}": its Dockerfile is in the workspace, where an agent can edit it, and its RUN steps were not held to the egress allowlist`);
    }
    if (digest !== null && agentEditable(devcontainerPath, workspace)) {
      let found = [];
      try {
        found = checkDockerfile(readFileSync(resolve(dirname(resolve(devcontainerPath)), dev.build.dockerfile), "utf8"), { args: dev.build.args ?? {} });
      } catch {
        /* advice only */
      }
      warnings.push(`image built from an accepted workspace Dockerfile, digest ${digest.slice(0, 12)}…${found.length ? `; the reader notes it would fetch on the host: ${found.join("; ")}` : ""}`);
    }
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
// "none" is NOT here: a feature at version "none" means "do not install it",
// so the tool must be absent (independent review: it was read as "any").
const ANY_VERSION = /^(latest|lts|os-provided|)$/i;

/**
 * The version in an image tag: its first dash-separated part that is a whole
 * number ("3.12-slim" is 3.12, "22-alpine3.20" is 22, not the alpine release;
 * independent review). The devcontainers images put their own version first,
 * so "1-22-bookworm" from .../devcontainers/ is 22. No such part: latest.
 */
export const tagVersion = (image) => {
  const s = String(image ?? "");
  const tag = /:([^/:@]+)(@|$)/.exec(s)?.[1] ?? "";
  const nums = tag.split("-").filter((p) => /^v?\d+(\.\d+)*$/.test(p)).map((p) => p.replace(/^v/, ""));
  // A devcontainers tag's first number is the image's own version, so with
  // only that one ("1-bookworm") no toolchain version is named: any.
  const pick = /\/devcontainers\//.test(s) ? (nums.length > 1 ? nums[1] : undefined) : nums[0];
  return pick ?? "latest";
};

/** An image's repository, without registry defaults, tag or digest: docker.io/library/postgres:16 is postgres. */
export const imageRepo = (image) =>
  String(image ?? "")
    .replace(/@.*$/, "")
    .replace(/:[^/:]*$/, "")
    .replace(/^(docker\.io\/|index\.docker\.io\/)?(library\/)?/, "");

/**
 * The services a compose file declares, and each one's image: the `services:`
 * map and its `image:` lines, nothing else of compose. No YAML dependency, so
 * a file this cannot read is reported as unread rather than guessed at.
 */
export function composeServices(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  let indent = null;
  let child = null;
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const lead = l.length - l.trimStart().length;
    if (lead === 0) break;
    indent ??= lead;
    const svc = lead === indent && /^\s*["']?([\w.-]+)["']?:\s*(#.*)?$/.exec(l);
    if (svc) {
      cur = svc[1];
      out[cur] = { image: null };
      child = null;
    } else if (cur && lead > indent) {
      // The service's own `image:`, one level in: an `image:` nested deeper
      // (under environment:, labels:, …) is not the service's image
      // (independent re-review).
      child ??= lead;
      const img = lead === child && /^\s*image:\s*["']?([^"'\s#]+)/.exec(l);
      if (img) out[cur].image = img[1];
    }
  }
  return out;
}

/**
 * The compose project names a running service of THIS stack can carry: the
 * file's top-level `name:` if it has one; else the compose directory's name,
 * and the `<folder>_devcontainer` name a dev container tool gives it. A
 * service found under any other project is another stack's (independent
 * re-review: a stopped db here was "running" because another project's was).
 */
export function composeProjects(text, composePath, workspaceRoot = null) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const named = /^name:\s*["']?([^"'\s#]+)/m.exec(String(text))?.[1];
  if (named) return [norm(named)];
  const out = [norm(basename(dirname(resolve(composePath))))];
  if (workspaceRoot) out.push(`${norm(basename(resolve(workspaceRoot)))}_devcontainer`);
  return [...new Set(out)];
}

/** What the spec and devcontainer declare. */
export function declared({ dev, specs = [], devcontainerPath = null }) {
  const tools = [];
  const unknownFeatures = [];
  for (const [id, opts] of Object.entries(dev?.features ?? {})) {
    const tc = TOOLCHAINS.find((t) => t.match.test(id));
    if (!tc) unknownFeatures.push(id);
    else tools.push({ name: tc.name, version: String(opts?.version ?? "latest"), feature: id });
  }
  // An image named for a toolchain declares it too, at its tag's version
  // (independent review: node:22 declared nothing), unless a feature says.
  if (dev?.image) {
    const base = String(dev.image).split("/").at(-1).split(/[:@]/)[0];
    const tc = TOOLCHAINS.find((t) => t.match.test(base));
    if (tc && !tools.some((t) => t.name === tc.name)) tools.push({ name: tc.name, version: tagVersion(dev.image), feature: `image ${dev.image}` });
  }
  // Services come from the compose file, with the image each one runs
  // (independent QA: the file was never read, so no version existed to
  // compare). The dev container's own `service` is the environment itself,
  // not a service it needs.
  let compose = null;
  let composeError = null;
  let projects = null;
  const files = [dev?.dockerComposeFile ?? []].flat();
  if (files.length && devcontainerPath) {
    compose = {};
    for (const f of files) {
      try {
        const file = resolve(dirname(devcontainerPath), f);
        const text = readFileSync(file, "utf8");
        projects ??= composeProjects(text, file, resolve(dirname(devcontainerPath), ".."));
        const got = composeServices(text);
        if (!got) composeError = `${f} has no services: map`;
        else Object.assign(compose, got);
      } catch (e) {
        composeError = `${f} could not be read: ${e.code ?? e.message}`;
      }
    }
  }
  const names = (dev?.runServices ?? Object.keys(compose ?? {})).filter((n) => n !== dev?.service);
  const services = names.map((name) => {
    const image = compose?.[name]?.image ?? null;
    return { name, image, version: image ? tagVersion(image) : null, ...(image ? {} : { why: composeError ?? (compose ? `no image: line for ${name} in the compose file` : "no compose file declares it") }) };
  });
  const merged = { hosts: [...new Set(specs.flatMap((s) => s.hosts ?? []))] };
  const egress = toEgress(merged, dev);
  return { image: dev?.image ?? (dev?.build?.dockerfile ? `build: ${dev.build.dockerfile}` : null), tools, unknownFeatures, services, composeProjects: projects, hosts: egress.allow };
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
  // Hosts reach a shell here, on the HOST with --sandbox none. spec.mjs refuses
  // anything that is not a host name; this refuses it again rather than trust
  // every path that builds a host list, and quotes what it prints.
  for (const h of [...hosts, canary]) {
    if (!HOST.test(String(h))) throw new EnvironmentError("BAD_HOST", `"${h}" is not a host name; refusing to put it in a shell script`);
  }
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
        `else r=noprobe; fi; printf 'host %s %s\\n' ${shq(h)} "$r"`,
    );
  }
  // The canary again with every proxy variable unset (independent review: a
  // network that routes AROUND the proxy read as closed, since the probe only
  // ever asked through it). Reached directly means the route itself is open.
  const bare = "env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy";
  const url = shq(`https://${canary}/`);
  lines.push(
    `if command -v curl >/dev/null 2>&1; then if ${bare} curl -s -m 5 -o /dev/null ${url}; then r=yes; else r=no; fi; ` +
      `elif command -v wget >/dev/null 2>&1; then ${bare} wget -q -T 5 -O /dev/null ${url} >/dev/null 2>&1; c=$?; if [ $c -eq 0 ] || [ $c -eq 8 ]; then r=yes; else r=no; fi; ` +
      `else r=noprobe; fi; printf 'direct %s %s\\n' ${shq(canary)} "$r"`,
  );
  return `${lines.join("\n")}\n`;
}

export function parseProbe(stdout) {
  const tools = {};
  const hosts = {};
  const direct = {};
  for (const line of String(stdout).split("\n")) {
    const t = /^tool (\S+) (.*)$/.exec(line);
    if (t) tools[t[1]] = t[2].trim() === "-" ? null : t[2].trim();
    const h = /^(host|direct) (\S+) (yes|no|noprobe)$/.exec(line);
    if (h) (h[1] === "host" ? hosts : direct)[h[2]] = h[3] === "yes" ? true : h[3] === "no" ? false : null;
  }
  return { tools, hosts, direct };
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
export function compare(decl, obs, { net = "none", canary, running = null } = {}) {
  const diffs = [];
  const add = (kind, message) => diffs.push({ kind, message });
  for (const t of decl.tools) {
    const got = obs.tools[t.name];
    if (/^none$/i.test(t.version)) {
      if (got) add("tool-version", `${t.name} is declared "none" (${t.feature}), so not installed, but the environment has ${got}`);
      continue;
    }
    if (got === undefined) add("tool-unchecked", `${t.name} is declared (${t.feature}) but the probe did not report it`);
    else if (got === null) add("tool-missing", `${t.name} ${t.version} is declared (${t.feature}) but not in the environment`);
    else if (!versionMatches(t.version, got)) add("tool-version", `${t.name} ${t.version} is declared (${t.feature}) but the environment has ${got}`);
  }
  for (const [name, got] of Object.entries(obs.tools)) {
    if (got !== null && !decl.tools.some((t) => t.name === name)) add("tool-undeclared", `${name} is in the environment (${got}) but nothing declares it`);
  }
  for (const f of decl.unknownFeatures) add("feature-unchecked", `feature ${f} is declared, and this check does not know how to ask for it`);
  for (const s of decl.services) {
    const name = s.name ?? s;
    if (!s.image) add("service-unchecked", `service ${name} is declared, but ${s.why ?? "nothing declares its image"}, so there is no version to compare`);
    else if (!running || !(name in running)) add("service-not-run", `service ${name} (${s.image}) is declared, and this runner starts no services; nothing checked it`);
    else if (!running[name]) add("service-not-running", `service ${name} (${s.image}) is declared, and no container for it is running`);
    else if (imageRepo(running[name]) !== imageRepo(s.image)) add("service-image", `service ${name} is declared as ${s.image} but ${running[name]} is running: another image`);
    else if (!versionMatches(s.version, tagVersion(running[name]))) add("service-version", `service ${name} is declared as ${s.image} but ${running[name]} is running`);
  }
  if (net === "none") {
    if (decl.hosts.length) add("hosts-unchecked", `no network (net none): none of the ${decl.hosts.length} declared host(s) can be reached, so reachability was not checked. Run with --egress`);
  } else {
    if (Object.values(obs.hosts).some((v) => v === null)) {
      add("hosts-unchecked", "hosts not checked: the image has neither curl nor wget");
    } else {
      for (const h of decl.hosts) if (obs.hosts[h] === false) add("host-unreachable", `${h} is declared but cannot be reached from the environment`);
      if (canary && obs.hosts[canary] === true) add("host-undeclared-reachable", `${canary} is NOT declared and WAS reached: egress is open`);
      else if (canary && obs.direct?.[canary] === true) add("host-undeclared-reachable", `${canary} is NOT declared and WAS reached DIRECTLY, with no proxy: the network routes around the proxy`);
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
/**
 * The image each declared service is running as, from the compose label the
 * runtime puts on its container: "" when none runs, absent when the runtime
 * cannot be asked.
 */
export function runningServices(services, run, projects = null) {
  const out = {};
  for (const s of services) {
    if (!s.image) continue;
    const r = run(["ps", "--filter", `label=com.docker.compose.service=${s.name}`, "--format", '{{.Image}}\t{{index .Labels "com.docker.compose.project"}}']);
    if (r.status !== 0) return null;
    const rows = String(r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
    out[s.name] = rows.find(([, p]) => !projects || projects.includes(String(p ?? "").trim()))?.[0] ?? "";
  }
  return out;
}

export async function check({ devcontainerPath, specs, image = null, sandbox = "podman", egress = null, exec, netns, runtime = "podman", controllers = null }) {
  const dev = readDevcontainer(devcontainerPath);
  if (dev?.__error) throw new EnvironmentError("BAD_DEVCONTAINER", `${devcontainerPath} is not readable JSON: ${dev.__error}`);
  const decl = declared({ dev, specs, devcontainerPath });
  const canary = canaryFor(decl.hosts);
  const script = probeScript({ hosts: decl.hosts, canary });
  const run = exec ?? defaultExec(runtime);
  const running = decl.services.some((s) => s.image) ? runningServices(decl.services, run, decl.composeProjects) : null;

  if (sandbox === "none") {
    // On the host, "reachable" is this machine's network, not a sandbox's.
    const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    const obs = parseProbe(r.stdout);
    return { declared: decl, observed: obs, image: null, net: "host", differences: compare(decl, obs, { net: "host", canary, running }) };
  }
  const { image: img, warnings } = resolveImage({ image, dev, devcontainerPath, runtime, exec: run });
  const limits = toLimits(dev);
  // The same preflight a run gets (independent review: --cpus killed the
  // probe where the cpu controller is not delegated). A check is not an
  // agent run, so a limit the kernel cannot enforce is dropped and said.
  if (runtime === "podman") {
    for (const m of checkLimits(["memory", "cpus", "pids"], controllers ?? delegatedControllers().controllers)) {
      if (limits[m.limit]) warnings.push(`probe not limited on ${m.limit}: no "${m.controller}" cgroup controller is delegated here`);
      limits[m.limit] = null;
    }
  }
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
  return { declared: decl, observed: obs, image: img, imageId: imageId(img, { runtime, exec: run }), net, warnings, differences: compare(decl, obs, { net, canary, running }) };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set(["devcontainer", "specs", "image", "sandbox", "egress", "egress-network", "json", "build-network"]);
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
      const r = resolveImage({ image: f.image ?? null, dev: readDevcontainer(devcontainerPath), devcontainerPath, buildNetwork: f["build-network"] ?? "none" });
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
