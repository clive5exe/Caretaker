---
title: Caretaker Web v1 — architecture and technical spec
status: accepted
updated: 2026-09-29
---

```spec
hosts:
governs: bin/serve.mjs, bin/readmodel.mjs, bin/lifecycle.mjs, web/src/api/**
```

# Caretaker Web v1 — architecture and technical spec

Accepted with ADR-0002 on 2026-09-29. **Nothing here is implemented yet.** It
covers:

1. the local server
2. the API boundary
3. live streaming
4. the optional React client
5. keeping gate logic out of the frontend
6. backward compatibility
7. the pages that sit on top (PRODUCT.md has those)

It also covers the changes to core that have to happen first.

**What the governed paths mean.** The `governs:` globs above name files that do
not exist yet. `drift.mjs map` reports them as orphaned until they do, which
does not block and is true. They make the drift gate hold this spec to the code
from the first commit that creates them.

**Line references.** Line references are to the tree at commit `d502820`. They
are pointers for a reviewer to check, and they will move as the code does.

---

## 0. Findings this design rests on

Each finding was checked against the source, not the docs. Several of them
change the design, and it would be wrong without them.

- **The board is a CLI, not a library.**
  - `bin/board.mjs:24-30` reads its config and resolves paths when the module
    loads.
  - The CLI runs at top level with no entry guard (`:315-435`).
  - The rule that decides whether a task may close is inline in `done`
    (`:396-421`), and a refusal ends in `process.exit(1)`.
  - Nothing is exported.
- **Four different places decide which gates apply, and they disagree.**
  - `done` hardcodes reviewer / qa / security, gated by a keyword regex over
    the title and note (`board.mjs:399-411`).
  - The markdown renderer lists `["reviewer","qa","security"]` (`:129`).
  - The verdict commands accept those three names (`:349`).
  - The dashboard uses `cfg.gates` (`dashboard.mjs:56`, `:208`), which `done`
    ignores.
- **Metrics are computed inside a script that has side effects.**
  - `dashboard.mjs` computes held, ETA, quality, gate stats, token composition
    and rework spend at module top level.
  - It then appends to `history.jsonl` (`:253-271`) and writes the HTML
    (`:1114-1116`).
  - A second consumer that recomputes these would be a second copy.
  - Commit 3e341bc is the precedent: `board.mjs` and the dashboard disagreed
    about the current phase.
- **Runs have no identity in the run log.**
  - `bin/run.mjs` rows carry `t, kind, name, state, task, tokens, in, cached,
    write, out, turns, model, note, src`, with no run id and no parent.
- **The harness writes logs but does not keep its result.**
  - `harness.run()` writes `transcript.log`, `stderr.log` and a `shadow/` git
    directory under its log dir, which defaults to `$TMPDIR/caretaker-runs/<id>`
    (`harness.mjs:842-865`, `:905-914`).
  - It *returns* diff, verdict and cost, and persists none of them.
  - The transcript is raw CLI stdout and is not redacted.
- **Only the drift gate writes the event log.**
  - `drift.mjs` writes `events-YYYY-MM-DD.jsonl` (`:423-460`), unredacted.
  - B-6 (every run appends events) and B-7 (the board as a projection of the
    log) are still `todo`.
  - The events `stage` field (`plan|build|review|verify|merge`) is a different
    vocabulary from the lifecycle in PRODUCT.md.
- **Egress is not attributable to a run.**
  - The harness never starts a proxy. `policy.net` is only a network name, and
    it defaults to `none`.
  - `netns.proxyRunArgs` (`netns.mjs:119-172`) starts one detached
    `fm-egress-proxy` per network, shared by every run on it. Its only mount
    is a read-only `bin/`, so a `--log` path given to it resolves inside a
    `--rm` container.
  - Egress records are `{t, kind, host, port?, reason?|why?}`
    (`egress.mjs:83, 91, 106, 116, 198`), with no client address and no run.
- **Recorded positions this project runs into:**
  - The U-2 board note: "TUI rather than a web UI on purpose: no daemon, no
    auth, no port".
  - ADR-0001 rejects "human approval gates as the verification story".
  - CLAUDE.md orders the UI last. U-1 is blocked on H-1, and H-1's latest qa
    verdict is `fail`.
- **Board data.**
  - `node -e` over `docs/board.json` shows two things. Every task that carries
    `spec:` points at a shared doc under `docs/`, and none of those docs
    contains a ```` ```spec ```` block. Some `todo` tasks carry a qa pass, so
    status lags the verdicts.

---

## Architecture

```
                         ┌──────────────── core (authoritative, files) ────────────────┐
web/ (React+Vite, opt.)  │ board.mjs      tasks, transitions, verdicts, missingGates   │
   │  HTTP + SSE         │ dashboard.mjs  metrics (exported) + static page             │
   ▼                     │ lifecycle.mjs  stageOf, commandsFor        (new, pure)      │
bin/serve.mjs ──▶ bin/readmodel.mjs ──▶ │ run.mjs + runstore.mjs  run log + archive (C-4)│
   (routing,             │ drift.mjs      ownership, drift verdicts, event log         │
    auth, files)         │ spec.mjs, secrets.mjs                                       │
                         └──────────────────────────────────────────────────────────────┘
