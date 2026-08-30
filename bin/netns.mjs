#!/usr/bin/env node
/**
 * NETNS — the network wiring that makes egress non-optional.
 *
 * E-2's other half. `egress.mjs`'s own header says it plainly: HTTPS_PROXY is
 * advisory. A process that ignores it and dials out directly is not stopped by
 * anything in that file. This file is the thing that stops it: the agent
 * container is placed on a podman network with no route off the host at all,
 * and the only thing reachable from it is the proxy.
 *
 * THE MECHANISM, VERIFIED RATHER THAN TRUSTED (podman 5.8.2, rootless, netavark
 * backend, pasta for the outbound leg — measured 2026-08-30, commands below are
 * real, not paraphrased):
 *
 *   $ podman network create --internal fm-internal-test
 *   $ podman run --rm --network fm-internal-test nginx:alpine \
 *       wget -q -T3 -O- http://1.1.1.1
 *   wget: can't connect to remote host (1.1.1.1): Network unreachable
 *
 * That is a raw IP, no DNS involved, and the error is a routing failure
 * ("Network unreachable"), not a refused connection — `ip route` inside that
 * container shows ONLY the local subnet route (`10.89.1.0/24 dev eth0 scope
 * link`), no default route at all. `--internal` does what ADR-0001 assumes:
 * the container has no path off its own subnet, full stop.
 *
 * DNS: `dns_enabled: true` even on an internal network (aardvark-dns still
 * runs), but it resolves NAMES OF CONTAINERS ON THE SAME NETWORK ONLY — it does
 * not forward to an external resolver:
 *
 *   $ podman run --rm --network fm-internal-test nginx:alpine \
 *       wget -q -T3 -O- http://example.com
 *   wget: bad address 'example.com'
 *
 * So the agent reaches the proxy by its `--network-alias` (aardvark-dns
 * resolves that fine within the shared internal network — verified below in
 * `runAttackSuite`), not by a public hostname, and never needs one.
 *
 * THE HOLE THE TASK ASKED ABOUT — does `--internal` still let the container
 * reach the host? Measured, not assumed. Rootless podman on this box runs
 * `pasta` (`podman info` → `rootlessNetworkCmd: pasta`), and ALL bridge
 * networks — internal or not — live inside a separate "rootless-netns" network
 * namespace (`podman unshare --rootless-netns ip addr` shows a private
 * loopback and its own pasta-fed eth0; the bridge gateway IP does not exist in
 * the host shell's own default namespace — a `python3 -m http.server` bound to
 * that gateway IP failed with `OSError: [Errno 99] Cannot assign requested
 * address` from the ordinary login shell). Host services are reachable from a
 * container ONLY through the special forwarder name `host.containers.internal`
 * (which resolves to a link-local `169.254.1.2`, pasta's own forwarding
 * address) — a bare host LAN IP (`192.168.1.20:PORT`) got a `Connection
 * refused` even from a NORMALLY-networked container, i.e. pasta does not
 * forward arbitrary host IP:port pairs, only that one dedicated address. And
 * `--internal` removes the route to `host.containers.internal` too:
 *
 *   normal network  -> host.containers.internal:8899   HTTP_STATUS=200 (real content)
 *   internal network -> host.containers.internal:8899  Network unreachable
 *
 * So: on THIS box, a normally-networked container already has a narrower path
 * to the host than "the host's whole network stack" — but it is not zero, and
 * `--internal` is what makes it zero. Do not assume the pasta behaviour holds
 * on every rootless install; that is why this file's tests re-measure it live
 * rather than asserting it from this comment.
 *
 * WHY TWO NETWORKS, NOT ONE. The agent's network must have no way out. The
 * proxy needs a way out to reach the allowed hosts. Putting both containers on
 * one `--internal` network gives the proxy no exit either. So the proxy joins
 * BOTH: the internal network (to be reachable BY the agent) and a normal one
 * (to reach the allowed hosts). `podman run --network A --network B` joins
 * both at container start — verified with `ip addr` inside the container
 * showing two interfaces, `eth0` on the internal subnet and `eth1` on the
 * normal one. No `podman network connect` step, and so no window where the
 * proxy is running but not yet dual-homed.
 *
 * WHAT THIS DOES NOT DO: run the agent container itself. `sandbox.mjs run
 * --net <name>` already accepts an arbitrary podman network name in its `net`
 * flag (it just does `--network <net>`, unmodified here) — point it at the
 * internal network this file creates and it is wired correctly with no change
 * to that file.
 *
 * Usage:
 *   netns.mjs create-internal <name>
 *   netns.mjs create-egress   <name>
 *   netns.mjs proxy    <internal-net> <egress-net> --allow a.com,b.com [--port 8080] [--name NAME]
 *   netns.mjs verify   <internal-net> <proxy-alias> <proxy-port> --allow-host H --deny-host H
 *   netns.mjs teardown <name...>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------------- networks */

