#!/usr/bin/env node
/**
 * S-1: a project points at skills in the existing layout and a run gets them,
 * read-only, without them landing in the workspace.
 *
 * Remote sources are fetched from a local git repo standing in for GitHub, so
 * no network is needed. The openai-compatible adapter is driven by a scripted
 * server to show a model can list and read a skill.
 *
 * Run: node bin/skills.test.mjs
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsError, collect, discover, fetchSource, parseSkill, stage, staged, stageForRun } from "./skills.mjs";
import { CLI_PRESETS, run, skillsMount } from "./harness.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof SkillsError ? e.code : `other: ${e.message}`;
  }
};

const TMP = mkdtempSync(join(tmpdir(), "skills-test-"));
const skill = (dir, name, description, extra = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the ${name} thing.\n`);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c);
};

/* ---------------------------------------------------------------- format */
ok("name and description come from the frontmatter", JSON.stringify(parseSkill("---\nname: review\ndescription: Review a diff\n---\nbody")) === '{"name":"review","description":"Review a diff"}');
ok("a folded description is read whole", parseSkill("---\nname: x\ndescription: >\n  first line\n  second line\n---\n").description === "first line second line");
ok("no frontmatter, no fields", parseSkill("# just markdown").name === null);

// The published layout: skills/<category>/<name>/SKILL.md
const PUB = join(TMP, "published");
skill(join(PUB, "skills", "dev", "code-review"), "code-review", "Review a diff for defects");
skill(join(PUB, "skills", "docs", "adr"), "adr", "Write an architecture decision record", { "template.md": "# ADR template\n" });
mkdirSync(join(PUB, "skills", "dev", "not-a-skill"), { recursive: true });
writeFileSync(join(PUB, "skills", "dev", "not-a-skill", "README.md"), "no SKILL.md here\n");
{
  const found = discover(PUB);
  ok("the standard layout is discovered", JSON.stringify(found.map((s) => [s.category, s.name])) === '[["dev","code-review"],["docs","adr"]]', JSON.stringify(found));
  ok("a directory with no SKILL.md is not a skill", !found.some((s) => s.name === "not-a-skill"));
}
// The flat layout `npx skills add` installs: <name>/SKILL.md
const FLAT = join(TMP, "flat");
skill(join(FLAT, "tidy"), "tidy", "Tidy imports");
ok("the flat installed layout is discovered too", discover(FLAT).map((s) => s.name).join() === "tidy");

/* ---------------------------------------------------------------- sources */
const ROOT = join(TMP, "repo");
mkdirSync(ROOT, { recursive: true });
const CACHE = join(TMP, "cache");
{
  const got = collect({ skills: [PUB, FLAT] }, { root: ROOT, cacheDir: CACHE });
  ok("local sources are read in place", got.map((s) => s.name).sort().join() === "adr,code-review,tidy");
  ok("a source that does not exist is refused by name", code(() => collect({ skills: ["./nope"] }, { root: ROOT, cacheDir: CACHE })) === "NO_SUCH_PATH");
  ok("an unfetched remote source is refused, never fetched at run time", code(() => collect({ skills: ["acme/skills"] }, { root: ROOT, cacheDir: CACHE })) === "NOT_FETCHED");
  const dupe = join(TMP, "dupe");
  skill(join(dupe, "tidy"), "tidy", "A different tidy");
  ok("two skills with one name are refused, so which one ran is answerable", code(() => collect({ skills: [FLAT, dupe] }, { root: ROOT, cacheDir: CACHE })) === "DUPLICATE_SKILL");
  ok("skills must be a list", code(() => collect({ skills: "x" }, { root: ROOT, cacheDir: CACHE })) === "BAD_CONFIG");
}
{
  // A git repo standing in for github.com/acme/skills.
  const hub = join(TMP, "hub");
  const src = join(hub, "acme", "skills");
  skill(join(src, "skills", "ops", "deploy-check"), "deploy-check", "Check a deploy plan");
  const g = (...a) => spawnSync("git", ["-C", src, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "skills");
  const r = fetchSource("acme/skills", { cacheDir: CACHE, gitBase: `file://${hub}` });
  ok("a remote source is fetched into the cache", r.fetched && existsSync(join(r.dest, "skills", "ops", "deploy-check", "SKILL.md")));
  ok("fetching again does nothing", fetchSource("acme/skills", { cacheDir: CACHE, gitBase: `file://${hub}` }).fetched === false);
  ok("once fetched, it is collected like any source", collect({ skills: ["acme/skills"] }, { root: ROOT, cacheDir: CACHE }).map((s) => s.name).join() === "deploy-check");
  ok("a path is not fetchable", code(() => fetchSource("./local", { cacheDir: CACHE })) === "NOT_REMOTE");
}

/* ------------------------------------------------------------------ stage */
const STAGED = join(TMP, "staged");
stage(collect({ skills: [PUB] }, { root: ROOT, cacheDir: CACHE }), STAGED);
ok("staging lays skills out by name, files and all", existsSync(join(STAGED, "adr", "SKILL.md")) && existsSync(join(STAGED, "adr", "template.md")));
ok("staged() lists them with their descriptions", JSON.stringify(staged(STAGED)) === '[{"name":"adr","description":"Write an architecture decision record"},{"name":"code-review","description":"Review a diff for defects"}]');
{
  const cfgDir = join(ROOT, "ops", "caretaker");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ repo: ".", stateDir: join(TMP, "state"), skills: [FLAT] }));
  const d = stageForRun(join(cfgDir, "config.json"), join(TMP, "run-skills"));
  ok("stageForRun stages a project's configured skills", d && existsSync(join(d, "tidy", "SKILL.md")));
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ repo: ".", stateDir: join(TMP, "state") }));
  ok("…and returns null when the project names none", stageForRun(join(cfgDir, "config.json"), join(TMP, "run-skills-2")) === null);
}

