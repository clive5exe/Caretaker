#!/usr/bin/env node
/**
 * H-4: the drift gate runs after a run, and only a check that covers the
 * failing paths can clear it (independent re-review).
 *
 * A scratch repo with an installed board (reviewer and qa already passed on
 * T-1), a spec governing src/**, and a scripted OpenAI-compatible model whose
 * run writes src/fee.js. `runstore.mjs run --task T-1` must record a drift
 * fail, `board.mjs done T-1` must refuse, a narrower pass must not clear it,
 * and a check that covers src/fee.js after the spec changes must.
 *
 * Run: node bin/drift-after-run.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driftOpen } from "./board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

/* ---------------------------------------------------- the rule, on its own */
{
  const f = (t, flagged) => ({ t, kind: "gate", task: "T", verdict: "fail", detail: "drift 1", flagged });
  const p = (t, checked) => ({ t, kind: "gate", task: "T", verdict: "pass", detail: "drift 0", ...(checked ? { checked } : {}) });
  ok("a pass that checked other paths leaves the fail open, and names what is open", /still open: src\/fee\.js/.test(driftOpen([f("1", ["src/fee.js"]), p("2", ["README.md"])], "T") ?? ""));
  ok("a pass that checked the flagged paths clears it", driftOpen([f("1", ["src/fee.js"]), p("2", ["src/fee.js", "README.md"])], "T") === null);
  ok("…only the paths it checked: two flagged, one checked, one still open", /still open: src\/b\.js\)$/.test(driftOpen([f("1", ["src/a.js", "src/b.js"]), p("2", ["src/a.js"])], "T") ?? ""));
  ok("an older fail with no paths is cleared by any later pass, as before", driftOpen([f("1"), p("2", ["README.md"])], "T") === null);
  ok("an older pass with no paths clears everything, as before", driftOpen([f("1", ["src/fee.js"]), p("2")], "T") === null);
  ok("a refutation is not the drift gate", driftOpen([{ ...f("1", ["x"]), source: "refute" }], "T") === null);
}

/* ------------------------------------------------------------ end to end */
const TMP = mkdtempSync(join(tmpdir(), "drift-after-run-"));
const R = join(TMP, "repo");
for (const d of ["ops/caretaker", "docs", "specs", "src"]) mkdirSync(join(R, d), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(R, "ops", "caretaker", "board.mjs"));
writeFileSync(join(R, "ops", "caretaker", "config.json"), JSON.stringify({ name: "Fx", board: "docs/board.json", repo: ".", activePhase: "P", operator: "five" }));
writeFileSync(join(R, "specs", "fee.md"), "# Fees\n\n```spec\ngoverns: src/**\n```\n\nThe fee is 2%.\n");
writeFileSync(join(R, "README.md"), "hello\n");
writeFileSync(join(R, "docs", "board.json"), JSON.stringify({ meta: { name: "Fx" }, phases: [{ name: "P", tasks: [
  { id: "T-1", title: "change the fee", owner: "b", est: "1h", status: "doing", ac: "fee is 3%", gate: { reviewer: { verdict: "pass", at: "2026-01-01" }, qa: { verdict: "pass", at: "2026-01-01" } } },
] }] }, null, 2));
const git = (...a) => spawnSync("git", ["-C", R, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "init");

let turn = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    turn += 1;
    const msg = turn === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/fee.js", content: "export const FEE = 0.03;\n" }) } }] }
      : { role: "assistant", content: "done" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const settings = join(TMP, "harness.json");
writeFileSync(settings, JSON.stringify({ default: { adapter: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "m" } }));
// Async, not spawnSync: the scripted model server runs in this process.
const node = (args) =>
  new Promise((res) => {
    const p = spawn(process.execPath, args, { cwd: R });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => res({ status, out }));
  });
const done = () => spawnSync(process.execPath, [join(R, "ops", "caretaker", "board.mjs"), "done", "T-1"], { cwd: R, encoding: "utf8" });

const run = await node([join(HERE, "runstore.mjs"), "run", "--workspace", R, "--prompt", "raise the fee", "--sandbox", "none", "--state-dir", join(TMP, "state"), "--task", "T-1", "--harness-config", settings]);
server.close();
ok("a run for a task is followed by the drift gate on its own diff", /drift gate for T-1: FAIL on 1 governed path/.test(run.out), run.out);
const evDir = join(R, "ops", "caretaker", "events");
const evFile = existsSync(evDir) ? readdirSync(evDir).map((f) => join(evDir, f))[0] : null;
const gateEv = evFile ? readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "gate") : null;
ok("…recorded against the task and the run, with the path that failed it", gateEv?.task === "T-1" && /^r_[0-9a-f]{8}$/.test(gateEv?.run ?? "") && JSON.stringify(gateEv?.flagged) === '["src/fee.js"]', JSON.stringify(gateEv));
let d = done();
ok("so done refuses, though reviewer and qa passed", d.status === 1 && /drift gate/.test(d.stderr), d.stderr);
spawnSync(process.execPath, [join(HERE, "drift.mjs"), "check", "--repo", R, "--task", "T-1", "--path", "README.md", "--quiet"], { cwd: R });
d = done();
ok("a later pass that checked only README.md does not clear it", d.status === 1 && /still open: src\/fee\.js/.test(d.stderr), d.stderr);
writeFileSync(join(R, "specs", "fee.md"), "# Fees\n\n```spec\ngoverns: src/**\n```\n\nThe fee is 3%.\n");
const fixed = spawnSync(process.execPath, [join(HERE, "drift.mjs"), "check", "--repo", R, "--task", "T-1", "--path", "src/fee.js", "--path", "specs/fee.md", "--quiet"], { cwd: R, encoding: "utf8" });
d = done();
ok("a check covering src/fee.js, with the spec changed too, clears it and done closes", fixed.status === 0 && d.status === 0, `${fixed.status} ${d.stderr}`);

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[drift-after-run] ${failures} FAILED` : "\n[drift-after-run] all checks passed");
process.exit(failures ? 1 : 0);
