#!/usr/bin/env node
/**
 * AGENT STEP — Caretaker's stand-in for Warp's `oz-agent-action` (docs/plan.md).
 *
 * In every Warp workflow the agent is ONE step:
 *
 *     uses: warpdotdev/oz-agent-action@v1.0.25
 *     with: { skill, name, prompt, warp_api_key, profile }   -> agent_output
 *
 * This is that step without Oz: the same prompt, run by YOUR AI (Claude or
 * ChatGPT, on your subscription) through Caretaker's harness, inside the
 * sandbox, handing back `agent_output` the way Oz did. Everything before and
 * after it in the workflow stays Warp's own code. The GitHub action that calls
 * this is factory/caretaker-agent/action.yml; it also runs on your own machine.
 *
 * SUBSCRIPTION FIRST. `claude setup-token` prints a token for your Claude
 * subscription; pass it by name with --secret CLAUDE_CODE_OAUTH_TOKEN. It is
 * handed to the container as an environment variable and scrubbed from every
 * log. An API key works the same way (--secret ANTHROPIC_API_KEY) but is never
 * needed.
 *
 * PERMISSIONS. Warp's skills have the agent write files (review.json) and run
 * Warp's scripts. A CLI in print mode refuses both unless told otherwise, so
 * INSIDE THE CONTAINER claude gets --permission-mode bypassPermissions (the
 * container is the boundary) plus IS_SANDBOX=1, without which the CLI refuses
 * that mode as root (checked with claude 2.1.285 on 2026-09-29). With
 * --sandbox none it gets acceptEdits only: on the host, nothing is bypassed.
 *
 * PUBLISHING (--open-pr): the agent cannot commit — the sandbox's .git is
 * read-only, because a hook planted there runs outside the sandbox the next
 * time anything uses git. So for the Warp skills that end in a pull request
 * (implementation, spec, improve-review-pr) the agent leaves its changes and
 * writes the PR title and body to .caretaker/pr.md, and THIS process, outside
 * the sandbox and after it, commits exactly the files the harness measured the
 * agent changing, pushes a branch, opens the PR with `gh`, and posts its link
 * on the issue. It runs git with hooks off and literal pathspecs, and never
 * commits .caretaker/ itself.
 *
 * Usage:
 *   node bin/agent-step.mjs --skill review-pr --name "Review PR #3"
 *        (--prompt TEXT | --prompt-file F | --prompt-env VAR)
 *        [--workspace .] [--cli claude|codex] [--model M]
 *        [--sandbox podman|none] [--image I] [--egress api.anthropic.com]
 *        [--secret CLAUDE_CODE_OAUTH_TOKEN]... [--state-dir D] [--timeout MS]
 *        [--output FILE] [--open-pr [--issue N]]
 * Writes agent_output to --output and, under GitHub Actions, to $GITHUB_OUTPUT.
 * Exit: 0 the agent completed, 1 it did not (failed, killed, unavailable), 2 misuse.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactorFor, runArchived } from "./runstore.mjs";

export class AgentStepError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentStepError";
  }
}

/**
 * Warp names a skill either plainly (`review-pr`) or as `owner/repo:triage`,
 * meaning "the triage skill of this repository". Both resolve to the checked
 * out `.agents/skills/<name>/SKILL.md`, which is where Warp's prompts tell the
 * agent to read it.
 */
