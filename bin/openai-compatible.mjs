/**
 * THE OPENAI-COMPATIBLE ADAPTER — H-2 and H-10's SDK half.
 *
 * The second vendor, behind the same seam:
 *
 *     run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
 *
 * Nearly everything self-hosted speaks this API — Ollama, vLLM, SGLang,
 * llama.cpp, TGI — so one adapter covers them (docs/vendors.md). It uses plain
 * `fetch`; no vendor SDK is a dependency, and nothing above the harness knows
 * this file exists.
 *
 * WHERE THINGS RUN, which is the point of the SDK shape (docs/architecture.md):
 *
 *   the model call   HERE, in the harness process, above the dev environment.
 *                    So the container needs NO egress for the agent's own
 *                    traffic, and `net: none` works — which the CLI adapter
 *                    cannot do, since its model traffic starts inside.
 *   the tools        INSIDE the dev environment. With sandbox "podman" a
 *                    container is started for the run (rebuilt, limits,
 *                    read-only root, the repo at /work, no socket) and every
 *                    tool call is a `podman exec` in it. With sandbox "none"
 *                    tools run ON THE HOST: the three file tools are held to
 *                    the workspace by path checks, and `run` is a host shell
 *                    held to nothing at all. The run's warning says exactly
 *                    that; none is not a sandbox.
 *
 * FOUR TOOLS BY DEFAULT, deliberately few: list_files, read_file, write_file,
 * run. A small model with a short context does worse with a large menu, and
 * every extra tool is one more thing it can call wrongly. Which of them the
 * model gets, tools of your own, and a yes from you before a call runs are
 * all `policy.tools` (bin/tools.mjs).
 *
 * WHAT IT SCORES, because vendors.md names these as the real discriminator
 * and a benchmark score is not: `verdict.toolUse` counts malformed tool calls,
 * calls to tools that were never offered, and whether the model STOPPED on its
 * own before the turn ceiling. A call it gets wrong is answered with an error
 * and the loop continues; it is counted, never silently fixed.
 *
 * THE KEY. `policy.apiKeyEnv` names an environment variable of the harness
 * process; its value goes into the Authorization header and nowhere else. Not
 * into the policy (which runstore records), not into the transcript, not into
 * the container. A local server usually needs none, so the default is none.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { within } from "./paths.mjs";
import { buildArgs, checkLimits, delegatedControllers } from "./sandbox.mjs";
import { readDevcontainer, toLimits } from "./spec.mjs";
import { staged } from "./skills.mjs";
import { forModel, menu, needsApproval, terminalApprover } from "./tools.mjs";

const OUTPUT_CAP = 20_000;
const CMD_TIMEOUT_MS = 120_000;

export const TOOLS = [
  {
    name: "list_files",
    description: "List the entries of a directory in the repository. Paths are relative to the repository root.",
    parameters: { type: "object", properties: { path: { type: "string", description: "directory, default ." } }, required: [] },
  },
  {
    name: "read_file",
    description: "Read a text file from the repository.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the repository with the given content.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "run",
    description: "Run a shell command in the repository root and get its exit code and output.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];
/** Offered only when skills were staged for the run (S-1). */
export const READ_SKILL = {
  name: "read_skill",
  description: "Read one of the skills listed in the instructions: its SKILL.md, or another file inside it.",
  parameters: { type: "object", properties: { name: { type: "string" }, file: { type: "string", description: "default SKILL.md" } }, required: ["name"] },
};

/** Read a file from a staged skill, confined to that skill's directory. */
function readSkill(skillsDir, names, name, file) {
  if (!names.has(name)) return { ok: false, output: `no skill named ${JSON.stringify(name)}; the skills are: ${[...names].join(", ")}` };
  const base = join(skillsDir, name);
  const rel = confine(base, file ?? "SKILL.md");
  if (rel === null) return { ok: false, output: "refused: path is outside the skill" };
  const abs = resolve(base, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, output: `no such file in skill ${name}: ${file}` };
  return { ok: true, output: cap(readFileSync(abs, "utf8")) };
}

