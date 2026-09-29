#!/usr/bin/env node
/**
 * E-5 and E-6: a run's environment is built from the spec every run and keeps
 * nothing between runs but the repo; and a check names every difference
 * between what the environment declares and what it has.
 *
 * The declared-vs-real comparison runs here against a fake toolchain on PATH.
 * The live checks need podman and node:22-alpine (CI pulls it) and SKIP
 * loudly without them.
 *
 * Run: node bin/environment.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EnvironmentError, buildArgv, buildTag, canaryFor, check, compare, composeServices, declared, parseProbe, probeScript, resolveImage, runningServices, tagVersion, versionMatches,
} from "./environment.mjs";
import { HarnessError, imageFor, run } from "./harness.mjs";
import { detect } from "./sandbox.mjs";
import { toLimits } from "./spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof EnvironmentError ? e.code : `other: ${e.name}: ${e.message}`;
  }
};
const TMP = mkdtempSync(join(tmpdir(), "environment-test-"));

/* ------------------------------------------------------------- E-5: image */
const DEVDIR = join(TMP, "proj", ".devcontainer");
mkdirSync(DEVDIR, { recursive: true });
const DEV = join(DEVDIR, "devcontainer.json");
{
  const built = { build: { dockerfile: "Dockerfile", context: "..", args: { V: "1" }, target: "dev" } };
  const argv = buildArgv(built, DEV);
  ok("a Dockerfile is built with paths taken from the devcontainer's own directory",
    JSON.stringify(argv) === JSON.stringify(["build", "--network", "none", "-t", buildTag(DEV), "-f", join(DEVDIR, "Dockerfile"), "--build-arg", "V=1", "--target", "dev", join(TMP, "proj")]), JSON.stringify(argv));
  ok("THE IMAGE BUILD HAS NO NETWORK by default: its Dockerfile is agent-editable", argv[1] === "--network" && argv[2] === "none");
  {
    const w = resolveImage({ dev: built, devcontainerPath: DEV, exec: () => ({ status: 0 }), buildNetwork: "host" }).warnings;
    ok("…a build given a network is named in the warnings", w.some((x) => /built with network "host"/.test(x)), JSON.stringify(w));
  }
  ok("the build tag is stable for one devcontainer and distinct for another", buildTag(DEV) === buildTag(DEV) && buildTag(DEV) !== buildTag(join(TMP, "other.json")));
  ok("a build-only devcontainer no longer passes its Dockerfile path off as an image name", toLimits(built).image === null);

  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  const r = resolveImage({ dev: built, devcontainerPath: DEV, exec });
  ok("a build section is BUILT, now, and its tag used", r.built && r.image === buildTag(DEV) && calls.length === 1 && calls[0][0] === "build");
  resolveImage({ dev: built, devcontainerPath: DEV, exec });
  ok("…and built again on the next run: no cache key of ours decides what is stale", calls.length === 2);
  calls.length = 0;
  ok("an explicit image wins, and nothing is built", resolveImage({ image: "x:1", dev: built, devcontainerPath: DEV, exec }).image === "x:1" && calls.length === 0);
  ok("a devcontainer image is used as named", resolveImage({ dev: { image: "node:22" }, devcontainerPath: DEV, exec }).image === "node:22" && calls.length === 0);
  ok("no image anywhere is refused by name", code(() => resolveImage({ dev: {}, devcontainerPath: DEV, exec })) === "NO_IMAGE");
  const failing = () => ({ status: 125, stdout: "", stderr: "step 1\nstep 2\nError: no such file stamp.txt" });
  let msg = "";
  try {
    resolveImage({ dev: built, devcontainerPath: DEV, exec: failing });
  } catch (e) {
    msg = e.message;
  }
  ok("a failed build stops the run and quotes the build's own error", /building the image .* failed \(exit 125\).*no such file stamp\.txt/.test(msg), msg);
  const w = resolveImage({ dev: { image: "i", features: { "ghcr.io/devcontainers/features/python:1": {} } }, devcontainerPath: DEV, exec }).warnings;
  ok("declared features that this runner does not install are named, not silently skipped", w.length === 1 && /python:1/.test(w[0]) && /NOT installed/.test(w[0]));
}
{
  // The harness turns the environment's refusal into its own error type and records the image id.
  const warnings = [];
  const exec = (args) => (args[0] === "image" ? { status: 0, stdout: "sha256:abc123\n" } : { status: 0, stdout: "" });
  const r = imageFor({ image: "node:22", devcontainer: DEV, sandbox: "podman" }, null, warnings, { exec });
  ok("a run records the id of the image it resolved, not only the tag", r.imageId === "sha256:abc123");
  let err = null;
  try {
    imageFor({ image: null, devcontainer: DEV, sandbox: "podman" }, {}, [], { exec });
  } catch (e) {
    err = e;
  }
  ok("with no image the harness raises its own error, naming the fix", err instanceof HarnessError && /no image/.test(err.message));
}

