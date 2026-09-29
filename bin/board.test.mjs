#!/usr/bin/env node
/**
 * Four small defects in the board tooling, each pinned by a check that was
 * watched go red against the unfixed code before the fix went in.
 *
 *   1. board.mjs `esc()` escaped & < > and not quotes. No user text sits in an
 *      HTML attribute in its output today — the one `title="…"` carries only
 *      validated verdicts — so this is a latent hazard, not a live injection.
 *      It is fixed so that adding an attribute later cannot quietly make one.
 *   2. board.mjs ran a `build.mjs` beside itself on every mutation, and no
 *      such file ships, so every mutation printed "build.mjs failed". A hook
 *      that exists is still run; a hook that does not is not an error.
 *   3. docs/board.html pulled fonts from Google, while the README says the
 *      page has "no CDN". The page now makes no external request; the font
 *      stacks already fall back to system fonts.
 *   4. ops/foreman/ is this repo's installed copy of bin/ and had drifted
 *      (run.mjs lacked the token breakdown). The copies must be identical.
 *
 * Fixtures are built in a temp dir by copying the real scripts, because both
 * resolve their repo root from their own location.
 *
 * Run: node bin/board.test.mjs
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fixture({ withBuildHook = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "foreman-board-test-"));
  const ops = join(root, "ops", "foreman");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  copyFileSync(join(HERE, "board.mjs"), join(ops, "board.mjs"));
  copyFileSync(join(HERE, "dashboard.mjs"), join(ops, "dashboard.mjs"));
  writeFileSync(
    join(ops, "config.json"),
    JSON.stringify({
      name: "Fixture",
      board: "docs/board.json",
      boardMarkdown: "docs/board.md",
      out: "docs/board.html",
      runs: "ops/foreman/runs.jsonl",
      history: "ops/foreman/history.jsonl",
      agentsDir: ".claude/agents",
      repo: ".",
      activePhase: "Phase 1",
    }),
  );
  writeFileSync(
    join(root, "docs", "board.json"),
    JSON.stringify({
      meta: { name: "Fixture", updated: "2026-01-01", launch: "2026-12-01" },
      phases: [
        {
          name: "Phase 1",
          start: "2026-01-01",
          end: "2026-02-01",
          goal: "fixture",
          tasks: [
            {
              id: "T-001",
              title: `say "hi" and it's fine`,
              owner: "you",
              est: "1h",
              status: "todo",
              ac: `the "quoted" criterion`,
            },
          ],
        },
      ],
    }),
  );
  if (withBuildHook) {
    writeFileSync(
      join(ops, "build.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./hook-ran", import.meta.url), "yes");\n`,
    );
  }
  return { root, ops };
}

const node = (args, cwd) => spawnSync("node", args, { cwd, encoding: "utf8" });

/* 1. quotes are escaped ---------------------------------------------------- */
{
  const { root, ops } = fixture();
  const r = node([join(ops, "board.mjs"), "build"], root);
  const md = readFileSync(join(root, "docs", "board.md"), "utf8");
  ok("board build exits 0", r.status === 0, r.stderr);
  ok(
    "a double quote in a title is escaped in board.md",
    md.includes("say &quot;hi&quot;") && !md.includes(`say "hi"`),
  );
  ok("a single quote in a title is escaped in board.md", md.includes("it&#39;s fine"));
  ok("a quote in the acceptance criterion is escaped", md.includes("the &quot;quoted&quot; criterion"));
  rmSync(root, { recursive: true, force: true });
}

/* 2. the build hook -------------------------------------------------------- */
{
  const { root, ops } = fixture();
  const r = node([join(ops, "board.mjs"), "note", "T-001", "a note"], root);
  ok("a mutation with no build.mjs exits 0", r.status === 0, r.stderr);
  ok("a mutation with no build.mjs prints no build.mjs error", !/build\.mjs/.test(r.stderr), r.stderr.trim());
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, ops } = fixture({ withBuildHook: true });
  const r = node([join(ops, "board.mjs"), "note", "T-001", "a note"], root);
  ok("a build.mjs that exists is still run on a mutation", existsSync(join(ops, "hook-ran")), r.stderr.trim());
  rmSync(root, { recursive: true, force: true });
}

/* 3. the page makes no external request ------------------------------------ */
{
  const { root, ops } = fixture();
  const r = node([join(ops, "dashboard.mjs")], root);
  ok("dashboard exits 0", r.status === 0, r.stderr);
  const html = readFileSync(join(root, "docs", "board.html"), "utf8");
  const external = html.match(/<(?:link|script|img)[^>]*(?:href|src)=["']?(?:https?:)?\/\/[^"'\s>]+/gi) ?? [];
  ok("board.html loads nothing from another origin", external.length === 0, external.join("\n      "));
  rmSync(root, { recursive: true, force: true });
}

/* 4. the installed copy matches the source --------------------------------- */
for (const f of ["board.mjs", "dashboard.mjs", "run.mjs", "loop.sh"]) {
  const src = readFileSync(join(HERE, f), "utf8");
  const inst = readFileSync(join(REPO, "ops", "foreman", f), "utf8");
  ok(`ops/foreman/${f} is identical to bin/${f}`, src === inst);
}

console.log(failures ? `\n[board] ${failures} FAILED` : "\n[board] all checks passed");
process.exit(failures ? 1 : 0);
