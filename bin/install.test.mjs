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
const DEST = join(T, "ops", "foreman");
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
const owned = ["ops/foreman/config.json", "ops/foreman/prompt.txt", "docs/board.json"];
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

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[install] ${failures} FAILED` : "\n[install] all checks passed");
process.exit(failures ? 1 : 0);
