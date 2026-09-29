#!/usr/bin/env node
/**
 * SECRETS — get an API key to the process that needs it without it landing
 * anywhere durable.
 *
 * H-0. The acceptance criterion: "an API key is available to the harness at run
 * time, is never written into the image, the repo, the spec or the event log,
 * and a test proves a key value cannot be found in any of them after a run".
 *
 * ---------------------------------------------------------------------------
 * 1. HOW THE SECRET GETS IN — one anonymous pipe per secret, `--preserve-fd`
 * ---------------------------------------------------------------------------
 *
 * The harness's default adapter (H-10) shells out to an agent CLI running
 * INSIDE the dev environment, because that is where subscription auth lives. So
 * the key has to cross into a `--read-only` container whose only bind mount is
 * the repo — and the repo is the one place it must never be.
 *
 * The mechanism here: the parent creates one pipe per secret, hands podman
 * `--preserve-fd 3 [--preserve-fd 4 ...]`, writes the raw value into each pipe
 * and closes it. A one-line `sh -c` preamble inside the container does
 * `export NAME="$(cat <&3)"; exec "$@"`. No framing, no parser, one value per
 * descriptor.
 *
 * Every rejected alternative below was MEASURED on this box, not assumed.
 * podman 5.8.2 rootless, image docker.io/library/nginx:alpine, probe value
 * `sk-ant-LEAKPROBE-1111111111` held in $V.
 *
 *   REJECTED — `-e NAME=value`, the obvious one.
 *     podman run -d --name probe1 -e PROBE_KEY=$V $IMG sleep 60
 *     podman inspect probe1 | grep -c "$V"        ->  2
 *   Two hits: `.Config.Env` and the recorded `CreateCommand`. `podman inspect
 *   probe1 --format '{{.Config.Env}}'` prints `PROBE_KEY=sk-ant-LEAKPROBE-...`
 *   in full. And for a FOREGROUND run — which is what `sandbox.mjs` does, a
 *   `spawnSync` with inherited stdio — the value sits in the podman process's
 *   argv for the whole run:
 *     podman run --rm -e PROBE_KEY="$V" $IMG sleep 6 &   # then, from another shell
 *     ps -eo pid,args | grep PSPROBE
 *     -> 2475068 podman run --rm -e PROBE_KEY=sk-ant-PSPROBE-2222222222 ...
 *   Any user on the host who can run `ps` reads the key. (The detached `-d`
 *   form does NOT show it in `ps`, because the podman process exits; that is a
 *   difference between the two forms and not a defence of the flag.)
 *
 *   REJECTED — `--env-file F`.
 *     podman run -d --name probe2 --env-file $SP/probe.env $IMG sleep 60
 *     podman inspect probe2 | grep -c "$V"        ->  1
 *   Keeps the value out of argv and out of `CreateCommand`. It does not keep it
 *   out of `.Config.Env`, and it needs a plaintext file on the host filesystem
 *   that something has to create and delete.
 *
 *   FALLBACK, NOT DEFAULT — `podman secret create` + `--secret NAME`.
 *     podman run -d --name probe3 --secret probekey $IMG sleep 60
 *     podman inspect probe3 | grep -c "$V"        ->  0
 *   Clean on inspect, and worth recording because it was expected to fail and
 *   did not: `--tmpfs /run:rw,size=64m` (which `sandbox.mjs` passes) does NOT
 *   shadow the secret mount —
 *     podman run --rm --read-only --tmpfs /run:rw,size=64m --secret probekey \
 *       $IMG sh -c 'cat /run/secrets/probekey'   ->  sk-ant-LEAKPROBE-1111111111
 *   The cost is durability. The file driver stores the value BASE64, not
 *   encrypted, and it outlives the run:
 *     grep -rl "$(printf %s "$V" | base64)" ~/.local/share/containers/storage/secrets
 *     -> .../secrets/filedriver/secretsdata.json
 *   So this path exists only for a consumer that needs a filesystem PATH rather
 *   than a value, it is opt-in (`--via secret`), and `withPodmanSecret()` below
 *   removes the store entry in a `finally`.
 *
 *   REJECTED — stdin. One channel, no framing, and the agent CLI's own prompt
 *   already claims it. Two secrets would need a wire format, and a wire format
 *   is a parser, and a parser in the credential path is a bug waiting for a
 *   value containing a newline.
 *
 * WHAT THE PIPE DOES NOT DO, stated on its own so it cannot be read as part of
 * the guarantee: once the preamble exports the value, that value is in the
 * environment of the process inside the container, and any process in that
 * container running as the same uid can read it from /proc/PID/environ. That is
 * not a leak being tolerated by accident — the agent CLI and the tools it spawns
 * ARE the intended consumer, and they get it by inheritance. The property the
 * pipe buys is that the value is absent from every surface that OUTLIVES the
 * process or is visible OUTSIDE the container: argv, `podman inspect`, the
 * image, the repo, the host filesystem, and the event log.
 *
 * DOCKER IS REFUSED RATHER THAN DEGRADED. `docker run` has no `--preserve-fd`.
 * The nearest equivalents are the two mechanisms measured above as leaking. A
 * credential channel that quietly becomes a weaker one on a different runtime is
 * the failure `sandbox.mjs` already refuses for cgroup limits, for the same
 * reason: a control you believe in and do not have is worse than none.
 *
 * ---------------------------------------------------------------------------
 * 2. REDACTION ON THE WAY OUT — two nets, and neither is sufficient alone
 * ---------------------------------------------------------------------------
 *
 * The event log is append-only JSONL, tailed by a TUI and read by a dashboard.
 * A key that reaches it is permanent. So everything written there goes through
 * `makeRedactor()` first.
 *
 * NET ONE — known values, given deliberately. The redactor is CONSTRUCTED from
 * the resolved secret values; it never guesses which of them are secret. Exact
 * substring replacement, so it cannot miss a key it was told about and cannot
 * mangle anything else. It also matches three re-encodings of the same value,
 * because a key reaches a log through more than one shape: base64 (an
 * Authorization header dumped whole), percent-encoding (a URL), and
 * JSON-string escaping (a nested field inside a serialised event).
 *
 * NET TWO — anchored shapes, for keys it was never told about. `KEY_SHAPES`
 * below.
 *
 * WHY NET ONE ALONE IS NOT ENOUGH. Its input is a hand-maintained list of
 * secret names, which is exactly the kind of list that goes stale. A second
 * vendor's key added to config without updating the list, a key the agent read
 * out of a file and echoed into its own transcript, a token minted mid-run — the
 * redactor was never told about any of those, so it passes them through, and the
 * failure is silent and lands in an append-only file.
 *
 * WHY NET TWO ALONE IS NOT ENOUGH. A pattern cannot tell a 40-character hex
 * string that is a key from one that is a git SHA, so a pattern list broad
 * enough to catch unprefixed keys mangles ordinary log lines until nobody trusts
 * the log. And it is defeated the day a vendor changes its prefix — which is
 * routine — with no error anywhere. Patterns are a net, not a policy.
 *
 * `KEY_SHAPES` IS NOT A COMPLETE SET AND IS NOT CLAIMED TO BE. It is the shapes
 * listed there and nothing else: each one is anchored on a vendor prefix so that
 * a false positive on ordinary text is unlikely, which is the trade that makes a
 * second net safe to leave on by default. Anything without such a prefix is net
 * one's job.
 *
 * ---------------------------------------------------------------------------
 * 3. A MISSING SECRET REFUSES BY NAME, BEFORE ANYTHING STARTS
 * ---------------------------------------------------------------------------
 *
 * `requireSecrets()` throws `SecretsError` with `code: "MISSING_SECRET"`, naming
 * the secret and every source that was consulted, and the CLI exits 3. It runs
 * before the container is built, so the failure is one line at second zero
 * rather than a 401 from a vendor forty seconds into a run — which reads as a
 * model outage and gets debugged as one.
 *
 * Two more refusals in the same family, both `SecretsError`:
 *   SECRET_IN_REPO   — a secrets file resolving inside the repo working tree.
 *                      It is one `git add` from being permanent, so it is
 *                      refused rather than warned about.
 *   SECRET_FILE_MODE — a secrets file readable by group or other.
 *   SECRET_TOO_SHORT — a known value under MIN_REDACTABLE characters. Such a
 *                      value cannot be redacted without destroying the log: a
 *                      four-character secret would blank every occurrence of
 *                      those four characters everywhere. Refused, not silently
 *                      skipped, because silently skipping means believing in a
 *                      redactor that is not redacting.
 *
 * Usage:
 *   secrets.mjs check  --require ANTHROPIC_API_KEY[,OTHER]
 *   secrets.mjs exec   --require N --image IMG [--workdir D] [--via fd|secret] -- cmd...
 *   secrets.mjs redact --require N                      # stdin -> stdout filter
 *   secrets.mjs audit  --require N [--log F] [--image IMG] [--root D]
 *
 * Run the tests: node bin/secrets.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { under } from "./paths.mjs";

/* ------------------------------------------------------------------ errors */

