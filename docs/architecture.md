# What this is

An abstraction layer for agentic development. It owns the things every AI coding
setup improvises and gets wrong: where the agent runs, what it may reach, which
model does what, whether the work is actually done, and what the project looks
like when you hand it to someone else.

The board that exists in this repo today is one layer of six. It is the layer
that was already built; it is not the interesting one.

## The layers

```
6  graduate     CI/CD + docs generated from what actually happened
5  UI           watch a run, steer it mid-flight
4  board        tasks, gates, tracking, cost        <- exists today
3  skills       consume the existing standard, do not rebuild it
2  harness      plug in your AI
1  environment  it cannot hurt your machine, and you can cap what it takes
```

Built bottom-up, and the order is not negotiable. Layers 1 and 2 are the
product; 4 already exists; 5 and 6 are what make it worth paying for.

## 1. Environment

**The isolation is the easy half.** `--memory`, `--cpus`, `--pids-limit`, a
read-only root with a tmpfs, the repo bind-mounted, and never the container
socket. Mounting `/var/run/docker.sock` is root on the host, and it is how most
"sandboxed" agent tools are quietly not sandboxed.

**The hard half is egress, and it is the actual security layer.** An agent needs
to reach an API. A container with open internet can exfiltrate the whole repo,
which is worse than the machine damage the sandbox was for, because it is
silent. The control is an allowlist proxy: the container gets no route to the
internet, only to a proxy that permits the model API, the package registry, and
nothing else. Everything else 403s and is logged.

That is the difference between "runs in Docker" as a marketing line and "cannot
hurt you" as a property.

**Rootless podman over Docker.** A container escape lands as an unprivileged
user rather than root. Same CLI surface, cgroup limits work the same. The
development box already runs podman 5.8.2 rootless.

## 2. Harness

**The seam is the whole design decision.** The tempting abstraction is an LLM
interface — messages, tools, streaming. That is a trap: you re-implement every
vendor's SDK forever and break on each release.

The seam that holds:

```
run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
```

Every agent CLI can do exactly that. None of them agree on anything below it.
Define it there and a new vendor is a small adapter rather than a permanent
maintenance tax.

Two vendors before calling the seam proven. One vendor proves nothing — the
abstraction will have that vendor's shape baked into it and nobody will notice
until the second one arrives.

## 3. Skills

Solved elsewhere. `npx skills@latest add owner/repo`, skills as
`skills/<category>/<name>/SKILL.md`, invoked as slash commands. That convention
has enormous adoption already.

Consume it. Let a project point at any repo that follows it. Building a second
skills format is a losing move and the differentiator was never the skills.

## 4. Board

What this repo does today: tasks, gates that refuse a builder closing their own
work, a dashboard that shows effort against task count and says what it cannot
measure, a run log with cost, an unattended loop.

Slots in above the harness. Needs one addition to be useful to a new project: a
`spec` field on a task, and a staleness check that compares a document's claimed
`updated:` date against the last commit that touched it, so a doc that lies
about its own freshness is visible.

## 5. UI

Last, and it changes what the thing is to operate. The dashboard today is one
static file with no attack surface. A UI that shows live runs and lets you steer
one needs a daemon, a websocket and auth — a service, not a file.

Worth building. Building it first is the standard way this dies: a good shell
over a harness that does not work yet.

## 6. Graduate

The sharpest idea here and nobody ships it.

During a build, CI is friction. At handoff, its absence is exactly what makes a
project unmaintainable. Every scaffolder emits CI at `init`, when it knows
nothing about the project.

`graduate` runs at the END and generates from what actually happened: the
workflow file from the commands the gates really ran, the docs site from the
specs that were really written, the decision index from the ADRs that were
really recorded. Real history rather than a template.

## Prior art, honestly

**Fabro** — DOT graphs as workflow definitions, a CSS-like stylesheet routing
model per node class, git checkpoints per stage. The stylesheet idea is good and
worth taking: separating what a step does from how much thinking to buy for it
is the right seam. Their unit being a *stage* rather than a *conversation* is
also right, and is the same conclusion the harness seam above reaches.

Where they stop short: a graph fixes the ORDER of steps, not the CORRECTNESS of
any one of them, and their verification is a human approval gate. A person
approving their fortieth diff of the day is a rubber stamp. Machine gates that
revert a fix and assert the test goes red by name are the thing that actually
catches a false claim.

**mattpocock/skills** — the skills distribution standard. Consume, do not
compete.
