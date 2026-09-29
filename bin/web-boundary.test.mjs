#!/usr/bin/env node
/**
 * W-5: the web client displays; core decides (TECH.md §4, §5).
 *
 * Fails if anything under web/src:
 *   1. imports from bin/ (core never ships into the browser, and the browser
 *      never grows a second copy of a rule)
 *   2. imports one of the vendor SDK packages bin/harness.test.mjs checks
 *   3. contains innerHTML or dangerouslySetInnerHTML
 *   4. names a gate or a lifecycle stage in a string literal outside
 *      web/src/api/labels.ts, the one display-label module
 *   5. contains an http:// or https:// URL, which would be an external request
 *   6. contains a color literal outside web/src/theme.css
 *
 * Every rule is proven by attack first: a planted violation of each one must
 * be caught, or the scan of the real tree proves nothing. Needs no npm install.
 *
 * Run: node bin/web-boundary.test.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES } from "./lifecycle.mjs";
import { missingGates } from "./board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "web", "src");

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

// The same package list as bin/harness.test.mjs, and not claimed complete.
const VENDOR_PACKAGES = ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk", "openai", "@google/generative-ai", "@google/genai", "@mistralai/mistralai", "cohere-ai", "ollama"];
// Gate names are whatever core's missingGates can ask for, read from core
// rather than typed here: a task that touches money, auth and isolation.
const GATES = missingGates({ title: "auth token money isolation sandbox", gate: {} }).missing.map((g) => g.split(" ")[0]);
const NAMES = [...new Set([...GATES, ...STAGES])];
const NAMED_COLORS = ["red", "green", "blue", "white", "black", "gray", "grey", "orange", "purple", "violet", "pink", "yellow", "silver", "navy", "teal", "maroon", "crimson", "gold"];

const LABELS = ["api", "labels.ts"].join(sep);
const THEME = "theme.css";

/** Returns [rule, detail] for every violation in one file's text. */
export function violations(rel, text) {
  const out = [];
  const code = rel.endsWith(".css") ? text.replace(/\/\*[\s\S]*?\*\//g, "") : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)) {
    const spec = m[1];
    if (/(^|\/)bin\//.test(spec) || /\.\.\/(\.\.\/)+bin\b/.test(spec)) out.push(["imports from bin/", spec]);
    if (VENDOR_PACKAGES.some((v) => spec === v || spec.startsWith(`${v}/`))) out.push(["imports a vendor SDK", spec]);
  }
  if (/\binnerHTML\b|dangerouslySetInnerHTML/.test(code)) out.push(["uses innerHTML", "innerHTML"]);
  if (rel !== LABELS && !rel.endsWith(".css")) {
    for (const m of code.matchAll(/(["'`])([a-z-]+)\1/g)) {
      if (NAMES.includes(m[2])) out.push(["names a gate or stage outside labels.ts", m[0]]);
    }
  }
  for (const m of code.matchAll(/\bhttps?:\/\/[^\s"'`)]*/g)) out.push(["contains an external URL", m[0]]);
  if (rel !== THEME) {
    for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g)) {
      // A hex run in an id, a fragment or a hash is not a color when it is not a whole token after '#'.
      out.push(["contains a color literal", m[0]]);
    }
    for (const m of code.matchAll(/(["'`])([a-z]+)\1/g)) {
      if (NAMED_COLORS.includes(m[2]) && /(?:color|background|fill|stroke|border)[\w-]*["']?\s*[:=]\s*$/i.test(code.slice(Math.max(0, m.index - 40), m.index))) {
        out.push(["contains a color literal", m[0]]);
      }
    }
  }
  return out;
}

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|js|jsx|mjs|css)$/.test(n)) out.push(p);
  }
  return out;
}

/* 1. each rule catches a planted violation ------------------------------- */
{
  const Q = '"';
  const plant = [
    ["imports from bin/", "src/pages/X.tsx", `import { stageOf } from "../../../bin/lifecycle.mjs";`],
    ["imports from bin/", "src/pages/X.tsx", `const m = await import("../../bin/board.mjs");`],
    // Quotes spliced in, so bin/harness.test.mjs's scan of bin/ does not read these as imports.
    ["imports a vendor SDK", "src/api/X.ts", `import Anthropic from ${Q}@anthropic-ai/sdk${Q};`],
    ["imports a vendor SDK", "src/api/X.ts", `import OpenAI from ${Q}openai/index${Q};`],
    ["uses innerHTML", "src/pages/X.tsx", `el.innerHTML = transcript;`],
    ["uses innerHTML", "src/pages/X.tsx", `<pre dangerouslySetInnerHTML={{ __html: t }} />`],
    ["names a gate or stage outside labels.ts", "src/pages/X.tsx", `if (t.lifecycle === "human") show();`],
    ["names a gate or stage outside labels.ts", "src/pages/X.tsx", `const g = t.gates["security"];`],
    ["contains an external URL", "src/pages/X.tsx", `fetch("https://api.example.com/x");`],
    ["contains an external URL", "src/fonts.css", `@import url(http://fonts.example.com/inter.css);`],
    ["contains a color literal", "src/pages/X.tsx", `<div style={{ color: "#dc2626" }} />`],
    ["contains a color literal", "src/components/X.css", `.x { background: rgb(0 0 0); }`],
    ["contains a color literal", "src/pages/X.tsx", `<i style={{ background: "red" }} />`],
  ];
  for (const [rule, rel, text] of plant) {
    const got = violations(rel.split("/").slice(1).join(sep), text);
    ok(`a planted "${rule}" is caught: ${text.slice(0, 60)}`, got.some(([r]) => r === rule), JSON.stringify(got));
  }
  ok("labels.ts may name a stage", !violations(LABELS, `export const L = { human: "Human" }; const x = "human";`).length);
  ok("theme.css may hold colors", !violations(THEME, `:root { --fail: #b91c1c; --x: rgba(0,0,0,.1); }`).length);
  ok("a var() is not a color literal", !violations(join("pages", "X.tsx"), `<i style={{ background: "var(--line)" }} />`).length);
}

/* 2. the real tree is clean ----------------------------------------------- */
{
  const list = files(SRC);
  ok("web/src has files to check", list.length > 10, String(list.length));
  const found = [];
  for (const f of list) {
    const rel = relative(SRC, f);
    for (const [rule, detail] of violations(rel, readFileSync(f, "utf8"))) found.push(`${rel}: ${rule}: ${detail}`);
  }
  ok(`no file under web/src breaks a boundary rule (${list.length} files, ${NAMES.length} gate and stage names)`, found.length === 0, found.join("\n      "));
  ok("labels.ts exists and is the one place naming them", list.some((f) => relative(SRC, f) === LABELS));
  ok("theme.css holds the colors", /--fail:\s*#/.test(readFileSync(join(SRC, THEME), "utf8")));
}

console.log(failures ? `\n[web-boundary] ${failures} FAILED` : "\n[web-boundary] all checks passed");
process.exit(failures ? 1 : 0);
