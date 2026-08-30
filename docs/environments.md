# Environments

## Two problems that look like one

They get conflated constantly, and they want opposite tools.

| | **Sandbox** | **Infrastructure** |
|---|---|---|
| what | the container a run happens inside | the box, the database, the proxy, the monitoring |
| lifetime | minutes | months |
| created | dozens of times an hour | rarely, deliberately |
| when it changes | never — it is rebuilt | slowly, and drift is real |

## Why Terraform and Ansible are wrong for the sandbox

Not because they are bad. Because their model is a mismatch.

**Terraform is desired-state reconciliation with a state file.** That is exactly
right for a resource that persists and that you need to converge back to a known
shape. For a container created fifty times an hour it is pure overhead: you are
storing durable state about a thing whose entire point is not to persist, and
the state file becomes a lock contention point between concurrent runs. The
cycle time is wrong too — seconds to minutes against milliseconds for a
container start.

**Ansible is push-based convergence over SSH.** It assumes a host that exists and
persists, and its job is to walk that host toward a description. A container
built from a spec does not need converging. It needs building once and throwing
away.

The right tool for a sandbox is an image and a run spec. That is the whole thing.

## "Environments change" — at this layer, they must not

This is the sharpest form of the question, and the answer is not to detect the
change but to make it impossible.

**The sandbox is rebuilt from the spec on every run.** Nothing persists between
runs except the repo. A package installed by hand inside a container is gone the
next time. If something is genuinely needed, the spec changes and the image is
rebuilt — which means the change is reviewable, attributable, and visible to the
egress allowlist that is derived from the same block.

Immutable rebuild converts a drift problem into a non-problem. It is the one
place in this design where the answer is prevention rather than detection.

## Where drift IS real, and why it is easier here than in docs

Long-lived infrastructure drifts. Postgres 16 becomes 17. Somebody adds a host
to a firewall by hand. That is genuine and the same machinery as the doc drift
gate applies — declared versus actual, with a direction.

**But it is a much easier problem than doc drift, and worth doing first for that
reason.** A document's meaning is ambiguous; you need judgment to decide whether
prose still describes code. A container's contents are not ambiguous. You can
ask it what packages it has, what versions the services are, which hosts it can
reach, and diff that against the declaration with no interpretation involved.

Same gate, pointed at a target that cannot argue about what it says.

## Where Terraform and Ansible DO belong

Two places, both above the sandbox.

**E-4, targeting a box you own.** The environment layer should be able to produce
a deployable for a plain Linux host with its own Postgres and its own Prometheus
scrape config, not only a managed platform. Terraform provisions that box;
Ansible converges it. This is what they are for.

**G-2, graduate.** At handoff, emit a Terraform module and an Ansible playbook
derived from the spec and from what was actually deployed. This beats emitting
them at `init` for exactly the reason CI does: a scaffolder at init knows nothing
about the project, so it emits a template with placeholders in it, and templates
with placeholders are how infrastructure code starts lying.

There is a second reason `terraform plan` belongs in the story: **it is a drift
detector.** Not only a provisioner. Running it on a schedule against real
infrastructure answers "has anyone changed this by hand" better than anything
bespoke would.

## Emitter, not dependency

The tool must run with neither Terraform nor Ansible installed.

Some teams use Pulumi. Some use plain bash and are right to. Some use Nix, which
is the strongest available answer to "a reproducible environment derived from a
declaration" and also a large bet with a brutal learning curve. Making any one of
them a hard requirement contradicts the thesis this whole project rests on: ship
the mechanism, not the opinion.

So they are outputs. `graduate` emits what your team already uses, and the tool
does not care which.
