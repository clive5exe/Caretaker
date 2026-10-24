#!/usr/bin/env node
/**
 * Tool control (bin/tools.mjs): the model gets the tools you enabled and no
 * others, your own tools run with their arguments as variables and never as
 * shell text, your yes is asked before a listed call runs, and the claude CLI
 * receives its tool flags. A fake OpenAI-compatible server scripts the model,
 * and a fake `claude` on PATH records the argv it was given. All offline,
 * sandbox:none.
 *
 * Run: node bin/tools.test.mjs
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliToolSetup, run } from "./harness.mjs";
import { HarnessConfigError, policyFor, validate } from "./harness-config.mjs";
import { BUILTIN_TOOLS, ToolsError, checkTools, claudeArgs, menu, terminalApprover, unreachable } from "./tools.mjs";
import { TOOLS } from "./openai-compatible.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const throwsCode = (fn, code) => {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e.code === code ? true : `${e.code}: ${e.message}`;
  }
};

/* ---------------------------------------------------------- fake server */
const scripts = {};
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body);
    seen.push(j);
    const next = (scripts[j.model] ?? []).shift() ?? { choices: [{ message: { role: "assistant", content: "done" } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ENDPOINT = `http://127.0.0.1:${server.address().port}/v1`;
const call = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const say = (tool_calls) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls } }] });
const toolReplies = (model) => (seen.filter((s) => s.model === model).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
const offeredTo = (model) => (seen.find((s) => s.model === model)?.tools ?? []).map((t) => t.function.name);

const TMP = mkdtempSync(join(tmpdir(), "tools-test-"));
let n = 0;
const workspace = () => {
  const w = join(TMP, `ws${n++}`);
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, "README.md"), "hello\n");
  return w;
};
const api = (model, tools, extra = {}) => ({ adapter: "openai-compatible", endpoint: ENDPOINT, model, sandbox: "none", events: false, logDir: join(TMP, `log-${model}`), tools, ...extra });
const transcript = (out) => readFileSync(out.transcript.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

try {
  /* ------------------------------------------------------ settings shape */
  ok("a built-in the harness does not have is refused by name", throwsCode(() => checkTools("t", { enable: ["shell"] }), "BAD_VALUE") === true);
  ok("a custom tool may not take a built-in's name", throwsCode(() => checkTools("t", { custom: { run: { description: "x", command: "true" } } }), "SHADOWS_BUILTIN") === true);
  ok("nor read_skill's", throwsCode(() => checkTools("t", { custom: { read_skill: { description: "x", command: "true" } } }), "SHADOWS_BUILTIN") === true);
  ok("a custom tool needs a description", throwsCode(() => checkTools("t", { custom: { a: { command: "true" } } }), "BAD_VALUE") === true);
  ok("a custom tool needs a command", throwsCode(() => checkTools("t", { custom: { a: { description: "x" } } }), "BAD_VALUE") === true);
  ok("an upper-case argument name is refused (it would replace PATH or HOME)", throwsCode(() => checkTools("t", { custom: { a: { description: "x", command: "true", args: { PATH: "p" } } } }), "BAD_NAME") === true);
  ok("required must name a declared argument", throwsCode(() => checkTools("t", { custom: { a: { description: "x", command: "true", args: { f: "f" }, required: ["g"] } } }), "BAD_VALUE") === true);
  ok("approve must name a tool that exists", throwsCode(() => checkTools("t", { approve: ["nothing"] }), "BAD_VALUE") === true);
  ok('approve may be "all"', checkTools("t", { approve: "all" }).approve === "all");
  ok("a claude allow entry starting with - is refused (the CLI would read a flag)", throwsCode(() => checkTools("t", { claude: { allow: ["--dangerously-skip-permissions"] } }), "BAD_VALUE") === true);
  ok("a claude permission mode the CLI does not have is refused", throwsCode(() => checkTools("t", { claude: { permissionMode: "yolo" } }), "BAD_VALUE") === true);
  ok("an unknown tools key is refused", throwsCode(() => checkTools("t", { disable: ["run"] }), "UNKNOWN_KEY") === true);

  // Through harness settings: tools is a per-role setting, and a role's replaces the default's whole.
  const conf = validate({ default: { tools: { enable: ["read_file"], approve: ["read_file"] } }, roles: { refuter: { tools: { enable: ["list_files"] } } } });
  const b = policyFor("builder", { path: "x", conf }).policy.tools;
  const r = policyFor("refuter", { path: "x", conf }).policy.tools;
  ok("the default's tools reach a role that sets none", JSON.stringify(b) === JSON.stringify({ enable: ["read_file"], approve: ["read_file"] }), JSON.stringify(b));
  ok("a role's tools replace the default's whole, not merged", JSON.stringify(r) === JSON.stringify({ enable: ["list_files"] }), JSON.stringify(r));
  ok("a bad tools setting in the file is refused as a harness settings error", (() => {
    try {
      validate({ roles: { builder: { tools: { enable: ["nope"] } } } });
      return false;
    } catch (e) {
      return e instanceof HarnessConfigError && /roles\.builder\.tools\.enable/.test(e.message);
    }
  })());

  /* ------------------------------------------------------------- menu */
  ok("no tools setting offers the four built-ins", menu(null, TOOLS).map((t) => t.name).join() === BUILTIN_TOOLS.join());
  ok("enable offers exactly those", menu({ enable: ["read_file"] }, TOOLS).map((t) => t.name).join() === "read_file");

  /* --------------------------------------- disabled tool: not offered, not run */
  {
    const ws = workspace();
    scripts.m1 = [say([call("run", { command: "echo pwned > pwned.txt" })])];
    const out = await run(ws, "task", api("m1", { enable: ["list_files", "read_file"] }));
    ok("the model is offered only the enabled tools", offeredTo("m1").join() === "list_files,read_file", offeredTo("m1").join());
    ok("a call to a tool that was not enabled does not run", !existsSync(join(ws, "pwned.txt")));
    ok("...and is answered as a tool that does not exist", /no tool named "run"/.test(toolReplies("m1")[0] ?? ""), toolReplies("m1")[0]);
    ok("...and counted as invented", out.verdict.toolUse.invented === 1, JSON.stringify(out.verdict.toolUse));
  }

  /* --------------------------------- custom tool: args as variables, never code */
  {
    const ws = workspace();
    const tools = { enable: [], custom: { greet: { description: "Say hello to someone.", command: 'printf "hello %s%s\\n" "$who" "$extra"', args: { who: "the name" }, required: ["who"] } } };
    scripts.m2 = [say([call("greet", { who: "$(touch injected.txt)" })]), say([call("greet", { who: "ada", extra: "LEAKED" })])];
    const out = await run(ws, "task", api("m2", tools));
    const replies = toolReplies("m2");
    ok("a custom tool is offered with its own name and description", JSON.stringify(seen.find((s) => s.model === "m2").tools) === JSON.stringify([{ type: "function", function: { name: "greet", description: "Say hello to someone.", parameters: { type: "object", properties: { who: { type: "string", description: "the name" } }, required: ["who"] } } }]));
    ok("a custom tool runs its command and returns the output", replies[1] === "exit 0\nhello ada\n", JSON.stringify(replies));
    ok("an argument is handed over as a variable, never run as shell", !existsSync(join(ws, "injected.txt")) && replies[0] === "exit 0\nhello $(touch injected.txt)\n", JSON.stringify(replies[0]));
    // The command reads $extra, which the tool never declared: the model's value must not reach it.
    ok("an argument the tool did not declare is not handed over at all", !/LEAKED/.test(replies[1] ?? ""), JSON.stringify(replies[1]));
    ok("an empty enable leaves only the custom tools", offeredTo("m2").join() === "greet");
    ok("a custom tool's call is well formed, not counted as a mistake", out.verdict.toolUse.malformed === 0 && out.verdict.toolUse.invented === 0);
  }
  {
    const ws = workspace();
    scripts.m3 = [say([call("greet", {})])];
    await run(ws, "task", api("m3", { custom: { greet: { description: "d", command: 'echo "$who"', args: { who: "w" }, required: ["who"] } } }));
    ok("a missing required argument is answered as malformed, not run", /greet needs who/.test(toolReplies("m3")[0] ?? ""), toolReplies("m3")[0]);
  }
  {
    // No tools at all: the request carries no menu (some servers refuse an empty one).
    const ws = workspace();
    await run(ws, "task", api("m4", { enable: [] }));
    const req = seen.find((s) => s.model === "m4");
    ok("an empty menu is sent as no menu", req && !("tools" in req) && !("tool_choice" in req), JSON.stringify(Object.keys(req ?? {})));
  }

  /* ---------------------------------------------------------- approval */
  {
    const ws = workspace();
    const asked = [];
    const answers = [{ allow: false, why: "write it under src/, not the root" }, { allow: true }];
    const approver = (name, args) => {
      asked.push({ name, args });
      return answers.shift();
    };
    scripts.m5 = [
      say([call("write_file", { path: "a.txt", content: "one" })]),
      say([call("write_file", { path: "src/a.txt", content: "one" })]),
      say([call("read_file", { path: "README.md" })]),
    ];
    const out = await run(ws, "task", api("m5", { approve: ["write_file"] }, { approver }));
    const replies = toolReplies("m5");
    ok("a refused call is not run", !existsSync(join(ws, "a.txt")));
    ok("the operator's reason is handed to the model", replies[0] === "refused by the operator: this call was not run. Their reason: write it under src/, not the root", replies[0]);
    ok("an allowed call runs", readFileSync(join(ws, "src/a.txt"), "utf8") === "one");
    ok("a tool not listed in approve is not asked about", asked.length === 2 && asked.every((a) => a.name === "write_file"), JSON.stringify(asked.map((a) => a.name)));
    ok("the approver sees the call's arguments", asked[0]?.args?.path === "a.txt");
    ok("refusals are counted", out.verdict.toolUse.refused === 1, JSON.stringify(out.verdict.toolUse));
    const records = transcript(out).filter((l) => l.type === "approval");
    ok("every answer is in the transcript", records.length === 2 && records[0].allow === false && records[0].why === "write it under src/, not the root" && records[1].allow === true, JSON.stringify(records));
  }
  {
    const ws = workspace();
    let asks = 0;
    scripts.m6 = [say([call("run", { command: "echo 1 >> n" })]), say([call("run", { command: "echo 2 >> n" })])];
    await run(ws, "task", api("m6", { approve: "all" }, { approver: () => (asks++, { allow: true, always: true }) }));
    ok('"yes for the rest of this run" stops the asking for that tool', asks === 1 && readFileSync(join(ws, "n"), "utf8") === "1\n2\n", `asks=${asks}`);
  }
  {
    const ws = workspace();
    scripts.m7 = [say([call("run", { command: "touch ran" })])];
    await run(ws, "task", api("m7", { approve: ["run"] }, {
      approver: () => {
        throw new Error("the UI went away");
      },
    }));
    ok("an approver that fails refuses the call rather than running it", !existsSync(join(ws, "ran")) && /refused by the operator/.test(toolReplies("m7")[0] ?? ""));
  }
  {
    // The real terminal prompt, through a real pseudo-terminal (util-linux
    // `script`), and with none at all. Skipped by name where `script` is missing.
    const asker = join(TMP, "ask.mjs");
    writeFileSync(asker, `import { terminalApprover } from ${JSON.stringify(new URL("./tools.mjs", import.meta.url).href)};\nconsole.log("RESULT " + JSON.stringify(terminalApprover("write_file", { path: "a.txt", content: "x".repeat(700) })));\n`);
    const viaPty = (answer) => {
      const r = spawnSync("script", ["-qec", `node ${asker}`, "/dev/null"], { input: answer, encoding: "utf8", timeout: 20_000 });
      const line = String(r.stdout ?? "").split(/\r?\n/).find((l) => l.includes("RESULT "));
      return { text: String(r.stdout ?? ""), result: line ? JSON.parse(line.slice(line.indexOf("RESULT ") + 7)) : null, missing: r.error?.code === "ENOENT" };
    };
    const y = viaPty("y\n");
    if (y.missing) console.log("SKIP  the terminal prompt through a pty\n      util-linux script is not on PATH");
    else {
      ok("terminal: y allows once", JSON.stringify(y.result) === JSON.stringify({ allow: true, via: "terminal" }), y.text);
      ok("terminal: a allows for the rest of the run", viaPty("a\n").result?.always === true);
      const no = viaPty("n put it in src/\n").result;
      ok("terminal: n with a reason refuses and keeps the reason", no?.allow === false && no.why === "put it in src/", JSON.stringify(no));
      ok("terminal: an empty answer refuses", viaPty("\n").result?.allow === false);
      ok("terminal: a long argument is cut in the question", /\[100 more characters\]/.test(y.text));
    }
    const none = spawnSync("setsid", ["-w", "node", asker], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });
    if (none.error?.code === "ENOENT") console.log("SKIP  no terminal refuses\n      setsid is not on PATH");
    else ok("no terminal to ask on: the call is refused, and says why", /"allow":false,"why":"there was no terminal to ask the operator on/.test(none.stdout), none.stdout + none.stderr);
  }
  ok("an approver that is not a function is refused", await run(workspace(), "t", api("m8", null, { approver: "yes" })).then(() => false, (e) => /approver must be a function/.test(e.message)));

  /* ---------------------------------------------------- the claude CLI */
  ok("claude flags: permission mode, then allow, then deny, lists last", JSON.stringify(claudeArgs({ claude: { allow: ["Read", "Bash(npm test:*)"], deny: ["WebFetch"], permissionMode: "acceptEdits" } })) === JSON.stringify(["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Bash(npm test:*)", "--disallowedTools", "WebFetch"]));
  {
    // A fake claude on PATH that records its argv; the harness runs it on the host.
    const bin = join(TMP, "bin");
    mkdirSync(bin, { recursive: true });
    const argvFile = join(TMP, "claude-argv.json");
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",result:"ok"}))});\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const out = await run(workspace(), "task", { cli: "claude", sandbox: "none", events: false, logDir: join(TMP, "log-claude"), env: { PATH: process.env.PATH }, tools: { claude: { allow: ["Edit"], deny: ["WebFetch"] }, approve: ["run"] } });
      const argv = existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, "utf8")) : [];
      ok("the claude CLI is given the allow and deny lists", argv.join(" ").endsWith("--allowedTools Edit --disallowedTools WebFetch"), argv.join(" "));
      ok("settings the CLI cannot use are named as not applied", out.verdict.warnings.some((w) => /tools\.approve NOT applied: the claude CLI runs its own tools/.test(w)), JSON.stringify(out.verdict.warnings));
    } finally {
      process.env.PATH = oldPath;
    }
  }
  ok("bypassPermissions on the host is refused before anything runs", await run(workspace(), "t", { cli: "claude", sandbox: "none", events: false, logDir: join(TMP, "log-bypass"), tools: { claude: { permissionMode: "bypassPermissions" } } }).then(() => false, (e) => /refused with sandbox:none/.test(e.message)));
  const inBox = cliToolSetup({ sandbox: "podman", tools: { claude: { permissionMode: "bypassPermissions", allow: ["Edit"] } } }, "claude");
  ok("bypassPermissions in the container sets IS_SANDBOX=1, which claude needs as root", inBox.toolEnv.IS_SANDBOX === "1" && inBox.toolArgs.join(" ") === "--permission-mode bypassPermissions --allowedTools Edit");
  ok("any other mode sets no IS_SANDBOX", cliToolSetup({ sandbox: "podman", tools: { claude: { permissionMode: "acceptEdits" } } }, "claude").toolEnv.IS_SANDBOX === undefined);
  ok("tools.claude on another CLI is named as not applied", unreachable({ claude: { allow: ["Edit"] } }, "cli", "codex").some((w) => /tools\.claude NOT applied: this run is the codex CLI/.test(w)));
  ok("tools.claude on the API adapter is named as not applied", unreachable({ claude: { allow: ["Edit"] } }, "openai-compatible", null).length === 1);
  ok("enable/custom/approve on the API adapter are not warned about", unreachable({ enable: ["run"], approve: "all" }, "openai-compatible", null).length === 0);
  ok("ToolsError is exported for callers", new ToolsError("X", "m").code === "X");
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
