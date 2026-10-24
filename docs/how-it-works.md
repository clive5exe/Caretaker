# How Caretaker works, end to end

This is the operator's guide: what happens when you install Caretaker into a
repo, hand a task to an AI, and ask whether the work is done. It describes the
system as it is on 2026-10-24, after the independent review rounds recorded on
the board. Where a claim has a test, the test is named. Where something is not
built or not proven, it says so.

The short pitch is the [README](../README.md). Every command and file is in
[reference.md](reference.md). The design decisions are in
[architecture.md](architecture.md) and [decisions/](decisions/). What the
sandbox is required to hold is the spec, [specs/sandbox.md](../specs/sandbox.md).

## The one sentence

An AI agent edits your repo inside a container that cannot reach the
internet, under limits it cannot raise, from an environment a human accepted;
what it changed is measured, logged and costed; a second agent tries to refute
it; and a task closes only when people other than its builder say so.

## The six layers, bottom up

```
6  graduate     CI and docs generated from what actually happened   (G-1 built, G-2 not)
5  UI           a web client and a terminal view over the same read model
4  board        tasks, gates, run log, dashboard, unattended loop   (built, installable)
3  skills       consumes the existing skills standard               (S-1 built)
2  harness      run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
1  environment  rootless podman, limits, egress allowlist, secrets by name
```

Layers 1 and 2 are the product. Everything above them is only as honest as
they are, which is why most of the review effort went there.

## Installing it into a repo

```sh
bash install.sh /path/to/repo "Project Name"
```

That copies four scripts and the rules into `ops/caretaker/`, writes a starter
board at `docs/board.json`, and renders `docs/board.html`. Nothing is installed
globally and no service runs. `install.sh --upgrade` replaces the tool files
only and keeps your board, config and prompt; it backs up what it replaced and
restores it if the new board cannot read yours.

The repo you install into is **the workspace**. Everything below is judged
against it: a file inside the workspace is a file the agent could have edited.

## The board, and why it refuses you

```
$ node ops/caretaker/board.mjs done T-001

  REFUSED — T-001 has not passed the gate.
  Missing: reviewer, qa
```

A task has an owner, an acceptance criterion, dependencies, and gates. The
gates are `reviewer`, `qa`, and, for money, auth and isolation work,
`security`. The board decides which tasks need `security` from their own
words: anything mentioning secrets, keys, logins, the sandbox, egress,
redaction, cookies and the like. A verdict records who gave it, when, how
(`via: cli`, `via: web`, `via: ci`) and what they ran; verdicts are appended,
never overwritten, so rework and first-pass rate are computable.

`done` is refused until every required gate's latest verdict is `pass`, and
until the drift gate is not failing for the task. The builder cannot record a
verdict on their own task. This repo dogfoods it: every task closed today was
reviewed by agents that did not build the work, and the verdicts are in
`docs/board.json`.

## A run, step by step

```sh
node bin/runstore.mjs run --workspace /path/to/repo \
  --prompt-file task.txt --config /path/to/repo/ops/caretaker/config.json \
  --task T-001 --cli codex --sandbox podman \
  --secret OPENAI_API_KEY --egress api.openai.com
```

1. **Policy.** Your harness settings (`~/.config/caretaker/harness.json`:
   which AI does which job) are laid under the command line. Isolation is
   never a setting: `--sandbox`, `--net`, `--egress`, `--max-memory`,
   `--max-cpus`, `--accept-build` exist only on the command line, and the
   settings file refuses them by name. An unknown policy field is refused,
   not ignored.
2. **The devcontainer.** `.devcontainer/devcontainer.json` in the workspace
   declares the image or a Dockerfile, resource requirements, hosts and
   compose services. It is resolved against the workspace, never the current
   directory. It is read only if it is a regular file, and a file that does
   not parse is a refusal on every path.