/** Every refusal in this module is one of these, and every one names the secret. */
export class SecretsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SecretsError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * A value shorter than this cannot be redacted without eating the log.
 * Asserted by the SECRET_TOO_SHORT test in secrets.test.mjs.
 */
export const MIN_REDACTABLE = 8;

/* ------------------------------------------------------------- where it is */

/** Walk up for a `.git`. Used to refuse a secrets file living inside the repo. */
export function repoRootOf(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Is `p` inside `root` (and not root itself)? paths.mjs's answer: whole path
 * segments, so `/repo-backup` is not `/repo` and `/repo/..x` is inside it, with
 * symlinks resolved.
 */
export function isInside(p, root) {
  if (!root) return false;
  return under(p, root);
}

/**
 * `KEY=value` per line, `#` comments, blank lines ignored. No quoting rules and
 * no interpolation: a credential file is not a shell script, and the moment it
 * is parsed like one someone's key with a `$` in it silently becomes a different
 * key. Everything after the first `=` is the value, verbatim.
 */
export function parseSecretsFile(text) {
  const out = new Map();
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key) continue;
    out.set(key, line.slice(eq + 1));
  }
  return out;
}

/**
 * Where to write a secrets file if you do not have one. Named separately from
 * the search order below because the search order's first entry is an optional
 * env override: indexing into the filtered list to build the "or write:" hint
 * pointed the operator at the SECOND fallback whenever that override was unset,
 * which is every normal invocation.
 */
