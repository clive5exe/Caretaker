# foreman — build guide

An abstraction layer for agentic development: where the agent runs, what it may
reach, which model does what, whether the work is actually done, and what the
project looks like when you hand it to someone else.

**Read `docs/architecture.md` first.** It has the six layers, the build order,
and the two design decisions everything else depends on — the harness seam and
the egress allowlist. Neither is negotiable without redoing the work.

- **Board:** `docs/board.json`, driven by `node ops/foreman/board.mjs`
- **Dashboard:** `node ops/foreman/dashboard.mjs` → `docs/board.html`
- **This repo dogfoods itself.** The board tracking this work IS the product.
  If the tool is annoying to use here, that is the bug report.

## The order is the plan

```
6  graduate     CI/CD + docs generated from what actually happened
5  UI           watch a run, steer it mid-flight
4  board        tasks, gates, tracking, cost        <- exists
3  skills       consume the existing standard
2  harness      plug in your AI
1  environment  it cannot hurt your machine
```

Bottom-up. Layers 1 and 2 are the product. Building the UI early is the standard
way this dies: a good shell over a harness that does not work.

## Hard rules

- **The seam is `run(workspace, prompt, policy) -> { diff, transcript, verdict,
  cost }`.** Nothing above the harness layer may import a vendor's SDK. If it
  does, the abstraction has that vendor's shape baked in and the second vendor
  will not fit.

- **Two vendors before the seam is called proven.** One proves nothing.

- **Never mount the container socket.** `/var/run/docker.sock` inside a container
  is root on the host. This is how most "sandboxed" agent tools are quietly not
  sandboxed.

- **The container gets no route to the internet.** Only an allowlist proxy. Open
  egress means a confused agent can exfiltrate the repo, which is worse and
  quieter than the machine damage the sandbox was for.

- **Rootless podman, not Docker.** An escape lands as an unprivileged user rather
  than root.

- **Do not build a skills format.** `skills/<category>/<name>/SKILL.md` and
  `npx skills add owner/repo` already have the adoption. Consume them.

- **Prove a control by attacking it.** A sandbox nobody has tried to break is a
  claim, not a control. E-3 exists for exactly this and should never be dropped
  as "obviously fine".

- **Nobody closes their own work.** `board.mjs` enforces it. Money, auth and
  isolation changes need `security` as well as `reviewer` and `qa`.

- **A count in a comment is legitimate only if the line below asserts it, or the
  comment names the command that produces it.** See `ops/foreman/RULES.md` for
  the rest, including the one that costs the most: a comment defending a correct
  control with a wrong reason is worse than no comment, because the next reader
  checks it, finds it false, and discards the control with it.

## What is deliberately NOT here

**Encore.** This began as tooling inside a ticketing project and was extracted.
If something in here knows about tickets, orders or Stripe, it is a leak and
should be removed rather than generalised.
