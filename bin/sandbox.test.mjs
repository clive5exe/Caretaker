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
import { buildArgs, checkLimits, delegatedControllers, detect, installHint } from "./sandbox.mjs";

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
  const inside = (script) => {
    const missing = checkLimits(["memory", "cpus", "pids"], delegatedControllers().controllers);
    const limits = { ...LIMITS };
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
    const r = inside("cat /sys/fs/cgroup/pids.max");
    ok("live: the pids ceiling is real", String(r.stdout).trim() === "512", r.stdout.trim());
  }

  {
    const r = inside("touch /nope 2>&1 || true");
    ok(
      "live: the root filesystem refuses a write",
      /Read-only/i.test(r.stdout),
      r.stdout.trim() || "the write SUCCEEDED, so --read-only is not in effect",
    );
  }

  {
    const r = inside("wget -q -T2 -O- http://example.com 2>&1 || echo BLOCKED");
    ok(
      "live: there is no route off the container",
      /BLOCKED|bad address|not resolve/i.test(r.stdout),
      r.stdout.trim() || "the request SUCCEEDED, so --network none is not in effect",
    );
  }

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

console.log(
  failures === 0
    ? `\n[sandbox] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[sandbox] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