export function skillName(s) {
  const name = String(s ?? "").includes(":") ? String(s).slice(String(s).lastIndexOf(":") + 1) : String(s ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new AgentStepError(`skill ${JSON.stringify(s)} is not a skill name`);
  return name;
}

/** The CLI flags and environment that let a CLI do a skill's work, by where it runs. */
export function permissionsFor(cli, sandbox) {
  const contained = sandbox !== "none";
  if (cli === "claude") {
    return contained
      ? { extraCliArgs: ["--permission-mode", "bypassPermissions"], env: { IS_SANDBOX: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }
      : { extraCliArgs: ["--permission-mode", "acceptEdits"], env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } };
  }
  // codex exec's own approvals: unverified against a live codex on this box;
  // the flag names are from `codex exec --help` as recorded in harness.mjs.
  return { extraCliArgs: [], env: {} };
}

/** The whole step. Returns { state, agentOutput, runId, archived }. */
export async function agentStep({ skill, name = null, prompt, workspace = ".", cli = "claude", model = null, sandbox = "podman", image = null, egress = null, secrets = [], stateDir = null, timeoutMs = null, env = process.env, run = runArchived }) {
  const ws = resolve(workspace);
  const s = skillName(skill);
  if (!existsSync(join(ws, ".agents", "skills", s, "SKILL.md"))) {
    throw new AgentStepError(`no .agents/skills/${s}/SKILL.md in ${ws}; install the factory first (node bin/vendor.mjs build)`);
  }
  if (!prompt || !String(prompt).trim()) throw new AgentStepError("the prompt is empty");
  if (!["claude", "codex"].includes(cli)) throw new AgentStepError(`cli must be claude or codex, got ${JSON.stringify(cli)}`);
  const values = {};
  for (const n of secrets) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) throw new AgentStepError(`--secret takes a variable NAME, got ${JSON.stringify(n)}`);
    if (!env[n]) throw new AgentStepError(`--secret ${n}: ${n} is not set in the environment`);
    values[n] = env[n];
  }
  const perm = permissionsFor(cli, sandbox);
  const policy = {
    adapter: "cli",
    cli,
    sandbox,
    ...(model ? { model } : {}),
    ...(image ? { image } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    extraCliArgs: perm.extraCliArgs,
    env: perm.env,
    stage: "build",
  };
  const dir = stateDir ?? join(env.RUNNER_TEMP || tmpdir(), "caretaker-state");
  mkdirSync(dir, { recursive: true });
  const out = await run(ws, String(prompt), policy, {
    stateDir: dir,
    secrets: values,
    egress: egress === null ? null : { allow: egress },
  });
  const redact = redactorFor(values);
  const agentOutput = out.verdict.finalText === null || out.verdict.finalText === undefined ? "" : redact(out.verdict.finalText);
  const changed = out.diff?.measured === false ? null : (out.diff?.files ?? []).map((f) => f.path);
  return { state: out.verdict.state, agentOutput, runId: out.verdict.runId, archived: out.archived, name, skill: s, warnings: out.verdict.warnings ?? [], changed };
}

/**
 * Both sides of a path as git's numstat prints a rename ("a => b" or
 * "dir/{a => b}/f"), so the commit records the old path's removal too.
 */
export function renamedPaths(p) {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (braced) return [braced[1] + braced[2] + braced[4], braced[1] + braced[3] + braced[4]].map((x) => x.replace(/\/\/+/g, "/"));
  const plain = /^(.*) => (.*)$/.exec(p);
  return plain ? [plain[1], plain[2]] : [p];
}

/** Title and body from .caretaker/pr.md: the first non-empty line, then the rest. */
export function prText(text, fallbackTitle) {
  const lines = String(text ?? "").split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim());
  if (i === -1) return { title: fallbackTitle, body: "Opened by the Caretaker agent step; the agent wrote no .caretaker/pr.md." };
  const title = lines[i].replace(/^#+\s*/, "").trim().slice(0, 200) || fallbackTitle;
  return { title, body: lines.slice(i + 1).join("\n").trim() || "(no description)" };
}

/**
 * Outside the sandbox, after the agent: commit what the agent changed, push a
 * branch, open the PR, link it on the issue. Returns { opened, url?, branch?,
 * files?, why? }; throws AgentStepError when a git or gh command fails.
 */
export function publish({ workspace, changed, runId, skill, name = null, issue = null, run = spawnSync, env = process.env }) {
  const ws = resolve(workspace);
  if (changed === null) return { opened: false, why: "the run's changes were not measured, so there is nothing safe to commit" };
  const files = [...new Set(changed.flatMap(renamedPaths))].filter((f) => f && f !== ".caretaker" && !f.startsWith(".caretaker/"));
  if (!files.length) return { opened: false, why: "the agent changed no files" };
  const sh = (file, args, what) => {
    const r = run(file, args, { cwd: ws, encoding: "utf8", env });
    if (r.status !== 0) throw new AgentStepError(`${what} failed: ${String(r.stderr || r.error?.message || "").trim()}`);
    return String(r.stdout ?? "").trim();
  };
  // Hooks off and pathspecs literal: a changed file named ":(glob)*" is a file.
  const git = (args, what) => sh("git", ["-c", "core.hooksPath=/dev/null", "--literal-pathspecs", ...args], what);
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], "reading the current branch");
  const base = head !== "HEAD" ? head : env.GITHUB_REF_NAME;
  if (!base) throw new AgentStepError("the checkout is on no branch and GITHUB_REF_NAME is not set, so there is no base for the PR");
  const branch = `caretaker/${skill}-${runId.replace(/^r_/, "")}`;
  const prFile = join(ws, ".caretaker", "pr.md");
  const { title, body } = prText(existsSync(prFile) ? readFileSync(prFile, "utf8") : "", name || `${skill} (${runId})`);
  git(["checkout", "-q", "-b", branch], "creating the branch");
  git(["add", "-A", "--", ...files], "staging the agent's changes");
  git(["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", title, "-m", `Caretaker run ${runId}, skill ${skill}.`], "committing");
  git(["push", "-q", "origin", branch], "pushing the branch");
  const bodyFile = join(ws, ".caretaker", `pr-body-${runId}.md`);
  mkdirSync(dirname(bodyFile), { recursive: true });
  writeFileSync(bodyFile, `${body}\n\n---\nOpened by Caretaker (run ${runId}) for the agent, which works in a sandbox that cannot push.\n`);
  const url = sh("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile], "opening the pull request").split("\n").pop();
  if (issue) sh("gh", ["issue", "comment", String(issue), "--body", `Pull request opened: ${url}`], "linking the PR on the issue");
  return { opened: true, url, branch, files };
}