/* ------------------------------------------------------ E-6: the declaration */
const FEATURES = {
  "ghcr.io/devcontainers/features/node:1": { version: "22" },
  "ghcr.io/devcontainers/features/python:1": { version: "3.12" },
  "ghcr.io/devcontainers/features/go:1": {},
  "ghcr.io/acme/features/widget:1": {},
};
const decl = declared({ dev: { image: "base", features: FEATURES, runServices: ["db"] }, specs: [{ hosts: ["api.example.test"] }, { hosts: ["api.example.test", "cdn.example.test"] }] });
ok("toolchains and their versions are read from the features", JSON.stringify(decl.tools.map((t) => [t.name, t.version])) === '[["node","22"],["python","3.12"],["go","latest"]]', JSON.stringify(decl.tools));
ok("a feature this check cannot ask about is kept, to be named", decl.unknownFeatures.join() === "ghcr.io/acme/features/widget:1");
ok("hosts are every spec's, plus the registries the toolchains need", ["api.example.test", "cdn.example.test", "registry.npmjs.org", "pypi.org", "proxy.golang.org"].every((h) => decl.hosts.includes(h)) && decl.hosts.filter((h) => h === "api.example.test").length === 1);
ok("the canary is a host nobody declared", canaryFor(decl.hosts) === "example.com" && canaryFor(["example.com"]) === "example.net");

ok("22 matches v22.3.0", versionMatches("22", "v22.3.0"));
ok("3.12 matches 'Python 3.12.1'", versionMatches("3.12", "Python 3.12.1"));
ok("3.1 does NOT match 3.12.1", !versionMatches("3.1", "Python 3.12.1"));
ok("latest matches any version", versionMatches("latest", "go version go1.24.7 linux/amd64"));

