---
title: The sandbox
status: accepted
updated: 2026-09-29
---

```spec
hosts:   api.anthropic.com
governs: bin/sandbox.mjs, bin/egress.mjs, bin/netns.mjs, bin/environment.mjs
```

# The sandbox

Decided in ADR-0001 (build the egress layer, podman) and ADR-0003 (a run's
egress attributed by where its log lives).

An agent runs inside a container that cannot hurt the host and cannot reach
anything this file did not declare.

## The two halves

**Isolation** is table stakes and is the easy half: enforced memory and pids
ceilings, a read-only root with tmpfs for `/tmp` and `/run`, the repo bind
mounted at `/work` with its `.git` mounted over it read-only, every capability
dropped, `no-new-privileges`, and never the container socket. Verified from inside a running container rather than by
reading the flags back: `memory.max` is the declared ceiling, a write to `/`
is refused, and a file written as root inside is owned by the unprivileged host
user outside.

**The repo's `.git` is read-only inside,** because it is the part of the
workspace that runs code on the host: a hook, or `core.fsmonitor` in its config,
runs at the next `git status` anyone types there, this harness's own drift and
freshness checks included. A writable `.git` is an escape with a delay on it, and
the shadow-git diff never sees `.git`, so it would not even show in the run's
measured change. A workspace with no `.git` has nothing to mount, so a run that
creates one is named in the verdict's warnings instead.

**Egress** is the control that actually matters. A container with open internet
can exfiltrate the repo, which is worse and quieter than the machine damage a
sandbox is usually sold against. Hosts come from the `hosts:` field above, plus
the registries implied by the toolchains `devcontainer.json` declares. Everything
else is refused with a 403 and a reason, and logged — a silent drop is
indistinguishable from a broken network and gets debugged as one.

## The runner's own command line

`sandbox.mjs run` parses its flags by name: a value flag needs a value that is
not another flag, the one boolean (`--allow-missing-limits`) takes none, and an
unknown flag is refused with exit 2. Parsing in pairs let a boolean swallow the
next flag, and `--workdir` quietly became the current directory, mounted
read-write.

Anything weaker than rootless podman on no network is said before the run:
`--runtime docker` (its daemon is root), rootful podman, `--net host` (no
allowlist applies), and any other named network (only an internal one behind
the proxy is allowlisted).

Podman missing: `sandbox.mjs install` offers this platform's install command
and runs it only on a typed yes in a terminal. Without a terminal it prints the
command and installs nothing. Docker is never chosen for you.

## The image, every run

Nothing persists between runs except the repo. The container is `--rm`, its
root is read-only and its writable places are tmpfs, so a package an agent
installs by hand is gone when the run ends. If something is needed, the
declaration changes and the image is rebuilt; drift at this layer is made
impossible rather than detected.

The image comes from `devcontainer.json`, resolved in one place
(`environment.mjs`): an explicit `--image`, else its `image`, else its
`build.dockerfile`, **built on every run**. podman's layer cache makes an
unchanged build cheap, and unlike a tag keyed on a hash of the Dockerfile it
also sees a change to a file the Dockerfile copies. A build-only devcontainer is
never handed to podman as if its Dockerfile path were an image name. Each run
records the image id it ran in, because a tag moves.

**The build has no network.** Its Dockerfile and context are in the workspace,
which the last run's agent could edit, and a build's `RUN` steps would otherwise
reach the internet with the repo as their context, around the egress proxy the
run itself is held to. The base image still pulls; a build that downloads
packages is given a network per run on the command line (`--build-network`),
never in a settings file, and the run says so.

Devcontainer `features` are not installed by this runner; that is the
devcontainer CLI's job. They are named in a warning rather than skipped.

## Asking the environment what it has

`environment.mjs check` runs a probe inside the same sandbox a run gets, behind
the same per-run proxy when asked for egress, and names every difference from
the declaration: a declared toolchain missing or at another version, one present
that nobody declared, a declared service this runner does not start, a declared
host that cannot be reached, and an undeclared host that can. That last one
means egress is open. On `--network none` no host can be reached, and that is
stated once rather than reported as every host being down.

Hosts reach a shell in that probe, and with `--sandbox none` the shell is the
host's. So a `hosts:` entry must be a host name (two or more DNS labels, or
`.example.com` for its subdomains); anything else is refused when the spec is
parsed, and refused again by the probe itself.

## Egress belongs to one run

A run started with a proxy gets its own `--internal` network and its own proxy
(`netns.withRunEgress`). The proxy's log is bind-mounted into that run's archive
directory, so every allowed and refused host is attributed to exactly the run
that asked for it, by where the log lives. The proxy is never told which run it
serves, and so cannot tell a wrong story about it. Both are torn down when the
run ends, however it ends.

A client that resets while being refused does not stop the proxy either: the
connection's error handler is attached before the decision, so one abrupt
client cannot take down egress for the rest of the run.

A log the proxy cannot write does not stop the proxy. The failure is reported
once, and every refusal still goes to stderr. A proxy that died on its first
event refused every connection, allowed or not, and that reads as a broken
network rather than a wrong log path.

## What is deliberately not done

**No TLS interception.** The proxy reads the hostname from the CONNECT line and
then tunnels bytes it cannot see. Terminating TLS would mean the container trusts
a certificate authority we control, and anything holding that authority could
read every secret the agent handles. The hostname is the decision; the payload is
not our business.

**A limit the kernel cannot enforce is refused, not dropped.** Rootless podman
can only apply what systemd delegated to the user slice, which on a default
install is `memory pids` and not `cpu`. Passing `--cpus` anyway fails the run
with an error that reads like a podman bug. Dropping it silently would be worse:
the run succeeds and the ceiling is not there, and a limit you believe in and do
not have is worse than none.

## The claim this rests on

`--network none` is genuinely sealed. Anything looser is only as good as the
network the container sits on, because setting a proxy variable is advisory and a
process that ignores it is not stopped by the proxy. That enforcement is
`bin/netns.mjs`, and it is worth nothing until something has tried to break it.

## What has tried to break it

Run live in CI, where rootless podman is available. Each attack's command and
real output are written to a JSON report, and printed whether it passed or not.

- **The network** (`bin/netns.test.mjs`, `runAttackSuite`): an allowed host
  through the proxy (must work), a refused host through the proxy (403), a
  bypass by hostname, a bypass by raw IP (no name lookup, so only a missing
  route can stop it), a container on a sibling network, and a service on the
  host itself.
- **The container** (`bin/sandbox.test.mjs`): memory exhausted under a 64 MiB
  ceiling is killed inside the container (skipped where no ceiling can be
  enforced, since it would then take the host's memory); no container-runtime
  socket is reachable, with a control that the same hunt finds one that is
  mounted; the root filesystem refuses a write; there is no route off a
  `--network none` container.