docs/board.html ◀── dashboard.mjs (unchanged output, zero dependencies)
```

- **`serve.mjs` holds no rules.** It authenticates, routes, streams and serves
  files.
- **`readmodel.mjs` composes core reads into API shapes.** It computes nothing
  that core does not already compute.
- **The client renders what it receives.**
- **A rule in `web/`, `serve.mjs` or `readmodel.mjs` is a defect.**
  `lifecycle.mjs` is core. It is governed here because this project introduces
  it.

---

## Prerequisites in core

These are ordinary core changes, each with its own tests and gates. They remove
duplication *before* a second consumer exists. None of them adds web code.

### C-1 — make `board.mjs` importable, without changing it

1. **Config at call time.** Move config resolution into `loadConfig(path)`,
   and call it from the CLI. This keeps `FACTORY_CONFIG` and the `config.json`
   beside the file as defaults.
2. **Export the domain.**
   - Reads: `load`, `find`, `progress`.
   - Mutations: `transition(board, id, cmd, text)` and
     `recordVerdict(board, id, gate, verdict, note)`.
   - **`missingGates(task, cfg)`:** the body of `done`'s check, moved
     verbatim. It returns the missing list and the docs-only flag.
   - The mutations return `{ ok, task }` or `{ ok:false, refused:{ missing,
     docsOnly } }`. They never exit.
   - `export const API_VERSION = 1`.
3. **Lock the whole read-modify-write.** Use an `O_EXCL` lockfile beside
   `board.json`, with a pid and timestamp inside for stale-lock detection.
   Write to a temp file, then rename. Today two concurrent CLI invocations can
   lose an update. A server makes that likelier, and the fix belongs in core
   so both writers get it.
4. **Put the CLI behind `isEntry`,** the same guard `harness.mjs:1006`,
   `drift.mjs` and `egress.mjs` use.

**Why not a separate `board-core.mjs`?** `install.sh:38-43` copies exactly
four files into a target repo and refuses to overwrite an existing install. A
new import in `board.mjs` would break every installed copy on upgrade. Keeping
the exports in the same file leaves the install set unchanged.

**Behaviour change: none.** A golden test runs the old and new CLI over a
fixture board, with every command and every refusal. It asserts identical
stdout, stderr, exit code and resulting `board.json`. It normalises only two
things, and names them: `today()` and absolute paths.

The gate-definition disagreement and the Encore leak are **not** fixed here.
Fixing them is a rule change and gets its own task (see Findings).

### C-2 — export the dashboard metrics

- `dashboard.mjs` exports pure functions: `estHours`, `held`, `eta`,
  `quality`, `gateStats`, `tokenStats`, `reworkSpend`, `cycle`, `byOwner`, and
  a `metrics(board, runs, gitFacts, cfg, now)` that composes them.
- Rendering, the `history.jsonl` append and the file write move behind
  `isEntry`.
- **Test.** Generate the page with the old and new code back to back on a
  fixture repo, and diff the two outputs. Normalise the `built` stamp and git's
  relative dates (`%ar`, `dashboard.mjs:120`), since relative dates do not
  freeze.
- Both `docs/board.html` and the API then read one implementation, so the two
  surfaces cannot headline different numbers.

### C-3 — `bin/lifecycle.mjs` (new, pure, core)

- `stageOf(task, ctx) -> { stage, reason, rework? }`.
- `commandsFor(task, ctx) -> [{ cmd, args }]`: what core would accept now.
- `ctx` carries the config, the task's runs and the relevant events.
- **Its only notion of "which gates apply" is `missingGates`, imported from
  `board.mjs`.** It must not become a fifth definition.

The rules are in §Lifecycle below.

### C-4 — run identity and a run archive (layer 2, security gate)

**Built** in `bin/runstore.mjs`, checked by `bin/runstore.test.mjs`. Only runs
started through it are archived — `node bin/runstore.mjs run …`, or
`runArchived()` from code. `loop.sh` still calls the agent CLI directly and
leaves no archive.

- **`bin/run.mjs` gains** `--run <id>`, `--parent <id>`, `--adapter` and
  `--cli`, all optional and additive. Unknown flags still exit 2 on old
  installs, deliberately. Only the new runner that ships alongside these flags
  emits them.
- **`bin/runstore.mjs` (new)** archives a *finished* harness result to
  `<stateDir>/runs/<runId>/`:

  | file | content |
  |---|---|
  | `run.json` | verdict, cost, diff summary (without the patch), task, parent, adapter, cli, model; the policy with `env` values removed |
  | `diff.patch` | `diff.patch` from the harness result; `truncated` is recorded in `run.json` |
  | `transcript.log`, `stderr.log` | **redacted** with `secrets.makeRedactor` built from the run's own secret values |

  `shadow/` is never archived. It is a copy of the workspace.
- **A redacted live mirror.** While a run is in flight, the runner appends
  redacted lines to `transcript.live.log`. The server tails only this file,
  never the harness's raw file.
- **`stateDir` inside the workspace is refused** (`STATE_IN_WORKSPACE`), for
  the reason below. `stateDirFor()` is the single definition, and
  `readmodel.mjs` imports it.
- **`stateDir` defaults to
  `${XDG_STATE_HOME:-$HOME/.local/state}/caretaker/<repo-slug>`,** and is
  overridable in config. **The reason is the mount, not the harness refusal.**
  - The workspace is bind-mounted into the next agent's container at `/work`
    (`sandbox.mjs:172`), gitignored files included. Anything archived under
    the repo, transcripts included, is readable by the next agent.
  - The harness's refusal of an in-workspace log dir (`harness.mjs:842-865`) is
    a different concern: diff contamination *during* a run. It can be
    overridden with `allowLogDirInWorkspace`. It is not the reason here.

### C-5 — egress attribution (layer 1, security gate, touches `specs/sandbox.md`)

**Built, opt-in:** one internal network and one proxy per run, chosen in
`docs/decisions/0003-egress-attributed-by-location.md` over a shared proxy
logging client addresses. Checked by `bin/egress-attribution.test.mjs`, whose
live half runs where podman and the images are present (CI).

- `netns.withRunEgress()` creates `fm-int-<runId>` (internal, DNS off), starts
  `fm-egress-<runId>` with the run's archive dir bind-mounted writable at
  `/egress-log`, hands the harness `net`, a static `--add-host proxy:<ip>` and
  the proxy variables, and tears both down whatever the run does. A failed
  teardown is recorded in `run.json`, not thrown over the result.
- The run is identified by where its log lives. The proxy's allow/deny logic
  is unchanged.
- The archive redacts `egress.jsonl` with the run's secrets: a key smuggled
  out as a subdomain is still a refused CONNECT with the key in `host`.
- Egress attribution with `sandbox: none` is refused. An agent on the host is
  on no proxied network.
- Turned on per run with `runstore.mjs run --egress host,host`. It is not the
  default: the extra podman create and destroy per run has not yet been
  measured under the sustained churn suspected in H-1's note.

A run without it shows "not recorded: no proxy was attached to this run" for
egress, which is the true state under the default `net: none`.

The proxy used to die on its first event when `--log` could not be written
(the append threw inside the CONNECT handler). It now reports the log failure
once on stderr and keeps answering. `egress-attribution.test.mjs` fails
against the old code by name.

### C-6 — new append-only facts, as core commands

These are `board.mjs` commands and exports first. The server exposes them only
after they exist and are tested in core.

- **Every new record carries `by` and `at`.**
  - `by` is the config `operator`, falling back to the OS user.
  - `at` is a full ISO timestamp. Existing verdicts carry a date only
    (`board.mjs:373`), which cannot order two events on the same day.

| command | records (optional task fields) |
|---|---|
| `ask <id> "question"` | `questions[] {id, q, by, at}` |
| `answer <id> <qid> "text"` | `answer {text, by, at}` on that question |
| `triage <id> accept\|reject "why"` | `triage[] {decision, why, by, at}` |
| `spec-approve <id>` / `spec-reject <id> "why"` | `specReview[] {path, blob, decision, why, by, at}`, keyed on the spec's git blob sha, so editing the spec reopens approval |
| `pr <id> <url>` | `pr {url, by, at}` |
| `drop <id> "why"` | `status: "dropped"` plus the reason. `dropped` already exists as a status (`board.mjs:49`), but no command sets it. |

- All fields are optional and additive, so existing readers ignore them.
- `ops/caretaker/prompt.txt` currently says to write a needed decision "into the
  task note". It changes to `ask`, so the question becomes a fact the Inbox can
  see.

---

## 1. `caretaker serve`

```
node bin/serve.mjs path/to/ops/caretaker/config.json [--port 7420]
```

- **Built-ins only:** `node:http`, `node:fs`, `node:crypto`. That keeps the
  repo's "node and git, nothing else" property. There is no `caretaker` binary
  today, and adding one is out of scope.
- **It runs in the foreground,** with no daemon and no pidfile. Ctrl-C stops it.
- **It imports the target repo's own installed `ops/caretaker/board.mjs`,** so
  the server always applies exactly the rules that repo's CLI applies. If that
  file does not export `API_VERSION`, the server refuses to start and prints
  how to upgrade.
- `drift.mjs`, `spec.mjs`, `secrets.mjs`, `lifecycle.mjs` and `readmodel.mjs`
  are imported from the Caretaker checkout `serve.mjs` runs from. None of them is
  installed into target repos today.
- **Install gains an explicit upgrade mode** that replaces the tool files and
  never touches `board.json`, `config.json` or `prompt.txt`. Those are the
  files the existing overwrite refusal protects.
- **It serves `web/dist` if it has been built.** Otherwise it serves a minimal
  page that links to `docs/board.html` and lists the API.

### Security (auth and isolation, so security + reviewer + qa)

**Binding.**
- It binds to `127.0.0.1` only.
- A non-loopback bind is refused in v1, with a pointer to `ssh -L`. Plain HTTP
  on a LAN would carry the token in cleartext.

**Token.**
- A 256-bit random token is generated in-process at startup.
- It is never read from argv or the environment, where it would show in `ps`.
- It is printed once, as a bootstrap URL.

**Bootstrap.**
- `GET /auth?t=<token>` compares the token with a timing-safe comparison.
- It sets a cookie `caretaker_<port>=<token>` with `HttpOnly; SameSite=Strict;
  Path=/`.
- It then **redirects to `/`**, so the token leaves the address bar and the
  history.
- The cookie name carries the port because cookies are not port-scoped, so
  every service on `127.0.0.1` receives it.

**Every `/api` request and the SSE stream:**
- Require the cookie.
- Require `Host` to equal `127.0.0.1:<port>` or `localhost:<port>` exactly.
  This defeats DNS rebinding.

**Every POST additionally:**
- Requires an exact `Origin` match.
- Requires `Content-Type: application/json`.
- Requires the header `X-Caretaker: 1`.

**No CORS headers are sent, ever.**

**XSS is the realistic attack.** Transcripts, notes, hostnames in egress logs
and diff content are all text an agent controls. One script injection could
POST a board mutation.
- Every response carries
  `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'`.
