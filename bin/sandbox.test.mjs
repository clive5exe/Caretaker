#!/usr/bin/env node
/**
 * Tests for the sandbox runner.
 *
 * TWO KINDS. The argv tests are pure and always run: they assert the security
 * flags are present and, more importantly, that a limit the kernel cannot
 * enforce is OMITTED rather than passed. The live tests boot a real container
 * and read the limits from inside it, because a flag on a command line proves
 * nothing about what the kernel did with it — E-1's acceptance criterion says
 * "actually binds rather than being passed and ignored", and only the second
 * kind can show that.
 *
 * The live tests SKIP LOUDLY without podman or an image, rather than passing.
 *
 * Run: node bin/sandbox.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs, checkLimits, delegatedControllers, detect, installCommand, installHint, isolationWarnings, offerInstall, parseFlags } from "./sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let skipped = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const skip = (name, why) => {
  console.log(`SKIP ${name} — ${why}`);
  skipped += 1;
};

const LIMITS = { memory: "2gb", cpus: "2", image: "img", readOnlyRoot: true, containerSocket: false };
const args = (over = {}) =>
  buildArgs({ image: "img", limits: { ...LIMITS, ...over }, workdir: "/w", cmd: ["true"] });
const has = (a, flag, value) => {
  const i = a.indexOf(flag);
  return i !== -1 && (value === undefined || a[i + 1] === value);
};

/* -------------------------------------------------------------- the flags */

{
  const a = args();
  ok("no network by default", has(a, "--network", "none"));
  ok("memory limit is passed", has(a, "--memory", "2gb"));
  ok("cpu limit is passed", has(a, "--cpus", "2"));
  ok("a pids ceiling is set even though devcontainer.json has no field for it",
    has(a, "--pids-limit", "512"));
  ok("the root filesystem is read-only", a.includes("--read-only"));
  ok("tmp is a tmpfs, so writes die with the container", has(a, "--tmpfs", "/tmp:rw,size=512m,exec"));
  ok("the repo is mounted at /work", has(a, "-v", "/w:/work:Z"));
  ok("all capabilities are dropped", has(a, "--cap-drop", "ALL"));
  ok("no-new-privileges blocks setuid escalation", has(a, "--security-opt", "no-new-privileges"));
  ok("the container is removed after the run", a.includes("--rm"));
  ok(
    "THE CONTAINER SOCKET IS NEVER MOUNTED",
    !a.some((x) => String(x).includes("docker.sock") || String(x).includes("podman.sock")),
    "mounting it is root on the host, and is how most sandboxed agent tools are quietly not",
  );
}

{
  // .git runs code on the host (hooks, core.fsmonitor), so it is mounted over
  // the writable repo read-only, after it: the later, narrower mount wins.
  const ws = mkdtempSync(join(tmpdir(), "sandbox-git-"));
  mkdirSync(join(ws, ".git"));
  const a = buildArgs({ image: "img", limits: LIMITS, workdir: ws, cmd: ["true"] });
  const repo = a.indexOf(`${ws}:/work:Z`);
  const git = a.indexOf(`${join(ws, ".git")}:/work/.git:ro,Z`);
  ok("THE REPO'S .git IS MOUNTED READ-ONLY, over the writable repo", repo !== -1 && git > repo && a[git - 1] === "-v", JSON.stringify(a));
  ok("a workspace with no .git gets no .git mount (nothing to mount)", !args().some((x) => String(x).includes("/work/.git")));
  rmSync(ws, { recursive: true, force: true });
}

{
  // The property that matters most and is easiest to get wrong.
  const a = args({ cpus: null });
  ok(
    "a limit the kernel cannot enforce is OMITTED, not passed",
    !a.includes("--cpus"),
    "passing --cpus without the cpu controller fails the run with an OCI error that reads " +
      "like a podman bug; dropping it silently is worse, because the run succeeds unlimited",
  );
  ok("the other limits survive one being unenforceable", has(a, "--memory", "2gb"));
}

/* ------------------------------------------------------------- controllers */

{
  const missing = checkLimits(["memory", "cpus", "pids"], ["memory", "pids"]);
  ok(
    "a missing cpu controller is detected",
    missing.length === 1 && missing[0].limit === "cpus" && missing[0].controller === "cpu",
    JSON.stringify(missing),
  );
  ok("nothing is missing when everything is delegated",
    checkLimits(["memory", "cpus", "pids"], ["memory", "cpu", "pids", "io"]).length === 0);
}

{
  const d = delegatedControllers();
  ok(
    `the delegated controllers are readable (${d.controllers.join(" ") || "none"})`,
    d.controllers.length > 0,
    "could not read cgroup.controllers anywhere, so the preflight cannot know what binds",
  );
}

