#!/usr/bin/env node
/**
 * Tests for the secret channel.
 *
 * MOST OF THESE ARE NEGATIVE, because every property H-0 claims is an absence:
 * the key is NOT in the repo, NOT in the image, NOT in `podman inspect`, NOT in
 * the event log, NOT in the argv. An absence is the easiest thing in the world
 * to prove by accident with a broken check, so the scanner that proves those
 * absences is itself checked against a PLANTED value first — see "the scanner is
 * not vacuous". Without that, every leak test below would pass on a scanner that
 * finds nothing ever.
 *
 * TWO KINDS, as in sandbox.test.mjs. The pure tests always run. The live tests
 * boot a real container, because a flag on a command line proves nothing about
 * what podman did with it, and the whole acceptance criterion is about what is
 * true AFTER a run. They SKIP LOUDLY without podman or an image rather than
 * passing.
 *
 * NOTHING HERE WRITES A SECRET INTO THE REPO. Temporary files go to an
 * mkdtemp under the OS temp dir, including the fake repo used to test the
 * in-repo refusal, and every one is removed in a finally.
 *
 * Run: node bin/secrets.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEY_SHAPES,
  MIN_REDACTABLE,
  SecretsError,
  fingerprint,
  isInside,
  makeRedactor,
  parseSecretsFile,
  preserveFdPlan,
  redactEvent,
  requireSecrets,
  resolveSecrets,
  scanCommand,
  scanFiles,
  shimCommand,
  supportsPreserveFd,
  walkFiles,
  writeSecrets,
} from "./secrets.mjs";

let failures = 0;
let skipped = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const skip = (name, why) => {
  console.log(`SKIP ${name} — ${why}`);
  skipped += 1;
};
/** Assert that `fn` throws a SecretsError with exactly this code. */
const refuses = (name, code, fn) => {
  try {
    fn();
    ok(name, false, `it did NOT refuse; expected ${code}`);
  } catch (e) {
    ok(name, e instanceof SecretsError && e.code === code, `threw ${e.code ?? e.name}: ${e.message}`);
  }
};

/*
 * The value used throughout. Anthropic-shaped on purpose: it exercises the
 * known-value net AND the pattern net, and the tests below distinguish which one
 * fired by using a second value that matches no shape at all.
 */
const KEY = "sk-ant-api03-TESTONLY-6Qx7n2Vb8Lm4Kd0Ry9Tz";
const UNSHAPED = "correct-horse-battery-staple-9182736450";
const TMP = mkdtempSync(join(tmpdir(), "foreman-secrets-test-"));

