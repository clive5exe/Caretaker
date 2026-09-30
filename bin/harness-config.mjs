#!/usr/bin/env node
/**
 * HARNESS SETTINGS — which AI does which job, in a file the person edits.
 *
 *   ${XDG_CONFIG_HOME:-~/.config}/caretaker/harness.json   (or --harness-config F)
 *
 *   {
 *     "default": { "adapter": "cli", "cli": "claude" },
 *     "roles": {
 *       "refuter":    { "cli": "codex" },
 *       "reconciler": { "adapter": "openai-compatible",
 *                       "endpoint": "https://api.openai.com/v1",
 *                       "apiKeyEnv": "OPENAI_API_KEY", "model": "..." }
 *     },
 *     "clis": {
 *       "mine": { "argv": ["mine", "--print"], "modelFlag": "--model",
 *                 "env": { "HOME": "/tmp/agent-home" } }
 *     }
 *   }
 *
 * A role's settings are laid over `default`, and flags given for one run are
 * laid over both. `tools` is one setting: a role's `tools` REPLACES the
 * default's whole, never merged key by key, so what a role's model may call
 * is read in one place (bin/tools.mjs has the shape). The roles are the jobs the harness is asked to do:
 * `builder` (runstore run), `refuter` (verify refute), `reconciler`
 * (reconcile propose). `cli` names a built-in preset (claude, codex) or one of
 * the `clis` defined here; a custom CLI may not reuse a built-in's name,
 * because which program ran must be answerable from its name.
 *
 * THE FILE LIVES OUTSIDE THE REPO, AND ONE INSIDE THE WORKSPACE IS REFUSED.
 * The workspace is mounted into the agent's container. Settings the agent can
 * edit are settings the agent chooses: one line pointing `endpoint` at another
 * server and the harness — which makes that call from the HOST, with the key —
 * would send the key and the conversation there on the next run.
 *
 * ISOLATION IS NOT A SETTING HERE. `sandbox`, `net`, `extraRunFlags`, `env`
 * and the rest are refused by name: what the agent can reach is decided per
 * run, on the command line, where it is seen. A preference file that could
 * quietly turn the sandbox off would make every run's isolation depend on a
 * file nobody reads.
 *
 * NO KEY VALUES. `apiKeyEnv` names an environment variable; a key-looking
 * field, or a custom CLI env var whose name says KEY/TOKEN/SECRET/PASSWORD,
 * is refused. Settings are recorded with each run, and a key recorded there
 * is a key in the archive.
 *
 * Usage:
 *   node bin/harness-config.mjs show [--role builder|refuter|reconciler] [--harness-config F]
 *   node bin/harness-config.mjs path
 * Exit: 0 ok, 1 the file is refused (the reason is printed), 2 misuse.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI_PRESETS, cliLabel } from "./harness.mjs";
import { within } from "./paths.mjs";
import { ToolsError, checkTools } from "./tools.mjs";

export class HarnessConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarnessConfigError";
    this.code = code;
  }
}

export const ROLES = ["builder", "refuter", "reconciler"];
/** What a profile may set: which AI, which model, how long. Nothing about isolation. */
export const PROFILE_KEYS = ["adapter", "cli", "model", "endpoint", "apiKeyEnv", "maxTurns", "timeoutMs", "image", "tools"];
const ISOLATION = new Set(["sandbox", "net", "buildNetwork", "extraRunFlags", "extraCliArgs", "env", "allowLogDirInWorkspace", "logDir", "devcontainer", "graceMs", "events"]);
const CLI_KEYS = ["argv", "modelFlag", "env", "skillsPath"];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const ADAPTERS = ["cli", "openai-compatible"];

export function defaultPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "caretaker", "harness.json");
}

const inside = within;

