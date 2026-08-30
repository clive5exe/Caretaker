---
title: The sandbox
status: accepted
updated: 2026-08-30
---

```spec
hosts:   api.anthropic.com
governs: bin/sandbox.mjs, bin/egress.mjs, bin/netns.mjs
```

# The sandbox

An agent runs inside a container that cannot hurt the host and cannot reach
anything this file did not declare.

## The two halves

**Isolation** is table stakes and is the easy half: enforced memory and pids
ceilings, a read-only root with tmpfs for `/tmp` and `/run`, the repo bind
mounted at `/work`, every capability dropped, `no-new-privileges`, and never the
container socket. Verified from inside a running container rather than by
reading the flags back: `memory.max` is the declared ceiling, a write to `/`
is refused, and a file written as root inside is owned by the unprivileged host
user outside.

**Egress** is the control that actually matters. A container with open internet
can exfiltrate the repo, which is worse and quieter than the machine damage a
sandbox is usually sold against. Hosts come from the `hosts:` field above, plus
the registries implied by the toolchains `devcontainer.json` declares. Everything
else is refused with a 403 and a reason, and logged — a silent drop is
indistinguishable from a broken network and gets debugged as one.

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
