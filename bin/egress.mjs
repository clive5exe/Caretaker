#!/usr/bin/env node
/**
 * EGRESS — a CONNECT proxy that allows the hosts a spec declared and nothing else.
 *
 * E-2, and the load-bearing piece of the whole thing. Isolation from the host is
 * table stakes; a container with open internet can exfiltrate the repo, which is
 * worse and quieter than the machine damage a sandbox is usually sold against.
 *
 * WHY A PROXY RATHER THAN A CIDR LIST. `api.anthropic.com` and
 * `registry.npmjs.org` sit behind CDNs on rotating address ranges, so an
 * address-based allowlist is either too broad to mean anything — whole CDN
 * ranges, which is most of the internet — or it breaks the first time an address
 * moves. Hostname control has to happen where the hostname is still visible,
 * which is the CONNECT request.
 *
 * THE PROXY IS NOT THE ENFORCEMENT. Setting HTTPS_PROXY in a container is
 * advisory: a process that ignores the variable and dials out directly is not
 * stopped by anything here. Enforcement is the network the container is placed
 * on — `podman network create --internal` gives it no route off the host at all,
 * and this proxy is the only thing reachable on it. See `network()` below for
 * the wiring, and note that running this with a normally-networked container
 * gives the appearance of control without the substance.
 *
 * WHAT IS DELIBERATELY NOT DONE: no TLS interception. The proxy sees the
 * hostname in the CONNECT line and then tunnels bytes it cannot read. Reading
 * the payload would mean terminating TLS with a forged certificate, which means
 * the container trusts a CA we control, which means anything holding that CA can
 * read every secret the agent handles. The hostname is the decision; the
 * contents are not our business.
 *
 * Usage:
 *   egress.mjs serve --allow a.com,b.com [--port 8080] [--log FILE]
 *   egress.mjs serve --spec specs/x.md --devcontainer .devcontainer/devcontainer.json
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
import { parseSpec, toEgress, readDevcontainer } from "./spec.mjs";

/**
 * Does `host` match the allowlist?
 *
 * EXACT MATCH, OR A LEADING-DOT SUFFIX. `api.stripe.com` allows exactly that
 * host. `.stripe.com` allows any subdomain of it, and must be written with the
 * dot so it can never be mistaken for a hostname.
 *
 * The rule that matters is the one that is easy to get wrong: a bare
 * `stripe.com` in the list does NOT allow `evil-stripe.com`, because matching is
 * on labels rather than string prefixes. Suffix matching on raw strings is how
 * allowlists get bypassed, and it looks correct in every test written by the
 * person who wrote the bug.
 */
export function allowed(host, allowlist) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    const e = String(entry).toLowerCase().replace(/\.$/, "");
    if (e.startsWith(".")) return h === e.slice(1) || h.endsWith(e);
    return h === e;
  });
}

/** Split "host:443" without tripping over IPv6 literals. */
export function splitHostPort(authority, fallbackPort = 443) {
  const s = String(authority);
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    const host = s.slice(1, close);
    const rest = s.slice(close + 1);
    return { host, port: rest.startsWith(":") ? Number(rest.slice(1)) : fallbackPort };
  }
  const i = s.lastIndexOf(":");
  if (i === -1) return { host: s, port: fallbackPort };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || fallbackPort };
}

export function createProxy({ allowlist, onEvent = () => {}, allowPorts = [443, 80] }) {
  const server = createServer((req, res) => {
    // Plain HTTP through a proxy is a full URL in the request line. Refused
    // rather than proxied: everything worth reaching is HTTPS, and forwarding
    // cleartext would be a second code path to get wrong for no gain.
    onEvent({ kind: "refused", reason: "plain-http", host: req.headers.host ?? "?" });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("egress: plain HTTP is not proxied; use HTTPS\n");
  });

  server.on("connect", (req, clientSocket, head) => {
    const { host, port } = splitHostPort(req.url);
    const deny = (reason) => {
      onEvent({ kind: "refused", reason, host, port });
      // 403 rather than a silent drop. A dropped connection is
      // indistinguishable from a network fault and gets debugged as one for an
      // hour before anyone suspects policy.
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n" +
          `egress: ${host} is not in this project's allowlist\n`,
      );
      clientSocket.end();
    };

    if (!allowPorts.includes(port)) return deny(`port-${port}`);
    if (!allowed(host, allowlist)) return deny("not-allowed");

    const upstream = connect(port, host, () => {
      onEvent({ kind: "allowed", host, port });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Both directions must be torn down together, or a half-open socket leaks a
    // file descriptor per refused connection and the proxy dies quietly under
    // load — which reads as "the network is flaky".
    const bail = (why) => {
      onEvent({ kind: "error", host, port, why: String(why?.message ?? why) });
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", bail);
    clientSocket.on("error", bail);
  });

  return server;
}

/* --------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isEntry) {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 1; i < argv.length; i += 2) flags[argv[i]?.replace(/^--/, "")] = argv[i + 1];

  if (argv[0] !== "serve") {
    console.error("usage: egress.mjs serve --allow a.com,b.com | --spec F [--devcontainer F]");
    process.exit(2);
  }

  let allowlist = [];
  if (flags.allow) {
    allowlist = flags.allow.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (flags.spec) {
    const { ok, errors, spec } = parseSpec(readFileSync(flags.spec, "utf8"));
    if (!ok) {
      console.error(`${flags.spec} is not a valid spec:`);
      for (const e of errors) console.error(`  ${e}`);
      process.exit(1);
    }
    allowlist = toEgress(spec, readDevcontainer(flags.devcontainer)).allow;
  } else {
    console.error("egress: give --allow or --spec. There is no default allowlist, and an empty");
    console.error("one is a valid answer that denies everything — but it has to be asked for.");
    process.exit(2);
  }

  const logFile = flags.log ?? null;
  const port = Number(flags.port ?? 8080);
  const counts = { allowed: 0, refused: 0, error: 0 };

  const onEvent = (e) => {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const line = JSON.stringify({ t: new Date().toISOString(), ...e });
    // EVERY REFUSAL IS LOGGED. A block that leaves no trace is the same
    // experience as a broken network, and the person debugging it has no way to
    // tell which without this line.
    if (logFile) appendFileSync(logFile, line + "\n");
    if (e.kind !== "allowed") console.error(line);
  };

  createProxy({ allowlist, onEvent }).listen(port, "0.0.0.0", () => {
    console.error(
      `[egress] listening on :${port}, allowing ${allowlist.length} host(s): ${allowlist.join(", ") || "(none)"}`,
    );
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.error(
        `[egress] ${counts.allowed ?? 0} allowed, ${counts.refused ?? 0} refused, ${counts.error ?? 0} errored`,
      );
      process.exit(0);
    });
  }
}