/** `podman network create --internal <name>` — no route off the host at all. */
export function internalNetworkArgs(name) {
  return ["network", "create", "--internal", name];
}

/** A normally-connected network, for the proxy's outbound leg. */
export function networkArgs(name) {
  return ["network", "create", name];
}

export function removeNetworkArgs(name) {
  return ["network", "rm", name];
}

/* ------------------------------------------------------------------ proxy */

/**
 * Build the argv for the dual-homed proxy container. Separated from execution
 * for the same reason `sandbox.mjs`'s `buildArgs` is: a test can assert on the
 * flags without starting a container.
 *
 * The proxy runs `egress.mjs` itself, unmodified — this file does not
 * reimplement allowlist logic, it only decides which networks the process
 * carrying it sits on.
 */
export function proxyRunArgs({
  name = "fm-egress-proxy",
  internalNetwork,
  egressNetwork,
  alias = "proxy",
  image = "docker.io/library/node:22-alpine",
  binDir = __dirname,
  allow = null,
  spec = null,
  devcontainer = null,
  port = 8080,
  logFile = null,
  detach = true,
}) {
  if (!internalNetwork) throw new Error("proxyRunArgs needs internalNetwork");
  if (!egressNetwork) throw new Error("proxyRunArgs needs egressNetwork");
  if (!allow && !spec) throw new Error("proxyRunArgs needs allow or spec — no default allowlist");

  const args = ["run"];
  if (detach) args.push("-d");
  args.push(
    "--rm",
    "--name",
    name,
    // Order matters for readability only — both are joined before the
    // container's entrypoint runs, verified above (`ip addr` shows both
    // interfaces present from the first moment the process starts).
    "--network",
    internalNetwork,
    "--network-alias",
    alias,
    "--network",
    egressNetwork,
    // The proxy relays; it does not need to write to the repo or run as root.
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${binDir}:/egress-bin:Z,ro`,
    "-w",
    "/egress-bin",
    image,
    "node",
    "egress.mjs",
    "serve",
  );
  if (allow) args.push("--allow", Array.isArray(allow) ? allow.join(",") : allow);
  if (spec) args.push("--spec", spec);
  if (devcontainer) args.push("--devcontainer", devcontainer);
  args.push("--port", String(port));
  if (logFile) args.push("--log", logFile);
  return args;
}

/**
 * What to pass sandbox.mjs. Not a wrapper — `sandbox.mjs run --net <name>`
 * already does exactly `--network <name>`, so the internal network's name IS
 * the value, and this function exists only so nobody has to remember that.
 */
export function agentNetFlag(internalNetwork) {
  return internalNetwork;
}

/* ------------------------------------------------------------- the attack */

/**
 * Run a short-lived container on `network` and return {status, stdout}.
 * `cmd` is a shell string executed with `sh -c`, because every check here is
 * "did the request get through", which a one-line curl answers.
 */
function attackerRun({ network, image, cmd, timeoutMs = 15000 }) {
  const r = spawnSync(
    "podman",
    ["run", "--rm", "--network", network, image, "sh", "-c", cmd],
    { encoding: "utf8", timeout: timeoutMs },
  );
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/**
 * E-3, made runnable rather than left as a claim. Five attacks against a LIVE
 * network + proxy — this shells out to real `podman run` invocations, same as
 * a human would from the command line, and returns each command alongside its
 * real output so a report can quote it rather than paraphrase it.
 *
 * Requires: `internalNetwork` already created `--internal`, and a proxy already
 * running on it (see `proxyRunArgs`) reachable at `proxyAlias:proxyPort`,
 * configured to allow `allowedHost` and refuse `deniedHost`. This function
 * does not create or start either — it only attacks what is already there, so
 * the same code path serves the automated test and a person re-running it by
 * hand against a proxy they started themselves.
 */
export function runAttackSuite({
  internalNetwork,
  proxyAlias = "proxy",
  proxyPort = 8080,
  allowedHost,
  deniedHost,
  victimNetwork = null,
  victimHost = null, // "ip:port" of a container on victimNetwork, if reachability across networks is being checked
  hostProbe = null, // "host:port" of something bound on the real host, if that check is wanted
  agentImage = "docker.io/library/nginx:alpine", // has curl AND busybox wget; nothing here is agent-specific
}) {
  if (!internalNetwork) throw new Error("runAttackSuite needs internalNetwork");
  if (!allowedHost) throw new Error("runAttackSuite needs allowedHost");
  if (!deniedHost) throw new Error("runAttackSuite needs deniedHost");

  const curl = (target, { proxy = null } = {}) => {
    const proxyFlag = proxy ? `-x http://${proxy}` : "";
    return `curl -sS ${proxyFlag} https://${target} -o /dev/null -w 'HTTP_STATUS=%{http_code}' --max-time 8 2>&1`;
  };

  const results = [];
  const record = (name, expectPass, { command, out }) => {
    results.push({
      name,
      command,
      stdout: out.stdout,
      stderr: out.stderr,
      exitStatus: out.status,
      passed: expectPass(out),
    });
  };

  // 1. Allowed host THROUGH the proxy — must succeed.
  {
    const command = curl(allowedHost, { proxy: `${proxyAlias}:${proxyPort}` });
    record("allowed host through the proxy reaches it", (out) => /HTTP_STATUS=200/.test(out.stdout), {
      command,
      out: attackerRun({ network: internalNetwork, image: agentImage, cmd: command }),
    });
  }

  // 2. Not-allowed host THROUGH the proxy — must 403 at the CONNECT tunnel.
  {
    const command = curl(deniedHost, { proxy: `${proxyAlias}:${proxyPort}` });
    record(
      "not-allowed host through the proxy is refused (403)",
      (out) => /CONNECT tunnel failed, response 403/.test(out.stdout) || /HTTP_STATUS=403/.test(out.stdout),
      { command, out: attackerRun({ network: internalNetwork, image: agentImage, cmd: command }) },
    );
  }

  // 3. Reach ANY host directly, bypassing the proxy entirely — must fail. This
  // is the one that matters: it is the entire justification for this file
  // existing rather than trusting HTTPS_PROXY.
  {
    const command = curl(allowedHost); // no -x: dial out directly, no proxy involved
    record(
      "bypassing the proxy and dialing out directly fails",
      (out) => out.status !== 0 && /Could not resolve host|Could not connect|Network unreachable/.test(out.stdout),
      { command, out: attackerRun({ network: internalNetwork, image: agentImage, cmd: command }) },
    );
  }

  // 4. Reach another container on the host (a different, non-internal
  // network) — must fail. Optional: needs a victim already running.
  if (victimHost) {
    const command = `curl -sS http://${victimHost}/ -o /dev/null -w 'HTTP_STATUS=%{http_code}' --max-time 8 2>&1`;
    record(
      "reaching another container on a sibling network fails",
      (out) => out.status !== 0 && !/HTTP_STATUS=200/.test(out.stdout),
      { command, out: attackerRun({ network: internalNetwork, image: agentImage, cmd: command }) },
    );
  }

  // 5. Reach a service on the host itself — must fail, including via the
  // pasta forwarder name, which DOES work from a normally-networked container
  // (see the header comment) and must NOT work from here.
  if (hostProbe) {
    const command = `curl -sS http://${hostProbe}/ -o /dev/null -w 'HTTP_STATUS=%{http_code}' --max-time 8 2>&1`;
    record(
      "reaching a service on the host itself fails",
      (out) => out.status !== 0 && !/HTTP_STATUS=200/.test(out.stdout),
      { command, out: attackerRun({ network: internalNetwork, image: agentImage, cmd: command }) },
    );
  }

  return results;
}