- The client renders text nodes only. The boundary test (§4) fails the build
  on `dangerouslySetInnerHTML` or `innerHTML`.
- `docs/board.html` is served with `Content-Security-Policy: sandbox`. It is
  generated outside the server and carries agent-written text, so it gets no
  script execution even if its escaping is ever wrong.

**Files.**
- A run id must match `^r_[0-9a-f]{8}$`, the shape from `harness.mjs:115`.
- Filenames come from a fixed allowlist: `run.json`, `diff.patch`,
  `transcript.log`, `transcript.live.log`, `stderr.log`, `egress.jsonl`.
- The resolved path must pass a `realpath` prefix check against `stateDir`.
- `shadow/` is never served.

**Secrets.**
- The server serves only the redacted archive and mirror from C-4.
- It applies `secrets.KEY_SHAPES` redaction as a best-effort second pass, on
  whole lines only, because a key can be split across read chunks.
- Byte offsets used for resuming stay offsets into the file on disk.

**Identity.** v1 is single-operator. `by` on a web mutation is the configured
operator, recorded with `via: "web"` so the log can tell browser actions from
CLI actions.

---

## 2. API boundary — `/api/v1`, JSON

Reads go through `bin/readmodel.mjs`. Route handlers never open data files
themselves.

**Every response carries `sources`.** For example:
`{ board: "present", runs: "absent", events: "present", archive: "absent", agents: "absent" }`.
The client uses this to render "not recorded". A missing source is never a
zero.

