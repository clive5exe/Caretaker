#!/usr/bin/env node
/**
 * B-8: run.mjs derives a run's total from its token breakdown, and refuses a
 * total that disagrees with the parts rather than storing both.
 *
 * Run: node bin/run.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "run-test-"));
const ops = join(TMP, "ops", "caretaker");
mkdirSync(ops, { recursive: true });
const cfg = join(ops, "config.json");
writeFileSync(cfg, JSON.stringify({ runs: "ops/caretaker/runs.jsonl", repo: "." }));
const log = join(ops, "runs.jsonl");
const run = (...a) => spawnSync(process.execPath, [join(HERE, "run.mjs"), ...a, "--config", cfg], { encoding: "utf8" });
const rows = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

{
  const r = run("end", "--name", "b", "--in", "10", "--cached", "200", "--write", "30", "--out", "4");
  ok("the total is derived from the parts", r.status === 0 && rows().at(-1)?.tokens === 244, r.stderr);
}
{
  const r = run("end", "--name", "b", "--tokens", "244", "--in", "10", "--cached", "200", "--write", "30", "--out", "4");
  ok("a total that equals the parts is accepted", r.status === 0 && rows().length === 2);
}
{
  const r = run("end", "--name", "b", "--tokens", "999", "--in", "10", "--out", "4");
  ok("a total that disagrees with the parts is refused, by name", r.status === 2 && /--tokens 999 does not equal in \+ out = 14/.test(r.stderr), r.stderr);
  ok("…and nothing is written", rows().length === 2);
}
{
  const r = run("end", "--name", "b", "--tokens", "500");
  ok("a total alone is kept as given", r.status === 0 && rows().at(-1)?.tokens === 500 && rows().at(-1)?.in === undefined);
}
{
  const r = run("end", "--name", "b", "--in", "ten");
  ok("a part that is not a number is refused", r.status === 2 && /--in must be a number/.test(r.stderr) && rows().length === 3);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[run] ${failures} FAILED` : "\n[run] all checks passed");
process.exit(failures ? 1 : 0);
