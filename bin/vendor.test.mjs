#!/usr/bin/env node
/**
 * Warp's vendored code is exactly upstream's, and every change to it is a
 * patch that applies (docs/plan.md, bin/vendor.mjs). Offline: it checks the
 * repo's real vendor/, then attacks a copy of it.
 *
 * Run: node bin/vendor.test.mjs
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDOR, build, check, readSources } from "./vendor.mjs";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const real = check();
ok("the vendored copy in this repo is exactly upstream's, and every patch applies", real.length === 0, real.join("\n      "));

const T = mkdtempSync(join(tmpdir(), "vendor-test-"));
const copy = (tag) => {
  const v = join(T, tag);
  cpSync(VENDOR, v, { recursive: true });
  return v;
};
try {
  {
    const v = copy("edited");
    appendFileSync(join(v, "cloud-factory/.agents/skills/review-pr/SKILL.md"), "\nhand edit\n");
    const p = check({ vendor: v });
    ok("one hand-edited byte in a vendored file fails the check, by file", p.some((x) => /review-pr\/SKILL\.md: EDITED/.test(x)), p.join("; "));
  }
  {
    const v = copy("added");
    writeFileSync(join(v, "cloud-factory/.agents/skills/review-pr/mine.md"), "caretaker's own\n");
    const p = check({ vendor: v });
    ok("a Caretaker file dropped into vendor/ fails the check", p.some((x) => /mine\.md: not from upstream/.test(x)), p.join("; "));
  }
  {
    const v = copy("removed");
    rmSync(join(v, "cloud-factory/.agents/skills/review-pr/scripts/publish_review.py"));
    ok("a vendored file that was deleted fails the check", check({ vendor: v }).some((x) => /publish_review\.py: missing/.test(x)));
  }
  {
    const v = copy("repinned");
    const s = readSources(v);
    s["cloud-factory"].commit = "0".repeat(40);
    writeFileSync(join(v, "sources.json"), JSON.stringify(s));
    ok("re-pinning without re-syncing fails the check", check({ vendor: v }).some((x) => /manifest is from .* pins 0{40}/.test(x)));
  }
  {
    const v = copy("badpatch");
    // Created here: git does not keep an empty directory, so a checkout with
    // no patches yet has no patches/ at all (CI failed on exactly that).
    mkdirSync(join(v, "patches"), { recursive: true });
    writeFileSync(join(v, "patches", "zz-bad.patch"), "--- a/.github/workflows/nope.yml\n+++ b/.github/workflows/nope.yml\n@@ -1 +1 @@\n-a\n+b\n");
    ok("a patch that no longer applies fails the check, by name", check({ vendor: v }).some((x) => /patch zz-bad\.patch does not apply/.test(x)));
  }
  {
    const out = join(T, "out");
    const files = build(out);
    ok("build installs Warp's skills where agents read them", files.includes(".agents/skills/review-pr/scripts/validate_review_json.py") && files.includes(".agents/skills/write-tech-spec/SKILL.md"));
    ok("build installs Warp's workflows", files.filter((f) => f.startsWith(".github/workflows/")).length === 5, files.join(","));
    ok("build keeps both MIT licences beside what it installs", readFileSync(join(out, ".agents/THIRD_PARTY/cloud-factory.LICENSE"), "utf8").startsWith("MIT License") && files.includes(".agents/THIRD_PARTY/common-skills.LICENSE"));
    ok("the Oz-only demo skill is not installed", !files.some((f) => f.includes("oz-cloud-factory-demo")));
    ok("build refuses a directory that is not empty", (() => {
      try {
        build(out);
        return false;
      } catch (e) {
        return e.code === "NOT_EMPTY";
      }
    })());
  }
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