### Reads

| route | returns | backed by |
|---|---|---|
| `GET /snapshot` | headline metrics, active phase, executing runs, inbox count | `dashboard.metrics` (C-2), readmodel |
| `GET /work` | tasks with `lifecycle`, `reason`, `rework`, `missingGates`, `commands`, run count, tokens | `board.load`, `lifecycle.stageOf`/`commandsFor`, `board.missingGates` |
| `GET /work/:id` | one task in full: gate history, notes, questions, spec review, pr, runs | same |
| `GET /inbox` | derived items: `{ kind, task, since, action }` | readmodel over the facts in §Inbox |
| `GET /runs?task=&state=&agent=&model=` | runs, folded by id | `runs.jsonl` plus `<stateDir>/runs/*/run.json` |
| `GET /runs/:id` | one run: identity, parent, children, verdict, cost, diff summary, drift events for it | same, plus the event log |
| `GET /runs/:id/transcript?from=<byte>`, `/stderr?from=`, `/diff`, `/egress` | raw text or JSONL, byte-ranged | the run archive (C-4, C-5) |
| `GET /agents` | roles, models, runs and tokens aggregate, current work | `agentsDir` frontmatter (as `dashboard.mjs` `agents()` reads it), runs |
| `GET /specs` | specs, `governs`, parse errors, and `freshness` (stale, lying, undated; null outside git) | `drift.loadSpecs`, `freshness.freshness` |
| `GET /specs/ownership` | the ownership map, unowned, orphaned | `drift.buildOwnership`, `findOrphaned`, `treeFromGit` |
| `GET /specs/drift` | recent drift and gate events, dismissals | the event log, `kind in (drift, gate)` |
| `GET /settings` | read-only config, `stateDir`, sources, binding | config, server |
| `GET /metrics?days=7\|14\|30` | the Metrics page's figures over the range, and `kpis`: delivery from git, AI figures, open work in tokens, the anti-KPIs; each null with a reason when not recorded | `dashboard.mjs` functions, `kpis.mjs` (B-2, B-4) |

**Folding runs.**
- `start` and `end` rows with the same `run` id become one run.
- A start with no end, older than `cfg.staleRunHours`, is reported as
  `noEndRecorded: true`. It is not reported as running.
- Rows without `run` (everything logged before C-4) are returned in a separate
  `legacy` list. They are never paired by guesswork.
- Rows with `src: "reconstructed"` keep that label.

### Mutations

```
POST /work/:id/commands   { "cmd": "start", "args": { ... } }
```

| cmd | core function |
|---|---|
| `start`, `block`, `todo`, `note`, `done` | `board.transition` |
| `ask`, `answer`, `triage`, `spec-approve`, `spec-reject`, `pr`, `drop` | the C-6 exports |

