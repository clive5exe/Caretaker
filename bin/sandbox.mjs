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
import { resolve } from "node:path";
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
export function installHint() {
  const p = process.platform;
  if (p === "darwin") return "brew install podman && podman machine init && podman machine start";
  if (p === "linux") {
    if (existsSync("/etc/debian_version")) return "sudo apt-get install -y podman";
    if (existsSync("/etc/fedora-release") || existsSync("/etc/redhat-release"))
      return "sudo dnf install -y podman";
    if (existsSync("/etc/arch-release")) return "sudo pacman -S --needed podman";
    return "install podman with your package manager";
  }
  return "see https://podman.io/docs/installation";
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
  if (!out.chosen && docker) out.chosen = null; // never chosen implicitly
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

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dashdash = argv.indexOf("--");
  const flags = {};
  const head = dashdash === -1 ? argv.slice(1) : argv.slice(1, dashdash);
  for (let i = 0; i < head.length; i += 2) flags[head[i].replace(/^--/, "")] = head[i + 1];
  const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);

  if (cmd === "detect") {
    const d = detect();
    if (d.chosen === "podman") {
      console.log(`podman ${d.podman}${d.rootless ? " (rootless)" : " (ROOTFUL — an escape lands as root)"}`);
      process.exit(0);
    }
    console.error("podman not found.\n");
    console.error(`  install it:  ${installHint()}\n`);
    if (d.docker) {
      console.error("  docker IS present, and is not used automatically.");
      console.error("  Rootless podman means an escape lands as an unprivileged user;");
      console.error("  docker's daemon runs as root and an escape ends the argument.");
      console.error("  To use it anyway, pass --runtime docker and accept that.\n");
    }
    process.exit(1);
  }

  if (cmd === "limits") {
    const dev = readDevcontainer(flags.devcontainer ?? ".devcontainer/devcontainer.json");
    console.log(JSON.stringify(toLimits(dev), null, 2));
    process.exit(0);
  }

  if (cmd === "run") {
    if (!rest.length) {
      console.error("usage: sandbox.mjs run [--devcontainer F] [--net none|host] -- <command...>");
      process.exit(2);
    }
    const runtime = flags.runtime ?? "podman";
    if (runtime === "podman" && detect().chosen !== "podman") {
      console.error(`podman not available. install it:  ${installHint()}`);
      process.exit(1);
    }
    const dev = readDevcontainer(flags.devcontainer ?? ".devcontainer/devcontainer.json");
    const limits = toLimits(dev);
    const image = flags.image ?? limits.image;
    if (!image) {
      console.error("no image: give --image or set `image` in devcontainer.json");
      process.exit(2);
    }
    const workdir = resolve(flags.workdir ?? process.cwd());
    const net = flags.net ?? "none";
    if (net !== "none") {
      console.error(
        `[sandbox] WARNING: --net ${net}. There is no egress allowlist yet (E-2), so this ` +
          "container can reach anything the host can.",
      );
    }
    // PREFLIGHT. Refuse rather than pass a limit the kernel will ignore or choke on.
    if (runtime === "podman") {
      const { controllers, path } = delegatedControllers();
      const missing = checkLimits(["memory", "cpus", "pids"], controllers);
      if (missing.length && !("allow-missing-limits" in flags)) {
        console.error(`[sandbox] REFUSING — this user cannot enforce ${missing.length} limit(s).\n`);
        for (const m of missing) {
          console.error(`  --${m.limit} needs the "${m.controller}" cgroup controller, which is not delegated`);
        }
        console.error(`\n  delegated here: ${controllers.join(" ") || "(none)"}`);
        if (path) console.error(`  read from: ${path}`);
        console.error(`\n  fix it:\n    ${delegationFix()}\n`);
        console.error("  A ceiling you believe in and do not have is worse than none, which is why");
        console.error("  this refuses instead of dropping the flag. To run anyway, and accept that");
        console.error("  the run is NOT limited on those axes: --allow-missing-limits 1\n");
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

  console.error("usage: sandbox.mjs detect | limits | run -- <command...>");
  process.exit(2);
}
