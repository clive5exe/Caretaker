#!/usr/bin/env node
/**
 * W-14: install.sh installs, refuses to overwrite a live install, and upgrades
 * one without touching what the repo owns.
 *
 * The old install being upgraded is `bin/testdata/board.pre-c1.mjs`: the
 * board as it was before it became importable, which the web server refuses
 * ("predates the web API"). An upgrade that works is one after which the
 * server's read model opens the repo, and the repo's config, prompt and board
 * are byte-for-byte what they were.
 *
 * Run: node bin/install.test.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const TMP = mkdtempSync(join(tmpdir(), "install-test-"));
const install = (args, installer = join(REPO, "install.sh")) => spawnSync("bash", [installer, ...args], { encoding: "utf8" });
const target = (name) => {
  const t = join(TMP, name);
  mkdirSync(t, { recursive: true });
  spawnSync("git", ["init", "-q", t]);
  return t;
};

/* ------------------------------------------------------------ fresh install */
const T = target("repo");
const fresh = install([T, "Fixture"]);
const DEST = join(T, "ops", "caretaker");
ok("a fresh install succeeds", fresh.status === 0, fresh.stderr + fresh.stdout);
for (const f of ["board.mjs", "dashboard.mjs", "run.mjs", "loop.sh", "RULES.md", "config.json", "prompt.txt"]) {
  ok(`it installs ${f}`, existsSync(join(DEST, f)));
}
const again = install([T, "Fixture"]);
ok("a second plain install is refused, by name", again.status === 1 && /REFUSING/.test(again.stdout));

/* ------------------------------------- make it an OLD install with local edits */
copyFileSync(join(HERE, "testdata", "board.pre-c1.mjs"), join(DEST, "board.mjs"));
writeFileSync(join(DEST, "prompt.txt"), "this repo's own prompt, edited by its owner\n");
const cfg = JSON.parse(readFileSync(join(DEST, "config.json"), "utf8"));
writeFileSync(join(DEST, "config.json"), JSON.stringify({ ...cfg, activePhase: "Phase 1", localSetting: true }, null, 2));
const board = JSON.parse(readFileSync(join(T, "docs", "board.json"), "utf8"));
board.phases[0].tasks.push({ id: "T-002", title: "the owner's real work", status: "doing", owner: "you", est: "1h", ac: "x" });
writeFileSync(join(T, "docs", "board.json"), JSON.stringify(board, null, 2));
const owned = ["ops/caretaker/config.json", "ops/caretaker/prompt.txt", "docs/board.json"];
const before = Object.fromEntries(owned.map((p) => [p, sha(join(T, p))]));
const oldBoardSha = sha(join(DEST, "board.mjs"));

const { open } = await import("./readmodel.mjs");
let refusedBefore = false;
// The pre-C-1 board runs its CLI when imported (no entry guard; that is what
// C-1 fixed), so its status output is swallowed here rather than printed.
const realLog = console.log;
console.log = () => {};
try {
  await open(join(DEST, "config.json"));
} catch (e) {
  refusedBefore = /predates the web API/.test(e.message);
} finally {
  console.log = realLog;
}
ok("the old install is one the web server refuses (so the upgrade has something to fix)", refusedBefore);

/* ----------------------------------------------------------------- upgrade */
const up = install(["--upgrade", T]);
ok("--upgrade succeeds", up.status === 0, up.stdout + up.stderr);
ok("it names what it replaced", /upgraded .*board\.mjs/.test(up.stdout), up.stdout);
for (const f of ["board.mjs", "dashboard.mjs", "run.mjs", "loop.sh"]) {
  ok(`${f} now matches this checkout`, sha(join(DEST, f)) === sha(join(HERE, f)));
}
for (const p of owned) ok(`${p} is untouched, byte for byte`, sha(join(T, p)) === before[p]);
const backups = readdirSync(DEST).filter((n) => n.startsWith(".upgrade-backup-"));
const backedUp = backups.length === 1 ? join(DEST, backups[0], "board.mjs") : null;
ok("the replaced files are kept in a backup dir", backedUp !== null && existsSync(backedUp) && sha(backedUp) === oldBoardSha);
// A fresh process: Node caches ES modules by URL, so this process still holds
// the OLD board.mjs it imported above and would re-refuse it regardless.
const probe = spawnSync("node", ["--input-type=module", "-e",
  `const { open } = await import(${JSON.stringify(new URL("./readmodel.mjs", import.meta.url).href)});
   const rm = await open(${JSON.stringify(join(DEST, "config.json"))});
   console.log(JSON.stringify(rm.work()).includes("T-002") ? "SEES-T-002" : "NO-T-002");`], { encoding: "utf8" });
ok("after the upgrade the web server opens the repo and sees the owner's board", /SEES-T-002/.test(probe.stdout), probe.stdout + probe.stderr);
const noop = install(["--upgrade", T]);
ok("upgrading an already-current install replaces nothing", noop.status === 0 && /already current/.test(noop.stdout), noop.stdout);
ok("…and leaves no empty backup dir behind", readdirSync(DEST).filter((n) => n.startsWith(".upgrade-backup-")).length === 1);

/* ---------------------------------------------------------------- refusals */
const bare = target("bare");
const noInstall = install(["--upgrade", bare]);
ok("--upgrade on a repo with no install is refused", noInstall.status === 1 && /no install/.test(noInstall.stdout) && !existsSync(join(bare, "ops")));

