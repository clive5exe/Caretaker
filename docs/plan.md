# The plan: Warp's factory, running on Caretaker

Updated 2026-09-29. This replaces every earlier plan. If another document
disagrees with this one, this one wins, and the other is out of date.

## The goal, in one line

Run **Warp's cloud factory** (triage → spec → implement → review → improve)
with **your AI** (Claude or ChatGPT) inside **Caretaker's sandbox**, tracked on
**Caretaker's board**. No Oz, no Warp account, no local model.

## What went wrong, and the rule that fixes it for good

Caretaker took Warp's *ideas* and rewrote them by hand. The result:

- code Warp already had working got rewritten and has to be re-proven;
- time went into re-deriving answers Warp had already shipped.

**The rule from now on: Warp's code is copied, never rewritten.**

- Warp's files live unmodified in `vendor/cloud-factory/`, pinned to one
  upstream commit, with Warp's MIT licence beside them.
- Where a Warp file has to change, the change is a small patch file in
  `vendor/patches/`. Nobody edits the vendored copy by hand.
- One script re-pulls upstream and re-applies the patches, so upgrading to a
  newer Warp is one command, not a rewrite.
- A test fails if the vendored copy differs from upstream plus the patches.
  That turns "we didn't hand-roll it" from a promise into a check.

Caretaker code gets written in exactly one place: the **shim** that stands in
for Oz.

## Why this works

In every Warp workflow, Oz is **one step**:

```yaml
- uses: warpdotdev/oz-agent-action@v1.0.25
  with: { skill, name, prompt, warp_api_key, profile }
  # output: agent_output
```

Everything around that step is plain Python and `gh` with no Oz in it:

- preparing the diff (`annotate_diff.py`)
- building review context (`build_review_context.py`, `resolve_spec_context.py`)
- validating the answer (`validate_review_json.py`)
- publishing it (`publish_review.py`)

So the swap is one line per workflow:

```yaml
- uses: ./.github/actions/caretaker-agent        # was warpdotdev/oz-agent-action
  with: { skill, name, prompt, anthropic_api_key } # same inputs, your key
  # output: agent_output                           # same output
```

The shim runs the skill through Caretaker's harness: Claude or Codex, inside
the rootless-podman sandbox, with egress allowed only to the model's API. It
hands back `agent_output` just as Oz did. Every other line of every workflow
stays Warp's.

## Who does what

| part | comes from | what happens to it |
|---|---|---|
| skills: triage, spec, implementation, review-pr (+5 scripts), improve-review-pr | **Warp** | copied as-is |
| workflows: triage, spec, implement, review, improve | **Warp** | copied; `uses: oz-agent-action` → `uses: caretaker-agent` (a patch) |
| installer `install-cloud-factory.sh` | **Warp** | copied; the patch points it at this repo and drops the Warp-key line |
| skill `verify-behavior` | **Warp** | copied. It asks for Oz's `computer_use`; the patch points it at Playwright (already on the runner) |
| triage's Oz polling (~200 lines of `oz run get`) | **Warp** | patched out. Our run is synchronous, so `agent_output` is already the final answer |
| skill `oz-cloud-factory-demo` | Warp | **not copied**: it only describes Oz |
| `warpdotdev/common-skills` (write-product-spec, write-tech-spec, validate-changes-match-specs) | Warp | copied the same way, if its licence allows; checked in step 1 |
| sandbox, egress allowlist, secrets by name | **Caretaker** | kept: Warp has none of this, Oz did it in Warp's cloud |
| harness: `run(workspace, prompt, policy)`, Claude + ChatGPT | **Caretaker** | kept: it *is* the shim's engine |
| board, gates (reviewer / qa / security), dashboard, web UI | **Caretaker** | kept: Warp has no board |
| drift gate, run archive, cost log | **Caretaker** | kept |
| `ops/caretaker/prompt.txt` (hand-written builder brief) | Caretaker | **retired** once `implementation` has run for real |
| `bin/verify.mjs` refuter prompt (hand-written reviewer) | Caretaker | **retired** once `review-pr` has run for real; the refuter becomes review-pr on a second model |
| `bin/graduate.mjs` CI generator | Caretaker | **retired**: Warp's workflows are the CI |
| harness tool control (`tools.mjs`) | Caretaker | written and tested, **parked in `git stash`**. Lands after step 5 |

Nothing is deleted until its Warp replacement has done one real run. You
should never be left with neither.

## The steps, in order, with times

The budget is 5 hours. Each step ends in a commit you can check.

| # | step | done when | time |
|---|---|---|---|
| 0 | This plan and a README a person can read | pushed; README fits on a few screens | 0:30 |
| 1 | **Vendor Warp**: `vendor/cloud-factory/` at `ab21d0c5`, LICENSE + NOTICE, `scripts/sync-warp.sh`, the "vendored == upstream + patches" test | test passes; flipping one byte in `vendor/` fails it | 0:45 |
| 2 | **The shim**: `.github/actions/caretaker-agent/action.yml` + `bin/agent-step.mjs`. Same inputs and output as oz-agent-action. Runs the skill through the harness | a fake model run through the shim writes `review.json`, and Warp's own `validate_review_json.py` accepts it | 1:00 |
| 3 | **Patch the workflows**: five `uses:` swaps, triage polling removed, installer repointed. Each is a patch file | `actionlint` clean; every patch applies to upstream | 0:45 |
| 4 | **Review → gate**: a review verdict from Warp's `review-pr` records the board's `reviewer` gate (`by: review-pr`, `via: ci`) | a PR with a board id in its title gets its reviewer verdict recorded | 0:30 |
| 5 | **Local mode**: `caretaker review <pr>` runs Warp's prepare → agent → validate on your machine through the same shim, and prints the review instead of posting it | runs on this repo's own open PR with a fake model | 0:45 |
| 6 | Mark the retired pieces, update the board, final check | drift gate passes; every test passes | 0:30 |
| — | buffer | | 0:15 |

**What needs you, and only you:**

- **A key** for the first real run, added as a repository secret:
  - `CLAUDE_CODE_OAUTH_TOKEN` (your Claude subscription: run
    `claude setup-token` once), **or**
  - `ANTHROPIC_API_KEY`, **or**
  - `OPENAI_API_KEY`.

  Until one exists, everything is proven against a fake model. That proves the
  plumbing, not the AI's work. I will say which is which every time.
- **Merging.** Steps land on this branch and you merge. I don't merge.

## After the 5 hours (not in this window)

1. Land the parked tool control. It lets you choose the tools the model gets,
   add your own, and approve calls live.
2. Retire `prompt.txt`, the verify refuter and graduate's CI generator, after
   their Warp replacements have each done one real run.
3. Watch runs and steer them from the web UI (layer 5).

## What is paused

Everything else on the board: the round-3 fixes (P-4, P-5, B-5, G-1, B-2) and
new features. They resume after step 6. Nothing new gets hand-built while
Warp has a working version of it.
