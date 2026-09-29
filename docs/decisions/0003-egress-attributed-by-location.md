---
title: "ADR-0003: A run's egress is attributed by where its log lives"
status: draft
updated: 2026-09-29
---

## The question

Run detail should show which hosts a run reached and which it was refused
(`specs/foreman-web/PRODUCT.md`). Before this, nothing could: the harness never
started a proxy, `netns.proxyRunArgs` started one long-lived proxy per network
shared by every run on it, and the proxy's records carry no run and no client
address.

TECH.md §C-5 named two ways to fix that and asked for a decision.

## The options

**One shared proxy that logs the client address,** mapped to the run's
container when the run starts.
- Less podman churn.
- The mapping is a second record that has to be right. Addresses are reused,
  so it must be taken at start and closed at end. A run whose harness died
  leaves a mapping open for the next run to inherit.
- The proxy's log becomes correct only if something else is.

**One internal network and one proxy per run,** with the proxy's log
bind-mounted into that run's archive directory.
- The run is identified by where the log file is. The proxy never learns which
  run it serves, so it cannot mislabel one.
- Two more podman objects created and destroyed per run.

## Decision

**Draft.** Proposed: one network and one proxy per run, implemented in
`netns.withRunEgress` and `runstore.runArchived({ egress })`, **opt-in** per run.

Opt-in rather than default, because of the cost this ADR does not yet know. The
H-1 board note records a DNS symptom that appeared only under sustained podman
churn. This design adds churn. It becomes the default after it has been run
under that kind of load and the symptom has not returned, and the measurement
is recorded here.

## What it commits us to

- The proxy's allow/deny logic stays in `egress.mjs`, untouched by this.
  Attribution is a property of placement, not of the proxy.
- The archive redacts the egress log with the run's own secrets. A hostname is
  agent-controlled text, and a key can leave as a subdomain.
- A run with `sandbox: none` cannot ask for egress attribution. The agent is on
  the host network, which no proxy guards, so any record would imply a control
  that was not there.
- A proxy whose log cannot be written keeps serving, and says so once. Before
  this it died on its first event, which is how this ADR's own test found it.

## Who decides

Accepting it needs `security` as well as `reviewer` and `qa`, since it changes
how the isolation layer is wired. The author does not close it.
