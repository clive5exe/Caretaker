#!/usr/bin/env node
/**
 * Option A (docs/plan.md): the agent edits inside the sandbox; the trusted
 * step AFTER it (agent-step.mjs publish) commits exactly what the harness
 * measured the agent changing, pushes a branch, opens the PR with gh and links
 * it on the issue. Real git against a real bare "origin"; a fake `gh` records
 * what it was asked to do. The full CLI path runs a fake model too.
 *
 * Run: node bin/publish.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentStepError, publish } from "./agent-step.mjs";
import { build } from "./vendor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const T = mkdtempSync(join(tmpdir(), "publish-test-"));
try {
  // A fake gh: records its argv, prints a PR URL for `pr create`.
  const bin = join(T, "bin");
  mkdirSync(bin);
  const ghLog = join(T, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("https://github.com/o/r/pull/7");
`);
  chmodSync(join(bin, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  const fresh = (tag) => {
    const origin = join(T, `${tag}-origin.git`);
    const ws = join(T, `${tag}-ws`);
    git(T, "init", "-q", "--bare", "-b", "main", origin);
    git(T, "clone", "-q", origin, ws);
    const built = join(T, `${tag}-built`);
    build(built);
    cpSync(built, ws, { recursive: true });
    writeFileSync(join(ws, "app.py"), "def add(a, b):\n    return a - b\n");
    writeFileSync(join(ws, "old.py"), "x = 1\n");
    git(ws, "checkout", "-q", "-b", "main");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "base");
    git(ws, "push", "-q", "origin", "main");
    return { origin, ws };
  };

  /* ---------------------------------------------------- publish() directly */
  {
    const { origin, ws } = fresh("a");
    rmSync(ghLog, { force: true });
    // What the workflow made BEFORE the agent (improve-review-pr writes this).
    writeFileSync(join(ws, "feedback_corpus.json"), "{}\n");
    // What the agent did.
    writeFileSync(join(ws, "app.py"), "def add(a, b):\n    return a + b\n");
    git(ws, "mv", "old.py", "renamed.py");
    git(ws, "reset", "-q"); // the agent never stages: the index is as the checkout left it
    mkdirSync(join(ws, ".caretaker"), { recursive: true });
    writeFileSync(join(ws, ".caretaker", "pr.md"), "# Fix add() to add\n\nCloses #12\n");
    // A hook planted in the checkout's .git must NOT run (hooks are off).
    writeFileSync(join(ws, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(join(T, "HOOK-RAN"))}\n`);
    chmodSync(join(ws, ".git", "hooks", "pre-commit"), 0o755);

    const changed = ["app.py", "{old.py => renamed.py}", ".caretaker/pr.md"];
    const p = publish({ workspace: ws, changed, runId: "r_0123abcd", skill: "implementation", issue: "12", env });
    ok("the PR is opened and its URL returned", p.opened === true && p.url === "https://github.com/o/r/pull/7", JSON.stringify(p));
    ok("the branch is named for the skill and the run", p.branch === "caretaker/implementation-0123abcd");
    const show = git(origin, "show", "--name-status", "--format=%s", "caretaker/implementation-0123abcd");
    ok("the branch reached origin", show.status === 0, show.stderr);
    ok("the commit is titled from pr.md", show.stdout.startsWith("Fix add() to add\n"), show.stdout);
    ok("the agent's edit is committed", /\nM\tapp\.py/.test(show.stdout), show.stdout);
    ok("a rename is committed as one (old path removed, new added)", /\n(R\d*\told\.py\trenamed\.py|D\told\.py[\s\S]*A\trenamed\.py|A\trenamed\.py[\s\S]*D\told\.py)/.test(show.stdout), show.stdout);
    ok("a file the workflow made before the agent is NOT committed", !show.stdout.includes("feedback_corpus.json"));
    ok(".caretaker/ is never committed", !show.stdout.includes(".caretaker"));
    ok("a hook planted in .git did not run", !existsSync(join(T, "HOOK-RAN")));
    const calls = ghCalls();
    const create = calls.find((c) => c[0] === "pr" && c[1] === "create") ?? [];
    ok("gh opens the PR from that branch onto the checkout's branch", create.join(" ").includes("--base main --head caretaker/implementation-0123abcd --title Fix add() to add"), create.join(" "));
    const bodyFile = create[create.indexOf("--body-file") + 1];
    ok("the PR body is the agent's, marked as opened by Caretaker", bodyFile && /Closes #12[\s\S]*Opened by Caretaker \(run r_0123abcd\)/.test(readFileSync(bodyFile, "utf8")));
    ok("the PR link is posted on the issue", calls.some((c) => c.join(" ") === "issue comment 12 --body Pull request opened: https://github.com/o/r/pull/7"), JSON.stringify(calls));
  }
  {
    const { ws } = fresh("b");
    rmSync(ghLog, { force: true });
    const p = publish({ workspace: ws, changed: [".caretaker/pr.md"], runId: "r_00000001", skill: "spec", env });
    ok("an agent that changed nothing but pr.md opens no PR", p.opened === false && /changed no files/.test(p.why) && ghCalls().length === 0);
    ok("changes that were not measured open no PR", publish({ workspace: ws, changed: null, runId: "r_00000002", skill: "spec", env }).opened === false);
  }
  {
    const { ws } = fresh("c");
    rmSync(ghLog, { force: true });
    writeFileSync(join(ws, "app.py"), "changed\n");
    const p = publish({ workspace: ws, changed: ["app.py"], runId: "r_00000003", skill: "spec", name: "Spec issue #4", env });
    const create = ghCalls().find((c) => c[1] === "create") ?? [];
    ok("with no pr.md the PR still opens, titled from the run's name", p.opened && create.includes("Spec issue #4"), create.join(" "));
    ok("no issue given: nothing is posted on an issue", !ghCalls().some((c) => c[0] === "issue"));
  }
  {
    const { ws } = fresh("d");
    writeFileSync(join(ws, "app.py"), "changed\n");
    // origin gone: the push fails, and says so.
    git(ws, "remote", "set-url", "origin", join(T, "nowhere.git"));
    let err = null;
    try {
      publish({ workspace: ws, changed: ["app.py"], runId: "r_00000004", skill: "spec", env });
    } catch (e) {
      err = e;
    }
    ok("a push that fails is an error naming the step, not a silent success", err instanceof AgentStepError && /pushing the branch failed/.test(err.message), String(err));
  }

  /* ------------------------------------------- the CLI, with a fake model */
  {
    const { origin, ws } = fresh("e");
    rmSync(ghLog, { force: true });
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync("app.py", "def add(a, b):\\n    return a + b\\n");
  fs.mkdirSync(".caretaker", { recursive: true });
  fs.writeFileSync(".caretaker/pr.md", "Fix add\\n\\nCloses #5\\n");
  console.log(JSON.stringify({ type: "result", result: "done; the step after me opens the PR" }));
});
`);
    chmodSync(join(bin, "claude"), 0o755);
    const r = spawnSync(process.execPath, [join(HERE, "agent-step.mjs"), "--skill", "owner/repo:implementation", "--name", "Implement issue #5", "--prompt", "implement it", "--workspace", ws, "--sandbox", "none", "--state-dir", join(T, "state"), "--open-pr", "--issue", "5"], { encoding: "utf8", env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(20) } });
    ok("the CLI runs the agent, then opens the PR", r.status === 0 && /opened https:\/\/github\.com\/o\/r\/pull\/7 from caretaker\/implementation-[0-9a-f]{8} \(1 file\(s\)\)/.test(r.stderr), r.stderr);
    const branches = git(origin, "branch", "--list", "caretaker/*").stdout;
    ok("the agent's change is on a branch at origin", /caretaker\/implementation-[0-9a-f]{8}/.test(branches), branches);
    ok("the PR link is posted on issue 5", ghCalls().some((c) => c[0] === "issue" && c[2] === "5"));
    const bad = spawnSync(process.execPath, [join(HERE, "agent-step.mjs"), "--skill", "implementation", "--prompt", "x", "--workspace", ws, "--sandbox", "none", "--state-dir", join(T, "state"), "--open-pr", "--issue", "5; rm -rf /"], { encoding: "utf8", env });
    ok("an --issue that is not a number is refused", bad.status !== 0 && /--issue takes an issue number/.test(bad.stderr), bad.stderr);
  }
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