/* ------------------------------------------------- E-6: asking a real shell */
// A fake toolchain: only these commands exist on PATH.
const BIN = join(TMP, "bin");
mkdirSync(BIN);
const fake = (name, body) => {
  writeFileSync(join(BIN, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(BIN, name), 0o755);
};
for (const t of ["sh", "head", "grep", "env"]) {
  const p = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(p, join(BIN, t));
}
fake("node", "echo v22.3.0");
fake("python3", "echo 'Python 3.10.4'");
fake("ruby", "echo 'ruby 3.3.0'");
fake("java", "echo 'Picked up JAVA_TOOL_OPTIONS: -Dx=127.0.0.1' >&2; echo 'openjdk version \"21.0.2\"' >&2");
const probe = (curlBody, extra = {}) => {
  if (curlBody === null) rmSync(join(BIN, "curl"), { force: true });
  else fake("curl", curlBody);
  const canary = canaryFor(decl.hosts);
  const r = spawnSync(join(BIN, "sh"), ["-c", probeScript({ hosts: decl.hosts, canary })], { encoding: "utf8", env: { PATH: BIN, ...extra } });
  return { obs: parseProbe(r.stdout), canary, raw: r.stdout };
};
{
  // curl reaches everything declared except cdn.example.test, and refuses the canary.
  const { obs, canary, raw } = probe('for a; do u=$a; done; case "$u" in *cdn.example.test*|*example.com*) exit 7;; esac; exit 0');
  ok("the probe reports each toolchain's own version line", obs.tools.node === "v22.3.0" && obs.tools.python === "Python 3.10.4" && obs.tools.go === null, raw);
  ok("…with java's JAVA_TOOL_OPTIONS noise skipped", obs.tools.java === 'openjdk version "21.0.2"', obs.tools.java);
  const diffs = compare(decl, obs, { net: "caretaker-egress-x", canary });
  const kinds = (k) => diffs.filter((d) => d.kind === k).map((d) => d.message);
  ok("a declared version the environment does not have is named", kinds("tool-version").some((m) => /python 3\.12 .* has Python 3\.10\.4/.test(m)), JSON.stringify(diffs));
  ok("a matching version is not a difference", !diffs.some((d) => /node/.test(d.message)));
  ok("a declared toolchain the environment lacks is named", kinds("tool-missing").some((m) => /^go latest/.test(m)));
  ok("a toolchain present that nobody declared is named", kinds("tool-undeclared").some((m) => /^ruby/.test(m)) && kinds("tool-undeclared").some((m) => /^java/.test(m)));
  ok("a declared service with no compose file to give its image is named as unchecked, with why", kinds("service-unchecked").some((m) => /service db .*no compose file declares it/.test(m)), JSON.stringify(diffs));
  ok("a feature the check cannot ask about is named as unchecked", kinds("feature-unchecked").some((m) => /widget/.test(m)));
  ok("a declared host that cannot be reached is named", JSON.stringify(kinds("host-unreachable")) === JSON.stringify(["cdn.example.test is declared but cannot be reached from the environment"]));
  ok("a refused canary is not a difference", kinds("host-undeclared-reachable").length === 0);
}
{
  const { obs, canary } = probe("exit 0");
  ok("an UNDECLARED host that is reachable is named: egress is open", compare(decl, obs, { net: "n", canary }).some((d) => d.kind === "host-undeclared-reachable" && d.message.includes(canary)));
}
{
  const { obs, canary } = probe(null);
  const diffs = compare(decl, obs, { net: "n", canary });
  ok("with neither curl nor wget, hosts are reported unchecked, not reachable or not", diffs.some((d) => d.kind === "hosts-unchecked" && /neither curl nor wget/.test(d.message)) && !diffs.some((d) => d.kind.startsWith("host-")));
}
{
  // net none as it really is: curl present, every request fails.
  const { obs, canary } = probe("exit 7");
  const none = compare(decl, obs, { net: "none", canary });
  ok("on net none, reachability is one named line, not one 'unreachable' per host", none.filter((d) => d.kind === "hosts-unchecked").length === 1 && /net none/.test(none.find((d) => d.kind === "hosts-unchecked")?.message) && !none.some((d) => d.kind === "host-unreachable"), JSON.stringify(none));
}
{
  // The reviewer's attack: shell syntax in a spec's hosts, checked on the host.
  const pwned = join(TMP, "pwned-by-spec");
  const specs = join(TMP, "evil-specs");
  mkdirSync(specs);
  writeFileSync(join(specs, "evil.md"), `\`\`\`spec\nhosts: $(touch\${IFS}${pwned}), api.example.test\ngoverns: src/**\n\`\`\`\n`);
  const { loadSpecs } = await import("./drift.mjs");
  const loaded = loadSpecs(specs).specs;
  try {
    await check({ devcontainerPath: join(TMP, "none.json"), specs: loaded, sandbox: "none" });
  } catch {
    /* the probe's own refusal; the assertion below is about the host */
  }
  ok("shell syntax in a spec's hosts never runs on the host", !existsSync(pwned) && loaded[0].hosts.join() === "api.example.test", JSON.stringify(loaded[0]));
  let refused = null;
  try {
    probeScript({ hosts: ["a.example.test; touch /tmp/x"], canary: "example.com" });
  } catch (e) {
    refused = e.code;
  }
  ok("…and the probe refuses a non-host name itself, whoever built the list", refused === "BAD_HOST");
}
/* ------------------------------------- E-6: what independent review found */
{
  // Services, from the compose file (QA: it was never read, and the dev
  // container's own service was reported as an unstarted one).
  const dir = join(TMP, "compose-dev");
  mkdirSync(dir);
  writeFileSync(join(dir, "compose.yml"), "# the stack\nservices:\n  app:\n    build: .\n  db:\n    image: \"docker.io/library/postgres:16\"  # pinned\n    ports: [\"5432\"]\n  cache:\n    image: redis:7.2-alpine\nvolumes:\n  data:\n");
  writeFileSync(join(dir, "devcontainer.json"), JSON.stringify({ dockerComposeFile: "compose.yml", service: "app", runServices: ["app", "db"] }));
  const d = declared({ dev: JSON.parse(readFileSync(join(dir, "devcontainer.json"), "utf8")), devcontainerPath: join(dir, "devcontainer.json") });
  ok("the compose file is read: each service's image, and its version from the tag", JSON.stringify(d.services) === '[{"name":"db","image":"docker.io/library/postgres:16","version":"16"}]', JSON.stringify(d.services));
  ok("…and the dev container's own service is the environment, not a service it needs", !d.services.some((x) => x.name === "app"));
  const all = declared({ dev: { dockerComposeFile: "compose.yml", service: "app" }, devcontainerPath: join(dir, "devcontainer.json") });
  ok("with no runServices, every compose service but the dev container's is declared", all.services.map((x) => x.name).join() === "db,cache" && all.services[1].version === "7.2");
  const k = (running) => compare({ ...d, tools: [], unknownFeatures: [], hosts: [] }, { tools: {}, hosts: {} }, { net: "none", running }).map((x) => x.kind).join();
  ok("a running service at another version is named", k({ db: "docker.io/library/postgres:15" }) === "service-version");
  // Independent QA: both of these read as no difference.
  ok("…including when the tags share a base-OS suffix", compare({ ...d, services: [{ name: "db", image: "postgres:16-alpine3.20", version: tagVersion("postgres:16-alpine3.20") }], tools: [], unknownFeatures: [], hosts: [] }, { tools: {}, hosts: {} }, { net: "none", running: { db: "postgres:17-alpine3.20" } }).map((x) => x.kind).join() === "service-version");
  ok("a service running ANOTHER image at the same version is named", k({ db: "redis:16" }) === "service-image");
  ok("…one at the declared version is not a difference", k({ db: "docker.io/library/postgres:16.2" }) === "");
  ok("…a declared service with no container running is named", k({ db: "" }) === "service-not-running");
  ok("…and when the runtime cannot be asked, it says nothing checked it", k(null) === "service-not-run");
  const asked = [];
  const got = runningServices(d.services, (a) => (asked.push(a.join(" ")), { status: 0, stdout: "docker.io/library/postgres:15\n" }));
  ok("running services are found by the compose label on their container", got.db === "docker.io/library/postgres:15" && asked[0] === "ps --filter label=com.docker.compose.service=db --format {{.Image}}", asked.join());
  ok("a compose file with no services map is unread, not guessed at", composeServices("version: 3\n") === null);
}
{
  // Version "none" means not installed (review: it was read as any version).
  const d = { tools: [{ name: "python", version: "none", feature: "f" }], unknownFeatures: [], services: [], hosts: [] };
  ok("a tool declared at version none that IS present is named", compare(d, { tools: { python: "Python 3.12.1" }, hosts: {} }).some((x) => x.kind === "tool-version" && /declared "none"/.test(x.message)));
  ok("…and one that is absent is not a difference", compare(d, { tools: { python: null }, hosts: {} }).length === 0);
}
{
  // The image tag declares a toolchain (review: node:22 declared nothing).
  ok("an image named for a toolchain declares it at its tag", JSON.stringify(declared({ dev: { image: "mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm" } }).tools) === '[{"name":"node","version":"22","feature":"image mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm"}]');
  ok("…a feature's own version wins over the tag", declared({ dev: { image: "node:20", features: { "ghcr.io/devcontainers/features/node:1": { version: "22" } } } }).tools.map((t) => t.version).join() === "22");
  ok("tag versions", tagVersion("python:3.12-slim") === "3.12" && tagVersion("node") === "latest" && tagVersion("reg:5000/node:22@sha256:ab") === "22" && tagVersion("golang:1.23") === "1.23");
  // Independent review: the last number was taken, so node:22-alpine3.20 read as node 3.20.
  ok("the toolchain's number, not the base OS release", tagVersion("node:22-alpine3.20") === "22" && tagVersion("postgres:16-alpine3.20") === "16" && tagVersion("mcr.microsoft.com/devcontainers/python:1-3.12-bookworm") === "3.12" && tagVersion("x:v1.2") === "1.2");
}
{
  // The canary, asked directly too (review: a network that routes around the
  // proxy read as closed, since the probe only asked through it).
  const { obs, canary } = probe('[ -n "$HTTPS_PROXY" ] && exit 56; exit 0', { HTTPS_PROXY: "http://proxy:8080" });
  const diffs = compare(decl, obs, { net: "n", canary });
  ok("an undeclared host reached with no proxy is named: the route is open", obs.direct[canary] === true && obs.hosts[canary] === false && diffs.some((x) => x.kind === "host-undeclared-reachable" && /DIRECTLY/.test(x.message)), JSON.stringify(obs));
  const closed = probe("exit 7", { HTTPS_PROXY: "http://proxy:8080" });
  ok("…and a closed route is not a difference", closed.obs.direct[closed.canary] === false && !compare(decl, closed.obs, { net: "n", canary: closed.canary }).some((x) => x.kind === "host-undeclared-reachable"));
}

ok("a fully matching environment has no differences", compare({ tools: [{ name: "node", version: "22", feature: "f" }], unknownFeatures: [], services: [], hosts: ["a.test"] }, { tools: { node: "v22.1.0", python: null }, hosts: { "a.test": true, "example.com": false } }, { net: "n", canary: "example.com" }).length === 0);

/* ---------------------------------------- E-6: in the run's own sandbox */
{
  writeFileSync(DEV, JSON.stringify({ image: "probe:1", features: { "ghcr.io/devcontainers/features/node:1": { version: "22" } } }));
  const seen = [];
  const exec = (args) => {
    seen.push(args);
    if (args[0] === "image") return { status: 0, stdout: "sha256:feed\n" };
    return { status: 0, stdout: "tool node v22.3.0\ntool python -\nhost registry.npmjs.org yes\nhost example.com no\n" };
  };
  const netns = {
    withRunEgress: async (opts, fn) => {
      seen.push(["egress", opts.allow]);
      return { result: await fn({ net: "caretaker-egress-r_1", extraRunFlags: ["--add-host", "proxy:10.89.0.2"], env: { HTTPS_PROXY: "http://proxy:8080" } }) };
    },
  };
  const r = await check({ devcontainerPath: DEV, specs: [], exec, netns, egress: { egressNetwork: "podman" } });
  const runArgs = seen.find((a) => a[0] === "run") ?? [];
  const joined = runArgs.join(" ");
  ok("the probe runs with the sandbox a run gets: read-only root, no capabilities, no socket", joined.includes("--read-only") && joined.includes("--cap-drop ALL") && !joined.includes("docker.sock") && !joined.includes("podman.sock"), joined);
  ok("…behind the run's own egress proxy, allowing exactly the declared hosts", joined.includes("--network caretaker-egress-r_1") && joined.includes("-e HTTPS_PROXY=http://proxy:8080") && JSON.stringify(seen.find((a) => a[0] === "egress")?.[1]) === '["registry.npmjs.org"]', joined);
  ok("…and reports the image id it asked", r.imageId === "sha256:feed" && r.differences.length === 0, JSON.stringify(r.differences));
  // Review: check() skipped the cgroup preflight, so --cpus killed the probe
  // where the cpu controller is not delegated.
  seen.length = 0;
  const pre = await check({ devcontainerPath: DEV, specs: [], exec, netns, egress: { egressNetwork: "podman" }, controllers: ["memory", "pids"] });
  const pj = (seen.find((a) => a[0] === "run") ?? []).join(" ");
  ok("the probe gets the preflight a run gets: a limit that cannot bind is dropped", !pj.includes("--cpus") && pj.includes("--memory"), pj);
  ok("…and said", pre.warnings.some((w) => /not limited on cpus/.test(w)), JSON.stringify(pre.warnings));
}
{
  const r = spawnSync(process.execPath, [join(HERE, "environment.mjs"), "check", "--sandbox", "none", "--devcontainer", DEV, "--specs", join(TMP, "no-specs")], { encoding: "utf8", env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` } });
  ok("the CLI prints each difference and exits 1 when there are any", r.status === 1 && /DIFF\s+tool-undeclared/.test(r.stdout), r.stdout + r.stderr);
}

/* ------------------------------------------------------------------ live */
const LIVE_IMAGE = process.env.ENVIRONMENT_TEST_IMAGE ?? "docker.io/library/node:22-alpine";
const havePodman = detect().chosen === "podman";
const haveImage = havePodman && spawnSync("podman", ["image", "exists", LIVE_IMAGE], { stdio: "ignore" }).status === 0;
if (!haveImage) {
  const why = havePodman ? `image ${LIVE_IMAGE} not present` : "podman not available";
  for (const n of ["live: nothing written in one run survives into the next; the repo does", "live: a Dockerfile is rebuilt every run, a COPY'd file change included", "live: the check names what a real image lacks"]) skip(n, why);
} else {
  const ws = mkdtempSync(join(TMP, "live-ws-"));
  writeFileSync(join(ws, "README"), "x\n");
  const once = (script, extra = {}) =>
    run(ws, "go", { adapter: "cli", cli: { argv: ["sh", "-c", `cat > /dev/null; ${script}`] }, sandbox: "podman", net: "none", image: LIVE_IMAGE, events: false, timeoutMs: 90_000, logDir: mkdtempSync(join(TMP, "log-")), ...extra });
  {
    // Run 1 writes everywhere it can, and tries where it cannot.
    await once("echo hand > /tmp/installed; echo hand > /run/installed; (echo x > /usr/local/bin/installed) 2>/dev/null; echo kept > /work/kept.txt");
    const r2 = await once("for f in /tmp/installed /run/installed /usr/local/bin/installed; do [ -e $f ] && echo SURVIVED $f; done; cat /work/kept.txt");
    const out = r2.transcript.tail;
    ok("live: nothing written in one run survives into the next; the repo does", r2.verdict.state === "completed" && !/SURVIVED/.test(out) && /kept/.test(out), out.slice(0, 400));
    ok("live: the run records the image id it ran in", /^[0-9a-f]{12,}|^sha256:/.test(r2.verdict.container?.imageId ?? ""), JSON.stringify(r2.verdict.container));
  }
  {
    const proj = mkdtempSync(join(TMP, "live-build-"));
    mkdirSync(join(proj, ".devcontainer"));
    writeFileSync(join(proj, ".devcontainer", "Dockerfile"), `FROM ${LIVE_IMAGE}\nCOPY stamp.txt /stamp.txt\n`);
    writeFileSync(join(proj, ".devcontainer", "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile" } }));
    const devPath = join(proj, ".devcontainer", "devcontainer.json");
    writeFileSync(join(proj, ".devcontainer", "stamp.txt"), "one\n");
    const a = await once("cat /stamp.txt", { image: null, devcontainer: devPath });
    writeFileSync(join(proj, ".devcontainer", "stamp.txt"), "two\n");
    const b = await once("cat /stamp.txt", { image: null, devcontainer: devPath });
    const outA = a.transcript.tail;
    const outB = b.transcript.tail;
    ok("live: a Dockerfile is rebuilt every run, a COPY'd file change included", a.verdict.container?.built === true && /one/.test(outA) && /two/.test(outB), `${outA.slice(0, 200)} / ${outB.slice(0, 200)}`);
    spawnSync("podman", ["rmi", "-f", buildTag(devPath)], { stdio: "ignore" });
  }
  {
    writeFileSync(DEV, JSON.stringify({ image: LIVE_IMAGE, features: { "ghcr.io/devcontainers/features/node:1": { version: "20" }, "ghcr.io/devcontainers/features/python:1": {} } }));
    const r = await check({ devcontainerPath: DEV, specs: [] });
    const kinds = r.differences.map((d) => d.kind);
    ok("live: the check names what a real image lacks", kinds.includes("tool-version") && kinds.includes("tool-missing") && r.differences.some((d) => /node 20 .* has v22/.test(d.message)), JSON.stringify(r.differences));
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[environment] ${failures} FAILED` : "\n[environment] all checks passed");
process.exit(failures ? 1 : 0);
