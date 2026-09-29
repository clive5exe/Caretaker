<p align="center"><img src="docs/assets/caretaker-logo.png" alt="Caretaker" width="600"></p>

# Caretaker

**Warp's cloud factory, running on your own AI, inside a sandbox, tracked on a
board.**

Warp built a good pipeline for AI development: triage an issue → write a spec
→ implement it → review the PR → improve the reviewer. It only runs on Warp's
hosted agent, Oz. Caretaker runs **Warp's own code** without Oz:

- **Your AI.** Claude or ChatGPT, through their CLIs or APIs. No Warp account
  and no local model.
- **In a sandbox.** Rootless podman, with no route to the internet except the
  model's API.
- **On a board** that won't let anyone, human or AI, sign off their own work.

The plan, with who does what and the order, is **[docs/plan.md](docs/plan.md)**.

## What is Warp's and what is Caretaker's

| | from | status |
|---|---|---|
| Skills: triage, spec, implementation, review-pr, verify-behavior, improve-review-pr | **Warp** (MIT), copied unmodified into `vendor/` | done |
| The five GitHub workflows | **Warp**; the Oz step patched to Caretaker (`vendor/patches/`) | done; not yet run on GitHub with a real login |
| The Oz replacement (`factory/caretaker-agent`) | **Caretaker** | done; proven with a fake model only so far |
| Harness: runs Claude or ChatGPT behind one interface | **Caretaker** | works |
| Sandbox, egress allowlist, secrets by name | **Caretaker** | works; needs podman |
| Board, gates, dashboard, web UI | **Caretaker** | works |
| Drift gate (specs vs code) | **Caretaker** | works |

Warp's code is copied, never rewritten. Any change to it is a small patch file,
and a test fails if the copy drifts from upstream plus those patches.

## Quick start (what works today)

You need `node` and `git`. For sandboxed runs you also need rootless `podman`.

**1. Put the board into a repo:**

```sh
bash install.sh /path/to/repo "Project Name"
cd /path/to/repo
node ops/caretaker/board.mjs status        # the board
node ops/caretaker/dashboard.mjs           # writes docs/board.html
```

**2. Choose your AI.** Create `~/.config/caretaker/harness.json`:

```json
{ "default": { "adapter": "cli", "cli": "claude" } }
```

Use `"cli": "codex"` for ChatGPT. You can also give each job its own AI, for
example Claude builds and ChatGPT reviews:

```json
{ "default": { "cli": "claude" }, "roles": { "refuter": { "cli": "codex" } } }
```

**3. Run an agent in the sandbox:**

```sh
claude setup-token                          # once, uses your Claude subscription
export CLAUDE_CODE_OAUTH_TOKEN=...          # the token it printed
node bin/runstore.mjs run --workspace . --prompt "fix the failing test" \
  --secret CLAUDE_CODE_OAUTH_TOKEN --egress api.anthropic.com --task T-1
```

**What this command does:**
- The agent runs in a container that can reach `api.anthropic.com` and
  nothing else.
- The token goes in by name and is scrubbed from the logs.
- Afterwards you get the diff, the transcript and the cost. The drift gate
  checks the change against your specs.

**4. Review a pull request with Warp's review skill, on your machine:**

```sh
node bin/review.mjs 12 --task T-1 --sandbox none   # uses your own claude login
```

- **What runs:** the steps of Warp's review workflow, as Warp wrote them,
  around your AI.
- **Where:** a throwaway copy of your checkout.
- **What you get:** the review printed. `--task` records the board's
  reviewer gate.
- **Posting:** nothing goes to GitHub unless you add `--post`.

**5. Watch it:**

```sh
node bin/serve.mjs ops/caretaker/config.json   # prints a local URL
```

## The rules the board enforces

- **Nobody closes their own work.** A task needs a `reviewer` pass and a `qa`
  pass, from someone other than its owner. Money, auth and isolation changes
  need `security` too.
- **Every verdict is recorded:** who gave it, when, and how.
- **A spec that no longer matches the code blocks `done`** until someone
  updates the spec or explains why.

## More

- **[docs/plan.md](docs/plan.md):** what happens next, in order, with times
- **[docs/reference.md](docs/reference.md):** the full manual for every
  command and file
- **[docs/architecture.md](docs/architecture.md):** the layers, and the two
  decisions everything rests on
- **[ops/caretaker/RULES.md](ops/caretaker/RULES.md):** the rules for this
  repo's own work

## Licence

Caretaker's code is MIT. Warp's vendored code is MIT © 2026 Warp, and keeps its
own `LICENSE` in `vendor/cloud-factory/`.
