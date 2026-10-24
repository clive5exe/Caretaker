#!/usr/bin/env node
/**
 * The Oz stand-in (bin/agent-step.mjs) runs a Warp skill through the harness
 * and hands back agent_output, the way oz-agent-action did.
 *
 * A FAKE MODEL: a `claude` on PATH that does what an agent following Warp's
 * review-pr skill does — writes review.json and validates it with Warp's own
 * script. So this proves the plumbing (prompt in, files out, Warp's validator
 * satisfied, token handed in and scrubbed, output in GitHub's format). It does
 * not prove a real model's review; that needs a real run with your login.
 *
 * Offline, sandbox:none. Run: node bin/agent-step.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentStepError, agentStep, githubOutput, permissionsFor, skillName } from "./agent-step.mjs";
import { build } from "./vendor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const rejects = async (p, re) => p.then(() => "resolved", (e) => (e instanceof AgentStepError && re.test(e.message) ? true : `${e.name}: ${e.message}`));

const T = mkdtempSync(join(tmpdir(), "agent-step-test-"));
const TOKEN = "sk-ant-oat01-FAKE-subscription-token-0123456789";
try {
  /* ------------------------------------------------------------ pieces */
  ok("a plain skill name", skillName("review-pr") === "review-pr");
  ok("Warp's owner/repo:skill form names this repo's skill", (() => {
    try {
      return skillName("clive5exe/Caretaker:triage") === "triage";
    } catch {
      return false;
    }
  })());
  ok("a skill name that could climb out of .agents/skills is refused", (() => {
    try {
      skillName("../../etc");
      return false;
    } catch (e) {
      return e instanceof AgentStepError;
    }
  })());
  const inBox = permissionsFor("claude", "podman");
  ok("in the container claude may act without asking, and IS_SANDBOX lets it as root", inBox.extraCliArgs.join(" ") === "--permission-mode bypassPermissions" && inBox.env.IS_SANDBOX === "1");
  const onHost = permissionsFor("claude", "none");
  ok("on the host nothing is bypassed: edits only, no IS_SANDBOX", onHost.extraCliArgs.join(" ") === "--permission-mode acceptEdits" && onHost.env.IS_SANDBOX === undefined);
  const g = githubOutput("agent_output", "line1\nline2");
  ok("agent_output is written as a GitHub multi-line output", /^agent_output<<(CARETAKER_[0-9a-f]{16})\nline1\nline2\n\1\n$/.test(g), g);

  /* ------------------------------------------- a workspace with the factory */
  const ws = join(T, "repo");
  build(ws);
  writeFileSync(join(ws, "app.py"), "def add(a, b):\n    return a - b\n");
  // Warp's own diff preparation, exactly as its workflow runs it.
  writeFileSync(join(ws, "raw_diff.txt"), "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a + b\n+    return a - b\n");
  const ann = spawnSync("python3", [".agents/skills/review-pr/scripts/annotate_diff.py", "--input", "raw_diff.txt", "--output", "pr_diff.txt"], { cwd: ws, encoding: "utf8" });
  ok("Warp's annotate_diff.py prepares the diff (vendored, unmodified)", ann.status === 0 && existsSync(join(ws, "pr_diff.txt")), ann.stderr);

  // The fake model.
  const bin = join(T, "bin");
  mkdirSync(bin);
  const seen = join(T, "seen.json");
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), prompt, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, cwd: process.cwd() }));
  const review = { verdict: "REJECT", body: "Found: 1 critical, 0 important, 0 suggestions\\nDisposition: Request changes", comments: [{ path: "app.py", line: 2, side: "RIGHT", body: "🚨 [CRITICAL] add() subtracts." }] };
  fs.writeFileSync("review.json", JSON.stringify(review));
  const v = cp.spawnSync("python3", [".agents/skills/review-pr/scripts/validate_review_json.py", "--review-json", "review.json", "--diff", "pr_diff.txt"], { encoding: "utf8" });
  console.log(JSON.stringify({ type: "result", subtype: "success", result: "review.json written; validator exit " + v.status + "; token " + process.env.CLAUDE_CODE_OAUTH_TOKEN, usage: { input_tokens: 10, output_tokens: 5 } }));
});
`);
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const prompt = "Review GitHub pull request #3 using the review-pr skill.\nFirst read `.agents/skills/review-pr/SKILL.md`, then follow it exactly.";
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  const r = await agentStep({ skill: "review-pr", name: "Review PR #3", prompt, workspace: ws, sandbox: "none", secrets: ["CLAUDE_CODE_OAUTH_TOKEN"], stateDir: join(T, "state"), env });
  const s = existsSync(seen) ? JSON.parse(readFileSync(seen, "utf8")) : {};
  ok("the agent ran and completed", r.state === "completed", JSON.stringify(r));
  ok("the agent got Warp's prompt unchanged, on stdin", s.prompt === prompt);
  ok("the agent ran in the workspace", s.cwd === ws, s.cwd);
  ok("the subscription token reached the agent", s.token === TOKEN);
  ok("on the host claude was given acceptEdits, not bypass", (s.argv ?? []).join(" ").includes("--permission-mode acceptEdits") && !(s.argv ?? []).includes("bypassPermissions"), (s.argv ?? []).join(" "));
  const v = spawnSync("python3", [".agents/skills/review-pr/scripts/validate_review_json.py", "--review-json", "review.json", "--diff", "pr_diff.txt"], { cwd: ws, encoding: "utf8" });
  ok("the review.json it left is accepted by Warp's own validator", v.status === 0, v.stdout + v.stderr);
  ok("agent_output is the agent's final message", /^review\.json written; validator exit 0; token /.test(r.agentOutput), r.agentOutput);
  ok("the token is scrubbed from agent_output", !r.agentOutput.includes(TOKEN) && r.agentOutput.includes("[redacted:CLAUDE_CODE_OAUTH_TOKEN]"), r.agentOutput);
  ok("the run is archived outside the workspace", r.archived.startsWith(join(T, "state")) && existsSync(join(r.archived, "run.json")));
  ok("the archived transcript does not hold the token", !readFileSync(join(r.archived, "transcript.log"), "utf8").includes(TOKEN));

  /* -------------------------------------------------- the CLI, as the action runs it */
  const ghOut = join(T, "github_output");
  writeFileSync(ghOut, "");
  // The INSTALLED copy (build put it in the workspace with its own bin/), so
  // this also proves the action needs nothing else from Caretaker.
  const installed = join(ws, ".github/actions/caretaker-agent/bin/agent-step.mjs");
  ok("build installed the action's own copy of agent-step", existsSync(installed));
  const c = spawnSync(process.execPath, [installed, "--skill", "owner/repo:review-pr", "--prompt-env", "PROMPT", "--workspace", ws, "--sandbox", "none", "--secret", "CLAUDE_CODE_OAUTH_TOKEN", "--state-dir", join(T, "state2")], { encoding: "utf8", env: { ...env, PROMPT: prompt, GITHUB_OUTPUT: ghOut } });
  const written = readFileSync(ghOut, "utf8");
  ok("the CLI exits 0 when the agent completed", c.status === 0, c.stderr);
  ok("the CLI writes agent_output, run_id and state to $GITHUB_OUTPUT", /agent_output<<CARETAKER_/.test(written) && /\nrun_id=r_[0-9a-f]{8}\n/.test(written) && /\nstate=completed\n/.test(written), written);
  ok("the token is not in $GITHUB_OUTPUT", !written.includes(TOKEN));

  /* ------------------------------------------------------------ refusals */
  ok("a skill that is not installed is refused before anything runs", (await rejects(agentStep({ skill: "nope", prompt: "x", workspace: ws, sandbox: "none", env }), /no \.agents\/skills\/nope\/SKILL\.md/)) === true);
  ok("a --secret that is not set is refused by name", (await rejects(agentStep({ skill: "review-pr", prompt: "x", workspace: ws, sandbox: "none", secrets: ["CLAUDE_CODE_OAUTH_TOKEN"], env: {} }), /CLAUDE_CODE_OAUTH_TOKEN is not set/)) === true);
  ok("a --secret given as a value, not a name, is refused", (await rejects(agentStep({ skill: "review-pr", prompt: "x", workspace: ws, sandbox: "none", secrets: [TOKEN], env }), /takes a variable NAME/)) === true);
  ok("an empty prompt is refused", (await rejects(agentStep({ skill: "review-pr", prompt: "  ", workspace: ws, sandbox: "none", env }), /prompt is empty/)) === true);
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