- A command not in the list returns `400`.
- A command core refuses returns `409` with core's structured refusal, for
  example `{ refused: { missing: ["qa", "security (money/auth/tenant)"] } }`.
  The UI shows it verbatim.
- On success the server returns the updated task, and emits
  `invalidate {resource:"board"}` on the stream.

**Deliberately absent in v1:**
- **`reviewer` / `qa` / `security` verdicts.** A one-click pass in a browser is
  the rubber stamp ADR-0001 rejects. Verdicts come from gate runs and the CLI.
- **Drift dismissal.** A dismissal is an input to re-running
  `drift.mjs check` (`drift.mjs:595-620`), and the change set it applied to is
  not recorded anywhere a server could replay it. The Specs page shows the
  exact command instead.

---

## 3. Live updates — Server-Sent Events

```
GET /api/v1/stream              board, run log, event log, archive index
GET /api/v1/runs/:id/stream     one run's redacted live transcript
```

**Watching.**
- The server uses `fs.watch` with a 2-second `stat` poll as a fallback.
  `fs.watch` is unreliable across filesystems, and a missed event must never
  mean a stale page.
- It watches `board.json`, `runs.jsonl`, the events directory and
  `<stateDir>/runs/`.

**Tailing.**
- Append-only files are tailed from a byte offset.
- A partial final line is held until its newline arrives. `docs/events.md`
  already says a half-written last line is the normal state of an appended
  file.
- An unparseable complete line is skipped and counted, never thrown.

**Events.**
- `event: log`, carrying one redacted record.
- `event: invalidate`, with data `{resource: "board"}` when `board.json`
  changes. It is rewritten rather than appended, so clients refetch.
- A comment heartbeat every 15 seconds.

**Resuming.** Event ids are `<file>:<byteOffset>`, so a reconnect with
`Last-Event-ID` resumes with no gap and no duplicate.

**Why SSE and not WebSockets:**
- Data flows one way.
- It is plain HTTP, with the same auth and the same CSP.
- It needs no dependency on either side.
- `EventSource` reconnects on its own.
- Mutations are ordinary POSTs.

**Transcripts are streamed as raw text.** Parsing them turn by turn in the UI
would put one vendor's output shape above the harness seam, which CLAUDE.md
forbids. Structured tool events can arrive later, as normalised events emitted
by the harness.

---

## 4. The React/Vite client — `web/`, optional

**Layout.**
- `web/package.json` holds the only npm dependencies in the repo: React, Vite,
  TypeScript and react-router.
- Core never imports from `web/`, and no core test needs `npm install`.
- `npm --prefix web ci && npm --prefix web run build` produces `web/dist/`,
  which `serve.mjs` serves. `web/dist/` is gitignored.

**Design.** The client takes its shape from Warp Factories' web app: a light
page, a white sidebar, breadcrumbs, bordered cards and colored icon tiles.
PRODUCT.md §Layout describes the layout. The tokens are below. `docs/board.html`
keeps its own dark look, because it is a different surface. The two surfaces
share numbers (C-2), not styles.

- **No external requests.** The page keeps the same "nothing leaves the
  machine" posture as the sandbox.
  - Inter is bundled from `@fontsource-variable/inter`, and Anton from
    `@fontsource/anton`. Both are `web/` dependencies, served from
    `web/dist/`, and only their Latin files are used.
  - Monospace uses the system stack (`ui-monospace, SFMono-Regular, Menlo,
    Consolas, monospace`).
  - The page contains no CDN link, web font URL or analytics call.
- **Name and logo.**
  - The UI says **Caretaker**. Paths and commands keep saying `caretaker`
    wherever the code does, as the README explains.
  - The wordmark in the sidebar and on the Getting started page is text:
    CARETAKER in Anton, a heavy condensed face close to the repo logo's
    letterforms, set in `fg` on the white page. It is text rather than an image
    because the distressed repo logo breaks up at sidebar size, even inverted.
  - `docs/assets/caretaker-logo.png`, which is white on black, stays the logo
    for dark surfaces such as the README.
- **Color.** Color has two jobs, and they never swap:
  - **Category** says *which one*: which agent, which Inbox kind, which chart
    series.
  - **Status** says *how it went*: pass, fail, or needs attention.

  A tag that says where a number comes from is neither, and stays grey. Using
  status colors for provenance tags is what made an earlier draft read as "all
  over the place".

| token | value | use |
|---|---|---|
| `bg` / `canvas` / `hover` | `#ffffff` / `#fafafa` / `#f5f5f5` | page, inset panels, hovered and selected rows |
| `line` / `line2` | `#e5e5e5` / `#d4d4d4` | card borders, dashed "not recorded" boxes |
| `fg` / `dim` / `faint` | `#0a0a0a` / `#525252` / `#737373` | text, secondary text, labels and axes |
| `black` | `#0a0a0a` | the one primary button per page ("Go to" / "Actions") |
| `accent` | `#7c3aed`; badges `#6d28d9` on `#f3e8ff` | the brand accent: unread dots, the Inbox count, `new` and `proposed` badges |
| category: violet | `#9333ea` on `#f3e8ff`, series `#8b5cf6` | the verifier, the first chart series |
| category: blue | `#2563eb` on `#dbeafe` | the builder, questions, the second series, a running run |
| category: orange | `#ea580c` on `#ffedd5` | the reconciler, spec reviews, the third series |
| category: pink | `#db2777` on `#fce7f3` | the reviewer, the fourth series |
| status: pass | `#15803d` on `#dcfce7`; rail `#16a34a` | a passing verdict, a PR ready for review, a filled gate-rail segment |
| status: fail | `#b91c1c` on `#fee2e2`; rail `#dc2626` | a failing verdict, a gate failure in the Inbox, a red gate-rail segment |
| status: attention | `#b45309` on `#fef3c7`; dot `#d97706` | no end recorded, stale data, a warn event |