export const PREFERRED_FILE = join(homedir(), ".config", "caretaker", "secrets.env");

/** Default search order for a secrets file. Every entry is outside any repo. */
export const DEFAULT_FILES = [
  process.env.CARETAKER_SECRETS_FILE,
  PREFERRED_FILE,
  join(homedir(), ".caretaker", "secrets.env"),
].filter(Boolean);

function readSecretsFile(path, repoRoot) {
  if (isInside(path, repoRoot)) {
    throw new SecretsError(
      "SECRET_IN_REPO",
      `secrets file ${path} is inside the repo at ${repoRoot}. One 'git add' from permanent.`,
      { path, repoRoot },
    );
  }
  const st = statSync(path);
  // 0o077 is group+other. A credential file the rest of the box can read is not
  // a credential file.
  if (st.mode & 0o077) {
    throw new SecretsError(
      "SECRET_FILE_MODE",
      `secrets file ${path} is mode ${(st.mode & 0o777).toString(8)}; needs 600. ` +
        `fix: chmod 600 ${path}`,
      { path, mode: st.mode & 0o777 },
    );
  }
  return parseSecretsFile(readFileSync(path, "utf8"));
}

/**
 * Resolve the named secrets. Sources, in order, first hit wins:
 *
 *   1. the process environment  — the operator's own shell, deliberately
 *   2. a secrets file outside the repo
 *   3. a command per secret, e.g. `pass show anthropic` or `op read op://...`
 *
 * NAMES ARE REQUIRED AND NOTHING IS SCRAPED. This does not sweep the
 * environment for things that look like keys: what is secret is a declaration,
 * and a redactor built from a guess redacts the wrong things and misses the
 * right ones.
 *
 * Returns { values: Map<name,string>, sources: Map<name,string>, missing: [] }.
 * It does NOT throw on a missing secret — `requireSecrets` does that, so `check`
 * can report every missing name at once instead of one per run.
 */