ok("an install hint exists for this platform", installHint().length > 10);

/* --------------------------------------------------------------- live run */

const runtime = detect();
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "docker.io/library/nginx:alpine";
const haveImage =
  runtime.chosen === "podman" &&
  spawnSync("podman", ["image", "exists", IMAGE], { stdio: "ignore" }).status === 0;

if (runtime.chosen !== "podman") {
  skip("live: the limits actually bind", `podman not available (${installHint()})`);
} else if (!haveImage) {
  skip("live: the limits actually bind", `image ${IMAGE} not present locally`);
} else {
  const inside = (script, over = {}) => {
    const missing = checkLimits(["memory", "cpus", "pids"], delegatedControllers().controllers);
    const limits = { ...LIMITS, ...over };
    for (const m of missing) limits[m.limit] = null;
    const a = buildArgs({ image: IMAGE, limits, workdir: process.cwd(), cmd: ["sh", "-c", script] });
    return spawnSync("podman", a, { encoding: "utf8" });
  };

  {
    const r = inside("cat /sys/fs/cgroup/memory.max");
    const bytes = Number(String(r.stdout).trim());
    ok(
      `live: the memory ceiling is real inside the container (${bytes} bytes)`,
      bytes === 2 * 1024 * 1024 * 1024,
      `expected 2147483648, container reports ${r.stdout.trim() || r.stderr.trim()}`,
    );
  }

  {
    // E-1 (independent review): nothing proved --cpus binds. cpu.max is
    // "<quota> <period>", and --cpus 2 is a quota of two periods.
    const cpuMissing = checkLimits(["cpus"], delegatedControllers().controllers).length > 0;
    if (cpuMissing) {
      skip("live: the cpu ceiling is real", "the cpu controller is not delegated here, so the preflight refuses --cpus rather than passing it");
    } else {
      const r = inside("cat /sys/fs/cgroup/cpu.max");
      const [quota, period] = String(r.stdout).trim().split(/\s+/).map(Number);
      ok(`live: the cpu ceiling is real (${r.stdout.trim()})`, period > 0 && quota === 2 * period, r.stdout.trim() || r.stderr.trim());
    }
  }

  {
    const r = inside("cat /sys/fs/cgroup/pids.max");
    ok("live: the pids ceiling is real", String(r.stdout).trim() === "512", r.stdout.trim());
  }


  {
    const r = inside("wget -q -T2 -O- http://example.com 2>&1 || echo BLOCKED");
    ok(
      "live: there is no route off the container",
      /BLOCKED|bad address|not resolve/i.test(r.stdout),
      r.stdout.trim() || "the request SUCCEEDED, so --network none is not in effect",
    );
  }

  // E-3 (independent review): the memory and socket attacks were never
  // attempted, only a read of memory.max and a string check for ".sock".
  // Each is now run, and its command and output are recorded in a report.
  const attacks = [];
  const attackRun = (name, command, over, passed) => {
    const r = inside(command, over);
    const out = { name, command, stdout: String(r.stdout ?? "").trim(), stderr: String(r.stderr ?? "").trim(), exitStatus: r.status };
    out.passed = passed(out);
    attacks.push(out);
    console.log(`  $ ${command}\n    exit ${out.exitStatus}: ${(out.stdout || out.stderr).split("\n").slice(-2).join(" / ")}`);
    ok(`live attack: ${name}`, out.passed, out.stdout || out.stderr);
  };
  // (a) Write outside the repo mount: the root, /etc, a system bin, and a
  // path that climbs out of /work. Each must be refused (independent review:
  // this ran as a bare check, so its command and output were not recorded).
  attackRun(
    "writing outside the repo mount is refused",
    `for p in /nope /etc/caretaker-escape /usr/bin/caretaker-escape /work/../caretaker-escape; do touch "$p" 2>&1 && echo "WROTE $p"; done; echo DONE`,
    {},
    (o) => /DONE/.test(o.stdout) && !/^WROTE /m.test(o.stdout) && /Read-only/i.test(o.stdout),
  );
  if (checkLimits(["memory"], delegatedControllers().controllers).length) {
    // Without an enforced ceiling this attack would take the HOST's memory.
    skip("live attack: exhausting memory is stopped by the ceiling", "the memory controller is not delegated here, so there is no ceiling to attack");
  } else {
    // A string that doubles until something stops it. Under a 64 MiB ceiling
    // the kernel kills it (137) inside the container, and the host carries on.
    attackRun(
      "exhausting memory is stopped by the ceiling, inside the container",
      `awk 'BEGIN { s = "x"; while (1) s = s s }'; echo "EXIT=$?"; grep oom_kill /sys/fs/cgroup/memory.events`,
      { memory: "64m" },
      (o) => /EXIT=137/.test(o.stdout) || /oom_kill [1-9]/.test(o.stdout),
    );
  }
  const SOCKET_HUNT = `for s in /var/run/docker.sock /run/docker.sock /run/podman/podman.sock /var/run/podman/podman.sock /run/user/*/podman/podman.sock; do [ -S "$s" ] && echo "SOCKET $s"; done; find / \\( -path /proc -o -path /sys \\) -prune -o -type s -print 2>/dev/null | sed 's/^/SOCKET /'; curl -sS --max-time 3 --unix-socket /run/podman/podman.sock http://d/_ping 2>&1 | head -1; echo; echo DONE`;
  // Every place a container-runtime socket lives, and any socket anywhere in
  // the container, mounts included (a mounted socket is on another device, so
  // no -xdev). Driving one is root on the host.
  attackRun(
    "no container-runtime socket is reachable from inside",
    SOCKET_HUNT,
    {},
    // _ping answers "OK" with no newline; the echo before DONE ends that line.
    (o) => /DONE/.test(o.stdout) && !/^SOCKET /m.test(o.stdout) && !/^OK$/m.test(o.stdout),
  );
  {
    // CONTROL for the attack above: the same hunt, in a container that DOES
    // have a socket mounted, must find it. Otherwise "no socket found" could
    // just mean the hunt cannot see one.
    const { createServer } = await import("node:net");
    const dir = mkdtempSync(join(tmpdir(), "sock-control-"));
    const sock = join(dir, "s.sock");
    const srv = createServer();
    await new Promise((res) => srv.listen(sock, res));
    const ctl = spawnSync("podman", ["run", "--rm", "-v", `${sock}:/run/podman/podman.sock`, IMAGE, "sh", "-c", SOCKET_HUNT], { encoding: "utf8" });
    srv.close();
    rmSync(dir, { recursive: true, force: true });
    ok("live control: the same hunt finds a socket when one IS mounted", /^SOCKET \/run\/podman\/podman\.sock$/m.test(ctl.stdout ?? ""), `${ctl.stdout}${ctl.stderr}`);
  }
  const { writeAttackReport } = await import("./netns.mjs");
  console.log(`[sandbox] attack report: ${writeAttackReport(process.env.ATTACK_REPORT_SANDBOX ?? join(tmpdir(), `caretaker-sandbox-attacks-${process.pid}.json`), attacks, { suite: "sandbox", image: IMAGE })}`);

  {
    const probe = `.uidprobe-${process.pid}`;
    inside(`touch /work/${probe}`);
    const st = spawnSync("stat", ["-c", "%u", probe], { encoding: "utf8" });
    spawnSync("rm", ["-f", probe]);
    ok(
      `live: root INSIDE maps to the unprivileged host user (uid ${st.stdout.trim()})`,
      st.stdout.trim() === String(process.getuid()),
      "a file written as root in the container is owned by root on the host, which means " +
        "the rootless mapping is not in effect and an escape lands as root",
    );
  }
}

