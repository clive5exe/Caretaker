#!/usr/bin/env node
/**
 * TOOL-USE FIXTURE — H-10. Score a candidate model on the three behaviours an
 * agent loop lives or dies on, which a code benchmark does not measure
 * (docs/vendors.md, "THE DISCRIMINATOR IS TOOL-USE RELIABILITY"):
 *
 *   1. well-formed tool calls, every time
 *   2. stopping when the work is done
 *   3. not calling a tool that was never offered
 *
 * plus whether it actually did the task. The task is fixed and small, and has
 * one known-good result, so two candidates are compared on the same thing:
 * read a file, then write a second file derived from it. It needs a read, a
 * write and a stop, and nothing else.
 *
 * The run goes through the ordinary seam — `harness.run` with the
 * openai-compatible adapter — in a throwaway workspace, so the result is
 * measured the same way as real work: the diff, not the model's account.
 *
 * Usage:
 *   node bin/tool-fixture.mjs --endpoint http://localhost:11434/v1 --model qwen2.5-coder
 *        [--api-key-env VAR] [--runs N] [--sandbox podman|none] [--image IMG] [--json]
 *   --sandbox defaults to podman: the candidate's shell commands are untrusted.
 * Exit: 0 every run passed, 1 any run did not, 2 misuse.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./harness.mjs";

export const FIXTURE = {
  seed: { "names.txt": "ada\ngrace\nlinus\n" },
  prompt:
    "Read names.txt. Write a file named upper.txt containing the same names in UPPER CASE, " +
    "one per line, in the same order, ending with a newline. Change nothing else. Then stop.",
  expect: { "upper.txt": "ADA\nGRACE\nLINUS\n" },
};

/** Score one run's outcome. Pure, so it is testable without a model. */
export function score(out, ws) {
  const tu = out.verdict.toolUse ?? null;
  const changed = out.diff.measured ? out.diff.files.map((f) => f.path).sort() : null;
  const want = Object.keys(FIXTURE.expect).sort();
  const correct =
    changed !== null &&
    JSON.stringify(changed) === JSON.stringify(want) &&
    want.every((p) => existsSync(join(ws, p)) && readFileSync(join(ws, p), "utf8") === FIXTURE.expect[p]);
  const checks = {
    completed: out.verdict.state === "completed",
    correct,
    wellFormed: tu !== null && tu.malformed === 0,
    noInvented: tu !== null && tu.invented === 0,
    stopped: tu !== null && tu.stopped === true,
  };
  return { pass: Object.values(checks).every(Boolean), checks, toolUse: tu, changed, state: out.verdict.state, tokens: out.cost.tokens.total };
}

export async function runFixture(policy, { runs = 1 } = {}) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const ws = mkdtempSync(join(tmpdir(), "tool-fixture-"));
    try {
      for (const [p, c] of Object.entries(FIXTURE.seed)) writeFileSync(join(ws, p), c);
      const logDir = join(tmpdir(), `tool-fixture-logs-${process.pid}-${i}-${Date.now()}`);
      mkdirSync(logDir, { recursive: true });
      const out = await run(ws, FIXTURE.prompt, { adapter: "openai-compatible", events: false, logDir, ...policy });
      results.push(score(out, ws));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { runs: results.length, passed, results };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const KNOWN = new Set(["endpoint", "model", "api-key-env", "runs", "sandbox", "image", "json", "timeout"]);
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.replace(/^--/, "").split("=")[0];
    if (!a.startsWith("--") || !KNOWN.has(key)) {
      console.error(`tool-fixture: unknown argument ${a}`);
      process.exit(2);
    }
    if (key === "json") f.json = true;
    else f[key] = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
  }
  if (!f.endpoint || !f.model) {
    console.error("usage: tool-fixture.mjs --endpoint URL --model M [--api-key-env VAR] [--runs N] [--sandbox podman|none] [--image IMG] [--json]");
    process.exit(2);
  }
  const policy = {
    endpoint: f.endpoint,
    model: f.model,
    // The model under test is untrusted: its `run` calls are shell commands.
    // In the sandbox by default; on the host only when asked for by name.
    sandbox: f.sandbox ?? "podman",
    ...(f["api-key-env"] ? { apiKeyEnv: f["api-key-env"] } : {}),
    ...(f.image ? { image: f.image } : {}),
    ...(f.timeout ? { timeoutMs: Number(f.timeout) } : {}),
  };
  const r = await runFixture(policy, { runs: Number(f.runs ?? 3) });
  if (f.json) console.log(JSON.stringify(r, null, 2));
  else {
    r.results.forEach((x, i) => {
      const bad = Object.entries(x.checks).filter(([, v]) => !v).map(([k]) => k);
      console.log(`run ${i + 1}: ${x.pass ? "PASS" : `FAIL (${bad.join(", ")})`}  calls ${x.toolUse?.calls ?? "?"}, malformed ${x.toolUse?.malformed ?? "?"}, invented ${x.toolUse?.invented ?? "?"}, turns ${x.toolUse?.turns ?? "?"}, tokens ${x.tokens ?? "unknown"}`);
    });
    console.log(`[tool-fixture] ${f.model}: ${r.passed}/${r.runs} passed`);
  }
  process.exit(r.passed === r.runs ? 0 : 1);
}