export function resolveSecrets(names, opts = {}) {
  const {
    env = process.env,
    files = DEFAULT_FILES,
    commands = {},
    repoRoot = repoRootOf(),
    exec = (cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" }),
  } = opts;

  const values = new Map();
  const sources = new Map();
  const missing = [];

  let fileValues = new Map();
  let fileFrom = null;
  for (const f of files) {
    if (!f || !existsSync(f)) continue;
    fileValues = readSecretsFile(f, repoRoot); // throws IN_REPO / FILE_MODE by name
    fileFrom = f;
    break;
  }

  for (const name of names) {
    if (env[name]) {
      values.set(name, env[name]);
      sources.set(name, "environment");
      continue;
    }
    if (fileValues.get(name)) {
      values.set(name, fileValues.get(name));
      sources.set(name, fileFrom);
      continue;
    }
    if (commands[name]) {
      const r = exec(commands[name]);
      const out = String(r.stdout ?? "").replace(/\n+$/, "");
      if (r.status === 0 && out) {
        values.set(name, out);
        sources.set(name, `command: ${commands[name]}`);
        continue;
      }
    }
    missing.push(name);
  }
  return { values, sources, missing, consulted: { env: true, file: fileFrom, files } };
}

/** As `resolveSecrets`, but a missing secret is a named refusal. */
export function requireSecrets(names, opts = {}) {
  const r = resolveSecrets(names, opts);
  if (r.missing.length) {
    const where = [
      "the process environment",
      ...(r.consulted.files ?? []).map((f) => `${f}${existsSync(f) ? "" : " (absent)"}`),
    ];
    throw new SecretsError(
      "MISSING_SECRET",
      `missing secret(s): ${r.missing.join(", ")}\n` +
        where.map((w) => `  looked in: ${w}`).join("\n") +
        `\n  set one:   export ${r.missing[0]}=...` +
        `\n  or write:  ${PREFERRED_FILE}  (chmod 600)`,
      { missing: r.missing },
    );
  }
  return r;
}

/**
 * A stable, non-reversing handle for a value. Prints in logs and terminals so
 * "which key is loaded" is answerable without answering "what is the key".
 * Truncated SHA-256 plus the length.
 */
export const fingerprint = (value) =>
  `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}/${String(value).length}`;

/* -------------------------------------------------------------- redaction */

/**
 * NET TWO. Shapes anchored on a vendor prefix, so an ordinary log line does not
 * match by accident. This list is a net for keys the redactor was never told
 * about; it is not, and is not claimed to be, an enumeration of key formats.
 * Each entry's `re` must be global — `redact` calls `.replace` with it directly.
 */
export const KEY_SHAPES = [
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai", re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { name: "github", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/g },
  { name: "google-api", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "slack", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Not a key shape — a CARRIER. Whatever is presented as a bearer credential is
  // a credential whatever it looks like, which is the one case where matching
  // on context rather than on the token's own shape is correct.
  { name: "bearer", re: /\b([Bb]earer\s+)([A-Za-z0-9._~+/=-]{20,})/g, keepGroup: 1 },
];

/** The re-encodings of a value that a log can plausibly contain. */
function encodingsOf(value) {
  const v = String(value);
  const out = new Set([v]);
  out.add(Buffer.from(v, "utf8").toString("base64"));
  out.add(Buffer.from(v, "utf8").toString("base64url"));
  out.add(encodeURIComponent(v));
  // JSON string escaping, minus the surrounding quotes: what the value looks
  // like once it is a field inside a serialised event.
  out.add(JSON.stringify(v).slice(1, -1));
  return [...out].filter((s) => s.length >= MIN_REDACTABLE);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the redactor. `values` is Map<name,value> or an object.
 *
 * Known values are replaced with `[redacted:NAME]` — the NAME is deliberate.
 * A log that says a secret was here and which one is debuggable; one that says
 * `[redacted]` is not, and one that drops the field silently is a lie.
 *
 * Throws SECRET_TOO_SHORT rather than skipping a value it cannot safely handle.
 */
export function makeRedactor(values, { patterns = true, minLength = MIN_REDACTABLE } = {}) {
  const entries = values instanceof Map ? [...values] : Object.entries(values ?? {});
  const rules = [];
  for (const [name, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    const v = String(value);
    if (v.length < minLength) {
      throw new SecretsError(
        "SECRET_TOO_SHORT",
        `${name} is ${v.length} characters; under ${minLength} it cannot be redacted without ` +
          "blanking ordinary text. Refusing rather than silently not redacting it.",
        { secret: name, length: v.length },
      );
    }
    for (const enc of encodingsOf(v)) {
      rules.push({ re: new RegExp(escapeRe(enc), "g"), to: `[redacted:${name}]` });
    }
  }
  // Longest first: a value that contains another value must not be half-replaced.
  rules.sort((a, b) => b.re.source.length - a.re.source.length);

  const redact = (input) => {
    let s = String(input ?? "");
    for (const r of rules) s = s.replace(r.re, r.to);
    if (patterns) {
      for (const shape of KEY_SHAPES) {
        s = s.replace(shape.re, (...m) =>
          shape.keepGroup ? `${m[shape.keepGroup]}[redacted:${shape.name}]` : `[redacted:${shape.name}]`,
        );
      }
    }
    return s;
  };
  redact.ruleCount = rules.length;
  return redact;
}

/**
 * Redact a whole event object by round-tripping its JSON.
 *
 * SERIALISE, THEN SCRUB, THEN PARSE — not field by field. A key arrives in
 * whatever field the caller happened to put it in, often nested inside a
 * `detail` string that is itself JSON, and a field-walking redactor only cleans
 * the fields someone remembered to list.
 *
 * The replacement text contains no quote or backslash, so it cannot break the
 * JSON it is substituted into. Asserted by the "redacting cannot corrupt the
 * JSON" test in secrets.test.mjs.
 */
export const redactEvent = (obj, redact) => JSON.parse(redact(JSON.stringify(obj)));

/** The one call anything writing the event log should make. Returns the line. */
export function redactedLine(obj, redact) {
  return redact(JSON.stringify(obj));
}

/* --------------------------------------------------- delivery into podman */

/**
 * Flags and stdio for delivering `names` over preserved file descriptors.
 *
 * Descriptors are assigned from 3 upward in the order given. `stdio` is what
 * `child_process.spawn` needs so that fd N in the parent's array becomes fd N in
 * podman, which becomes fd N in the container — verified end to end by the
 * "two secrets arrive on their own descriptors" test.
 */
export function preserveFdPlan(names, { firstFd = 3 } = {}) {
  const fdOf = new Map();
  const args = [];
  names.forEach((name, i) => {
    const fd = firstFd + i;
    fdOf.set(name, fd);
    args.push("--preserve-fd", String(fd));
  });
  const stdio = ["ignore", "pipe", "pipe"];
  for (let i = 0; i < names.length; i++) stdio[firstFd + i] = "pipe";
  return { args, fdOf, stdio };
}

/**
 * The in-container preamble: read each descriptor into its variable, then exec
 * the real command.
 *
 * THE PREAMBLE CARRIES NO VALUE, only descriptor numbers and variable names, so
 * it is safe in argv and safe in `podman inspect`. `$(cat <&N)` strips trailing
 * newlines, which is what you want for a key and is why the parent may write the
 * value with or without one.
 *
 * `exec "$@"` replaces the shell, so the shell does not linger holding the
 * value, and signals reach the agent rather than a wrapper.
 */
export function shimCommand(fdOf, cmd) {
  const sets = [...fdOf]
    .map(([name, fd]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SecretsError("SECRET_BAD_NAME", `${name} is not a usable shell variable name`, {
          secret: name,
        });
      }
      return `export ${name}="$(cat <&${fd})"`;
    })
    .join("; ");
  return ["sh", "-c", `${sets}; exec "$@"`, "sh", ...cmd];
}

/**
 * Write each value into its descriptor and close it.
 *
 * A runtime that exits without reading its descriptor resets the pipe
 * (ECONNRESET, or EPIPE on the write). The runtime's own exit status and
 * stderr already report that failure, so the error is absorbed here: left
 * unhandled it kills this process with a stack trace instead, which is what
 * podman 4.9.3, lacking `--preserve-fd`, did (measured 2026-09-29).
 */
export function writeSecrets(child, values, fdOf) {
  for (const [name, fd] of fdOf) {
    const pipe = child.stdio[fd];
    if (!pipe) throw new SecretsError("SECRET_NO_PIPE", `no pipe on fd ${fd} for ${name}`, { secret: name });
    pipe.on("error", () => {});
    pipe.end(String(values.get(name)));
  }
}

/**
 * Whether `runtime run` accepts `--preserve-fd`. podman 4.9.3 (Ubuntu 24.04's
 * package) does not: it exits 125 with "unknown flag: --preserve-fd".
 */
export function supportsPreserveFd(runtime = "podman") {
  const r = spawnSync(runtime, ["run", "--help"], { encoding: "utf8" });
  return r.status === 0 && /--preserve-fd\b/.test(r.stdout ?? "");
}

/**
 * The `--secret` fallback, for a consumer that needs a PATH rather than a value.
 * Opt-in, and the store entry is removed in a `finally` — podman's file driver
 * keeps it base64 on disk until something deletes it (measured; see the header).
 */
export function withPodmanSecret(name, value, fn, { runtime = "podman" } = {}) {
  const id = `caretaker-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${process.pid}`;
  spawnSync(runtime, ["secret", "rm", id], { stdio: "ignore" });
  const created = spawnSync(runtime, ["secret", "create", id, "-"], { input: String(value) });
  if (created.status !== 0) {
    throw new SecretsError("SECRET_STORE_FAILED", `${runtime} secret create ${id} failed`, { secret: name });
  }
  try {
    return fn(id, `/run/secrets/${id}`);
  } finally {
    spawnSync(runtime, ["secret", "rm", id], { stdio: "ignore" });
  }
}

/* ------------------------------------------------------------------- audit */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

/** Every file under `root`, skipping the directories above and anything huge. */
export function walkFiles(root, { maxBytes = 8 * 1024 * 1024, out = [] } = {}) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(p, { maxBytes, out });
    } else if (e.isFile()) {
      try {
        if (statSync(p).size <= maxBytes) out.push(p);
      } catch {
        /* vanished mid-walk; a shared tree is normal here */
      }
    }
  }
  return out;
}

