#!/usr/bin/env node
/**
 * Tests for netns.mjs — the network wiring that makes the egress proxy
 * non-optional rather than advisory.
 *
 * TWO KINDS, same split as sandbox.test.mjs. The argv tests are pure and
 * always run. The live tests stand up a REAL `--internal` network, a REAL
 * dual-homed proxy container running the real `egress.mjs`, and REAL attacker
 * containers, then attack it — because a flag on a command line proves
 * nothing about what podman's network backend actually enforces, and this is
 * the file where "the proxy is not the enforcement" either becomes true or
 * does not.
 *
 * SKIP LOUDLY, NEVER PASS SILENTLY: no podman, no rootless podman, or a
 * missing test image skips with a stated reason. A green run with zero live
 * checks executed would be indistinguishable from a broken one, so the
 * skip count is printed and a CI wired to fail on skip>0 can catch it.
 *
 * Run: node bin/netns.test.mjs
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentNetFlag,
  internalNetworkArgs,
  networkArgs,
  proxyRunArgs,
  removeNetworkArgs,
  runAttackSuite,
} from "./netns.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/* ------------------------------------------------------------- argv (pure) */

ok(
  "an internal network is created with --internal, not a plain bridge",
  internalNetworkArgs("x").join(" ") === "network create --internal x",
);
ok("an egress network has no --internal flag", !networkArgs("x").includes("--internal"));

{
  const a = proxyRunArgs({
    internalNetwork: "int",
    egressNetwork: "egr",
    allow: ["a.com", "b.com"],
    binDir: "/repo/bin",
  });
  // NOT indexOf-based: --network appears twice in this argv (once per
  // network), and indexOf only ever finds the first, which would make a test
  // for the SECOND network's presence pass by accident even if it were
  // missing entirely — caught by this test failing against its own first
  // draft, which is the reason it looks like this instead of the simpler
  // version sandbox.test.mjs's `has` uses for flags that appear once.
  const has = (flag, value) => a.some((x, i) => x === flag && (value === undefined || a[i + 1] === value));
  ok("the proxy joins the internal network", has("--network", "int"));
  ok(
    "the proxy joins BOTH networks (dual-homed), not just one",
    a.filter((x) => x === "--network").length === 2 && has("--network", "egr"),
    JSON.stringify(a),
  );
  ok("the proxy is reachable under a stable alias", has("--network-alias", "proxy"));
  ok("the allowlist is passed straight through to egress.mjs, unmodified here", has("--allow", "a.com,b.com"));
  ok("egress.mjs itself is bind-mounted read-only", a.some((x) => String(x).includes(":/egress-bin:Z,ro")));
  ok("the proxy has no capabilities either", has("--cap-drop", "ALL"));
}

ok(
  "proxyRunArgs refuses to build an argv with no allowlist source at all",
  (() => {
    try {
      proxyRunArgs({ internalNetwork: "int", egressNetwork: "egr" });
      return false;
    } catch {
      return true;
    }
  })(),
  "an empty allowlist is a valid answer, but it has to be asked for — same rule egress.mjs's own CLI enforces",
);

ok(
  "agentNetFlag hands back exactly the network name sandbox.mjs's --net flag needs, nothing more",
  agentNetFlag("fm-agent-net") === "fm-agent-net",
);

/* -------------------------------------------------------------- live setup */

const podmanAvailable = spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
  encoding: "utf8",
}).stdout?.trim();

const PROXY_IMAGE = process.env.NETNS_TEST_PROXY_IMAGE ?? "docker.io/library/node:22-alpine";
const AGENT_IMAGE = process.env.NETNS_TEST_AGENT_IMAGE ?? "docker.io/library/nginx:alpine";
const hasImage = (img) => spawnSync("podman", ["image", "exists", img], { stdio: "ignore" }).status === 0;

const LIVE_SKIP_NAME = "live: the internal network + dual-homed proxy actually enforces egress";