/* ---------------------------------------------------- the CLI adapter */
{
  const w = [];
  const flags = skillsMount({ skillsDir: STAGED, cli: "claude" }, CLI_PRESETS.claude, w);
  ok("the claude CLI gets the skills mounted read-only where it reads them", JSON.stringify(flags) === JSON.stringify(["-v", `${STAGED}:/tmp/agent-home/.claude/skills:ro,Z`]) && !w.length);
  const w2 = [];
  ok("a CLI with no known skills location gets a warning, not a guessed mount", skillsMount({ skillsDir: STAGED, cli: "codex" }, CLI_PRESETS.codex, w2).length === 0 && /NOT attached/.test(w2[0] ?? ""));
  ok("no skills, no mount", skillsMount({ skillsDir: null }, CLI_PRESETS.claude, []).length === 0);
}

/* ---------------------------------------------- the openai-compatible adapter */
const seen = [];
const replies = [];
const server = createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    seen.push(JSON.parse(b));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(replies.shift() ?? { choices: [{ message: { role: "assistant", content: "done" } }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const call = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
{
  const ws = join(TMP, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "a.txt"), "a\n");
  replies.push(
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [call("read_skill", { name: "adr" }), call("read_skill", { name: "adr", file: "template.md" }), call("read_skill", { name: "adr", file: "../code-review/SKILL.md" }), call("read_skill", { name: "nope" })] } }] },
    { choices: [{ message: { role: "assistant", content: "read them" } }] },
  );
  const out = await run(ws, "write an ADR", { adapter: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "m", sandbox: "none", events: false, logDir: join(TMP, "logs"), skillsDir: STAGED });
  const first = seen[0];
  ok("the system prompt lists each skill with its description", /adr: Write an architecture decision record/.test(first.messages[0].content) && /code-review: Review a diff/.test(first.messages[0].content));
  ok("read_skill is offered alongside the four tools", first.tools.map((t) => t.function.name).join() === "list_files,read_file,write_file,run,read_skill");
  const tool = seen[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
  ok("read_skill returns the SKILL.md", tool[0].includes("Do the adr thing."));
  ok("…and another file in the skill", tool[1] === "# ADR template\n");
  ok("…and refuses a path out of the skill", /refused: path is outside the skill/.test(tool[2]));
  ok("…and answers an unknown skill with the list", /no skill named "nope"/.test(tool[3]) && /adr, code-review/.test(tool[3]));
  ok("reading skills put nothing in the workspace", out.diff.files.length === 0);
  const noSkills = await run(ws, "x", { adapter: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "m", sandbox: "none", events: false, logDir: join(TMP, "logs2") });
  ok("with no skills, read_skill is not offered", !seen.at(-1).tools.some((t) => t.function.name === "read_skill") && noSkills.verdict.state === "completed");
}
server.close();

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[skills] ${failures} FAILED` : "\n[skills] all checks passed");
process.exit(failures ? 1 : 0);