{
  // Independent re-review: an image name from devcontainer.json, which the
  // agent can edit, starting with "-" would reach podman as a flag.
  const refused = (image) => {
    try {
      buildArgs({ image, limits: LIMITS, workdir: "/w", cmd: ["true"] });
      return false;
    } catch {
      return true;
    }
  };
  ok("an image name that starts with - or holds whitespace is refused before podman sees it", refused("--privileged") && refused("-v") && refused("img --privileged") && refused("") && !refused("docker.io/library/node:22"));
}

/* E-0: the install command is offered, and run only on a yes (independent review: only printed). */
{
  const ran = [];
  const run = (c) => (ran.push(c), 0);
  const yes = await offerInstall({ command: "sudo apt-get install -y podman", ask: async () => "y", run });
  ok("a yes runs exactly the offered command", yes.ran && yes.status === 0 && ran.join() === "sudo apt-get install -y podman");
  ran.length = 0;
  for (const answer of ["", "n", "no", "maybe", undefined]) {
    const r = await offerInstall({ command: "x", ask: async () => answer, run });
    if (r.ran) ran.push(`ran on ${JSON.stringify(answer)}`);
  }
  ok("anything but a yes runs nothing", ran.length === 0, ran.join());
  let asked = false;
  const none = await offerInstall({ command: null, ask: async () => ((asked = true), "y"), run });
  ok("with no single command for the platform, nothing is offered or run", !none.offered && !none.ran && !asked);
  ok("the command per platform", installCommand("linux", (f) => f === "/etc/debian_version") === "sudo apt-get install -y podman" && installCommand("linux", (f) => f === "/etc/fedora-release") === "sudo dnf install -y podman" && installCommand("darwin", () => false).startsWith("brew install podman") && installCommand("linux", () => false) === null && installCommand("win32", () => false) === null);
  // Run with a PATH holding only a stand-in `sh` that records what it is
  // asked to run and installs nothing: if the terminal check were ever lost,
  // this test must fail, not install podman on the machine running it.
  const fake = mkdtempSync(join(tmpdir(), "sandbox-fake-sh-"));
  const calls = join(fake, "calls");
  writeFileSync(join(fake, "sh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$2" in "command -v"*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  const cli = spawnSync(process.execPath, [join(HERE, "sandbox.mjs"), "install"], { encoding: "utf8", input: "y\n", env: { ...process.env, PATH: fake } });
  const ranInstall = existsSync(calls) && readFileSync(calls, "utf8").split("\n").some((l) => l && !l.startsWith("-c command -v"));
  ok("the CLI never installs without a terminal to confirm in, even given a y on stdin", cli.status === 1 && /not a terminal/.test(cli.stderr) && !ranInstall, `${cli.status} ${cli.stderr} ${existsSync(calls) ? readFileSync(calls, "utf8") : ""}`);
  rmSync(fake, { recursive: true, force: true });
}

/* E-1, E-0: the CLI's flags and what it warns about (independent review). */
{
  // Review: the header's usage offered --spec, which the parser refuses.
  const src = readFileSync(join(HERE, "sandbox.mjs"), "utf8");
  const usage = [...src.slice(0, src.indexOf("*/")).matchAll(/--([a-z][a-z-]*)/g), ...[...src.matchAll(/"usage: sandbox\.mjs run ([^"]*)"/g)].flatMap((m) => [...m[1].matchAll(/--([a-z][a-z-]*)/g)])].map((m) => m[1]).filter((f) => f !== "network");
  const refused = usage.filter((f) => { try { parseFlags(f === "allow-missing-limits" ? [`--${f}`] : [`--${f}`, f === "runtime" ? "podman" : "v"]); return false; } catch { return true; } });
  ok("every flag the usage names is one the parser accepts", usage.length >= 6 && refused.length === 0, refused.join());
}
{
  const err = (a) => {
    try {
      parseFlags(a);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  // The attack: a boolean flag first used to swallow the next flag as its
  // value, so --workdir's value was dropped and the cwd was mounted rw.
  const f = parseFlags(["--allow-missing-limits", "--workdir", "/srv/repo", "--net", "none"]);
  ok("a boolean flag does not swallow the next flag: --workdir keeps its value", f.workdir === "/srv/repo" && f["allow-missing-limits"] === true && f.net === "none", JSON.stringify(f));
  ok("--k=v works for a value flag", parseFlags(["--image=img:1"]).image === "img:1");
  ok("a value flag with no value is refused, not given the next flag", /--workdir needs a value/.test(err(["--workdir", "--net", "none"]) ?? "") && /needs a value/.test(err(["--image"]) ?? ""));
  ok("an unknown flag is refused, not ignored", /unknown flag --netw/.test(err(["--netw", "host"]) ?? ""));
  ok("a boolean flag given a value is refused", /takes no value/.test(err(["--allow-missing-limits=1"]) ?? ""));
  ok("a runtime other than podman or docker is refused", /--runtime must be/.test(err(["--runtime", "lxc"]) ?? ""));
  const cli = spawnSync(process.execPath, [join(HERE, "sandbox.mjs"), "run", "--allow-missing-limits", "--wrokdir", "/x", "--", "true"], { encoding: "utf8" });
  ok("the CLI refuses a misspelt flag with exit 2 before running anything", cli.status === 2 && /unknown flag --wrokdir/.test(cli.stderr), `${cli.status} ${cli.stderr}`);
  const w = (o) => isolationWarnings(o).join(" | ");
  ok("--runtime docker is warned about: its daemon is root", /docker's daemon runs as root/.test(w({ runtime: "docker", net: "none" })));
  ok("rootful podman is warned about", /ROOTFUL/.test(w({ runtime: "podman", rootless: false, net: "none" })));
  ok("rootless podman on no network warns about nothing", w({ runtime: "podman", rootless: true, net: "none" }) === "");
  ok("--net host says no allowlist applies, not that none exists yet", /No allowlist applies/.test(w({ runtime: "podman", rootless: true, net: "host" })) && !/yet/.test(w({ runtime: "podman", rootless: true, net: "host" })));
  ok("a named network says only the proxy's internal network is allowlisted", /netns\.mjs/.test(w({ runtime: "podman", rootless: true, net: "somenet" })));
}

console.log(
  failures === 0
    ? `\n[sandbox] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[sandbox] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