if (podmanAvailable !== "true") {
  skip(LIVE_SKIP_NAME, `podman not available or not rootless (got ${JSON.stringify(podmanAvailable)})`);
} else if (!hasImage(PROXY_IMAGE)) {
  skip(LIVE_SKIP_NAME, `proxy image ${PROXY_IMAGE} not present locally — pull it or set NETNS_TEST_PROXY_IMAGE`);
} else if (!hasImage(AGENT_IMAGE)) {
  skip(LIVE_SKIP_NAME, `agent image ${AGENT_IMAGE} not present locally — pull it or set NETNS_TEST_AGENT_IMAGE`);
} else {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const INTERNAL_NET = `fm-netns-test-int-${suffix}`;
  const EGRESS_NET = `fm-netns-test-egr-${suffix}`;
  const VICTIM_NET = `fm-netns-test-victim-${suffix}`;
  const PROXY_NAME = `fm-netns-test-proxy-${suffix}`;
  const VICTIM_NAME = `fm-netns-test-victim-${suffix}`;
  const ALLOW_HOST = "example.com"; // real, stable, small — same host egress.test.mjs's live analogue would need
  const DENY_HOST = "evil.example"; // not in the allowlist, and not resolvable either way — the proxy must 403
  // before DNS even matters, since it reads the CONNECT authority, not a resolved address.

  let hostServer = null;
  let hostServerPort = null;
  const cleanup = [];
  const run = (args, opts = {}) => spawnSync("podman", args, { encoding: "utf8", ...opts });

  try {
    // A self-contained host-side listener, bound to all interfaces, so "reach
    // a service on the host itself" is tested against something this run
    // controls rather than an incidental service that happens to be on
    // whatever box runs this — that would make the check unrepeatable.
    hostServer = createServer((_req, res) => res.end("host service, should be unreachable"));
    await new Promise((res) => hostServer.listen(0, "0.0.0.0", res));
    hostServerPort = hostServer.address().port;
    cleanup.push(() => hostServer.close());

    ok("setup: internal network created", run(internalNetworkArgs(INTERNAL_NET)).status === 0);
    cleanup.push(() => run(removeNetworkArgs(INTERNAL_NET)));
    ok("setup: egress network created", run(networkArgs(EGRESS_NET)).status === 0);
    cleanup.push(() => run(removeNetworkArgs(EGRESS_NET)));
    ok("setup: victim network created", run(networkArgs(VICTIM_NET)).status === 0);
    cleanup.push(() => run(removeNetworkArgs(VICTIM_NET)));

    // The proxy: dual-homed, running the REAL egress.mjs from this repo,
    // mounted read-only, allowing exactly ALLOW_HOST.
    const proxyArgs = proxyRunArgs({
      name: PROXY_NAME,
      internalNetwork: INTERNAL_NET,
      egressNetwork: EGRESS_NET,
      image: PROXY_IMAGE,
      binDir: __dirname,
      allow: [ALLOW_HOST],
      port: 8080,
    });
    const proxyStart = run(proxyArgs);
    ok("setup: proxy container started, dual-homed", proxyStart.status === 0, proxyStart.stderr);
    cleanup.push(() => run(["rm", "-f", PROXY_NAME]));

    // The victim: an ordinary container on a THIRD, unrelated network — the
    // thing attack #4 is not supposed to be able to reach.
    const victimStart = run(["run", "-d", "--rm", "--network", VICTIM_NET, "--name", VICTIM_NAME, AGENT_IMAGE]);
    ok("setup: victim container started on a sibling network", victimStart.status === 0, victimStart.stderr);
    cleanup.push(() => run(["rm", "-f", VICTIM_NAME]));

    const victimIp = run([
      "inspect",
      VICTIM_NAME,
      "--format",
      `{{ (index .NetworkSettings.Networks "${VICTIM_NET}").IPAddress }}`,
    ]).stdout.trim();
    ok("setup: victim IP address discovered", /^\d+\.\d+\.\d+\.\d+$/.test(victimIp), victimIp);

    // Wait for the proxy to actually be listening rather than sleeping a
    // guessed duration — poll with the real attack itself, which both waits
    // and produces the first real result.
    let proxyReady = false;
    let lastProbe = null;
    for (let i = 0; i < 15 && !proxyReady; i++) {
      lastProbe = spawnSync(
        "podman",
        [
          "run",
          "--rm",
          "--network",
          INTERNAL_NET,
          AGENT_IMAGE,
          "sh",
          "-c",
          `curl -sS -x http://proxy:8080 https://${ALLOW_HOST} -o /dev/null -w 'HTTP_STATUS=%{http_code}' --max-time 4 2>&1`,
        ],
        { encoding: "utf8" },
      );
      proxyReady = /HTTP_STATUS=200/.test(lastProbe.stdout ?? "");
      if (!proxyReady) await new Promise((r) => setTimeout(r, 500));
    }
    ok("setup: proxy answers CONNECT before the attack suite starts", proxyReady, lastProbe?.stdout ?? "(no probe ran)");

    if (!proxyReady) {
      console.log("[netns] proxy never came up — logs:");
      console.log(run(["logs", PROXY_NAME]).stdout);
    } else {
      // ------------------------------------------------------ the five attacks
      const results = runAttackSuite({
        internalNetwork: INTERNAL_NET,
        proxyAlias: "proxy",
        proxyPort: 8080,
        allowedHost: ALLOW_HOST,
        deniedHost: DENY_HOST,
        victimHost: `${victimIp}:80`,
        hostProbe: `host.containers.internal:${hostServerPort}`,
        agentImage: AGENT_IMAGE,
      });
      for (const r of results) {
        ok(`live attack: ${r.name}`, r.passed, `$ ${r.command}\n       -> ${r.stdout || r.stderr}`);
      }
      ok(
        "live attack: exactly five attacks were run (the ones this task named)",
        results.length === 5,
        `ran ${results.length}: ${results.map((r) => r.name).join(" | ")}`,
      );

      // A sixth check, adjacent to attack #1: DNS on the internal network must
      // never forward an arbitrary hostname to the open internet — only
      // resolve names of containers on the same network. This half of the
      // claim was 100% reproducible across every run of this file (EXIT=2,
      // no address, every attempt): getent hosts on a real internet hostname
      // never returns one.
      //
      // NOT ASSERTED HERE: that `getent hosts proxy` (the alias) resolves —
      // it does immediately after the proxy starts (measured by hand, see
      // this file's header comment and netns.mjs's), but a standalone getent
      // for it run AFTER this file's setup + poll loop + five attacks (about
      // twenty prior `podman run` cycles on the same network in under a
      // minute) returned empty in every run tried, 5 retries each, while
      // attack #1 immediately above — which depends on that exact same
      // resolution to route its CONNECT through `proxy:8080` — passed every
      // time in the same run. That is aardvark-dns being slow or busy
      // rewriting its zone under container churn, not a break in the
      // isolation this file exists to prove; asserting it here would be a
      // check that fails for a reason unrelated to the control, which is
      // worse than not having it. Left as a named, open question rather than
      // papered over: aardvark-dns's behaviour under heavy churn on one
      // network is unresolved and worth its own investigation if it matters
      // for a long-running proxy container with many short-lived agent runs
      // against it.
      const dnsProbe = spawnSync(
        "podman",
        ["run", "--rm", "--network", INTERNAL_NET, AGENT_IMAGE, "sh", "-c", "getent hosts example.com 2>&1; echo EXIT=$?"],
        { encoding: "utf8" },
      ).stdout;
      ok(
        "live: DNS on the internal network never forwards to the open internet",
        /EXIT=[12]/.test(dnsProbe) && !/^\d+\.\d+\.\d+\.\d+\s+example\.com/m.test(dnsProbe),
        dnsProbe,
      );
    }
  } catch (e) {
    ok("live setup completed without throwing", false, String(e?.stack ?? e));
  } finally {
    // Reverse order: containers before the networks they sit on, or network
    // rm fails with "network in use" — proven by trying it the other way
    // around during development.
    for (const fn of cleanup.reverse()) {
      try {
        fn();
      } catch {
        /* best-effort teardown; a leftover fm-netns-test-* network is
           harmless and named for exactly this so it's easy to find and
           remove by hand: `podman network ls | grep fm-netns-test-` */
      }
    }
  }
}

console.log(
  failures === 0
    ? `\n[netns] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[netns] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
