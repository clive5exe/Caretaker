#!/usr/bin/env node
/**
 * paths.mjs: "is this inside the workspace?" answered once, and correctly,
 * against the bypasses the independent review found.
 *
 * Run: node bin/paths.test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { under, within } from "./paths.mjs";
import { RunStoreError, checkStateDir } from "./runstore.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const TMP = mkdtempSync(join(tmpdir(), "paths-test-"));
const WS = join(TMP, "ws");
mkdirSync(join(WS, "src"), { recursive: true });

ok("a directory named ..state inside the workspace IS inside (a parent is `..` as a whole segment)", within(join(WS, "..state"), WS));
ok("a sibling that shares a prefix is not inside", !within(join(TMP, "ws-backup"), WS));
ok("the parent is not inside", !within(TMP, WS));
ok("the workspace is within itself, but not under itself", within(WS, WS) && !under(WS, WS));
symlinkSync(join(WS, "src"), join(TMP, "link-into-ws"));
ok("a path through a symlink into the workspace is inside", within(join(TMP, "link-into-ws", "state"), WS));
symlinkSync(WS, join(TMP, "ws-alias"));
ok("a workspace given by a symlinked path still contains its own files", within(join(WS, "x"), join(TMP, "ws-alias")));
ok("a path not created yet is judged by where it will be", within(join(TMP, "link-into-ws", "a", "b", "c"), WS));

let code = null;
try {
  checkStateDir(join(WS, "..state"), WS);
} catch (e) {
  code = e instanceof RunStoreError ? e.code : e.message;
}
ok("runstore refuses a state dir at <ws>/..state, where the next agent could read it", code === "STATE_IN_WORKSPACE", String(code));

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[paths] ${failures} FAILED` : "\n[paths] all checks passed");
process.exit(failures ? 1 : 0);
