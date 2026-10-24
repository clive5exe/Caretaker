#!/usr/bin/env node
/**
 * CARETAKER REVIEW — Warp's PR review, on your machine (docs/plan.md step 5).
 *
 *   node bin/review.mjs <pr-number> [--repo owner/repo] [--task T-1] [--post]
 *        [--cli claude|codex] [--sandbox podman|none] [--secret NAME]...
 *
 * It does not reimplement Warp's review. It runs the steps of the INSTALLED
 * .github/workflows/review-pull-requests.yml, as written, in order:
 *
 *   Resolve pull request metadata   (Warp's script, gh)
 *   Prepare review artifacts        (Warp's script: annotate_diff.py, build_review_context.py, ...)
 *   Clear untrusted review artifact (Warp's script)
 *   Review with Caretaker agent     (Warp's prompt, run by bin/agent-step.mjs)
 *   Materialize review.json         (Warp's script)
 *   validate                        (Warp's validate_review_json.py)
 *   Publish review.json             (Warp's script) ONLY with --post
 *
 * in a throwaway git worktree of HEAD, so the artifacts never land in your
 * checkout. Without --post nothing is written to GitHub: the review is printed
 * and kept in the run's archive. With --task, the verdict records the board's
 * reviewer gate (bin/review-gate.mjs).
 *
 * `gh` must be logged in (`gh auth login`); Warp's scripts use it. The agent
 * uses your AI login: on the host (--sandbox none) the CLI's own; in the
 * sandbox (the default) the token named by --secret, e.g. CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Exit: 0 reviewed, 1 the review could not be made or was invalid, 2 misuse.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentStep } from "./agent-step.mjs";
import { reviewGate, warpRejects } from "./review-gate.mjs";
import { evaluate, parseGithubOutput, readStep } from "./workflow-steps.mjs";

export class ReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewError";
  }
}

const WORKFLOW = ".github/workflows/review-pull-requests.yml";
const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/** Run one of Warp's `run:` scripts as Actions would: bash -eo pipefail, its env, a fresh $GITHUB_OUTPUT. */
function runStep(step, { cwd, ctx, extraEnv = {}, env = process.env, log = () => {} }) {
  const outFile = join(mkdtempSync(join(tmpdir(), "caretaker-step-")), "output");
  writeFileSync(outFile, "");
  const stepEnv = Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, evaluate(v, ctx)]));
  // An empty GH_TOKEN would override gh's own login with nothing.
  if (stepEnv.GH_TOKEN === "") delete stepEnv.GH_TOKEN;
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", evaluate(step.run, ctx)], {
    cwd,
    encoding: "utf8",
    env: { ...env, ...stepEnv, ...extraEnv, GITHUB_OUTPUT: outFile, GITHUB_WORKSPACE: cwd },
    maxBuffer: 64 * 1024 * 1024,
  });
  log(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  const outputs = parseGithubOutput(readFileSync(outFile, "utf8"));
  rmSync(outFile, { force: true });
  return { status: r.status, outputs, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export async function review({ pr, repo, task = null, post = false, cli = "claude", sandbox = "podman", secrets = null, configPath = "ops/caretaker/config.json", cwd = process.cwd(), env = process.env, stateDir = null, log = (s) => process.stderr.write(s) }) {
  if (!/^[0-9]+$/.test(String(pr))) throw new ReviewError(`the PR must be a number, got ${JSON.stringify(pr)}`);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(String(repo ?? ""))) throw new ReviewError(`--repo must be owner/repo, got ${JSON.stringify(repo)}`);
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (root.status !== 0) throw new ReviewError("run this inside the repository whose PR you are reviewing");
  const top = root.stdout.trim();
  const workflowText = spawnSync("git", ["show", `HEAD:${WORKFLOW}`], { cwd: top, encoding: "utf8" });
  if (workflowText.status !== 0) throw new ReviewError(`${WORKFLOW} is not committed here; install the factory first (node bin/vendor.mjs build)`);

  const wt = join(mkdtempSync(join(tmpdir(), "caretaker-review-")), "wt");
  const add = spawnSync("git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], { cwd: top, encoding: "utf8" });
  if (add.status !== 0) throw new ReviewError(`could not make a worktree: ${add.stderr.trim()}`);
  try {
    const ctx = { "github.token": env.GH_TOKEN ?? "", "github.repository": repo, "inputs.pr_number": String(pr), "github.event.pull_request.number": String(pr), "github.event_name": "workflow_dispatch" };
    const step = (job, name) => readStep(workflowText.stdout, job, name);
    const must = (r, what) => {
      if (r.status !== 0) throw new ReviewError(`Warp's "${what}" step failed:\n${r.output.trim()}`);
      return r;
    };

    const resolved = must(runStep(step("resolve", "Resolve pull request metadata"), { cwd: wt, ctx, env }), "Resolve pull request metadata").outputs;
    if (resolved.eligible !== "true") throw new ReviewError(`PR #${pr} is not open and ready for review (Warp's resolve step says eligible=${resolved.eligible})`);
    for (const k of ["pr_number", "base_sha", "head_sha"]) ctx[`needs.resolve.outputs.${k}`] = resolved[k];

    must(runStep(step("review", "Prepare review artifacts"), { cwd: wt, ctx, env, log }), "Prepare review artifacts");
    must(runStep(step("review", "Clear untrusted review artifact"), { cwd: wt, ctx, env }), "Clear untrusted review artifact");

    const agent = step("review", "Review with Caretaker agent");
    const names = secrets ?? CREDENTIALS.filter((n) => env[n]);
    const hosts = cli === "codex" ? ["api.openai.com"] : ["api.anthropic.com"];
    const ran = await agentStep({
      skill: evaluate(agent.with.skill, ctx),
      name: evaluate(agent.with.name, ctx),
      prompt: evaluate(agent.with.prompt, ctx),
      workspace: wt,
      cli,
      sandbox,
      secrets: names,
      egress: sandbox === "none" ? null : hosts,
      stateDir,
      env,
    });
    if (ran.state !== "completed") throw new ReviewError(`the agent did not complete (${ran.state}); its record is in ${ran.archived}`);
    ctx["steps.review.outputs.agent_output"] = ran.agentOutput;

    must(runStep(step("review", "Materialize review.json"), { cwd: wt, ctx, env }), "Materialize review.json");
    const rejected = warpRejects({ workspace: wt, reviewPath: join(wt, "review.json"), diffPath: join(wt, "pr_diff.txt") });
    if (rejected) throw new ReviewError(`Warp's validator rejected the review:\n${rejected}`);
    const kept = join(ran.archived, "review.json");
    copyFileSync(join(wt, "review.json"), kept);
    copyFileSync(join(wt, "pr_diff.txt"), join(ran.archived, "pr_diff.txt"));
    const result = { review: JSON.parse(readFileSync(kept, "utf8")), kept, runId: ran.runId, gate: null, posted: false };

    if (task) {
      const cfg = resolve(top, configPath);
      result.gate = await reviewGate({ reviewPath: kept, diffPath: join(ran.archived, "pr_diff.txt"), task, pr: `https://github.com/${repo}/pull/${pr}`, configPath: cfg, workspace: wt });
    }
    if (post) {
      must(runStep(step("publish", "Publish review.json"), { cwd: wt, ctx, env, log }), "Publish review.json");
      result.posted = true;
    }
    return result;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: top });
  }
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const f = { secret: [] };
  let pr = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--post") f.post = true;
    else if (["--repo", "--task", "--cli", "--sandbox", "--secret", "--config", "--state-dir"].includes(a) && argv[i + 1] !== undefined) {
      const k = a.slice(2);
      if (k === "secret") f.secret.push(argv[++i]);
      else f[k] = argv[++i];
    } else if (pr === null && /^[0-9]+$/.test(a)) pr = a;
    else {
      console.error("usage: review.mjs <pr-number> [--repo owner/repo] [--task T-1] [--post] [--cli claude|codex] [--sandbox podman|none] [--secret NAME]...");
      process.exit(2);
    }
  }
  if (pr === null) {
    console.error("review: which PR? usage: review.mjs <pr-number> [--repo owner/repo]");
    process.exit(2);
  }
  let repo = f.repo;
  if (!repo) {
    const v = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8" });
    repo = v.status === 0 ? v.stdout.trim() : null;
  }
  try {
    const r = await review({ pr, repo, task: f.task ?? null, post: Boolean(f.post), cli: f.cli ?? "claude", sandbox: f.sandbox ?? "podman", secrets: f.secret.length ? f.secret : null, configPath: f.config ?? "ops/caretaker/config.json", stateDir: f["state-dir"] ?? null });
    console.log(`\n${r.review.verdict} — PR #${pr}\n\n${r.review.body}\n`);
    for (const c of r.review.comments ?? []) console.log(`  ${c.path}:${c.line}  ${String(c.body).split("\n")[0]}`);
    console.log(`\nreview: ${r.kept}`);
    if (r.gate) console.log(`board: ${r.gate.task} reviewer ${r.gate.verdict}`);
    console.log(r.posted ? "posted to the PR" : "not posted (add --post to publish it with Warp's publish step)");
  } catch (e) {
    console.error(`[review] ${e.message}`);
    process.exit(e instanceof ReviewError ? 1 : 2);
  }
}