function checkProfile(where, prof, clis) {
  if (prof === null || typeof prof !== "object" || Array.isArray(prof)) throw new HarnessConfigError("BAD_SHAPE", `${where} must be an object`);
  for (const [k, v] of Object.entries(prof)) {
    if (ISOLATION.has(k)) {
      throw new HarnessConfigError("ISOLATION_KEY", `${where}.${k} is refused: what a run can reach is decided per run on the command line, never in a settings file`);
    }
    if (/^api[-_]?key$|^key$|^token$|^secret$/i.test(k)) {
      throw new HarnessConfigError("KEY_VALUE", `${where}.${k} is refused: put the key in an environment variable and name it in apiKeyEnv`);
    }
    if (!PROFILE_KEYS.includes(k)) throw new HarnessConfigError("UNKNOWN_KEY", `${where}.${k} is not a setting; the settings are ${PROFILE_KEYS.join(", ")}`);
    if (k === "adapter" && !ADAPTERS.includes(v)) throw new HarnessConfigError("BAD_VALUE", `${where}.adapter "${v}" is not one of ${ADAPTERS.join(", ")}`);
    if (k === "cli" && !(typeof v === "string" && (v in CLI_PRESETS || v in clis))) {
      throw new HarnessConfigError("UNKNOWN_CLI", `${where}.cli "${v}" is neither built in (${Object.keys(CLI_PRESETS).join(", ")}) nor defined under "clis"`);
    }
    if ((k === "maxTurns" || k === "timeoutMs") && !(Number.isInteger(v) && v > 0)) throw new HarnessConfigError("BAD_VALUE", `${where}.${k} must be a positive whole number`);
    if (k === "endpoint" && !/^https?:\/\/[^\s]+$/.test(String(v))) throw new HarnessConfigError("BAD_VALUE", `${where}.endpoint must be an http(s) URL`);
    if (k === "apiKeyEnv" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(v))) {
      throw new HarnessConfigError("BAD_VALUE", `${where}.apiKeyEnv must be the NAME of an environment variable, not a key`);
    }
    if ((k === "model" || k === "image") && typeof v !== "string") throw new HarnessConfigError("BAD_VALUE", `${where}.${k} must be a string`);
    if (k === "tools") {
      try {
        checkTools(`${where}.tools`, v);
      } catch (e) {
        if (e instanceof ToolsError) throw new HarnessConfigError(e.code, e.message);
        throw e;
      }
    }
  }
}

function checkCli(name, c) {
  const where = `clis.${name}`;
  if (name in CLI_PRESETS) throw new HarnessConfigError("SHADOWS_BUILTIN", `${where}: "${name}" is a built-in CLI; give yours another name so a run's record says which one ran`);
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new HarnessConfigError("BAD_SHAPE", `${where} must be an object`);
  for (const k of Object.keys(c)) if (!CLI_KEYS.includes(k)) throw new HarnessConfigError("UNKNOWN_KEY", `${where}.${k} is not a CLI setting; they are ${CLI_KEYS.join(", ")}`);
  if (!Array.isArray(c.argv) || !c.argv.length || !c.argv.every((a) => typeof a === "string")) {
    throw new HarnessConfigError("BAD_VALUE", `${where}.argv must be a non-empty list of strings; the prompt goes in on stdin`);
  }
  for (const [ek, ev] of Object.entries(c.env ?? {})) {
    if (SECRET_NAME.test(ek)) throw new HarnessConfigError("KEY_VALUE", `${where}.env.${ek} is refused: its name says it holds a secret. Pass secrets with --secret, which redacts them from the record`);
    if (typeof ev !== "string") throw new HarnessConfigError("BAD_VALUE", `${where}.env.${ek} must be a string`);
  }
}

/** Parse and check settings. Throws HarnessConfigError naming the first problem. */
export function validate(conf) {
  if (conf === null || typeof conf !== "object" || Array.isArray(conf)) throw new HarnessConfigError("BAD_SHAPE", "harness settings must be a JSON object");
  for (const k of Object.keys(conf)) {
    if (!["default", "roles", "clis"].includes(k)) throw new HarnessConfigError("UNKNOWN_KEY", `"${k}" is not a section; the sections are default, roles, clis`);
  }
  const clis = conf.clis ?? {};
  for (const [n, c] of Object.entries(clis)) checkCli(n, c);
  if (conf.default !== undefined) checkProfile("default", conf.default, clis);
  for (const [r, p] of Object.entries(conf.roles ?? {})) {
    if (!ROLES.includes(r)) throw new HarnessConfigError("UNKNOWN_ROLE", `roles.${r} is not a role; the roles are ${ROLES.join(", ")}`);
    checkProfile(`roles.${r}`, p, clis);
  }
  return conf;
}

/**
 * Read the settings. The default path may be absent (null: nothing set); an
 * explicitly named file must exist. Either is refused if inside the workspace.
 */