/** `name<<DELIM ... DELIM` for $GITHUB_OUTPUT, with a delimiter the value cannot contain. */
export function githubOutput(name, value) {
  let delim;
  do delim = `CARETAKER_${randomBytes(8).toString("hex")}`;
  while (value.includes(delim));
  return `${name}<<${delim}\n${value}\n${delim}\n`;
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const VALUE = ["skill", "name", "prompt", "prompt-file", "prompt-env", "workspace", "cli", "model", "sandbox", "image", "egress", "secret", "state-dir", "timeout", "output", "issue"];
  const f = { secret: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (argv[i] === "--open-pr") {
      f["open-pr"] = true;
      continue;
    }
    if (!argv[i].startsWith("--") || !VALUE.includes(k) || i + 1 >= argv.length) {
      console.error(`agent-step: bad argument ${argv[i]}\nusage: agent-step.mjs --skill S (--prompt T | --prompt-file F | --prompt-env V) [--cli claude|codex] [--sandbox podman|none] [--secret NAME]... [--egress hosts] [--output F]`);
      process.exit(2);
    }
    if (k === "secret") f.secret.push(argv[++i]);
    else f[k] = argv[++i];
  }
  const prompt = f.prompt ?? (f["prompt-file"] ? readFileSync(f["prompt-file"], "utf8") : f["prompt-env"] ? process.env[f["prompt-env"]] : undefined);
  try {
    const r = await agentStep({
      skill: f.skill,
      name: f.name ?? null,
      prompt,
      workspace: f.workspace ?? ".",
      cli: f.cli ?? "claude",
      model: f.model || null,
      sandbox: f.sandbox ?? "podman",
      image: f.image || null,
      egress: f.egress === undefined ? null : f.egress.split(",").map((h) => h.trim()).filter(Boolean),
      secrets: f.secret.filter(Boolean),
      stateDir: f["state-dir"] ?? null,
      timeoutMs: f.timeout ? Number(f.timeout) : null,
    });
    if (f.output) writeFileSync(f.output, r.agentOutput);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, githubOutput("agent_output", r.agentOutput));
      appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${r.runId}\nstate=${r.state}\n`);
    }
    for (const w of r.warnings) console.error(`[agent-step] warning: ${w}`);
    console.error(`[agent-step] ${r.name ?? r.skill}: ${r.runId} ${r.state} (archive ${r.archived})`);
    if (f["open-pr"] && r.state === "completed") {
      if (f.issue !== undefined && !/^[0-9]+$/.test(f.issue)) throw new AgentStepError(`--issue takes an issue number, got ${JSON.stringify(f.issue)}`);
      const p = publish({ workspace: f.workspace ?? ".", changed: r.changed, runId: r.runId, skill: r.skill, name: r.name, issue: f.issue || null });
      console.error(p.opened ? `[agent-step] opened ${p.url} from ${p.branch} (${p.files.length} file(s))` : `[agent-step] no pull request: ${p.why}`);
      if (process.env.GITHUB_OUTPUT && p.opened) appendFileSync(process.env.GITHUB_OUTPUT, `pr_url=${p.url}\n`);
    }
    process.exit(r.state === "completed" ? 0 : 1);
  } catch (e) {
    console.error(`[agent-step] ${e.message}`);
    process.exit(e instanceof AgentStepError ? 2 : 1);
  }
}
