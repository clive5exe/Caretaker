#!/usr/bin/env node
/**
 * Harness settings: a person chooses which AI does which job in a file outside
 * the repo, and that file cannot turn isolation off or hold a key.
 *
 * The end-to-end check drives `runstore.mjs run` with a settings file that
 * routes the builder to an OpenAI-compatible server scripted here.
 *
 * Run: node bin/harness-config.test.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessConfigError, defaultPath, load, policyFlags, policyFor, validate } from "./harness-config.mjs";
import { cliLabel } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
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
    return e instanceof HarnessConfigError ? e.code : `other: ${e.message}`;
  }
};

const TMP = mkdtempSync(join(tmpdir(), "harness-config-test-"));

/* ------------------------------------------------------------- validation */
const GOOD = {
  default: { adapter: "cli", cli: "claude", model: "big" },
  roles: {
    refuter: { cli: "codex" },
    reconciler: { adapter: "openai-compatible", endpoint: "https://api.example.test/v1", apiKeyEnv: "EXAMPLE_KEY", model: "small", maxTurns: 20 },
  },
  clis: { mine: { argv: ["mine", "--print"], modelFlag: "--model", env: { LANG: "C" }, skillsPath: "/tmp/agent-home/.mine/skills" } },
};
ok("a file choosing a CLI, a model and an API endpoint per role is accepted", code(() => validate(GOOD)) === null);
for (const k of ["sandbox", "net", "extraRunFlags", "env", "allowLogDirInWorkspace"]) {
  ok(`isolation is not a setting: ${k} is refused by name`, code(() => validate({ default: { [k]: k === "sandbox" ? "none" : "x" } })) === "ISOLATION_KEY");
}
ok("a key value is refused: name the variable instead", code(() => validate({ roles: { builder: { apiKey: "sk-live-123" } } })) === "KEY_VALUE");
ok("apiKeyEnv holding a key rather than a name is refused", code(() => validate({ default: { apiKeyEnv: "sk-live-1234" } })) === "BAD_VALUE");
ok("a custom CLI env var named like a secret is refused", code(() => validate({ clis: { x: { argv: ["x"], env: { OPENAI_API_KEY: "sk" } } } })) === "KEY_VALUE");
ok("a misspelt setting is refused, not ignored", code(() => validate({ default: { modle: "x" } })) === "UNKNOWN_KEY");
ok("an unknown section is refused", code(() => validate({ defaults: {} })) === "UNKNOWN_KEY");
ok("an unknown role is refused", code(() => validate({ roles: { tester: {} } })) === "UNKNOWN_ROLE");
ok("an unknown adapter is refused", code(() => validate({ default: { adapter: "sdk2" } })) === "BAD_VALUE");
ok("a cli that is neither built in nor defined is refused", code(() => validate({ default: { cli: "cursor" } })) === "UNKNOWN_CLI");
ok("a custom CLI may not take a built-in's name", code(() => validate({ clis: { claude: { argv: ["evil"] } } })) === "SHADOWS_BUILTIN");
ok("a custom CLI needs an argv", code(() => validate({ clis: { x: { argv: [] } } })) === "BAD_VALUE");
ok("an endpoint must be a URL", code(() => validate({ default: { endpoint: "api.example.test" } })) === "BAD_VALUE");
ok("maxTurns must be a positive whole number", code(() => validate({ default: { maxTurns: 0 } })) === "BAD_VALUE");

/* ------------------------------------------------------------------- load */
const WS = join(TMP, "ws");
mkdirSync(WS, { recursive: true });
const OUT = join(TMP, "home-config");
mkdirSync(OUT, { recursive: true });
const FILE = join(OUT, "harness.json");
writeFileSync(FILE, JSON.stringify(GOOD));
{
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(TMP, "empty-xdg");
  ok("the default location is under XDG_CONFIG_HOME", defaultPath() === join(TMP, "empty-xdg", "caretaker", "harness.json"));
  ok("no settings file at the default location means none set, not an error", load({ workspace: WS }) === null);
  if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prev;
}
ok("a named file that does not exist is refused", code(() => load({ path: join(TMP, "nope.json"), workspace: WS })) === "NO_SUCH_FILE");
ok("a file outside the workspace loads", load({ path: FILE, workspace: WS })?.path === FILE);
writeFileSync(join(WS, "harness.json"), JSON.stringify(GOOD));
ok("a file inside the workspace is refused: the agent could edit it", code(() => load({ path: join(WS, "harness.json"), workspace: WS })) === "IN_WORKSPACE");
symlinkSync(join(WS, "harness.json"), join(TMP, "link.json"));
ok("…including through a symlink that lives outside", code(() => load({ path: join(TMP, "link.json"), workspace: WS })) === "IN_WORKSPACE");
writeFileSync(join(TMP, "bad.json"), "{ nope");
ok("a file that is not JSON is refused by name", code(() => load({ path: join(TMP, "bad.json"), workspace: WS })) === "BAD_JSON");