/**
 * Scan files for any encoding of any value. Returns [{ file, secret, encoding }].
 *
 * IT SEARCHES THE SAME ENCODINGS THE REDACTOR REPLACES, deliberately. An audit
 * that only looks for the raw string cannot catch the base64 copy the redactor
 * exists to remove, and would report clean on exactly the leak that motivated
 * the second encoding.
 */
export function scanFiles(files, values) {
  const entries = values instanceof Map ? [...values] : Object.entries(values ?? {});
  const needles = entries.flatMap(([name, v]) =>
    encodingsOf(String(v)).map((enc) => ({ name, enc })),
  );
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "latin1"); // byte-preserving; finds it in binaries too
    } catch {
      continue;
    }
    for (const n of needles) if (text.includes(n.enc)) hits.push({ file: f, secret: n.name, encoding: n.enc.slice(0, 12) });
  }
  return hits;
}

/** Scan the output of a command (podman inspect, image history) for the values. */
export function scanCommand(cmd, args, values) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const entries = values instanceof Map ? [...values] : Object.entries(values ?? {});
  const hits = [];
  for (const [name, v] of entries) {
    for (const enc of encodingsOf(String(v))) {
      if (text.includes(enc)) hits.push({ where: `${cmd} ${args.join(" ")}`, secret: name });
    }
  }
  return { hits, status: r.status };
}

