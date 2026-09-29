---
title: "ADR-0002: An optional local web client, beside the TUI and the static page"
status: accepted
updated: 2026-09-29
supersedes: "the 'TUI rather than a web UI' position in the U-2 board note (only that part)"
---

## The question

Should Foreman have a web UI?

The board already answers no. The U-2 note says:

> TUI rather than a web UI on purpose: no daemon, no auth, no port, and it
> works over SSH. The static HTML dashboard is not a competitor to this, it is
> the artifact you send to someone who is not in a terminal.

The project is now being pointed at a software-factory control plane, where
many runs, their measured evidence, and the few decisions only a human can make
need to be visible at once. The first project for that is Foreman Web v1
(`specs/foreman-web/PRODUCT.md`, `specs/foreman-web/TECH.md`).

Per `docs/memory.md`, a decision is superseded, not edited. This ADR replaces
**only** the "not a web UI" part of U-2. The TUI stays in scope, and so does
`docs/board.html`.

## The three objections, answered rather than waved away

**No daemon.**
- `foreman serve` runs in the foreground and stops on Ctrl-C.
- It writes no pidfile, installs no service, and stores nothing that cannot be
  rebuilt from the files.
- Nothing about the core requires it to be running.

**No auth.**
- The server binds to loopback only.
- It prints a one-time bootstrap URL carrying a 256-bit token, generated
  in-process and never read from argv.
- It exchanges the token for an `HttpOnly; SameSite=Strict` cookie named by
  port, then redirects to strip the token from the URL.
- It checks `Host` exactly (against DNS rebinding) and `Origin` plus a custom
  header on writes, and sends no CORS headers.
- It sets a strict CSP, because agent-controlled text is the realistic
  injection path.

This is an auth change and goes through `security` as well as `reviewer` and
`qa`.

**No port.**
- There is one port, on 127.0.0.1, and only while you run it.
- A non-loopback bind is refused in v1.
- Remote access is `ssh -L`, which keeps "works over SSH" true.

## What does not change

- **The files stay authoritative.** There is no database. The server reads
  what the core writes.
- **Every mutation calls a core function,** the same one the CLI calls, and
  core re-checks. The browser holds no gate or lifecycle logic. TECH.md §5
  describes how that is proven by mutation, not asserted.
- **`docs/board.html` stays** zero-dependency and offline, and is generated
  from the same metric functions the API uses. So the two surfaces cannot
  disagree, which is the failure commit 3e341bc fixed.
- **The TUI (U-1, U-2) is not replaced.** Over SSH, in a terminal, with nothing
  listening, it is still the right tool.
- **ADR-0001 still holds.** Human approval is not the verification story. The
  web Inbox holds decisions the machinery cannot make (questions, spec intent,
  repeated failure, merge). Verification stays with the gates. The browser
  cannot record reviewer, qa or security verdicts in v1, because a one-click
  pass is the rubber stamp ADR-0001 rejects.

## The ordering this does not override

CLAUDE.md builds bottom-up and puts the UI last: "a good shell over a harness
that does not work" is how this dies. H-1's latest qa verdict is `fail`.

So accepting this ADR is **not** a decision to build the UI now. TECH.md splits
the work:
- Core prerequisites and pages over board data can proceed.
- Everything that shows runs waits on H-1 and B-6, for the same reason U-1
  waits.

Starting any web task before H-1 passes is a separate call, and whoever accepts
this ADR should make it explicitly.

## Decision

**Accepted on 2026-09-29.** Caretaker gets an optional, local, foreground web
client over the core, alongside the TUI and the static page. It is specified by
`specs/foreman-web/PRODUCT.md` and `specs/foreman-web/TECH.md`, which are
accepted with this ADR.

**Who decided.** Five, the project owner, asked for the web client, steered its
design through a clickable mockup of every page, and then asked for the work to
be finished. Claude wrote this acceptance on that instruction. The design that
came out of that review is recorded in the specs: the layout, colors and logo
(TECH.md §4, PRODUCT.md §Layout), the Metrics page, the command menu, and the
TUI's four screens.

**The ordering call this ADR asks for.** No W-task starts before H-1's qa gate
passes. That keeps CLAUDE.md's bottom-up order, and it is the same reason U-1
waits. C-1, C-2, C-3 and C-6 may start now. They are layer-4 board work, and
`docs/board.html` and the TUI use them as much as the web client does. C-4 and
C-5 wait on H-1 and B-6, as TECH.md already says.

The proposed tasks are still not on the board. Adding them is a separate board
change.
