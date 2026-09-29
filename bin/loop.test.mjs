#!/usr/bin/env node
/**
 * B-5 and B-8: the unattended loop records what the pass said and what it
 * spent, although it calls its CLI directly rather than through runstore.
 *
 * A scratch repo with the installed layout (ops/caretaker/loop.sh, run.mjs,
 * config.json, prompt.txt) and a stand-in `claude` that prints the JSON shape
 * `claude -p --output-format json` prints: a DECISION line, a key-shaped
 * string, a token breakdown, turns and one model.
 *
 * Run: node bin/loop.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "loop-test-"));
const KEY = "sk-ant-api03-" + "x".repeat(40);
const OAUTH = "oauth-token-value-0123456789";

function repo(name) {
  const root = join(TMP, name);
  const ops = join(root, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  for (const f of ["loop.sh", "run.mjs"]) copyFileSync(join(HERE, f), join(ops, f));
  chmodSync(join(ops, "loop.sh"), 0o755);
  writeFileSync(join(ops, "config.json"), JSON.stringify({ runs: "ops/caretaker/runs.jsonl", stateDir: join(root, "state"), repo: "." }));
  writeFileSync(join(ops, "prompt.txt"), "do one task\n");
  const claude = join(root, "fake-claude");
  writeFileSync(
    claude,
    `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
      type: "result",
      result: `Did T-1.\nDECISION: retry the upload twice because the API rate-limits a third\nleaked ${KEY} and ${OAUTH}`,
      num_turns: 7,
      usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 40 },
      modelUsage: { "claude-test-model": {} },
    })}\nJSON\n`,
  );
  chmodSync(claude, 0o755);
  return { root, ops, claude };
}
const loop = (r, env = {}) =>
  spawnSync("bash", [join(r.ops, "loop.sh")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_BIN: r.claude, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ...env },
  });
const rows = (r) => (existsSync(join(r.ops, "runs.jsonl")) ? readFileSync(join(r.ops, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

{
  const r = repo("with-harvest");
  const outs = () => new Set(readdirSync("/tmp").filter((f) => f.startsWith("caretaker-loop-out.")));
  const before = outs();
  const res = loop(r, { CARETAKER_HARVEST: join(HERE, "harvest.mjs") });
  const left = [...outs()].filter((f) => !before.has(f));
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  const skipped = /skip — only/.test(log);
  ok("the pass ran (not skipped for memory)", res.status === 0 && !skipped, log);
  const row = rows(r).at(-1);
  ok("the run row carries the token breakdown, and the total is derived from it", row?.in === 100 && row.cached === 2000 && row.write === 300 && row.out === 40 && row.tokens === 2440, JSON.stringify(row));
  ok("…and the turns and the one model", row?.turns === 7 && row.model === "claude-test-model");
  const runs = existsSync(join(r.root, "state", "runs")) ? readdirSync(join(r.root, "state", "runs")) : [];
  ok("the pass's output is archived as a run, and the row names it", runs.length === 1 && row?.run === runs[0], `${runs} ${row?.run}`);
  const dir = join(r.root, "state", "runs", runs[0] ?? "none");
  const h = existsSync(join(dir, "harvest.json")) ? JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) : null;
  ok("its DECISION line is harvested, recorded nowhere, so it reaches the Inbox", h?.decisions.length === 1 && /retry the upload twice/.test(h.decisions[0].text) && h.decisions[0].recordedIn === null, JSON.stringify(h));
  const archived = existsSync(join(dir, "transcript.log")) ? readFileSync(join(dir, "transcript.log"), "utf8") : "";
  ok("the archived output is redacted: a key by its shape", archived.length > 0 && !archived.includes(KEY), archived.slice(0, 300));
  ok("…and the CLI's own credential by its value", archived.length > 0 && !archived.includes(OAUTH));
  const rec = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : null;
  ok("run.json says what was not recorded, rather than leaving it empty", rec?.source === "loop.sh" && /did not go through runstore/.test(rec.notRecorded ?? ""));
  ok("the pass's unredacted output is deleted afterwards", left.length === 0, left.join());
}
{
  const r = repo("no-harvest");
  const res = loop(r, { CARETAKER_HARVEST: join(TMP, "nowhere.mjs") });
  const log = readFileSync(join(r.ops, "loop.log"), "utf8");
  ok("with no harvest.mjs, the pass still ends and says where decisions went", res.status === 0 && /no harvest\.mjs at .*decision lines kept here/.test(log), log);
  ok("…and the decision line is kept in loop.log, not lost with the output", /DECISION: retry the upload twice/.test(log));
  ok("…and the row still has the breakdown, with no run id", rows(r).at(-1)?.tokens === 2440 && rows(r).at(-1)?.run === undefined);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[loop] ${failures} FAILED` : "\n[loop] all checks passed");
process.exit(failures ? 1 : 0);