3. **Limits.** `hostRequirements.memory` and `cpus` are read as ceilings. A
   value that is not a size is refused. A value above the operator's ceiling
   (`--max-memory`, `--max-cpus`, default 2gb and 2) is clamped to it and the
   warning names the file and the flag; the host's own total caps it again.
   The file can lower a ceiling and never raise one. A limit the kernel cannot
   enforce here is dropped and recorded, never passed and refused.
4. **The image.** `--image` from you wins. Otherwise the devcontainer's
   `image`, which must be fully qualified (`registry/path[:tag]`), never under
   `localhost/`, never a caretaker build tag, and must already be local: the
   run never pulls an image the workspace named, because a pull is a host
   fetch from whatever registry the name says. Otherwise the devcontainer's
   `build`: a Dockerfile inside the workspace is built only after a human has
   accepted its digest (next section).
5. **The container.** Rootless podman, read-only root, tmpfs for `/tmp` and
   `/run`, every capability dropped, `no-new-privileges`, the repo bind-mounted
   at `/work` with its `.git` mounted over it read-only (a planted hook runs
   on the host next time anyone uses git). Never the container socket.
6. **The network.** `--net none` by default, which means a real agent CLI
   cannot reach its model and the run says so. `--egress host,host` gives the
   run its own internal network with a proxy on it that allows exactly those
   hosts and refuses the rest; the proxy's log is archived with the run,
   attributed by location.
7. **Secrets.** `--secret NAME` reads the value from
   `~/.config/caretaker/secrets.env` and hands it to the run by name, through
   the environment, never on the command line and never into the image. The
   archive's redactor is told every named value, plus the API key the policy
   names however it arrived, plus a net of known key shapes.
8. **The agent.** The CLI preset (`claude`, `codex`, or your own) gets the
   prompt on stdin and runs with its tool flags; the `openai-compatible`
   adapter talks to any OpenAI-style API from the harness and runs the tools
   in the container itself. The run is killed at its ceiling and the
   container removed explicitly.
9. **The result.** The workspace is snapshotted before and after in a shadow
   git dir outside the workspace, so the diff is measured, not reported.
   The archive holds `run.json`, `diff.patch`, the transcript (and a live
   mirror written as it ran), stderr, the egress log, harvested decisions and
   cost, every file redacted line by line. The verdict says how the run ended
   (`completed`, `failed`, `killed`, `unavailable`), never whether the work is
   good.
10. **Afterwards.** The drift gate checks the diff against the specs that
    govern those paths. The run's cost lands on the project's run log with its
    task. `verify.mjs refute` can start a second run that tries to refute the
    first; a refutation records a `qa` fail.

## Accepting a build

The one place the agent's words become host-side execution is `podman build`.
It runs on the host as you, from a Dockerfile the last run's agent could have
written, and podman's `--network none` covers `RUN` only: `ADD <url>` and every
image pull happen on the host regardless. Four independent review rounds got
past every check that read the Dockerfile's text, so the text is not the
control. The control is acceptance:

```
$ node bin/runstore.mjs run ... 
BUILD_NOT_ACCEPTED: .devcontainer/devcontainer.json builds an image from a
Dockerfile inside the workspace, which the last run's agent could have edited,
and this version has not been accepted. Read .devcontainer/Dockerfile (with
`cat -v`), then accept it once with --accept-build 3f9a…  What it would fetch
on the host: ADD https://… fetches a URL.
```

- The digest is sha256 over the Dockerfile's bytes and the devcontainer's
  `build` section (args feed `ARG`, which feeds `FROM`).
- `--accept-build <digest>` records it in
  `${XDG_CONFIG_HOME:-~/.config}/caretaker/accepted-builds.json`, the
  operator's config dir, never the workspace or a state dir the workspace's
  config names. Only a sha256 hex digest is ever written.
- The bytes hashed are the bytes built: podman is handed a private 0600 copy
  outside the workspace, and the workspace file is read once.
- The reader of the Dockerfile still runs, as advice: its findings are printed
  with the refusal so you accept knowing, and recorded in the run's warnings.
- A devcontainer you keep outside the workspace was never the agent's and
  needs no acceptance; `--build-network` lifts the `RUN` isolation for a build
  that must download, and the run says so.