- **Components.**
  - Cards have a 1px `line` border and an 8px radius.
  - A status chip is a pill with a dot in its own color. The dot of a running
    run pulses, except under `prefers-reduced-motion`.
  - An icon tile is the category color at 100 behind a 600-weight icon, as
    Factories' agent list does.
  - Provenance tags (`board.html today`, `planned`, `proposed`) are grey
    uppercase labels, except `proposed`, which uses the accent.
  - Line charts draw 2.5px lines with a 16% area fill, with series in the
    order violet, blue, orange, pink. The gate rail keeps its meaning: filled
    green on pass, red on fail, hollow if not run.
- **The reference.** The owner reviewed this design as a clickable mockup of
  every page and the TUI, made from these two specs. It is not committed, and
  where it and this section differ, this section wins.

**Structure.**
- `web/src/api/`: one typed client over the routes in §2, plus one
  `EventSource` subscription. Governed by this spec.
- `web/src/pages/`: the pages in PRODUCT.md. Governed by PRODUCT.md.
- `web/src/theme.css`: the tokens above, as CSS custom properties. Colors appear
  nowhere else in `web/src`.
- Shared state is one small store keyed by resource, refetched on `invalidate`.

**`bin/web-boundary.test.mjs`** is a plain node script like the other tests.
It fails if `web/src`:
- imports anything from `bin/`
- imports any vendor SDK (the same list `drift.test.mjs` bans)
- contains `innerHTML` or `dangerouslySetInnerHTML`
- names a gate or a lifecycle stage outside the single display-label module
  `web/src/api/labels.ts`
- contains an `http://` or `https://` URL, which would be an external request
- contains a color literal outside `web/src/theme.css`

---

## 5. No gate or business logic in the frontend

The browser displays; core decides.

- **The UI never computes these; it only displays them:** `lifecycle`,
  `reason`, `missingGates` and every derived metric. They come from the server.
- **Every button comes from `commands`,** the list `lifecycle.commandsFor`
  returns. If core would refuse a command, core does not offer it.
- **Every click round-trips to core, which checks again.** "Close" only ever
  calls `done`, and `done` re-runs `missingGates`. The board can change between
  render and click, so a stale page can offer a command. That is harmless,
  because the refusal comes back verbatim.

**Proof, by the method in RULES.md:**
1. Mutate a rule in `lifecycle.mjs` or in `missingGates`.
2. Show the API output change *by name*.
3. Show `web/src` untouched and the boundary test still green.
4. Restore, and verify the restore with a checksum.

A frontend that passes this has no copy of the rule to go stale.

---

## 6. Backward compatibility

| surface | guarantee | proven by |
|---|---|---|
| `board.json` | additive optional fields only; the shape of `gate.<k>` is unchanged | old `board.mjs` reads a board carrying C-6 fields |
| `board.mjs` CLI | identical commands, output, exit codes and refusals | C-1 golden test |
| `docs/board.html` | still generated by `dashboard.mjs`, zero dependencies, opens from disk, same output | C-2 back-to-back diff |
| headline numbers | the static page and the API call the same functions | by construction (C-2), asserted in the API test |
| `runs.jsonl` | additive fields; rows without `run` stay valid, shown as legacy | readmodel test over a mixed fixture |
| event log | read-only to the server; format unchanged | — |
| install | same four files; new explicit upgrade mode; `serve` and `web/` opt-in | install test on a throwaway repo, fresh and upgrade |
| storage | no database; files authoritative; the server keeps only a cache it can rebuild | restart the server with the cache deleted, get identical responses |

The web board groups by **lifecycle stage**, and `board.html` groups by
**status** (`config.columns`). The web board offers the status view too, so the
same question gets the same columns on both surfaces.

---

## Lifecycle — `lifecycle.stageOf`

The first match wins.
- `G = missingGates(task, cfg)`, imported from `board.mjs`.
- "Required gates" means the gates `missingGates` requires for this task.
- Runs are the task's runs from the run log and archive.

