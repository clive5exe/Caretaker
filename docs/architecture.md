# What this is

An abstraction layer for agentic development. It owns the things every AI coding
setup improvises and gets wrong: where the agent runs, what it may reach, which
model does what, whether the work is actually done, and what the project looks
like when you hand it to someone else.

## Four layers

```
control plane        the board, the gates, the loop. Decides what runs.
      |
harness              talks to an AI. Owns the model call and the tool loop.
      |
dev environment      node + postgres + the repo. What the project needs to
                     build and test itself.
      |
infra                where that environment is placed: your box, a VM, a
                     cloud sandbox, a workstation.
```

Two things this fixes that an earlier version of this document conflated.

**`devcontainer.json` describes the dev environment; Terraform and Ansible
provision the infra.** Both were already the right answers, filed one layer
apart without noticing they were layers of the same stack.

**Placement is separate from contents.** The same dev environment sits on a
laptop, a Hetzner box, or a cloud sandbox without being redesigned. That is a
deployment decision, not an architectural one.

## The consequence nobody warns you about

**Existing agent CLIs violate this boundary.** Claude Code, Codex and Aider are
monoliths: each owns the model call *and* executes its own tools, in one process
on one machine. They span the harness and the dev environment and do not split
where this diagram splits.

So the harness hooks at the **SDK level, not the CLI level**. The orchestrator
makes the model call; tool execution is routed down into the dev environment.

The seam is unchanged:

```
run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
```

The cost is honest: an SDK adapter is a few hundred lines per vendor rather than
fifty for shelling out to a binary. Three things are bought with it.

- **The dev environment stays sealed for the agent's own traffic.** The model
  call happens above it, so the container needs egress only for what the
  *project* legitimately does — installing dependencies, a test hitting a
  sandbox API.
- **"Plug in your AI" means the SDK**, which is the more durable interface. CLIs
  change their flags every release.
- **Tool execution becomes ours to place**, which is what makes the infra layer
  a real choice rather than a diagram.

## Layer by layer

### Control plane

Tasks, gates that refuse a builder closing their own work, the event log, the
dashboard, the unattended loop. **Largely built.**

State is a projection of an append-only log rather than a second record, so the
board cannot disagree with the log. See `events.md`.

### Harness

The seam above, plus everything that reasons about a run's *output* rather than
producing it: adversarial verification, drift detection between code and the
specs that govern it, and harvesting decisions a transcript holds and no document
does.

Two vendors before the seam is called proven. One bakes that vendor's shape in
and nobody notices until the second arrives. See `vendors.md`.

### Dev environment

A container built from the spec and `devcontainer.json`, rebuilt every run, with
enforced limits and no route to the internet except an allowlist derived from the
spec's declared hosts.

**Rebuilt every run, so drift here is impossible rather than detectable.** A
package installed by hand is gone next time; if it is needed, the spec changes
and the image rebuilds, which makes the change reviewable and visible to the
allowlist. See `environments.md`.

### Infra

Where the dev environment is placed. Terraform provisions, Ansible converges,
and both are **emitted rather than required** — some teams use Pulumi, some plain
bash, some Nix, and requiring one contradicts the thesis.

`graduate` generates them at handoff from what was actually deployed, which beats
generating them at init when a scaffolder knows nothing about the project.

## The decisions everything rests on

**The seam is `run(workspace, prompt, policy)`.** The tempting abstraction is an
LLM interface — messages, tools, streaming — and it is a trap: you re-implement
every vendor's SDK forever and break on each release.

**Egress, not isolation, is the security control.** Limits and a read-only root
are table stakes. A container with open internet can exfiltrate the repo, which
is worse and quieter than the machine damage the sandbox was for. Verified
against the alternative: Fabro's Docker provider errors on `cidr_allow_list`
entirely, and the allowlist that exists is enforced by a paid third-party cloud.
See `decisions/0001-build-the-egress-layer.md`.

**A spec that auto-follows the code is a mirror, not a spec.** So drift detection
is a gate, reconciliation is a run that *proposes*, and the direction — did we
learn something, or did the code drift — is recorded rather than guessed.

**Structure is inferred, intent is declared.** A code graph owns what calls what,
which is a fact in the AST. The spec's `governs` field owns which document is the
authority, which is a decision a human made and cannot be read off a parse tree.

**Three tiers of record, because they rot at different speeds.** Decisions never
decay and are superseded rather than edited. Specs carry current state only. The
log is append-only and never read in full. See `memory.md`.

## The walking skeleton

The roadmap is thirty-plus tasks. The scope is five, and everything else waits
behind them:

1. **Secrets** — an API key reaches the harness without touching the repo, the
   image, or the event log.
2. **Minimal egress** — a CONNECT proxy allowing the declared hostnames, denying
   and logging everything else. Roughly a hundred lines, not a policy engine.
3. **The harness seam** — one vendor, SDK level, tool execution routed into the
   dev environment.
4. **One real run** — an agent edits a file inside the sealed environment and a
   diff comes back.
5. **The drift gate on that diff** — did it touch governed paths without touching
   the spec.

Done already: the spec parser, the container with limits proven from inside it,
the board and its gates.

Not in the skeleton, deliberately: the TUI, the graph, skills, graduate, the
second vendor, the KPI panel. Each is easier once a run works, and none of them
proves anything until one does.