/* --------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  const [, , cmd, ...rest] = process.argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1];
      i++;
    } else pos.push(rest[i]);
  }

  const run = (args) => spawnSync("podman", args, { stdio: "inherit" });

  if (cmd === "create-internal") {
    if (!pos[0]) {
      console.error("usage: netns.mjs create-internal <name>");
      process.exit(2);
    }
    process.exit(run(internalNetworkArgs(pos[0])).status ?? 1);
  } else if (cmd === "create-egress") {
    if (!pos[0]) {
      console.error("usage: netns.mjs create-egress <name>");
      process.exit(2);
    }
    process.exit(run(networkArgs(pos[0])).status ?? 1);
  } else if (cmd === "proxy") {
    const [internalNetwork, egressNetwork] = pos;
    if (!internalNetwork || !egressNetwork) {
      console.error("usage: netns.mjs proxy <internal-net> <egress-net> --allow a.com,b.com [--port 8080]");
      process.exit(2);
    }
    const args = proxyRunArgs({
      internalNetwork,
      egressNetwork,
      allow: flags.allow,
      spec: flags.spec,
      devcontainer: flags.devcontainer,
      port: flags.port ? Number(flags.port) : 8080,
      name: flags.name,
      logFile: flags.log,
    });
    const r = spawnSync("podman", args, { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      process.exit(r.status ?? 1);
    }
    console.log(r.stdout.trim());
    process.exit(0);
  } else if (cmd === "verify") {
    const [internalNetwork, proxyAlias, proxyPort] = pos;
    if (!internalNetwork || !flags["allow-host"] || !flags["deny-host"]) {
      console.error(
        "usage: netns.mjs verify <internal-net> [proxy-alias] [proxy-port] --allow-host H --deny-host H " +
          "[--victim-host ip:port] [--host-probe host:port]",
      );
      process.exit(2);
    }
    const results = runAttackSuite({
      internalNetwork,
      proxyAlias: proxyAlias ?? "proxy",
      proxyPort: proxyPort ? Number(proxyPort) : 8080,
      allowedHost: flags["allow-host"],
      deniedHost: flags["deny-host"],
      victimHost: flags["victim-host"] ?? null,
      hostProbe: flags["host-probe"] ?? null,
    });
    let failures = 0;
    for (const r of results) {
      console.log(`${r.passed ? "PASS" : "FAIL"} ${r.name}`);
      console.log(`  $ ${r.command}`);
      console.log(`  ${r.stdout || r.stderr || "(no output)"}`);
      if (!r.passed) failures++;
    }
    process.exit(failures === 0 ? 0 : 1);
  } else if (cmd === "teardown") {
    if (!pos.length) {
      console.error("usage: netns.mjs teardown <name...>");
      process.exit(2);
    }
    let failures = 0;
    for (const name of pos) {
      spawnSync("podman", ["rm", "-f", name]); // in case it's a container name
      const r = spawnSync("podman", removeNetworkArgs(name), { encoding: "utf8" });
      if (r.status !== 0 && !/not found/.test(r.stderr ?? "")) {
        console.error(r.stderr.trim());
        failures++;
      }
    }
    process.exit(failures === 0 ? 0 : 1);
  } else {
    console.error(
      "usage: netns.mjs create-internal <name> | create-egress <name> | " +
        "proxy <internal> <egress> --allow H | verify <internal> [alias] [port] --allow-host H --deny-host H | " +
        "teardown <name...>",
    );
    process.exit(2);
  }
}