/* --------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const dashdash = argv.indexOf("--");
  const head = dashdash === -1 ? argv.slice(1) : argv.slice(1, dashdash);
  const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  const flags = {};
  for (let i = 0; i < head.length; i++) {
    if (!head[i].startsWith("--")) continue;
    const eq = head[i].indexOf("=");
    if (eq === -1) flags[head[i].slice(2)] = head[i + 1];
    else flags[head[i].slice(2, eq)] = head[i].slice(eq + 1);
  }

  const names = (flags.require ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const die = (err) => {
    if (err instanceof SecretsError) {
      console.error(`[secrets] REFUSING — ${err.code}\n\n  ${err.message.split("\n").join("\n  ")}\n`);
      process.exit(3);
    }
    throw err;
  };

  if (!sub || !["check", "exec", "redact", "audit"].includes(sub)) {
    console.error(
      "usage: secrets.mjs check|exec|redact|audit --require NAME[,NAME]\n" +
        "       secrets.mjs exec --require N --image IMG [--workdir D] [--via fd|secret] -- cmd...",
    );
    process.exit(2);
  }
  if (!names.length) {
    console.error("secrets.mjs: --require NAME[,NAME] is required. Nothing is scraped: what is");
    console.error("secret is a declaration, not a guess about which env vars look key-shaped.");
    process.exit(2);
  }

  if (sub === "check") {
    let r;
    try {
      r = requireSecrets(names);
    } catch (e) {
      die(e);
    }
    for (const n of names) {
      console.log(`${n}  ${fingerprint(r.values.get(n))}  from ${r.sources.get(n)}`);
    }
    process.exit(0);
  }

  if (sub === "redact") {
    let redact;
    try {
      redact = makeRedactor(requireSecrets(names).values);
    } catch (e) {
      die(e);
    }
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) process.stdout.write(redact(l) + "\n");
    });
    process.stdin.on("end", () => {
      if (buf) process.stdout.write(redact(buf));
      process.exit(0);
    });
  }

  if (sub === "audit") {
    let values;
    try {
      values = requireSecrets(names).values;
    } catch (e) {
      die(e);
    }
    const root = resolve(flags.root ?? repoRootOf() ?? process.cwd());
    const targets = walkFiles(root);
    const hits = scanFiles(targets, values);
    console.log(`[secrets] scanned ${targets.length} file(s) under ${root}`);
    if (flags.log && existsSync(flags.log)) {
      hits.push(...scanFiles([resolve(flags.log)], values));
      console.log(`[secrets] scanned the event log ${flags.log}`);
    }
    if (flags.image) {
      for (const a of [["inspect", flags.image], ["image", "history", "--no-trunc", flags.image]]) {
        const r = scanCommand("podman", a, values);
        hits.push(...r.hits);
        console.log(`[secrets] scanned: podman ${a.join(" ")}`);
      }
    }
    if (!hits.length) {
      console.log("[secrets] no secret value found in any scanned surface");
      process.exit(0);
    }
    for (const h of hits) console.error(`[secrets] LEAK ${h.secret} in ${h.file ?? h.where}`);
    process.exit(1);
  }

  if (sub === "exec") {
    if (!rest.length) {
      console.error("secrets.mjs exec: give a command after --");
      process.exit(2);
    }
    if (!flags.image) {
      console.error("secrets.mjs exec: --image is required");
      process.exit(2);
    }
    const runtime = flags.runtime ?? "podman";
    if (runtime !== "podman") {
      console.error(
        `[secrets] REFUSING — ${runtime} has no --preserve-fd. Its nearest equivalents put the\n` +
          "  value in `docker inspect` (measured: see the header of this file). A credential\n" +
          "  channel that silently weakens on a different runtime is worse than none.",
      );
      process.exit(3);
    }
    if (!supportsPreserveFd(runtime)) {
      const version = spawnSync(runtime, ["--version"], { encoding: "utf8" }).stdout?.trim() || runtime;
      console.error(
        `[secrets] REFUSING — ${version} has no --preserve-fd, which is the only channel this\n` +
          "  file trusts to carry a secret into a container. Upgrade podman rather than fall\n" +
          "  back to -e or --env-file, which put the value in `podman inspect`.",
      );
      process.exit(3);
    }
    let values;
    try {
      values = requireSecrets(names).values;
    } catch (e) {
      die(e);
    }
    const workdir = resolve(flags.workdir ?? process.cwd());
    const plan = preserveFdPlan(names);
    const args = [
      "run",
      "--rm",
      "--network",
      flags.net ?? "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=512m,exec",
      "--tmpfs",
      "/run:rw,size=64m",
      "-v",
      `${workdir}:/work:Z`,
      "-w",
      "/work",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...plan.args,
      flags.image,
      ...shimCommand(plan.fdOf, rest),
    ];
    const child = spawn(runtime, args, { stdio: plan.stdio });
    writeSecrets(child, values, plan.fdOf);
    // Output is redacted on the way through: this process holds the values, so
    // it is the last place that can scrub them before they reach a terminal, a
    // transcript or a tee into the event log.
    const redact = makeRedactor(values);
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding("utf8");
      let buf = "";
      stream.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) sink.write(redact(l) + "\n");
      });
      stream.on("end", () => buf && sink.write(redact(buf)));
    }
    child.on("exit", (code) => process.exit(code ?? 1));
  }
}