- The residual is a human accepting without reading.

`environment.mjs image` and `check` apply the same rule, and `sandbox.mjs run`
applies the image rules, so there is no entry point that builds or pulls on
the agent's say-so.

## Two vendors behind one seam

The harness seam is `run(workspace, prompt, policy) -> { diff, transcript,
verdict, cost }`, and nothing above it imports a vendor SDK. Two vendors sit
behind it: Claude through its CLI, and ChatGPT/OpenAI through the `codex` CLI
and through the `openai-compatible` API adapter. The second vendor ran for
real on 2026-10-24 (run `r_f90a8a0e`, on a ChatGPT-plan login, on the host),
and what it forced the seam to change is recorded in [vendors.md](vendors.md):
chiefly that OpenAI's input-token count includes the cached part and Claude's
does not, which the cost parser now knows by the key that matched.

Claude on a subscription needs `claude setup-token` once, run from your own
terminal, and the token passed by name. A real Claude run has not yet been
made through the seam, because that token cannot be minted from inside a
Claude Code session; it is the one thing waiting on the operator.

## Specs and the drift gate

A spec is markdown with a small block at the top:

````
```spec
hosts:   api.example.com
governs: src/lib/pricing*, src/app/api/checkout/**
```
````

`hosts` becomes the egress allowlist; `governs` names the paths the document
owns. When a governed path changes and its spec does not, the drift gate
blocks, and `done` is refused for the task until the spec changes or someone
dismisses the drift with a reason. `reconcile.mjs propose` lets a run propose
the spec change; a human accepts it. Whether a document is current is
computed from git, never declared.

## How work is reviewed here

The method that found the real holes today, and which the board now expects:

1. The builder records nothing on their own task.
2. A fresh agent, given the task's acceptance criterion and the code, attacks
   the control and records `reviewer`, `qa` or `security` with what it ran.
3. Each fix carries a test that repeats the reviewer's reproduction, and a
   mutation check: the fix is removed, the named test fails, the fix is
   restored and compared byte for byte.
4. A fresh agent re-reviews. Rounds continue until nothing is found.

E-5 took ten rounds. The first four failed a Dockerfile parser; the next six
found paths around acceptance (the current directory instead of the
workspace, an entry point without the gate, a sibling checkout behind a
symlink, a short image name, podman's `localhost/` namespace, a FIFO at the
file's path). All of that is in the board's verdict notes, with file and line.

## What is built, what is proven, what is not

| | state |
|---|---|
| Board, gates, dashboard, run log, loop, install | built, installed here, dogfooded |
| Harness seam with two vendors | built; codex proven on a real run; a real Claude run waits on the operator's token |
| Sandbox: limits, read-only root, no socket, `.git` read-only | built; attacked live in CI on every push |
| Egress allowlist proxy, attributed per run | built; attacked live in CI |
| Secrets by name, redaction | built; attacked by review; the container-crossing test skips where podman lacks `--preserve-fd` |
| Build acceptance, never-pull, fully-qualified images | built; ten security rounds, the last one passed |
| Drift gate, reconciliation, freshness | built, reviewed |
| Web client and terminal view | built over the read model; W-5, W-7, W-15, W-17 still have an open qa point |
| Warp's factory on Caretaker (F-1 to F-8) | vendored and patched; proven with a fake model; the first real run on GitHub (F-6) waits on the token |
| Graduate: CI and docs from what happened | G-1 built; G-2 (emit infrastructure) not |

The board itself is the live version of this table: `node
ops/caretaker/board.mjs status`, or `docs/board.html`.

## What needs the operator

- `claude setup-token`, from a plain terminal, and the token as the repo
  secret `CLAUDE_CODE_OAUTH_TOKEN` for the GitHub workflows, or in
  `~/.config/caretaker/secrets.env` for local runs.
- `--accept-build <digest>` once per Dockerfile version, having read it.
- Pulling any image a workspace devcontainer names, having read the name.
- Security verdicts on new isolation, auth or money work, by someone who did
  not build it.