try {
  /* ------------------------------------------------------------ refusals */

  refuses("a missing secret refuses by name with MISSING_SECRET", "MISSING_SECRET", () =>
    requireSecrets(["ANTHROPIC_API_KEY"], { env: {}, files: [] }),
  );
  {
    // The message has to NAME the thing, or the refusal is no better than a 401
    // forty seconds in — which is the failure this whole control exists to avoid.
    let msg = "";
    try {
      requireSecrets(["NOPE_KEY"], { env: {}, files: [] });
    } catch (e) {
      msg = e.message;
    }
    ok("the refusal names the missing secret", msg.includes("NOPE_KEY"), msg);
    ok("the refusal says where it looked", /looked in/.test(msg), msg);
    ok(
      "the refusal says how to fix it",
      msg.includes("export NOPE_KEY="),
      msg,
    );
  }
  {
    // Two missing secrets are reported together. One-per-run means the operator
    // fixes one, reruns, and waits again.
    let e;
    try {
      requireSecrets(["A_KEY", "B_KEY"], { env: {}, files: [] });
    } catch (err) {
      e = err;
    }
    ok("every missing secret is named at once, not one per run", e?.missing?.length === 2, JSON.stringify(e?.missing));
  }

  {
    const fakeRepo = join(TMP, "fakerepo");
    mkdirSync(join(fakeRepo, ".git"), { recursive: true });
    const inRepo = join(fakeRepo, "secrets.env");
    writeFileSync(inRepo, `ANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o600 });
    refuses("a secrets file INSIDE the repo is refused, not warned about", "SECRET_IN_REPO", () =>
      resolveSecrets(["ANTHROPIC_API_KEY"], { env: {}, files: [inRepo], repoRoot: fakeRepo }),
    );
  }

  {
    const loose = join(TMP, "loose.env");
    writeFileSync(loose, `ANTHROPIC_API_KEY=${KEY}\n`);
    chmodSync(loose, 0o644);
    refuses("a world-readable secrets file is refused", "SECRET_FILE_MODE", () =>
      resolveSecrets(["ANTHROPIC_API_KEY"], { env: {}, files: [loose], repoRoot: null }),
    );
    chmodSync(loose, 0o600);
    const r = resolveSecrets(["ANTHROPIC_API_KEY"], { env: {}, files: [loose], repoRoot: null });
    ok("the same file at 600 is accepted", r.values.get("ANTHROPIC_API_KEY") === KEY);
  }

  refuses(`a value under ${MIN_REDACTABLE} characters refuses with SECRET_TOO_SHORT`, "SECRET_TOO_SHORT", () =>
    makeRedactor({ TINY: "abc" }),
  );

  refuses("a secret name that is not a shell identifier is refused", "SECRET_BAD_NAME", () =>
    shimCommand(new Map([["not a name; rm -rf /", 3]]), ["true"]),
  );

  /* ------------------------------------------------- resolution behaviour */

  ok(
    "NOTHING IS SCRAPED: an env var that looks key-shaped but was not asked for is not returned",
    resolveSecrets(["ASKED_FOR"], {
      env: { ASKED_FOR: KEY, SOME_OTHER_TOKEN: "sk-ant-api03-NOTASKEDFOR-000000000000" },
      files: [],
    }).values.size === 1,
    "a redactor built from a guess redacts the wrong things and misses the right ones",
  );
  ok(
    "the environment wins over the file, and the source is reported",
    (() => {
      const f = join(TMP, "order.env");
      writeFileSync(f, `K_KEY=from-the-file-0000\n`, { mode: 0o600 });
      const r = resolveSecrets(["K_KEY"], { env: { K_KEY: KEY }, files: [f], repoRoot: null });
      return r.values.get("K_KEY") === KEY && r.sources.get("K_KEY") === "environment";
    })(),
  );
  ok(
    "a command source is consulted only when env and file miss",
    (() => {
      let calls = 0;
      const exec = () => {
        calls += 1;
        return { status: 0, stdout: `${KEY}\n` };
      };
      const a = resolveSecrets(["C_KEY"], { env: { C_KEY: KEY }, files: [], commands: { C_KEY: "x" }, exec });
      const b = resolveSecrets(["C_KEY"], { env: {}, files: [], commands: { C_KEY: "x" }, exec });
      return calls === 1 && a.sources.get("C_KEY") === "environment" && b.values.get("C_KEY") === KEY;
    })(),
    "a `pass show` per resolution is a keyring prompt per run",
  );

  ok(
    "a value containing '=' survives the file parser intact",
    parseSecretsFile("K=a=b=c\n").get("K") === "a=b=c",
    "everything after the FIRST '=' is the value; splitting on every '=' silently truncates a key",
  );
  ok(
    "no shell interpolation: a $ in a value is not expanded",
    parseSecretsFile("K=abc$HOME\n").get("K") === "abc$HOME",
  );
  ok("comments and blanks are ignored", parseSecretsFile("# c\n\nK=v\n").size === 1);

  ok(
    "a fingerprint identifies a key without revealing it",
    !fingerprint(KEY).includes(KEY) && fingerprint(KEY) === fingerprint(KEY) && fingerprint(KEY) !== fingerprint(UNSHAPED),
    fingerprint(KEY),
  );

  ok("a sibling directory is not 'inside' the repo", !isInside("/srv/foreman-backup/x", "/srv/foreman"));
  ok("a subdirectory is inside the repo", isInside("/srv/foreman/bin/x", "/srv/foreman"));
  ok("the repo root itself is not 'inside' itself", !isInside("/srv/foreman", "/srv/foreman"));

  /* ------------------------------------------------------------ redaction */

  {
    const redact = makeRedactor({ ANTHROPIC_API_KEY: KEY, OTHER: UNSHAPED });

    ok("the raw value is replaced", !redact(`Authorization: Bearer ${KEY}`).includes(KEY));
    ok(
      "the replacement NAMES the secret, so the log stays debuggable",
      redact(`key=${KEY}`).includes("[redacted:ANTHROPIC_API_KEY]"),
      redact(`key=${KEY}`),
    );
    ok(
      "a base64 copy of the value is replaced",
      !redact(`blob ${Buffer.from(KEY).toString("base64")} end`).includes(Buffer.from(KEY).toString("base64")),
      "an Authorization header dumped whole arrives base64; a redactor that only knows the raw " +
        "string reports clean on exactly the copy it exists to remove",
    );
    ok(
      "a percent-encoded copy is replaced",
      !redact(`https://x/?k=${encodeURIComponent(UNSHAPED)}`).includes(encodeURIComponent(UNSHAPED)),
    );
    ok(
      "a value with no vendor shape at all is still replaced, because it was declared",
      !redact(`the token is ${UNSHAPED}`).includes(UNSHAPED),
      "this is the test that shows net one is doing work the pattern net cannot",
    );

    /* --- the mangle tests: things that MERELY RESEMBLE a key, untouched --- */
    const innocuous = [
      ["a git SHA", "commit 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 touched pricing.ts"],
      ["a UUID", "run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 finished"],
      ["a bare 'sk-' with nothing after it", "the flag is --sk- and it takes no argument"],
      ["the NAME of a secret", "ANTHROPIC_API_KEY is not set; refusing"],
      ["prose about a key", "the api key was rejected by the vendor with a 401"],
      ["a bare AKIA with nothing after it", "AKIA is the prefix AWS uses"],
      ["a base64 blob that is not a key", "checksum " + Buffer.from("hello world hello world").toString("base64")],
      ["a long hex string in a path", "/var/lib/containers/overlay/abcdef0123456789abcdef0123456789abcdef01/diff"],
      ["a semver and a port", "node 22.11.0 listening on :8080 with 512 pids"],
      ["the word bearer alone", "the bearer of this note is authorised"],
    ];
    for (const [what, line] of innocuous) {
      ok(`the redactor does not mangle ${what}`, redact(line) === line, `became: ${redact(line)}`);
    }

    /* ------------------------------- net two: keys it was never told about */
    const stranger = makeRedactor({ ANTHROPIC_API_KEY: KEY });
    const unknown = "sk-ant-api03-NEVERREGISTERED-Zz9Yy8Xx7Ww6Vv5";
    ok(
      "NET TWO: a key the redactor was never told about is still caught by shape",
      !stranger(`stray ${unknown}`).includes(unknown),
      "the list of known secrets is hand-maintained and therefore the thing that goes stale; " +
        "without this net that failure is silent and lands in an append-only file",
    );
    ok(
      "net two catches a bearer token of no recognised vendor shape",
      !stranger("Authorization: Bearer aQ83nfLs02mXpQ71zbVe44TgHy19").includes("aQ83nfLs02mXpQ71zbVe44TgHy19"),
    );
    ok(
      "net two keeps the word Bearer so the line still reads",
      stranger("Authorization: Bearer aQ83nfLs02mXpQ71zbVe44TgHy19").includes("Bearer [redacted:bearer]"),
      stranger("Authorization: Bearer aQ83nfLs02mXpQ71zbVe44TgHy19"),
    );
    ok(
      "net two catches a JWT",
      !stranger("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r").includes("dBjftJeZ"),
    );
    ok(
      "NET TWO IS NOT LOAD-BEARING ON ITS OWN: an unregistered key with no prefix is NOT caught",
      stranger(`stray ${UNSHAPED}`).includes(UNSHAPED),
      "recorded as a limit rather than hidden. Patterns cannot tell a 40-char string that is a " +
        "key from one that is a git SHA, which is exactly why net one has to exist",
    );
    ok(
      "every KEY_SHAPES entry is a global regexp, or .replace would loop or miss",
      KEY_SHAPES.every((s) => s.re.global),
    );
  }

  /* -------------------------------------------- redaction of a whole event */

  {
    const redact = makeRedactor({ ANTHROPIC_API_KEY: KEY });
    const event = {
      t: "2026-08-30T14:22:01Z",
      run: "r_8f2c",
      task: "H-0",
      stage: "build",
      kind: "agent",
      level: "error",
      detail: `vendor rejected the request; sent header Authorization: Bearer ${KEY}`,
      nested: { payload: JSON.stringify({ api_key: KEY }) },
    };
    const line = redact(JSON.stringify(event));
    ok("a key nested inside a serialised field is scrubbed", !line.includes(KEY), line.slice(0, 160));
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* left null */
    }
    ok(
      "redacting cannot corrupt the JSON — the replacement has no quote or backslash",
      parsed !== null && parsed.task === "H-0",
      line.slice(0, 160),
    );
    ok(
      "the fields that are not secret survive untouched",
      parsed?.t === event.t && parsed?.run === event.run && parsed?.level === "error",
    );
    ok("redactEvent round-trips to an object", redactEvent(event, redact).task === "H-0");
    ok(
      "a value that is JSON-escaped in the log is still caught",
      !redact(JSON.stringify({ d: `a"b ${KEY}` })).includes(KEY),
    );
  }

  /* ------------------------------------- a runtime that never reads the pipe */

  {
    // podman 4.9.3 has no --preserve-fd, so it exits 125 without reading the
    // secret's descriptor, and the pipe resets. That reset used to be an
    // unhandled 'error' event which killed this process with a stack trace
    // instead of reporting podman's own exit status. `sh -c 'exit 3'` stands
    // in for podman here: it also exits without reading fd 3.
    const plan = preserveFdPlan(["ANTHROPIC_API_KEY"]);
    const child = spawn("sh", ["-c", "sleep 0.2; exit 3"], { stdio: plan.stdio });
    child.stdout.resume();
    child.stderr.resume();
    writeSecrets(child, new Map([["ANTHROPIC_API_KEY", KEY]]), plan.fdOf);
    const code = await new Promise((r) => child.on("exit", r));
    await new Promise((r) => setTimeout(r, 300));
    ok("a runtime that exits without reading its secret is reported by its exit status, not a crash", code === 3, `exit ${code}`);
  }

  /* ------------------------------------------------- the delivery argv */

  {
    const plan = preserveFdPlan(["ANTHROPIC_API_KEY", "SECOND_KEY"]);
    ok("fds are assigned from 3 upward in order", plan.fdOf.get("ANTHROPIC_API_KEY") === 3 && plan.fdOf.get("SECOND_KEY") === 4);
    ok("the flags name only descriptor numbers", plan.args.join(" ") === "--preserve-fd 3 --preserve-fd 4", plan.args.join(" "));
    ok("stdin is not used, so the agent's prompt channel is free", plan.stdio[0] === "ignore");
    ok("stdout and stderr are piped so they can be redacted before anything sees them", plan.stdio[1] === "pipe" && plan.stdio[2] === "pipe");

    const cmd = shimCommand(plan.fdOf, ["claude", "-p", "do the thing"]);
    const flat = cmd.join(" ");
    ok(
      "THE VALUE IS NOWHERE IN THE ARGV — the shim carries descriptor numbers and names only",
      !flat.includes(KEY),
      flat,
    );
    // HONESTY ABOUT WHAT THAT ASSERTION IS WORTH. `shimCommand` is never given a
    // value, so it cannot leak one — the property is structural rather than
    // checked, and the assertion above would pass on any implementation. It is
    // kept because the structure is the point, and the two below carry the
    // actual load: one shows the predicate CAN be true, and the live
    // /proc/1/cmdline test shows it is false for a real container.
    ok(
      "the argv check is not vacuous: the same predicate DOES fire on a spliced-in value",
      ["run", "--rm", "-e", `ANTHROPIC_API_KEY=${KEY}`, "img"].join(" ").includes(KEY),
    );
    ok(
      "shimCommand takes descriptors, never values — the leak is structurally unavailable to it",
      shimCommand.length === 2,
      `arity ${shimCommand.length}`,
    );
    ok("the shim reads each fd into its own variable", flat.includes('export ANTHROPIC_API_KEY="$(cat <&3)"') && flat.includes('export SECOND_KEY="$(cat <&4)"'), flat);
    ok(
      "the shim execs, so the shell does not linger holding the value",
      flat.includes('exec "$@"'),
      flat,
    );
    ok("the real command survives the wrapping", cmd.slice(-3).join(" ") === "claude -p do the thing");
  }

  /* ---------------------------------------------- the scanner, proven first */

  {
    // THE MOST IMPORTANT TEST IN THIS FILE. Every leak assertion below is an
    // absence, and an absence is what a broken scanner reports for everything.
    const planted = join(TMP, "planted", "deep", "file.txt");
    mkdirSync(join(TMP, "planted", "deep"), { recursive: true });
    writeFileSync(planted, `nothing to see\nkey=${KEY}\nmore text\n`);
    const b64 = join(TMP, "planted", "deep", "b64.txt");
    writeFileSync(b64, `blob=${Buffer.from(KEY).toString("base64")}\n`);
    const clean = join(TMP, "planted", "clean.txt");
    writeFileSync(clean, "a git sha 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432 and nothing else\n");

    const files = walkFiles(join(TMP, "planted"));
    const hits = scanFiles(files, { ANTHROPIC_API_KEY: KEY });
    ok("the scanner is not vacuous: it FINDS a planted raw value", hits.some((h) => h.file === planted), JSON.stringify(hits));
    ok("the scanner finds a planted BASE64 value", hits.some((h) => h.file === b64), JSON.stringify(hits));
    ok("the scanner does not flag a clean file", !hits.some((h) => h.file === clean));
    ok("walkFiles found the files it was meant to", files.length === 3, `${files.length}`);
  }

  /* ------------------------------------------------- the event log, end to end */

  {
    // A run whose "agent" does the worst thing: prints its own key. The line
    // goes through the redactor on the way to the log, which is the only order
    // that can work — the log is append-only, so there is no after-the-fact fix.
    const logPath = join(TMP, "events-2026-08-30.jsonl");
    const redact = makeRedactor({ ANTHROPIC_API_KEY: KEY });
    const agentOutput = [
      `starting up with ANTHROPIC_API_KEY=${KEY}`,
      `POST https://api.anthropic.com/v1/messages  Authorization: Bearer ${KEY}`,
      `{"error":"invalid x-api-key","sent":"${KEY}"}`,
      `retrying with ${Buffer.from(KEY).toString("base64")}`,
    ];
    for (const line of agentOutput) {
      appendFileSync(
        logPath,
        redact(JSON.stringify({ t: new Date().toISOString(), run: "r_test", task: "H-0", kind: "agent", level: "info", detail: line })) + "\n",
      );
    }
    const written = readFileSync(logPath, "utf8");
    ok("THE KEY VALUE IS NOT IN THE EVENT LOG AFTER A RUN THAT USED IT", !written.includes(KEY));
    ok("nor is its base64 copy", !written.includes(Buffer.from(KEY).toString("base64")));
    ok(
      "and the log is still valid JSONL that a dashboard can read",
      written.trim().split("\n").every((l) => {
        try {
          return JSON.parse(l).task === "H-0";
        } catch {
          return false;
        }
      }),
    );
    ok(
      "the redaction is visible rather than silent — the log says a secret was here",
      written.includes("[redacted:ANTHROPIC_API_KEY]"),
      "a log that drops the field instead is a lie, and the next reader debugs a phantom",
    );
    ok(
      "scanning the written log with the audit scanner agrees",
      scanFiles([logPath], { ANTHROPIC_API_KEY: KEY }).length === 0,
    );
  }

  /* ------------------------------------------------------------- live run */

  const podman = spawnSync("sh", ["-c", "command -v podman"], { encoding: "utf8" }).status === 0;
  const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "docker.io/library/nginx:alpine";
  const haveImage = podman && spawnSync("podman", ["image", "exists", IMAGE], { stdio: "ignore" }).status === 0;

  if (!podman) {
    skip("live: the secret crosses into a real container", "podman not on PATH");
  } else if (!haveImage) {
    skip("live: the secret crosses into a real container", `image ${IMAGE} not present locally`);
  } else if (!supportsPreserveFd("podman")) {
    const version = spawnSync("podman", ["--version"], { encoding: "utf8" }).stdout.trim();
    skip("live: the secret crosses into a real container", `${version} has no --preserve-fd`);
    // What CAN be checked on this podman: the CLI refuses by name, before any
    // secret is read or any container starts, rather than crashing on the pipe.
    const r = spawnSync(
      "node",
      [new URL("./secrets.mjs", import.meta.url).pathname, "exec", "--require", "ANTHROPIC_API_KEY", "--image", IMAGE, "--", "true"],
      { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: KEY } },
    );
    ok(
      "live: on a podman without --preserve-fd, exec refuses by name instead of crashing",
      r.status === 3 && /has no --preserve-fd/.test(r.stderr) && !/ECONNRESET|node:events/.test(r.stderr),
      `exit ${r.status}: ${r.stderr.trim()}`,
    );
  } else {
    /** Run `script` in a container with the secrets delivered over preserved fds. */
    const inside = (names, values, script, extraArgs = []) =>
      new Promise((done) => {
        const plan = preserveFdPlan(names);
        const args = [
          "run", "--rm", "--network", "none", "--read-only",
          "--tmpfs", "/tmp:rw,size=64m", "--tmpfs", "/run:rw,size=64m",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          ...extraArgs, ...plan.args, IMAGE,
          ...shimCommand(plan.fdOf, ["sh", "-c", script]),
        ];
        const child = spawn("podman", args, { stdio: plan.stdio });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        for (const [n, fd] of plan.fdOf) child.stdio[fd].end(values[n]);
        child.on("exit", (code) => done({ out, code, args }));
      });

    {
      const r = await inside(["ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: KEY }, 'printf "GOT:%s" "$ANTHROPIC_API_KEY"');
      ok("live: the secret arrives inside the container over the pipe", r.out.includes(`GOT:${KEY}`), r.out.trim());
    }

    {
      const r = await inside(
        ["FIRST_KEY", "SECOND_KEY"],
        { FIRST_KEY: KEY, SECOND_KEY: UNSHAPED },
        'printf "1:%s 2:%s" "$FIRST_KEY" "$SECOND_KEY"',
      );
      ok(
        "live: two secrets arrive on their own descriptors, uncrossed",
        r.out.includes(`1:${KEY}`) && r.out.includes(`2:${UNSHAPED}`),
        r.out.trim(),
      );
    }

    {
      // The container's own view of the host: podman's argv is not visible from
      // inside, but the container's argv is, and that is where a naive shim
      // would have put the value.
      const r = await inside(
        ["ANTHROPIC_API_KEY"],
        { ANTHROPIC_API_KEY: KEY },
        'tr "\\0" " " < /proc/1/cmdline; echo; echo "PS:"; ps -eo args 2>/dev/null | head -5',
      );
      ok(
        "live: the value is NOT in the container's own process arguments",
        !r.out.includes(KEY),
        r.out.trim().slice(0, 300),
      );
    }

    {
      // The headline claim. A container that is running with the secret loaded,
      // inspected from the host.
      const name = `foreman-h0-inspect-${process.pid}`;
      spawnSync("podman", ["rm", "-f", name], { stdio: "ignore" });
      const plan = preserveFdPlan(["ANTHROPIC_API_KEY"]);
      const child = spawn(
        "podman",
        [
          "run", "--name", name, "--network", "none", "--read-only",
          "--tmpfs", "/tmp:rw,size=64m", "--tmpfs", "/run:rw,size=64m",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          ...plan.args, IMAGE,
          ...shimCommand(plan.fdOf, ["sh", "-c", "sleep 4"]),
        ],
        { stdio: plan.stdio },
      );
      child.stdio[3].end(KEY);
      await new Promise((r) => setTimeout(r, 1500));

      const inspect = scanCommand("podman", ["inspect", name], { ANTHROPIC_API_KEY: KEY });
      ok(
        "live: THE KEY IS NOT IN `podman inspect` — measured at 2 hits for -e and 1 for --env-file",
        inspect.hits.length === 0 && inspect.status === 0,
        `hits=${JSON.stringify(inspect.hits)} inspect-status=${inspect.status}`,
      );

      // Non-vacuous: the same scanner against the same command DOES find a value
      // that really is in there, so the zero above is a fact about the mechanism
      // rather than about the scanner.
      const control = scanCommand("podman", ["inspect", name], { PROBE: IMAGE });
      ok(
        "live: the inspect scanner is not vacuous — it finds the image name in the same output",
        control.hits.length > 0,
        JSON.stringify(control),
      );

      const imageScan = scanCommand("podman", ["image", "history", "--no-trunc", IMAGE], { ANTHROPIC_API_KEY: KEY });
      ok("live: the key is not in the image history", imageScan.hits.length === 0, JSON.stringify(imageScan.hits));

      await new Promise((r) => child.on("exit", r));
      spawnSync("podman", ["rm", "-f", name], { stdio: "ignore" });
    }

    {
      // The container writes the key into the ONE path it can write that
      // survives: the bind-mounted repo. Proving the mount is the exposure, not
      // the channel — and that the audit scanner would catch it if a future
      // change made the agent do this for real.
      const work = join(TMP, "work");
      mkdirSync(work, { recursive: true });
      const plan = preserveFdPlan(["ANTHROPIC_API_KEY"]);
      const child = spawn(
        "podman",
        [
          "run", "--rm", "--network", "none", "--read-only",
          "--tmpfs", "/tmp:rw,size=64m", "--tmpfs", "/run:rw,size=64m",
          "-v", `${work}:/work:Z`, "-w", "/work",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          ...plan.args, IMAGE,
          ...shimCommand(plan.fdOf, ["sh", "-c", 'printf "%s" "$ANTHROPIC_API_KEY" > /work/leaked.txt']),
        ],
        { stdio: plan.stdio },
      );
      child.stdio[3].end(KEY);
      await new Promise((r) => child.on("exit", r));
      const found = scanFiles(walkFiles(work), { ANTHROPIC_API_KEY: KEY });
      ok(
        "live: `secrets.mjs audit` catches a key written into the bind-mounted repo",
        found.length === 1,
        "the mount is a channel this module cannot close — an agent that chooses to write its " +
          "key into /work has done so. The audit is what makes that visible before a commit does.",
      );
    }

    {
      // And the real repo, right now, with the real test value: clean.
      const repoHits = scanFiles(walkFiles(process.cwd()), { ANTHROPIC_API_KEY: KEY, OTHER: UNSHAPED });
      const outsideThisFile = repoHits.filter((h) => !h.file.endsWith("secrets.test.mjs"));
      ok(
        "the repo working tree contains no secret value outside this test's own fixture",
        outsideThisFile.length === 0,
        JSON.stringify(outsideThisFile),
      );
    }
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\n[secrets] all checks passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n[secrets] ${failures} FAILURE(S) above${skipped ? `, ${skipped} skipped` : ""}.`,
);
process.exit(failures === 0 ? 0 : 1);
