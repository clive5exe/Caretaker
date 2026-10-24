#!/usr/bin/env node
/**
 * Warp's workflows, as installed with the patches (vendor/patches/), run on
 * the Caretaker agent step instead of Oz, and GitHub would accept them.
 *
 * actionlint checks each workflow, INCLUDING every input given to the local
 * action against factory/caretaker-agent/action.yml. It only resolves local
 * actions inside a git repository, so the build is made into one first
 * (without that, a wrong input passed silently: measured). actionlint is
 * found on PATH or at $ACTIONLINT; where it is missing that half is SKIPPED
 * by name, not passed.
 *
 * Run: node bin/workflows.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./vendor.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const ON_CARETAKER = ["review-pull-requests.yml", "triage-issues.yml", "implement-ready-issues.yml", "spec-ready-issues.yml", "improve-review-pr.yml"];
/** The agent's work ends in a PR: it cannot push from the sandbox, so the trusted step opens it (option A, docs/plan.md). */
const OPENS_PR = ["implement-ready-issues.yml", "spec-ready-issues.yml", "improve-review-pr.yml"];

const T = mkdtempSync(join(tmpdir(), "workflows-test-"));
try {
  const out = join(T, "repo");
  build(out);
  const wf = (f) => readFileSync(join(out, ".github/workflows", f), "utf8");
  for (const f of ON_CARETAKER) {
    const text = wf(f);
    ok(`${f}: its agent step is the Caretaker action`, /uses: \.\/\.github\/actions\/caretaker-agent\n/.test(text));
    ok(`${f}: no step uses Oz any more`, !/uses: warpdotdev\/oz-agent-action/.test(text));
    ok(`${f}: the agent is given your subscription token, not a Warp key`, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/.test(text) && !/warp_api_key:/.test(text));
  }
  for (const f of OPENS_PR) {
    const text = wf(f);
    ok(`${f}: the trusted step opens the PR (open_pr), not the agent`, /open_pr: "true"/.test(text) && /write the pull request title[\s\S]*\.caretaker\/pr\.md/.test(text));
    ok(`${f}: the prompt no longer asks for Oz computer use or Oz links`, !/computer_use: true|oz\.warp\.dev\/runs/.test(text));
    ok(`${f}: no unpinned \`npx skills add\` at run time (the skills are vendored)`, !/npx skills add/.test(text));
  }
  for (const f of ["review-pull-requests.yml", "triage-issues.yml"]) ok(`${f}: opens no PR (the agent only reads)`, !/open_pr:/.test(wf(f)));

  const bin = process.env.ACTIONLINT || "actionlint";
  const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (probe.error) console.log(`SKIP  actionlint on the patched workflows\n      ${bin} not found; set ACTIONLINT=/path/to/actionlint`);
  else {
    spawnSync("git", ["init", "-q", out]);
    const files = ON_CARETAKER.map((f) => join(".github/workflows", f));
    const lint = spawnSync(bin, ["-shellcheck=", ...files], { cwd: out, encoding: "utf8" });
    ok("actionlint accepts the patched workflows, inputs checked against action.yml", lint.status === 0, lint.stdout + lint.stderr);
  }
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
