/**
 * TOOL CONTROL — which tools the model gets, your own tools, and your say
 * before a call runs. Set in harness settings (bin/harness-config.mjs), per
 * role or for all of them:
 *
 *   "default": {
 *     "tools": {
 *       "enable":  ["list_files", "read_file", "write_file"],
 *       "custom": {
 *         "run_tests": {
 *           "description": "Run the test suite, or one file of it.",
 *           "command": "node --test ${file:-.}",
 *           "args": { "file": "a test file; default all" }
 *         }
 *       },
 *       "approve": ["write_file", "run_tests"],
 *       "claude":  { "allow": ["Read", "Edit", "Bash(npm test:*)"], "deny": ["WebFetch"] }
 *     }
 *   }
 *
 * WHICH ADAPTER EACH PART REACHES. The honest split, because a setting that
 * looks applied and is not is worse than no setting:
 *
 *   enable, custom, approve   the openai-compatible adapter, where THIS harness
 *                             runs the tool loop: every call the model makes
 *                             passes through dispatch() here.
 *   claude                    the claude CLI, which runs its own tool loop;
 *                             these become its --allowedTools, --disallowedTools
 *                             and --permission-mode flags.
 *
 * Any part set for a run it cannot reach is named in verdict.warnings.
 *
 * A CUSTOM TOOL IS A NAMED COMMAND, run where `run` runs: inside the run's
 * container, or on the host under sandbox:none. It is no stronger than `run`,
 * and with `run` left out of `enable` it is how you give the model exactly the
 * commands you chose and no others. Its arguments reach the command as
 * ENVIRONMENT VARIABLES named after them, never pasted into the command text,
 * so a model's argument cannot become shell code. Quote them: "$file".
 *
 * APPROVE stops before each call of a listed tool (or every tool, with "all")
 * and asks on the terminal: y runs it, a runs it and stops asking about that
 * tool for this run, n refuses it, and anything after n is handed to the model
 * as the reason — which is how you steer a run mid-flight. With no terminal to
 * ask on, the call is refused and the model is told why. Every answer is in the
 * transcript.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export const BUILTIN_TOOLS = ["list_files", "read_file", "write_file", "run"];
/** Offered only when skills were staged; not something `enable` can add. */
const RESERVED = new Set([...BUILTIN_TOOLS, "read_skill"]);
const TOOL_KEYS = ["enable", "custom", "approve", "claude"];
const CUSTOM_KEYS = ["description", "command", "args", "required"];
const CLAUDE_KEYS = ["allow", "deny", "permissionMode"];
/** From `claude --help`, --permission-mode, on this box 2026-09-29. */
export const CLAUDE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
// Lower case only: an argument becomes an environment variable of that name,
// and upper case would let one called PATH or HOME replace the real one.
const ARG_NAME = /^[a-z][a-z0-9_]{0,47}$/;

export class ToolsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolsError";
    this.code = code;
  }
}