| # | stage | rule | reason text names |
|---|---|---|---|
| 1 | *dropped* | `status === "dropped"` | the drop reason |
| 2 | done | `status === "done"`, only reachable through core `done` | close date |
| 3 | human | `G` is empty | "all required gates passed", plus the PR if recorded |
| 4 | build (rework *n*) | the latest verdict on some required gate is `fail`, and no run for the task started after it | the gate and attempt count |
| 5 | review | at least one required verdict is `pass`, none is `fail`, and `G` is non-empty | the gates outstanding |
| 6 | verify | a run for the task has ended with a measured diff of one or more files, and no verdict is recorded | the run id |
| 7 | build | `status === "doing"`, or an open run younger than `cfg.staleRunHours` | status or run id |
| 8 | spec | approval is required and the latest `specReview` for (path, current blob) is not `approve` | spec path and blob |
| 9 | triage | a triage record exists whose latest decision is not `accept`, or `ac`, `owner` or `est` is missing | what is missing |
| 10 | intake | no triage record and no `ac` | — |
| 11 | *ready* | otherwise; shown at the head of the build column as queued | — |

**Blocked.** A blocked task (`status === "blocked"`) is badged with
`blockedReason` at whatever stage these rules give it.

**When a spec approval is required.** Approval is required when the task's
`spec` resolves to a file containing a ```` ```spec ```` block, meaning a
governing spec. Shared docs such as `docs/architecture.md` are context, not
specs, and do not trigger approval. On today's board no task triggers it: see
§0, Board data.

**Legacy tasks.** A task that already has `ac`, `owner` and `est` counts as
triaged. Existing boards do not flood intake and triage on upgrade.

**Rework.** After the first attempt, the retry loop is build → verify → review.
That is what agents are for. It reaches a human only through the Inbox
threshold.

**Known instability, documented rather than hidden.** `needsSecurity` also
scans the task's *note* (`board.mjs:400-401`). Appending a note that happens to
mention "auth" or "domain" adds a required gate, and can move a task from
human back to review. The fix belongs to the gate-definitions finding, not to
this spec.

**Relation to the `stage` field in events.md.**

| event `stage` | lifecycle stage |
|---|---|
| `plan` | spec |
| `build` | build |
| `verify` | verify |
| `review` | review |
| `merge` | human |

To avoid a name collision, the API field is `lifecycle`, not `stage`.

---

## Inbox — derived by `readmodel`

| kind | present while | clears when | action |
|---|---|---|---|
| `question` | a `questions[]` entry has no `answer` | answered | `answer` |
| `spec-approval` | rule 8 above holds | approved, or rejected with a reason | `spec-approve` / `spec-reject` |
| `gate-failure` | the latest `security` verdict is `fail`; **or** the latest drift `gate` event for the task has `verdict:"fail"` and no later pass; **or** some required gate has at least `cfg.inbox.reworkThreshold` fails (default 2) | a later pass, or the task is dropped | open the work item; drift shows the CLI command |
| `pr-review` | `lifecycle === "human"` and a `pr` is recorded | `done` (nothing records a merge yet) | review outside Caretaker, then `done` |

- **A single qa fail is not an Inbox item.** It sends the task back to build.
- **A refutation (H-3, `bin/verify.mjs`) is a qa fail like any other.** Its
  gate event carries `source: "refute"` and is excluded from the drift-gate
  rule, so it never gets a drift-dismissal command and never masks a drift
  failure. Repeated refutations reach the Inbox through the rework threshold.
- **Dropped tasks never appear.**
- Items are ordered by `since`: the `at` of the fact that created them, or the
  date for legacy verdicts.

---

## Run detail — what exists today

| field | source | today | after |
|---|---|---|---|
| run identity | harness `runId` | archived for runs started through `runstore.mjs` | C-4 (built) |
| task / work item | `runs.jsonl` `task` | yes | — |
| agent, model, harness | `name`, `model`; verdict `adapter`, `cli` | yes, for archived runs | C-4 (built) |
| status | verdict `state` and `reason`; start/end rows | yes, for archived runs | C-4 (built) |
| timestamps | row `t`; verdict `startedAt`, `endedAt`, `durationMs`, `timeoutMs` | yes, for archived runs | C-4 (built) |
| token usage | `in`, `cached`, `write`, `out`, `turns`, `tokens` (`bin/run.mjs`); harness `cost.tokens`, where null means unknown | yes, from `bin/run.mjs` | — |
| measured diff | harness `diff`: `files`, `insertions`, `deletions`, `patch`, `truncated`, `ignoredPathsNotMeasured` | yes, for archived runs | C-4 (built) |
| transcript | redacted archive or mirror | yes, for archived runs | C-4 (built) |
| gate results | drift gate events carrying `run`; task verdicts shown as task-level with their dates | drift yes, when `--run` is passed | — |
| egress allow/deny | `<run>/egress.jsonl` | for runs started with `--egress` | C-5 (built, opt-in) |
| artifacts | patch, transcript, stderr, drift report, PR | — | C-4, C-6 |
| parent/child | `parent` | yes, for archived runs | C-4 (built) |

**Gate verdicts are task-level.** A board verdict belongs to the *task*, and
its date carries no time. The page never presents a verdict as the result of a
particular run unless the record names that run. Inferring the run from the
date would be a guess.

---

## Ordering: this is layer 5, and CLAUDE.md puts it last

This spec does not override that. H-1 has a failing qa verdict, and U-1 is
blocked with the reason "building the cockpit before the engine runs is the
standard way this dies". The honest split:

**Can proceed without a working run (layer-4 board work and pages over board
data):**
- C-1, C-2, C-3, C-6
- W-1 to W-5
- the Dashboard, Activity, Inbox, Specs, Metrics, Settings and Getting started
  pages, and the command menu

**Blocked on H-1 and B-6, for U-1's reason:**
- C-4 and C-5, which are layer 1–2 work and need security
- the Runs, Run detail and Agents-activity pages

Until those land, the blocked pages render *not recorded*. Whether any W-task
starts before H-1 passes is the reviewer's call, and it is recorded in
ADR-0002.

## Proposed tasks

These are on the board as the phase "Layer 5 — Web client". None is closed:
every gate verdict is left for a reviewer.

| id | title | deps | gates |
|---|---|---|---|
| W-0 | ADR-0002 accepted or rejected | — | reviewer |
| C-1 | board.mjs importable; golden CLI test; lock | — | reviewer, qa |
| C-2 | dashboard metrics exported; identical page | — | reviewer, qa |
| C-3 | lifecycle.mjs: stageOf, commandsFor | C-1 | reviewer, qa |
| C-4 | run id, parent, archive, redacted transcripts | H-1, H-0 | reviewer, qa, security |
| C-5 | egress attributable to a run (ADR first) | E-2, C-4 | reviewer, qa, security |
| C-6 | ask/answer, triage, spec review, pr, drop | C-1 | reviewer, qa |
| W-1 | serve: binding, token, host/origin checks, CSP, files | C-1 | reviewer, qa, security |
| W-2 | read API over readmodel, `sources` everywhere | W-1, C-2, C-3 | reviewer, qa |
| W-3 | SSE stream with offset resume | W-1 | reviewer, qa |
| W-4 | command endpoint over core only | W-1, C-6 | reviewer, qa, security |
| W-5 | client shell, api module, boundary test | W-2 | reviewer, qa |
| W-6 | pages over the board: Dashboard, Work item, Inbox, Specs, Settings | W-5 | reviewer, qa |
| W-7 | pages over runs: Runs, Run detail, Agents | W-5, C-4, C-5 | reviewer, qa |
| W-14 | install upgrade mode; backward-compat end to end | all | reviewer, qa |
| W-15 | Metrics page (PRODUCT.md page 8) | W-5, C-2 | reviewer, qa |
| W-16 | command menu over `commandsFor`, and the Getting started page | W-5 | reviewer, qa |
| W-17 | `theme.css` tokens, bundled Inter and Anton, wordmark; boundary test covers URLs and color literals | W-5 | reviewer, qa |

## Findings recorded here, not fixed by this project

1. **Four gate definitions disagree** (§0). The dashboard reads
   `config.gates` and `done` ignores it. The README says so, but the two
   still disagree.
2. **Encore leaks into core,** which CLAUDE.md says should be removed:
   - `needsSecurity` terms (`fee|refund|stripe|…`, `board.mjs:400`)
   - `DOC_ROLES` / `NAMES_CODE` (`:404-405`)
   - `founderBlocked` (`:241`)
   - comments about Weeks, Waves and ADR-0028 (`:53`, `:323`)
3. **Board status lags recorded verdicts:** `todo` tasks carry qa passes.
4. **Drift events are written unredacted** (`drift.mjs:453-460`).
5. **The egress proxy's `--log` may be unwritable** as launched by
   `netns.proxyRunArgs`. Unverified; C-5 confirms or refutes it with a test.
6. **Encore leaks into `bin/tui-mock.mjs`:** task `T-277` "money gates",
   `src/lib/pricing.ts`, `scripts/qa/platform-fee.mjs` and a price check in
   the sample log (`:99-116` at `bb38593`). The TUI's sample data should use
   this repo's own tasks.

Four earlier findings were fixed by #2: `esc()` not escaping quotes, the
missing `build.mjs` hook, the drifted installed `run.mjs`, and the Google Fonts
links in `docs/board.html`.

## Verification plan (for the implementation, not this document)

- **C-1:** the golden CLI test, over every command including every refusal
  path, run against the old and new code.
- **C-2:** a back-to-back HTML diff on a fixture repo, normalising only
  `built` and `%ar`.
- **C-3:**
  - A table test with one fixture per lifecycle row.
  - The mutation proof from §5.
  - A test that `lifecycle.mjs` defines no gate list of its own.
- **W-1 security, each attempted and each shown to fail:**
  - no cookie
  - a wrong `Host` (rebinding)
  - a cross-origin POST
  - a POST without `X-Caretaker`
  - `../` in a run id or filename
  - a request for `shadow/`
  - a bind to `0.0.0.0`
  - a transcript containing `<script>` rendered as text
  - a planted key in a transcript that must come back redacted

  E-3's rule applies: a control nobody has attacked is a claim.
- **W-3:** append half a line, check nothing is emitted; append the rest,
  check exactly one event; disconnect and reconnect with `Last-Event-ID` and
  get no gap and no duplicate.
- **W-5:** the boundary test, proven able to fail by planting each banned
  pattern and watching it go red by name.
- **Throughout:** run a real CLI command while the server is up. The page
  updates via `invalidate`, and the numbers match `docs/board.html` rebuilt at
  the same moment.
