/**
 * STEER — answer a running agent's questions and talk to it mid-run, from
 * outside the process running it (the web UI, through bin/serve.mjs).
 *
 * The channel is FILES in the run's archive directory, `<runDir>/control/`,
 * so the server never holds a connection to the run and never runs anything:
 *
 *   ask-<n>.json      the harness asks: may the agent call <name>(<args>)?
 *   answer-<n>.json   the operator answers: { allow, always?, why? }
 *   steer.jsonl       the operator's messages, one per line: { t, text, by }
 *
 * The run's side (runstore.mjs --steer web): fileApprover() is the adapter's
 * `policy.approver` (tools.approve in bin/tools.mjs) and fileInbox() its
 * `policy.steer`, read before every model turn. The operator's side
 * (readmodel.mjs, for serve.mjs): pendingAsks(), answer(), steer().
 *
 * WHAT IT REACHES. Only a run where Caretaker drives the tool loop: the
 * openai-compatible adapter. A CLI (claude, codex) runs its own loop and
 * answers its own permission prompts; nothing here can reach inside it.
 *
 * A run is LIVE while its directory has no run.json: runstore writes that once,
 * when the run is archived. Nothing is written into a finished run.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export class SteerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SteerError";
    this.code = code;
  }
}

const MAX_TEXT = 4000;
export const controlDir = (runDir) => join(runDir, "control");
const writeAtomic = (p, text) => {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
export const isLive = (runDir) => existsSync(runDir) && !existsSync(join(runDir, "run.json"));

/* ------------------------------------------------------------ run's side */

/**
 * An approver that asks through the files and waits for the answer. `redact`
 * is applied to the arguments before they are written, as to every other file
 * in the archive. Resolves { allow, always?, why?, via: "web" }.
 */
export function fileApprover(runDir, { redact = (s) => s, pollMs = 250, now = () => new Date() } = {}) {
  let n = 0;
  return async (name, args) => {
    n += 1;
    const dir = controlDir(runDir);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `ask-${n}.json`), `${redact(JSON.stringify({ n, name, args, t: now().toISOString() }))}\n`);
    const answerPath = join(dir, `answer-${n}.json`);
    for (;;) {
      const a = existsSync(answerPath) ? readJson(answerPath) : null;
      if (a) return { allow: a.allow === true, ...(a.always === true ? { always: true } : {}), why: typeof a.why === "string" && a.why ? a.why : null, via: "web" };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
}

/** Messages written since the last call, oldest first: the adapter's `policy.steer`. */
export function fileInbox(runDir) {
  let seen = 0;
  return () => {
    const p = join(controlDir(runDir), "steer.jsonl");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const fresh = lines.slice(seen).flatMap((l) => {
      try {
        const m = JSON.parse(l);
        return typeof m.text === "string" && m.text.trim() ? [m] : [];
      } catch {
        return [];
      }
    });
    seen = lines.length;
    return fresh;
  };
}

/* ------------------------------------------------------- operator's side */

/** Questions not yet answered, and every message sent, for one run. */
export function control(runDir) {
  const dir = controlDir(runDir);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const answered = new Set(files.filter((f) => /^answer-\d+\.json$/.test(f)).map((f) => f.slice(7, -5)));
  const asks = files
    .filter((f) => /^ask-\d+\.json$/.test(f))
    .map((f) => readJson(join(dir, f)))
    .filter((a) => a && !answered.has(String(a.n)))
    .sort((a, b) => a.n - b.n);
  const steerPath = join(dir, "steer.jsonl");
  const messages = existsSync(steerPath) ? readFileSync(steerPath, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  return { live: isLive(runDir), pending: asks, messages };
}

/** Answer question `n`. Refused for a finished run, an unknown or already-answered question. */
export function answer(runDir, n, { allow, always = false, why = null, by = null } = {}) {
  if (!isLive(runDir)) throw new SteerError("NOT_LIVE", "the run has finished; there is nothing left to answer");
  if (!Number.isInteger(n) || n < 1) throw new SteerError("BAD_ASK", "a question is a positive whole number");
  if (typeof allow !== "boolean") throw new SteerError("BAD_ANSWER", "allow must be true or false");
  const dir = controlDir(runDir);
  if (!existsSync(join(dir, `ask-${n}.json`))) throw new SteerError("NO_ASK", `the run has asked no question ${n}`);
  const p = join(dir, `answer-${n}.json`);
  if (existsSync(p)) throw new SteerError("ANSWERED", `question ${n} is already answered`);
  const reason = why === null || why === undefined ? null : String(why).slice(0, MAX_TEXT);
  writeAtomic(p, `${JSON.stringify({ allow, ...(allow && always ? { always: true } : {}), why: reason, by, t: new Date().toISOString() })}\n`);
  return { n, allow };
}

/** Send the running agent a message; it reads it before its next turn. */
export function steer(runDir, text, { by = null } = {}) {
  if (!isLive(runDir)) throw new SteerError("NOT_LIVE", "the run has finished; there is no one to tell");
  const t = String(text ?? "").trim();
  if (!t) throw new SteerError("EMPTY", "the message is empty");
  if (t.length > MAX_TEXT) throw new SteerError("TOO_LONG", `a message is at most ${MAX_TEXT} characters`);
  const dir = controlDir(runDir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "steer.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), text: t, by })}\n`);
  return { sent: true };
}