const cap = (s) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n[truncated: ${s.length - OUTPUT_CAP} more characters]` : s);

/**
 * A repository-relative path, or null if it leaves the repository. Absolute
 * paths, `..` segments that climb out, and (on the host) a symlink whose
 * target is outside are all refused.
 */
export function confine(root, p) {
  const raw = String(p ?? ".");
  if (isAbsolute(raw)) return null;
  const abs = resolve(root, raw);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel || ".";
}

/* -------------------------------------------------------------- executors */

/**
 * Run one tool command WITHOUT blocking the process, bounded by `timeoutMs`.
 *
 * A blocking spawnSync froze the whole harness for the length of the call, so
 * the run's own ceiling could not fire until it returned (a 1s ceiling took
 * 120s, independent review). Here the event loop keeps running, the limit is
 * the run's remaining time, and the whole process group is killed when the
 * command ends or runs out of time, so a `sleep 999 &` it left behind does not
 * hold the pipes open or outlive the call.
 */
export function runBounded(file, args, { cwd, input, timeoutMs, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer = null;
    let child;
    const cap16 = (buf, d) => (buf.length < 16 * 1024 * 1024 ? buf + d : buf);
    const finish = (status, signal, timedOut = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ status, signal, stdout, stderr, timedOut });
    };
    try {
      child = spawn(file, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    } catch (e) {
      return resolve({ status: null, signal: null, stdout: "", stderr: String(e.message), timedOut: false });
    }
    timer = setTimeout(() => finish(null, "SIGKILL", true), Math.max(1, timeoutMs));
    child.stdout.on("data", (d) => (stdout = cap16(stdout, d)));
    child.stderr.on("data", (d) => (stderr = cap16(stderr, d)));
    child.on("error", (e) => {
      stderr += String(e.message);
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // A background child can hold the pipes open after the command itself has
    // exited; `close` would then wait for it. Give the pipes a moment, then end.
    child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 250));
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? undefined : String(input));
  });
}

const timedOutNote = (r) => (r.timedOut ? "\nerror: stopped at the run's time limit" : "");

/**
 * Tools on the host, for sandbox:none only. The FILE tools are held to the
 * workspace by path checks; `run` is a host shell and is held to nothing.
 */
export function hostExecutor(ws) {
  const guard = (p, { write = false } = {}) => {
    const rel = confine(ws, p);
    if (rel === null) return null;
    const abs = resolve(ws, rel);
    // A WRITE never goes through a link. existsSync follows links, so a
    // DANGLING one used to read as "not there yet", the check walked up to its
    // (inside) parent, and writeFileSync then followed it out of the
    // workspace (independent review, reproduced). A link that exists and
    // points inside may still be READ.
    let isLink = false;
    try {
      isLink = lstatSync(abs).isSymbolicLink();
    } catch {
      /* not there */
    }
    if (write && isLink) return null;
    // Everything else is judged where it really lands, symlinks resolved
    // through the deepest part that exists (paths.mjs).
    if (!within(abs, ws) || !within(dirname(abs), ws)) return null;
    return abs;
  };
  return {
    list(p) {
      const abs = guard(p ?? ".");
      if (!abs) return { ok: false, output: "refused: path is outside the repository" };
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, output: `not a directory: ${p}` };
      return { ok: true, output: readdirSync(abs).sort().map((n) => (lstatSync(join(abs, n)).isDirectory() ? `${n}/` : n)).join("\n") };
    },
    read(p) {
      const abs = guard(p);
      if (!abs) return { ok: false, output: "refused: path is outside the repository" };
      if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, output: `no such file: ${p}` };
      return { ok: true, output: cap(readFileSync(abs, "utf8")) };
    },
    write(p, content) {
      const abs = guard(p, { write: true });
      if (!abs) return { ok: false, output: "refused: path is outside the repository" };
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(content));
      return { ok: true, output: `wrote ${Buffer.byteLength(String(content))} bytes to ${confine(ws, p)}` };
    },
    async run(command, { timeoutMs = CMD_TIMEOUT_MS, vars } = {}) {
      const r = await runBounded("sh", ["-c", String(command)], { cwd: ws, timeoutMs, env: vars });
      return { ok: r.status === 0, output: cap(`exit ${r.status ?? r.signal}\n${r.stdout}${r.stderr}${timedOutNote(r)}`) };
    },
    close() {
      return null;
    },
  };
}

/**
 * Tools inside a container started for this run. The container IS the
 * boundary here, so paths are still confined to /work for consistency, but a
 * command that wanders is wandering inside the sandbox, not on the host.
 */
export function containerExecutor({ runtime, name }) {
  let limit = CMD_TIMEOUT_MS;
  // `vars` become -e NAME=value: a custom tool's arguments, as variables and
  // never as command text (bin/tools.mjs).
  const exec = (args, input, vars = {}) =>
    runBounded(runtime, ["exec", ...(input !== undefined ? ["-i"] : []), ...Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-w", "/work", name, ...args], { input, timeoutMs: limit });
  const inRepo = (p) => confine("/work", p);
  return {
    setLimit(ms) {
      limit = Math.max(1, Math.min(CMD_TIMEOUT_MS, ms));
    },
    async list(p) {
      const rel = inRepo(p ?? ".");
      if (rel === null) return { ok: false, output: "refused: path is outside the repository" };
      const r = await exec(["ls", "-1Ap", "--", rel]);
      return { ok: r.status === 0, output: cap(r.status === 0 ? r.stdout.trim() : `${r.stderr}`.trim()) };
    },
    async read(p) {
      const rel = inRepo(p);
      if (rel === null) return { ok: false, output: "refused: path is outside the repository" };
      const r = await exec(["cat", "--", rel]);
      return { ok: r.status === 0, output: cap(r.status === 0 ? r.stdout : r.stderr.trim()) };
    },
    async write(p, content) {
      const rel = inRepo(p);
      if (rel === null) return { ok: false, output: "refused: path is outside the repository" };
      const r = await exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", rel], String(content));
      return { ok: r.status === 0, output: r.status === 0 ? `wrote ${Buffer.byteLength(String(content))} bytes to ${rel}` : r.stderr.trim() };
    },
    async run(command, { vars } = {}) {
      const r = await exec(["sh", "-c", String(command)], undefined, vars);
      return { ok: r.status === 0, output: cap(`exit ${r.status ?? r.signal}\n${r.stdout}${r.stderr}${timedOutNote(r)}`) };
    },
    close() {
      const r = spawnSync(runtime, ["rm", "-f", "-t", "2", name], { encoding: "utf8", timeout: 30_000 });
      return { attempted: true, removed: r.status === 0, detail: r.status === 0 ? null : String(r.stderr ?? "").trim() };
    },
  };
}

/* ------------------------------------------------------------------ loop */

async function dispatch(ex, call, offered, skill, timeLeft, approval) {
  const name = call?.function?.name;
  const names = new Set(offered.map((t) => t.name));
  if (!names.has(name)) return { invented: true, ok: false, output: `error: there is no tool named ${JSON.stringify(name)}. The tools are: ${[...names].join(", ")}` };
  let args;
  try {
    args = call.function.arguments === undefined || call.function.arguments === "" ? {} : JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
  } catch {
    return { malformed: true, ok: false, output: "error: the arguments were not a JSON object. Call the tool again with valid JSON arguments." };
  }
  const spec = offered.find((t) => t.name === name);
  const missing = spec.parameters.required.filter((k) => typeof args[k] !== "string");
  if (missing.length) return { malformed: true, ok: false, output: `error: ${name} needs ${missing.join(", ")} as string(s)` };
  // Asked AFTER the call is known to be well formed, so the operator is only
  // ever asked about a call that would really run.
  if (approval) {
    const verdict = await approval(name, args);
    if (!verdict.allow) return { refused: true, ok: false, output: `refused by the operator: this call was not run.${verdict.why ? ` Their reason: ${verdict.why}` : ""}` };
  }
  if (name === "read_skill") return skill(args.name, args.file);
  // Measured after the operator answered: waiting for a yes spends the run's time.
  const timeoutMs = timeLeft();
  if (timeoutMs <= 0) return { ok: false, output: "error: the run's time ran out before this call could run" };
  ex.setLimit?.(timeoutMs);
  if (spec.kind === "custom") {
    // Only the tool's declared arguments, and only strings, become variables.
    const bad = spec.argNames.filter((a) => args[a] !== undefined && typeof args[a] !== "string");
    if (bad.length) return { malformed: true, ok: false, output: `error: ${name} takes ${bad.join(", ")} as string(s)` };
    const vars = Object.fromEntries(spec.argNames.filter((a) => typeof args[a] === "string").map((a) => [a, args[a]]));
    return ex.run(spec.command, { timeoutMs, vars });
  }
  if (name === "list_files") return ex.list(args.path);
  if (name === "read_file") return ex.read(args.path);
  if (name === "write_file") return ex.write(args.path, args.content);
  return ex.run(args.command, { timeoutMs });
}

const systemPrompt = (containerised, skills) =>
  [
    "You are a software engineer working in a repository" + (containerised ? " mounted at /work inside a sandbox." : "."),
    "Use the tools to inspect and change files and to run commands. Paths are relative to the repository root.",
    "When the task is done, reply with a short summary and do NOT call a tool. That is how you signal you have finished.",
    ...(skills.length
      ? [
          "\n\nSkills are available. When one fits the task, read it with read_skill before you start, and follow it:",
          ...skills.map((s) => `\n- ${s.name}: ${s.description ?? "(no description)"}`),
        ]
      : []),
  ].join(" ");

/**
 * The adapter. Same contract as the CLI adapter: returns { exec, container,
 * file, toolUse }, never throws for an outcome (a failed or killed run is a
 * result), and throws only when nothing could run at all.
 */
export async function openaiCompatibleAdapter({ workspace, prompt, policy, paths, warnings, HarnessError, imageFor }) {
  if (!policy.endpoint) throw new HarnessError('adapter "openai-compatible" needs policy.endpoint, e.g. http://localhost:11434/v1');
  if (!policy.model) throw new HarnessError('adapter "openai-compatible" needs policy.model; the server serves more than one');
  const url = `${String(policy.endpoint).replace(/\/+$/, "")}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (policy.apiKeyEnv) {
    // A KEY NEVER CROSSES A NETWORK IN CLEARTEXT. Plain http is fine for a
    // model server on this machine (Ollama, llama.cpp); anywhere else it would
    // hand the key to every hop on the way (independent review).
    let u;
    try {
      u = new URL(String(policy.endpoint));
    } catch {
      throw new HarnessError(`policy.endpoint ${policy.endpoint} is not a URL`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
    if (u.protocol !== "https:" && !local) {
      throw new HarnessError(`refusing to send the ${policy.apiKeyEnv} key to ${u.origin} over plain http; use https, or a model server on this machine`);
    }
    const key = process.env[policy.apiKeyEnv];
    if (!key) throw new HarnessError(`policy.apiKeyEnv names ${policy.apiKeyEnv}, which is not set in the harness's environment`);
    headers.authorization = `Bearer ${key}`;
  }

  let ex;
  let container = null;
  if (policy.sandbox === "none") {
    warnings.push(
      "sandbox:none — tools ran on the HOST. The file tools were held to the workspace by path checks; the run " +
        "tool was a host shell held to nothing: no filesystem isolation, no resource ceiling and no egress control.",
    );
    ex = hostExecutor(workspace);
  } else {
    const dev = readDevcontainer(policy.devcontainer);
    const limits = toLimits(dev);
    const { image, imageId, built } = imageFor(policy, dev, warnings);
    for (const m of checkLimits(["memory", "cpus", "pids"], delegatedControllers().controllers)) {
      limits[m.limit] = null;
      warnings.push(`not limiting ${m.limit} — no "${m.controller}" cgroup controller is delegated, so the flag is omitted. This run is NOT bounded on ${m.limit}.`);
    }
    // Kept alive by a shell loop, not `sleep infinity`, which BusyBox images
    // do not all accept; the image only needs a POSIX sh for the tools anyway.
    const name = `caretaker-${policy.runId}`;
    const base = buildArgs({ image, limits, workdir: workspace, net: policy.net, cmd: ["sh", "-c", "while :; do sleep 3600; done"], runtime: policy.sandbox });
    if (base[0] !== "run") throw new HarnessError(`sandbox.buildArgs no longer starts with "run"`);
    const args = ["run", "-d", "--name", name, ...policy.extraRunFlags, ...base.slice(1)];
    const started = spawnSync(policy.sandbox, args, { encoding: "utf8", timeout: 120_000 });
    if (started.status !== 0) {
      return {
        exec: { spawnError: Object.assign(new Error(String(started.stderr || started.error?.message || "").trim()), { code: `container did not start (exit ${started.status})` }), exitCode: null, signal: null, killed: false, durationMs: 0 },
        container: null,
        file: policy.sandbox,
      };
    }
    container = { runtime: policy.sandbox, name, image, imageId, built };
    ex = containerExecutor(container);
  }

  const log = (obj) => appendFileSync(paths.stdout, `${JSON.stringify(obj)}\n`);
  const err = (line) => appendFileSync(paths.stderr, `${line}\n`);
  const skills = policy.skillsDir ? staged(policy.skillsDir) : [];
  const skillNames = new Set(skills.map((s) => s.name));
  const offered = [...menu(policy.tools, TOOLS), ...(skills.length ? [{ ...READ_SKILL, kind: "builtin" }] : [])];
  const skill = (name, file) => readSkill(policy.skillsDir, skillNames, name, file);
  const messages = [
    { role: "system", content: systemPrompt(Boolean(container), skills) },
    { role: "user", content: prompt },
  ];
  const tools = offered.map((t) => ({ type: "function", function: forModel(t) }));
  const toolUse = { calls: 0, malformed: 0, invented: 0, refused: 0, stopped: false, turns: 0 };
  // The operator's yes (bin/tools.mjs). A library caller may pass its own
  // `policy.approver`, which is how a UI answers instead of a terminal.
  const ask = policy.approver ?? terminalApprover;
  const always = new Set();
  const approval = async (name, args) => {
    if (!needsApproval(policy.tools, name) || always.has(name)) return { allow: true };
    let v;
    try {
      // An answer that never comes must not outlast the run.
      let timer;
      const out = new Promise((r) => (timer = setTimeout(() => r({ allow: false, why: "the run's time ran out waiting for an answer", via: "timeout" }), Math.max(0, deadline - Date.now()))));
      v = await Promise.race([Promise.resolve(ask(name, args)), out]);
      clearTimeout(timer);
    } catch (e) {
      v = { allow: false, why: `the approval could not be asked (${e.message}), so the call was refused`, via: "error" };
    }
    if (v?.allow && v.always) always.add(name);
    log({ type: "approval", turn: toolUse.turns, name, allow: Boolean(v?.allow), ...(v?.always ? { always: true } : {}), why: v?.why ?? null, via: v?.via ?? "approver" });
    return { allow: Boolean(v?.allow), why: v?.why ?? null };
  };
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0 };
  let usageSeen = false;
  const startedAt = Date.now();
  const deadline = startedAt + policy.timeoutMs;
  const exec = { spawnError: null, exitCode: null, signal: null, killed: false, killReason: null, durationMs: 0, startedAt };
  // The model's own last words, never a tool's output (finalTextOf, harness.mjs).
  let finalText = null;

  try {
    for (;;) {
      if (toolUse.turns >= policy.maxTurns) {
        exec.exitCode = 1;
        err(`did not stop within ${policy.maxTurns} turns`);
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        exec.killed = true;
        exec.killReason = "timeout";
        break;
      }
      toolUse.turns += 1;
      // The operator's messages, sent mid-run (bin/steer.mjs), reach the
      // model before this turn, marked as the operator's.
      for (const m of policy.steer?.() ?? []) {
        messages.push({ role: "user", content: `[operator, mid-run] ${m.text}` });
        log({ type: "steer", turn: toolUse.turns, text: m.text, by: m.by ?? null });
      }
      let res;
      let bodyText;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          // No tools at all is a setting, not a mistake: some servers refuse an
          // empty list, so an empty menu is sent as no menu.
          body: JSON.stringify({ model: policy.model, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
          signal: AbortSignal.timeout(remaining),
        });
        // Inside the try, under the same deadline: a server that sends its
        // headers and then stalls the body used to throw out of run()
        // entirely, and the run was logged as never started (independent
        // re-review).
        bodyText = await res.text();
      } catch (e) {
        if (e.name === "TimeoutError" || e.name === "AbortError") {
          exec.killed = true;
          exec.killReason = "timeout";
        } else if (toolUse.turns === 1 && !res) {
          // Nothing answered at all: the model is not there, which is
          // UNAVAILABLE, not a failure of the work.
          exec.spawnError = Object.assign(new Error(e.cause?.message ?? e.message), { code: e.cause?.code ?? "ENDPOINT_UNREACHABLE" });
        } else {
          exec.exitCode = 1;
          err(`the endpoint stopped answering on turn ${toolUse.turns}: ${e.cause?.message ?? e.message}`);
        }
        break;
      }
      if (!res.ok) {
        exec.exitCode = 1;
        err(`HTTP ${res.status} from ${url}: ${bodyText.slice(0, 2000)}`);
        break;
      }
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        exec.exitCode = 1;
        err(`the endpoint answered with something that is not JSON: ${bodyText.slice(0, 500)}`);
        break;
      }
      if (body.usage) {
        usageSeen = true;
        usage.prompt_tokens += body.usage.prompt_tokens ?? 0;
        usage.completion_tokens += body.usage.completion_tokens ?? 0;
        usage.cached_input_tokens += body.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const msg = body.choices?.[0]?.message;
      if (!msg) {
        exec.exitCode = 1;
        err(`no message in the response: ${bodyText.slice(0, 500)}`);
        break;
      }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      // Per-turn usage under names parseUsage does not read, so the totals on
      // the last line are the only ones it finds.
      log({ type: "assistant", turn: toolUse.turns, content: msg.content ?? null, tool_calls: calls, turnUsage: body.usage ? { in: body.usage.prompt_tokens ?? null, out: body.usage.completion_tokens ?? null } : null });
      messages.push({ role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (typeof msg.content === "string" && msg.content.trim()) finalText = msg.content;
      if (!calls.length) {
        toolUse.stopped = true;
        exec.exitCode = 0;
        break;
      }
      for (const call of calls) {
        if (Date.now() >= deadline) {
          exec.killed = true;
          exec.killReason = "timeout";
          break;
        }
        toolUse.calls += 1;
        // A tool that THROWS (a write into a directory, a permission error) is
        // a failed tool call, answered to the model like any other. Letting it
        // escape would end the whole run over one bad call and lose the diff.
        let out;
        try {
          // Each tool gets what is left of the run, never more: the ceiling
          // holds inside a turn, not only between turns.
          out = await dispatch(ex, call, offered, skill, () => Math.min(CMD_TIMEOUT_MS, deadline - Date.now()), approval);
        } catch (e) {
          out = { ok: false, output: `error: the ${call?.function?.name ?? "tool"} call failed: ${e.message}` };
        }
        if (out.malformed) toolUse.malformed += 1;
        if (out.invented) toolUse.invented += 1;
        if (out.refused) toolUse.refused += 1;
        log({ type: "tool", turn: toolUse.turns, name: call?.function?.name ?? null, ok: out.ok, output: out.output });
        messages.push({ role: "tool", tool_call_id: call.id, content: out.output });
      }
    }
  } finally {
    if (container) container.cleanup = ex.close();
  }

  exec.durationMs = Date.now() - startedAt;
  if (exec.killed) exec.signal = "SIGKILL";
  // The totals, last, so parseUsage reads the whole run rather than one turn.
  // The API's prompt_tokens INCLUDES cached tokens, while the harness's `in` is
  // fresh input only (cost.tokens is in + cached + write + out), so the cached
  // part is split out rather than counted twice. It is reported only when the
  // server reported some: a local model with no prompt cache reports none, and
  // that absence is the fact vendors.md says changes the cost model.
  log({
    type: "result",
    num_turns: toolUse.turns,
    ...(usageSeen
      ? {
          usage: {
            input_tokens: usage.prompt_tokens - usage.cached_input_tokens,
            output_tokens: usage.completion_tokens,
            ...(usage.cached_input_tokens ? { cache_read_input_tokens: usage.cached_input_tokens } : {}),
          },
        }
      : {}),
  });
  return { exec, container, file: url, toolUse, finalText };
}