/* ------------------------------------------ a broken upgrade is rolled back */
{
  // A checkout whose board.mjs cannot load, standing in for a bad release.
  const bad = join(TMP, "bad-checkout");
  mkdirSync(join(bad, "bin"), { recursive: true });
  for (const f of ["install.sh", "RULES.md", "prompt.example.txt", "config.example.json"]) copyFileSync(join(REPO, f), join(bad, f));
  for (const f of ["dashboard.mjs", "run.mjs", "loop.sh"]) copyFileSync(join(HERE, f), join(bad, "bin", f));
  writeFileSync(join(bad, "bin", "board.mjs"), "this is not javascript (\n");
  const current = sha(join(DEST, "board.mjs"));
  const r = install(["--upgrade", T], join(bad, "install.sh"));
  ok("an upgrade whose board cannot read the repo's board exits 1", r.status === 1 && /ROLLED BACK/.test(r.stdout), r.stdout);
  ok("…and the previous board.mjs is back in place", sha(join(DEST, "board.mjs")) === current);
  for (const p of owned) ok(`…and ${p} is still untouched`, sha(join(T, p)) === before[p]);
}

/* -------------------------------------- an install from before the rename */
{
  // Built the way the old name laid it out: ops/<old>/, committed to git, with
  // config paths pointing inside it and a run log that must travel with it.
  // The project's name before the rename. This test and install.sh's
  // migration are the only places it appears: both exist to move old installs.
  const OLD = "foreman";
  const L = target("legacy");
  install([L, "Legacy"]);
  spawnSync("mv", [join(L, "ops", "caretaker"), join(L, "ops", OLD)]);
  const lcfgPath = join(L, "ops", OLD, "config.json");
  const lcfg = JSON.parse(readFileSync(lcfgPath, "utf8"));
  writeFileSync(lcfgPath, JSON.stringify({ ...lcfg, runs: `ops/${OLD}/runs.jsonl`, history: `ops/${OLD}/history.jsonl`, ownerSetting: 42 }, null, 2));
  writeFileSync(join(L, "ops", OLD, "prompt.txt"), `the owner's prompt; rebuild with node ops/${OLD}/board.mjs build\n`);
  writeFileSync(join(L, "ops", OLD, "runs.jsonl"), '{"t":"2026-09-01T00:00:00Z","kind":"end","name":"qa","state":"done","src":"live"}\n');
  const git = (...a) => spawnSync("git", ["-C", L, ...a], { encoding: "utf8" });
  git("add", "ops", "docs");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "old install");
  const boardBefore = sha(join(L, "docs", "board.json"));

  const m = install(["--upgrade", L]);
  const NEW = join(L, "ops", "caretaker");
  ok("an install from before the rename is upgraded, not refused", m.status === 0, m.stdout + m.stderr);
  ok("it now lives at ops/caretaker, and the old directory is gone", existsSync(join(NEW, "config.json")) && !existsSync(join(L, "ops", OLD)));
  ok("the move is a git rename, so history follows", git("ls-files", "ops/caretaker/config.json").stdout.trim() === "ops/caretaker/config.json" && git("ls-files", `ops/${OLD}`).stdout.trim() === "");
  ok("the run log moved with it", existsSync(join(NEW, "runs.jsonl")));
  const ncfg = JSON.parse(readFileSync(join(NEW, "config.json"), "utf8"));
  ok("config paths into the old directory now point into the new one", ncfg.runs === "ops/caretaker/runs.jsonl" && ncfg.history === "ops/caretaker/history.jsonl", JSON.stringify(ncfg));
  ok("every other config value is exactly as the owner left it", ncfg.ownerSetting === 42 && ncfg.name === lcfg.name && ncfg.board === lcfg.board);
  ok("prompt.txt's path is rewritten and the rest of it is not", readFileSync(join(NEW, "prompt.txt"), "utf8") === "the owner's prompt; rebuild with node ops/caretaker/board.mjs build\n");
  const mb = readdirSync(NEW).filter((n) => n.startsWith(".upgrade-backup-"));
  ok("the original config and prompt are kept in the backup", mb.length === 1 && JSON.parse(readFileSync(join(NEW, mb[0], "config.json"), "utf8")).runs === `ops/${OLD}/runs.jsonl`);
  ok("the board is untouched, byte for byte", sha(join(L, "docs", "board.json")) === boardBefore);
  ok("it says to repoint cron at the new loop.sh", /point it at the new path/.test(m.stdout));
  const st = spawnSync("node", ["ops/caretaker/board.mjs", "status"], { cwd: L, encoding: "utf8" });
  ok("the moved install runs", st.status === 0, st.stderr);
}

/* ------------------- a failed upgrade of a pre-rename install is undone whole */
{
  const OLD = "foreman";
  const L = target("legacy-bad");
  install([L, "Legacy"]);
  spawnSync("mv", [join(L, "ops", "caretaker"), join(L, "ops", OLD)]);
  const cfgPath = join(L, "ops", OLD, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), runs: `ops/${OLD}/runs.jsonl` }, null, 2));
  const cfgBefore = sha(cfgPath);
  const bad = join(TMP, "bad-checkout-2");
  mkdirSync(join(bad, "bin"), { recursive: true });
  for (const f of ["install.sh", "RULES.md", "prompt.example.txt", "config.example.json"]) copyFileSync(join(REPO, f), join(bad, f));
  for (const f of ["dashboard.mjs", "run.mjs", "loop.sh"]) copyFileSync(join(HERE, f), join(bad, "bin", f));
  writeFileSync(join(bad, "bin", "board.mjs"), "this is not javascript (\n");
  const r = install(["--upgrade", L], join(bad, "install.sh"));
  ok("a failed upgrade of a pre-rename install exits 1", r.status === 1 && /ROLLED BACK/.test(r.stdout), r.stdout);
  ok("…and the install is back where it was", existsSync(cfgPath) && !existsSync(join(L, "ops", "caretaker")));
  ok("…with its config exactly as before", sha(cfgPath) === cfgBefore);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[install] ${failures} FAILED` : "\n[install] all checks passed");
process.exit(failures ? 1 : 0);
