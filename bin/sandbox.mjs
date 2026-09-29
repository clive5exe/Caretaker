#!/usr/bin/env node
/**
 * SANDBOX — run a command inside a container that cannot hurt the host.
 *
 * E-0 and E-1. The runtime is podman, and that is an assumption rather than a
 * preference: rootless means a container escape lands as an unprivileged user,
 * where Docker's usual root daemon means an escape ends the argument. Docker is
 * supported because someone's machine will only have it, but it has to be asked
 * for and the run says what it costs.
 *
 * WHAT THIS DOES NOT DO YET: egress. `--network none` is the only network
 * setting here, which is safe and also unusable for an agent that needs to reach
 * a model API. E-2 puts an allowlist proxy in that gap. Until then this is
 * honest about being all-or-nothing, and `--net` has to be passed explicitly so
 * nobody opens it by forgetting.
 *
 * Usage:
 *   sandbox.mjs detect
 *   sandbox.mjs run [--spec F] [--devcontainer F] [--workdir D] [--net none|host] -- cmd...
 *   sandbox.mjs limits [--devcontainer F]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDevcontainer, toLimits } from "./spec.mjs";

/* ----------------------------------------------------------------- runtime */

const which = (bin) => {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

/**
 * INSTALL COMMANDS ARE PRINTED, NEVER RUN UNASKED. An installer that reaches for
 * sudo without explaining itself is exactly the behaviour this whole project is
 * supposed to make unnecessary.
 */
/** The command that installs podman on this platform, or null where there is no one command. */
export function installCommand(platform = process.platform, has = existsSync) {
  if (platform === "darwin") return "brew install podman && podman machine init && podman machine start";
  if (platform === "linux") {
    if (has("/etc/debian_version")) return "sudo apt-get install -y podman";
    if (has("/etc/fedora-release") || has("/etc/redhat-release")) return "sudo dnf install -y podman";
    if (has("/etc/arch-release")) return "sudo pacman -S --needed podman";
  }
  return null;
}

export function installHint() {
  return installCommand() ?? (process.platform === "linux" ? "install podman with your package manager" : "see https://podman.io/docs/installation");
}

/**
 * E-0: offer the install command and run it only on a person's yes. Not
 * run without asking, and not offered where there is no one command to run
 * (then the hint is printed instead). `ask` and `run` are passed in so the
 * decision is testable without installing anything.
 */
export async function offerInstall({ command = installCommand(), ask, run }) {
  if (!command) return { offered: false, ran: false };
  const answer = await ask(`podman is not installed. Run this now?\n  ${command}\n[y/N] `);
  if (!/^y(es)?$/i.test(String(answer ?? "").trim())) return { offered: true, ran: false };
  return { offered: true, ran: true, status: run(command) };
}

export function detect() {
  const podman = which("podman");
  const docker = which("docker");
  const out = { podman: null, docker: Boolean(docker), chosen: null, rootless: null };

  if (podman) {
    try {
      const info = execFileSync(
        "podman",
        ["info", "--format", "{{.Host.Security.Rootless}} {{.Version.Version}}"],
        { encoding: "utf8" },
      ).trim();
      const [rootless, version] = info.split(/\s+/);
      out.podman = version;
      out.rootless = rootless === "true";
      out.chosen = "podman";
    } catch {
      // Installed but not answering — a broken podman is not a usable one, and
      // silently reaching for docker here is exactly the substitution E-0 forbids.
      out.podman = "present but not responding";
    }
  }
  // docker is never chosen implicitly: `chosen` stays null unless podman answered.
  return out;
}

/* -------------------------------------------------------------- cgroups */

/**
 * Which cgroup controllers this user can actually enforce.
 *
 * ROOTLESS PODMAN CAN ONLY LIMIT WHAT SYSTEMD DELEGATED TO THE USER SLICE, and
 * on a default install that is `memory pids` — no `cpu`. Passing `--cpus`
 * anyway does not warn, it fails the run outright with an OCI error about
 * `controller cpu is not available`, which reads like a podman bug and is not.
 *
 * Measured on the development box: the root cgroup offers
 * `cpuset cpu io memory hugetlb pids rdma misc` and the user slice offers
 * `memory pids`.
 *
 * THE DANGEROUS OUTCOME IS NOT THE CRASH. It is dropping the flag and carrying
 * on, because then the run succeeds and the limit silently is not there. A
 * resource ceiling you believe in and do not have is worse than none, so this
 * refuses by default and says exactly how to fix it.
 */
export function delegatedControllers(uid = process.getuid?.() ?? 1000) {
  const paths = [
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
    "/sys/fs/cgroup/cgroup.controllers",
  ];
  for (const f of paths) {
    try {
      const raw = readFileSync(f, "utf8").trim();
      if (raw) return { path: f, controllers: raw.split(/\s+/) };
    } catch {
      /* try the next one */
    }
  }
  return { path: null, controllers: [] };
}

/** Which controller each limit needs. */
const LIMIT_CONTROLLER = { memory: "memory", cpus: "cpu", pids: "pids" };

export function checkLimits(wanted, available) {
  const missing = [];
  for (const [limit, controller] of Object.entries(LIMIT_CONTROLLER)) {
    if (wanted.includes(limit) && !available.includes(controller)) {
      missing.push({ limit, controller });
    }
  }
  return missing;
}

export const delegationFix = (uid = process.getuid?.() ?? 1000) =>
  [
    "sudo mkdir -p /etc/systemd/system/user@.service.d",
    "printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' |",
    "  sudo tee /etc/systemd/system/user@.service.d/delegate.conf",
    "sudo systemctl daemon-reload",
    `# then log out and back in, or: sudo systemctl restart user@${uid}.service`,
  ].join("\n    ");

/* ------------------------------------------------------------------ the run */

/**
 * Build the argv. Separated from execution so a test can assert the flags
 * without starting a container — the limits are the security property, and a
 * test that only checks "it ran" proves nothing about them.
 */
export function buildArgs({ image, limits, workdir, net = "none", cmd, runtime = "podman" }) {
  const args = [
    "run",
    "--rm",
    // No interactive tty: this is a batch runner, and a tty changes signal
    // handling in ways that make a hung agent harder to kill.
    "--network",
    net,
  ];
  // A NULL LIMIT MEANS THE KERNEL CANNOT ENFORCE IT HERE, and the caller has
  // already been told. Passing the flag anyway does not degrade gracefully — it
  // fails the run with an OCI error that reads like a podman bug.
  if (limits.memory) args.push("--memory", limits.memory);
  if (limits.cpus) args.push("--cpus", limits.cpus);
  // A fork bomb is the cheapest way for a runaway agent to take the host down
  // and costs nothing to prevent. devcontainer.json has no field for it, so it
  // is a floor rather than something derived.
  if (limits.pids !== null) args.push("--pids-limit", String(limits.pids ?? 512));
  args.push(
    "--read-only",
    // Read-only root still needs somewhere to write. tmpfs, so it dies with the
    // container and never touches the host filesystem.
    "--tmpfs",
    "/tmp:rw,size=512m,exec",
    "--tmpfs",
    "/run:rw,size=64m",
    // The repo, and nothing else. :Z relabels for SELinux, which is on by
    // default on RHEL-family hosts; without it the container reads nothing and
    // the error looks like a permissions bug in the app.
    "-v",
    `${workdir}:/work:Z`,
  );
  // THE REPO'S .git IS READ-ONLY INSIDE. It is the one place in the workspace
  // that runs code on the HOST: a hook, or `core.fsmonitor` in .git/config, is
  // executed by the next `git status` anyone runs there — including this
  // harness's own drift and freshness checks. A writable .git is a sandbox
  // escape with a delay on it, and the shadow-git diff never sees .git, so it
  // would not even show in the run's measured change. (A worktree's .git is a
  // file pointing outside the workspace; mounting it read-only covers that too.)
  if (workdir && existsSync(join(workdir, ".git"))) args.push("-v", `${join(workdir, ".git")}:/work/.git:ro,Z`);
  args.push(
    "-w",
    "/work",
    // Drop everything, add nothing back. An agent editing files needs no
    // capabilities at all.
    "--cap-drop",
    "ALL",
    // Stops a process gaining privileges through setuid binaries in the image.
    "--security-opt",
    "no-new-privileges",
  );
  if (runtime === "docker") {
    // podman is rootless by default; docker needs telling, and even then the
    // daemon it talks to is root.
    args.push("--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  }
  args.push(image, ...cmd);
  return args;
}

/* --------------------------------------------------------------------- cli */

/* ------------------------------------------------------------------ cli */

/**
 * The CLI's flags, parsed by NAME, not in pairs. Pairing broke the moment a
 * flag took no value: `--allow-missing-limits --workdir R` read "--workdir"
 * as the first flag's value and dropped R, so the run mounted the current
 * directory read-write instead (independent review). A value flag needs a
 * value that is not another flag; an unknown flag is refused.
 */
export const VALUE_FLAGS = ["devcontainer", "net", "runtime", "image", "workdir"];
export const BOOL_FLAGS = ["allow-missing-limits"];
export const RUNTIMES = ["podman", "docker"];
export function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}; the command goes after --`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (BOOL_FLAGS.includes(name)) {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const v = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      flags[name] = v;
    } else throw new Error(`unknown flag --${name}`);
  }
  if (flags.runtime !== undefined && !RUNTIMES.includes(flags.runtime)) throw new Error(`--runtime must be ${RUNTIMES.join(" or ")}, not ${flags.runtime}`);
  return flags;
}

/**
 * What to say before a run whose isolation is weaker than rootless podman on
 * no network (independent review: docker and rootful podman ran silently).
 */
export function isolationWarnings({ runtime, rootless, net }) {
  const out = [];
  if (runtime === "docker") out.push("--runtime docker: docker's daemon runs as root, so an escape from this container lands as root on the host. Rootless podman is the supported runtime.");
  if (runtime === "podman" && rootless === false) out.push("podman is ROOTFUL here: an escape lands as root. Run it rootless (podman as your own user).");
  if (net === "host") out.push("--net host: the container shares the host's network and can reach anything the host can. No allowlist applies.");
  else if (net && net !== "none") out.push(`--net ${net}: egress is as open as that network. Only an internal network behind the allowlist proxy (bin/netns.mjs) is allowlisted.`);
  return out;
}

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dashdash = argv.indexOf("--");
  const head = dashdash === -1 ? argv.slice(1) : argv.slice(1, dashdash);
  let flags;
  try {
    flags = parseFlags(head);
  } catch (e) {
    console.error(`sandbox.mjs: ${e.message}`);
    process.exit(2);
  }
  const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);

  if (cmd === "detect") {
    const d = detect();
    if (d.chosen === "podman") {
      console.log(`podman ${d.podman}${d.rootless ? " (rootless)" : " (ROOTFUL — an escape lands as root)"}`);
      process.exit(0);
    }
    console.error("podman not found.\n");
    console.error(`  install it:  ${installHint()}`);
    if (installCommand()) console.error("  or run `node bin/sandbox.mjs install` in a terminal, which asks, then runs it.");
    console.error("");
    if (d.docker) {
      console.error("  docker IS present, and is not used automatically.");
      console.error("  Rootless podman means an escape lands as an unprivileged user;");
      console.error("  docker's daemon runs as root and an escape ends the argument.");
      console.error("  To use it anyway, pass --runtime docker and accept that.\n");
    }
    process.exit(1);
  }

  if (cmd === "install") {
    if (detect().chosen === "podman") {
      console.log("podman is already installed.");
      process.exit(0);
    }
    if (!process.stdin.isTTY) {
      console.error(`not a terminal, so nobody can confirm. install it:  ${installHint()}`);
      process.exit(1);
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const r = await offerInstall({ ask: (q) => rl.question(q), run: (c) => spawnSync("sh", ["-c", c], { stdio: "inherit" }).status });
    rl.close();
    if (!r.offered) console.error(`no single install command for this platform: ${installHint()}`);
    else if (!r.ran) console.error("not installed.");
    process.exit(r.ran && r.status === 0 ? 0 : 1);
  }

  if (cmd === "limits") {
    const dev = readDevcontainer(flags.devcontainer ?? ".devcontainer/devcontainer.json");
    console.log(JSON.stringify(toLimits(dev), null, 2));
    process.exit(0);
  }

  if (cmd === "run") {
    if (!rest.length) {
      console.error("usage: sandbox.mjs run [--devcontainer F] [--image I] [--workdir D] [--net none|NETWORK] [--runtime podman|docker] [--allow-missing-limits] -- <command...>");
      process.exit(2);
    }
    const runtime = flags.runtime ?? "podman";
    const found = runtime === "podman" ? detect() : null;
    if (found && found.chosen !== "podman") {
      console.error(`podman not available. install it:  ${installHint()}`);
      process.exit(1);
    }
    const dev = readDevcontainer(flags.devcontainer ?? ".devcontainer/devcontainer.json");
    const limits = toLimits(dev);
    const image = flags.image ?? limits.image;
    if (!image) {
      console.error(
        dev?.build?.dockerfile
          ? "no image: devcontainer.json builds one; run `node bin/environment.mjs image` and pass the tag it prints as --image"
          : "no image: give --image or set `image` in devcontainer.json",
      );
      process.exit(2);
    }
    const workdir = resolve(flags.workdir ?? process.cwd());
    const net = flags.net ?? "none";
    for (const w of isolationWarnings({ runtime, rootless: found?.rootless ?? null, net })) console.error(`[sandbox] WARNING: ${w}`);
    // PREFLIGHT. Refuse rather than pass a limit the kernel will ignore or choke on.
    if (runtime === "podman") {
      const { controllers, path } = delegatedControllers();
      const missing = checkLimits(["memory", "cpus", "pids"], controllers);
      if (missing.length && !flags["allow-missing-limits"]) {
        console.error(`[sandbox] REFUSING — this user cannot enforce ${missing.length} limit(s).\n`);
        for (const m of missing) {
          console.error(`  --${m.limit} needs the "${m.controller}" cgroup controller, which is not delegated`);
        }
        console.error(`\n  delegated here: ${controllers.join(" ") || "(none)"}`);
        if (path) console.error(`  read from: ${path}`);
        console.error(`\n  fix it:\n    ${delegationFix()}\n`);
        console.error("  A ceiling you believe in and do not have is worse than none, which is why");
        console.error("  this refuses instead of dropping the flag. To run anyway, and accept that");
        console.error("  the run is NOT limited on those axes: --allow-missing-limits\n");
        process.exit(1);
      }
      if (missing.length) {
        for (const m of missing) {
          console.error(`[sandbox] WARNING: not limiting ${m.limit} — no "${m.controller}" controller`);
        }
      }
      // Only pass what can actually be enforced.
      for (const m of missing) {
        if (m.limit === "cpus") limits.cpus = null;
        if (m.limit === "memory") limits.memory = null;
        if (m.limit === "pids") limits.pids = null;
      }
    }
    const args = buildArgs({ image, limits, workdir, net, cmd: rest, runtime });
    const r = spawnSync(runtime, args, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  console.error("usage: sandbox.mjs detect | install | limits | run -- <command...>");
  process.exit(2);
}