const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Check a `tools` setting. Throws ToolsError naming the first problem. */
export function checkTools(where, tools) {
  if (!isObj(tools)) throw new ToolsError("BAD_SHAPE", `${where} must be an object`);
  for (const k of Object.keys(tools)) {
    if (!TOOL_KEYS.includes(k)) throw new ToolsError("UNKNOWN_KEY", `${where}.${k} is not a tools setting; they are ${TOOL_KEYS.join(", ")}`);
  }
  if (tools.enable !== undefined) {
    if (!Array.isArray(tools.enable)) throw new ToolsError("BAD_VALUE", `${where}.enable must be a list of built-in tool names`);
    for (const n of tools.enable) {
      if (!BUILTIN_TOOLS.includes(n)) throw new ToolsError("BAD_VALUE", `${where}.enable: "${n}" is not a built-in tool; they are ${BUILTIN_TOOLS.join(", ")}. Your own go under custom`);
    }
  }
  const custom = tools.custom ?? {};
  if (!isObj(custom)) throw new ToolsError("BAD_SHAPE", `${where}.custom must be an object of name -> tool`);
  for (const [name, t] of Object.entries(custom)) {
    const w = `${where}.custom.${name}`;
    if (!TOOL_NAME.test(name)) throw new ToolsError("BAD_NAME", `${w}: a tool name is lower case letters, digits and _, starting with a letter`);
    if (RESERVED.has(name)) throw new ToolsError("SHADOWS_BUILTIN", `${w}: "${name}" is a built-in tool; give yours another name so the transcript says which one ran`);
    if (!isObj(t)) throw new ToolsError("BAD_SHAPE", `${w} must be an object`);
    for (const k of Object.keys(t)) if (!CUSTOM_KEYS.includes(k)) throw new ToolsError("UNKNOWN_KEY", `${w}.${k} is not a tool setting; they are ${CUSTOM_KEYS.join(", ")}`);
    if (typeof t.description !== "string" || !t.description.trim()) throw new ToolsError("BAD_VALUE", `${w}.description is required: it is all the model knows about the tool`);
    if (typeof t.command !== "string" || !t.command.trim()) throw new ToolsError("BAD_VALUE", `${w}.command is required: the shell command the tool runs`);
    const args = t.args ?? {};
    if (!isObj(args)) throw new ToolsError("BAD_SHAPE", `${w}.args must be an object of argument name -> description`);
    for (const [a, d] of Object.entries(args)) {
      if (!ARG_NAME.test(a)) throw new ToolsError("BAD_NAME", `${w}.args.${a}: an argument name is lower case letters, digits and _, starting with a letter (it becomes an environment variable)`);
      if (typeof d !== "string") throw new ToolsError("BAD_VALUE", `${w}.args.${a} must be a description string`);
    }
    if (t.required !== undefined) {
      if (!strList(t.required)) throw new ToolsError("BAD_VALUE", `${w}.required must be a list of argument names`);
      for (const r of t.required) if (!(r in args)) throw new ToolsError("BAD_VALUE", `${w}.required names "${r}", which is not one of its args`);
    }
  }
  if (tools.approve !== undefined) {
    const known = new Set([...BUILTIN_TOOLS, ...Object.keys(custom)]);
    if (tools.approve !== "all" && !strList(tools.approve)) throw new ToolsError("BAD_VALUE", `${where}.approve must be "all" or a list of tool names`);
    if (tools.approve !== "all") {
      for (const n of tools.approve) {
        if (!known.has(n)) throw new ToolsError("BAD_VALUE", `${where}.approve: "${n}" is not a tool; the tools are ${[...known].join(", ")}`);
      }
    }
  }
  if (tools.claude !== undefined) {
    const c = tools.claude;
    if (!isObj(c)) throw new ToolsError("BAD_SHAPE", `${where}.claude must be an object`);
    for (const k of Object.keys(c)) if (!CLAUDE_KEYS.includes(k)) throw new ToolsError("UNKNOWN_KEY", `${where}.claude.${k} is not a claude tools setting; they are ${CLAUDE_KEYS.join(", ")}`);
    for (const k of ["allow", "deny"]) {
      if (c[k] !== undefined && !strList(c[k])) throw new ToolsError("BAD_VALUE", `${where}.claude.${k} must be a list of claude tool names or patterns, e.g. "Edit" or "Bash(npm test:*)"`);
      // A value starting with - would be read by the CLI as its next flag.
      for (const v of c[k] ?? []) if (v.startsWith("-")) throw new ToolsError("BAD_VALUE", `${where}.claude.${k}: "${v}" starts with -, which the CLI would read as a flag`);
    }
    if (c.permissionMode !== undefined && !CLAUDE_PERMISSION_MODES.includes(c.permissionMode)) {
      throw new ToolsError("BAD_VALUE", `${where}.claude.permissionMode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
    }
  }
  return tools;
}

/**
 * The tools the model is offered, as function specs, each tagged with how it
 * runs: `builtin` or `custom` (with its command). `builtins` are the adapter's
 * own specs, so their wording stays in one place.
 */
export function menu(tools, builtins) {
  const enable = tools?.enable ?? BUILTIN_TOOLS;
  const out = builtins.filter((t) => enable.includes(t.name)).map((t) => ({ ...t, kind: "builtin" }));
  for (const [name, t] of Object.entries(tools?.custom ?? {})) {
    const args = t.args ?? {};
    out.push({
      name,
      description: t.description,
      parameters: { type: "object", properties: Object.fromEntries(Object.entries(args).map(([a, d]) => [a, { type: "string", description: d }])), required: [...(t.required ?? [])] },
      kind: "custom",
      command: t.command,
      argNames: Object.keys(args),
    });
  }
  return out;
}

/** A spec as sent to the model: without the harness's own tags. */
export const forModel = ({ name, description, parameters }) => ({ name, description, parameters });

/** Does this tool need the operator's yes? */
export const needsApproval = (tools, name) => tools?.approve === "all" || (Array.isArray(tools?.approve) && tools.approve.includes(name));

/** The claude CLI's flags for `tools.claude`, placed last so a list flag cannot swallow another. */
export function claudeArgs(tools) {
  const c = tools?.claude;
  if (!c) return [];
  return [
    ...(c.permissionMode ? ["--permission-mode", c.permissionMode] : []),
    ...(c.allow?.length ? ["--allowedTools", ...c.allow] : []),
    ...(c.deny?.length ? ["--disallowedTools", ...c.deny] : []),
  ];
}

/**
 * What in `tools` this run will not use, as warnings. `cliName` is the
 * preset's name for the CLI adapter, null for the openai-compatible one.
 */
export function unreachable(tools, adapter, cliName) {
  if (!tools) return [];
  const w = [];
  const loopParts = ["enable", "custom", "approve"].filter((k) => tools[k] !== undefined);
  if (adapter === "cli" && loopParts.length) {
    w.push(`tools.${loopParts.join(", tools.")} NOT applied: the ${cliName} CLI runs its own tools. These settings reach the openai-compatible adapter${cliName === "claude" ? "; for this CLI use tools.claude" : ""}`);
  }
  if (tools.claude && !(adapter === "cli" && cliName === "claude")) {
    w.push(`tools.claude NOT applied: this run is ${adapter === "cli" ? `the ${cliName} CLI` : `the ${adapter} adapter`}, not the claude CLI`);
  }
  return w;
}

/** An argument shown to the operator: long values cut, so a whole file does not scroll the question away. */
function showArgs(args) {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `    ${k}: ${s.length > 600 ? `${s.slice(0, 600)}… [${s.length - 600} more characters]` : s}`;
    })
    .join("\n");
}

/**
 * Ask on the controlling terminal. Returns { allow, always, why, via }.
 * Reads /dev/tty rather than stdin: stdin may be a pipe carrying the prompt.
 * Synchronous on purpose — the run is waiting on this answer and nothing else.
 */
export function terminalApprover(name, args) {
  let fd;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return { allow: false, why: "there was no terminal to ask the operator on, so the call was refused", via: "no terminal" };
  }
  try {
    writeSync(fd, `\n[caretaker] the model wants to call ${name}\n${showArgs(args)}\n  allow? y = yes, a = yes for the rest of this run, n [reason] = no: `);
    let line = "";
    const buf = Buffer.alloc(1);
    for (;;) {
      const n = readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n") break;
      line += ch;
    }
    const answer = line.trim();
    if (/^(y|yes)$/i.test(answer)) return { allow: true, via: "terminal" };
    if (/^(a|always)$/i.test(answer)) return { allow: true, always: true, via: "terminal" };
    const why = answer.replace(/^(n|no)\b\s*/i, "");
    return { allow: false, why: why || null, via: "terminal" };
  } finally {
    closeSync(fd);
  }
}