export function load({ path = null, workspace = null } = {}) {
  const p = resolve(path ?? defaultPath());
  if (workspace && inside(p, workspace)) {
    throw new HarnessConfigError("IN_WORKSPACE", `harness settings ${p} are inside the workspace ${workspace}, which the agent can edit. Keep them outside the repo (default ${defaultPath()})`);
  }
  if (!existsSync(p)) {
    if (path) throw new HarnessConfigError("NO_SUCH_FILE", `harness settings ${p} do not exist`);
    return null;
  }
  let conf;
  try {
    conf = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new HarnessConfigError("BAD_JSON", `harness settings ${p} are not valid JSON: ${e.message}`);
  }
  return { path: p, conf: validate(conf) };
}

/** A JSON-defined CLI as the harness's preset shape. */
function preset(name, c) {
  const argv = [...c.argv];
  return {
    bin: argv[0],
    name,
    argv: ({ model }) => [...argv, ...(model && c.modelFlag ? [c.modelFlag, model] : [])],
    env: { HOME: "/tmp/agent-home", ...(c.env ?? {}) },
    ...(c.skillsPath ? { skillsPath: c.skillsPath } : {}),
  };
}

/**
 * The policy for one job: settings default, then the role, then this run's
 * flags. Returns { policy, from } where `from` says where each value came from.
 */
export function policyFor(role, loaded, flags = {}) {
  if (!ROLES.includes(role)) throw new HarnessConfigError("UNKNOWN_ROLE", `"${role}" is not a role; the roles are ${ROLES.join(", ")}`);
  const conf = loaded?.conf ?? {};
  const layers = [
    ["settings default", conf.default ?? {}],
    [`settings roles.${role}`, conf.roles?.[role] ?? {}],
    ["command line", flags],
  ];
  const policy = {};
  const from = {};
  for (const [label, layer] of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      policy[k] = v;
      from[k] = label;
    }
  }
  // A cli change from a lower layer does not carry the lower layer's adapter
  // away with it: choosing a CLI on the command line means the CLI adapter.
  if (from.cli === "command line" && from.adapter !== "command line") {
    policy.adapter = "cli";
    from.adapter = "command line (implied by --cli)";
  }
  const clis = conf.clis ?? {};
  if (typeof policy.cli === "string" && policy.cli in clis) policy.cli = preset(policy.cli, clis[policy.cli]);
  else if (typeof policy.cli === "string" && !(policy.cli in CLI_PRESETS)) {
    throw new HarnessConfigError("UNKNOWN_CLI", `cli "${policy.cli}" is neither built in (${Object.keys(CLI_PRESETS).join(", ")}) nor defined under "clis"${loaded ? ` in ${loaded.path}` : ""}`);
  }
  return { policy, from };
}

/**
 * One run's command-line flags as policy keys. The one place this mapping
 * lives, so runstore, verify and reconcile cannot disagree about a flag.
 */
export function policyFlags(flags) {
  const num = (k) => (flags[k] === undefined ? undefined : Number(flags[k]));
  const out = {
    adapter: flags.adapter,
    cli: flags.cli,
    model: flags.model,
    endpoint: flags.endpoint,
    apiKeyEnv: flags["api-key-env"],
    maxTurns: num("max-turns"),
    timeoutMs: num("timeout"),
    sandbox: flags.sandbox,
    net: flags.net,
    buildNetwork: flags["build-network"],
    image: flags.image,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1];
  };
  if (cmd === "path") {
    console.log(defaultPath());
    process.exit(0);
  }
  if (cmd !== "show") {
    console.error("usage: harness-config.mjs show [--role builder|refuter|reconciler] [--harness-config F] | path");
    process.exit(2);
  }
  try {
    const loaded = load({ path: flag("harness-config"), workspace: process.cwd() });
    console.log(loaded ? `settings: ${loaded.path}` : `settings: none (${defaultPath()} does not exist; built-in defaults apply)`);
    for (const role of flag("role") ? [flag("role")] : ROLES) {
      const { policy, from } = policyFor(role, loaded);
      const rows = Object.keys(policy).map((k) => `    ${k.padEnd(10)} ${k === "cli" ? cliLabel(policy.cli) : JSON.stringify(policy[k])}  (${from[k]})`);
      console.log(`  ${role}:${rows.length ? `\n${rows.join("\n")}` : " built-in defaults (adapter cli, cli claude)"}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`[harness-config] ${e.name}: ${e.message}`);
    process.exit(e instanceof HarnessConfigError && e.code !== "UNKNOWN_ROLE" ? 1 : 2);
  }
}
