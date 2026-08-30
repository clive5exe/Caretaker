---
title: "ADR-0001: Build the egress layer; take Fabro's technique, not its code"
status: accepted
updated: 2026-08-30
---

## The question

Fabro advertises "cloud sandbox execution with network isolation", which is E-1
and E-2 on our board. Before writing a runner, use theirs or build?

Answered by reading their source, not their README.

## What they actually have

Cloned at depth 1 and read. Three sandbox providers in
`lib/components/fabro-sandbox/src/provider/`:

| provider | isolation | egress control |
|---|---|---|
| `local` | **none** | none — "no filesystem or network isolation, use it only for trusted workflows" |
| `docker` | container | **none** |
| `daytona` | cloud VM | CIDR allow-list, enforced by Daytona |

Their own documentation table, `docs/public/execution/environments.mdx:220`:

```
network.mode = "allow_all"        Host network | Docker default bridge | Daytona allow-all
network.mode = "block"            Error        | Docker `none` network | Daytona block
network.mode = "cidr_allow_list"  Error        | Error                 | Daytona CIDR allow-list
```

**On Docker, an allowlist is an ERROR.** You get all or nothing: the default
bridge with the whole internet, or `none` with no network at all. `docker.rs` is
179 lines and contains no reference to networking whatsoever — it creates,
inspects, lists and deletes containers.

And the allowlist that does exist is not theirs. The type is named
`DaytonaNetwork` (`config.rs:29`); it is serialised into an API call and
**enforced by Daytona**, a paid third-party cloud. Fabro validates the CIDRs and
passes them on.

## Why that does not fit

**An agent needs the model API, so `block` is unusable.** That leaves `allow_all`
on any self-hosted container — the whole internet — which is the exact condition
the egress control exists to prevent. Isolation from the host does not stop a
confused or compromised agent POSTing the repo somewhere, and that failure is
silent, which makes it worse than the machine damage the sandbox was for.

**And CIDR is the wrong unit even where it works.** `api.stripe.com` and
`registry.npmjs.org` sit behind CDNs on rotating address ranges. A CIDR list is
either too broad — whole CDN ranges, which is most of the internet — or it
breaks the first time an address changes. Hostname-level control needs a proxy
that inspects SNI or handles CONNECT. That is a different mechanism, not a
tighter list.

**Using their runner would not get us the thing we need**, and would mean
adopting their graph model and their server to obtain a container wrapper we can
write ourselves.

## Decision

**Build the environment layer. Take the technique, not the code.**

Worth taking from them, credited:

- the model stylesheet — routing model and effort per node class, separating
  what a step does from how much thinking to buy for it
- a *stage* rather than a *conversation* as the unit of execution, which is the
  same conclusion our harness seam reaches independently
- git checkpoints per stage, for resumability

Not taken: DOT as the execution language (conditions become a string DSL the
moment you need a real one), and human approval gates as the verification story
(a person approving their fortieth diff of the day is a rubber stamp).

## What this commits us to

The egress proxy is now the load-bearing piece of the whole product, because it
is the part nobody else has. It must:

- give the container **no route to the internet** — not a filtered one
- allow only hosts derived from the spec's `hosts` block plus the registries
  implied by the declared devcontainer features
- **log every refusal**, so a block is never mistaken for a network fault
- work on a machine you own, not only on someone's cloud

E-3 exists because a sandbox nobody has attacked is a claim rather than a
control, and after this ADR that claim is the product's main one.

## Method note

The rule that produced this, and that was not being followed before it: **before
building anything, name what already exists and say why it does not fit — and
when the answer is that it does fit, use it.** The previous version of our spec
parser declared `runtime`, `services`, `memory` and `cpus`, all of which
devcontainer.json already carries. That was caught by asking the same question
one layer down.