/* ------------------------------------------------------------- policyFor */
const loaded = load({ path: FILE, workspace: WS });
{
  const b = policyFor("builder", loaded);
  ok("a role with no settings of its own gets the default", b.policy.cli === "claude" && b.policy.model === "big" && b.from.model === "settings default");
  const r = policyFor("refuter", loaded);
  ok("a role's settings are laid over the default", r.policy.cli === "codex" && r.policy.model === "big" && r.from.cli === "settings roles.refuter");
  const c = policyFor("reconciler", loaded);
  ok("a role can switch to an API endpoint, naming the key's variable", c.policy.adapter === "openai-compatible" && c.policy.apiKeyEnv === "EXAMPLE_KEY" && c.policy.model === "small");
  const f = policyFor("reconciler", loaded, policyFlags({ model: "flagged", sandbox: "none" }));
  ok("this run's flags are laid over both", f.policy.model === "flagged" && f.from.model === "command line");
  ok("…and isolation comes only from the command line", f.policy.sandbox === "none" && f.from.sandbox === "command line");
  const g = policyFor("reconciler", loaded, policyFlags({ cli: "codex" }));
  ok("--cli on the command line means the CLI adapter, even over a role's API setting", g.policy.adapter === "cli" && g.policy.cli === "codex");
  ok("with no settings file, the built-in defaults apply untouched", JSON.stringify(policyFor("builder", null).policy) === "{}");
  ok("a cli named on the command line that exists nowhere is refused", code(() => policyFor("builder", loaded, { cli: "cursor" })) === "UNKNOWN_CLI");
  ok("an unknown role is refused", code(() => policyFor("tester", loaded)) === "UNKNOWN_ROLE");
}
{
  const m = policyFor("builder", loaded, { cli: "mine", model: "x1" }).policy.cli;
  ok("a custom CLI becomes a preset: its argv, then the model flag", JSON.stringify(m.argv({ model: "x1" })) === '["mine","--print","--model","x1"]' && JSON.stringify(m.argv({ model: null })) === '["mine","--print"]');
  ok("…with HOME moved where the sandbox lets it write, and its own env", m.env.HOME === "/tmp/agent-home" && m.env.LANG === "C" && m.skillsPath === "/tmp/agent-home/.mine/skills");
  ok("…and is recorded under its own name, not a bare 'custom'", cliLabel(m) === "custom:mine");
}
ok("flags map to policy keys once, and absent flags set nothing", JSON.stringify(policyFlags({ "api-key-env": "K", "max-turns": "5", timeout: "9" })) === '{"apiKeyEnv":"K","maxTurns":5,"timeoutMs":9}');

/* ------------------------------------------------ end to end, through runstore */
const seen = [];
const server = createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    seen.push({ auth: req.headers.authorization ?? null, body: JSON.parse(b) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "nothing to do" } }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const node = (args, env = {}) =>
  new Promise((res) => {
    const p = spawn("node", args, { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => res({ status, out }));
  });
{
  const settings = join(OUT, "e2e.json");
  writeFileSync(settings, JSON.stringify({ roles: { builder: { adapter: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "E2E_KEY", model: "from-settings" } } }));
  const state = join(TMP, "state");
  const r = await node([join(HERE, "runstore.mjs"), "run", "--workspace", WS, "--prompt", "hi", "--sandbox", "none", "--state-dir", state, "--harness-config", settings], { E2E_KEY: "k-e2e-value" });
  const runId = /\b(r_[0-9a-f]{8})\b/.exec(r.out)?.[1];
  ok("runstore runs the builder the settings file chose", r.status === 0 && seen.at(-1)?.body.model === "from-settings", r.out);
  ok("…with the key from the variable the settings named", seen.at(-1)?.auth === "Bearer k-e2e-value");
  const rec = runId ? JSON.parse(readFileSync(join(state, "runs", runId, "run.json"), "utf8")) : null;
  ok("…and the archived run records which adapter and model", rec?.adapter === "openai-compatible" && rec?.model === "from-settings");
  ok("…and not the key", rec !== null && !JSON.stringify(rec).includes("k-e2e-value"));
  const inWs = await node([join(HERE, "runstore.mjs"), "run", "--workspace", WS, "--prompt", "hi", "--sandbox", "none", "--state-dir", state, "--harness-config", join(WS, "harness.json")]);
  ok("runstore refuses settings from inside the workspace, and runs nothing", inWs.status === 2 && /inside the workspace/.test(inWs.out) && seen.length === 1, inWs.out);
  const bad = join(OUT, "bad-e2e.json");
  writeFileSync(bad, JSON.stringify({ default: { sandbox: "none" } }));
  const iso = await node([join(HERE, "runstore.mjs"), "run", "--workspace", WS, "--prompt", "hi", "--state-dir", state, "--harness-config", bad]);
  ok("a settings file that tries to set the sandbox stops the run", iso.status === 2 && /sandbox is refused/.test(iso.out) && seen.length === 1, iso.out);
  const show = await node([join(HERE, "harness-config.mjs"), "show", "--harness-config", FILE]);
  ok("`show` prints each role's settings and where each came from", show.status === 0 && /refuter:[\s\S]*cli\s+codex\s+\(settings roles\.refuter\)/.test(show.out) && /model\s+"big"\s+\(settings default\)/.test(show.out), show.out);
}
server.close();

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[harness-config] ${failures} FAILED` : "\n[harness-config] all checks passed");
process.exit(failures ? 1 : 0);
