#!/usr/bin/env node
/**
 * W-16: the Getting started page walks a new repo to its first closed task,
 * and the walk works. Every <pre data-walk="…"> block in
 * web/src/pages/GettingStarted.tsx is run, in order, in a scratch git repo,
 * with /path/to/your-repo and /path/to/caretaker filled in. data-walk says
 * what the block must do: "ok" (exit 0) or "refused" (exit 1, REFUSED).
 *
 * Run: node bin/getting-started.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const page = readFileSync(join(ROOT, "web", "src", "pages", "GettingStarted.tsx"), "utf8");
const steps = [...page.matchAll(/<pre[^>]*data-walk="(ok|refused)"[^>]*>\{`([\s\S]*?)`\}<\/pre>/g)].map((m) => ({ expect: m[1], script: m[2] }));
ok("the page has a walk to run", steps.length >= 4, String(steps.length));

const TMP = mkdtempSync(join(tmpdir(), "getting-started-"));
const repo = join(TMP, "your-repo");
mkdirSync(repo);
spawnSync("git", ["init", "-q", repo]);
const results = [];
for (const [i, s] of steps.entries()) {
  const script = s.script.replaceAll("/path/to/your-repo", repo).replaceAll("/path/to/caretaker", ROOT);
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], { cwd: repo, encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } });
  const out = `${r.stdout}${r.stderr}`;
  const good = s.expect === "ok" ? r.status === 0 : r.status === 1 && /REFUSED/.test(out);
  results.push(good);
  ok(`step ${i + 1} does what the page says (${s.expect}): ${s.script.split("\n").at(-1).slice(0, 60)}`, good, out.slice(-400));
}
const board = (() => {
  try {
    return JSON.parse(readFileSync(join(repo, "docs", "board.json"), "utf8"));
  } catch {
    return null;
  }
})();
const t = board?.phases?.[0]?.tasks?.find((x) => x.id === "T-001");
ok("the walk ends with the first task closed", t?.status === "done" && !!t.completed, JSON.stringify(t));
ok("…and every move on it recorded, with who made it", (t?.transitions ?? []).map((m) => m.cmd).join() === "start,done" && t.transitions.every((m) => m.by && m.via === "cli"), JSON.stringify(t?.transitions));
// Independent re-review: the checks were the one move with no who.
ok("…the verdicts included", ["reviewer", "qa"].every((g) => t?.gate?.[g]?.by && t.gate[g].via === "cli"), JSON.stringify(t?.gate));

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[getting-started] ${failures} FAILED` : "\n[getting-started] all checks passed");
process.exit(failures ? 1 : 0);
