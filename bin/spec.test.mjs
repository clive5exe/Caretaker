#!/usr/bin/env node
/**
 * Tests for the spec parser.
 *
 * MOST OF THESE ARE NEGATIVE, on purpose. A parser that accepts a malformed
 * spec is worse than no parser: the project believes it declared an allowlist
 * entry it did not, and finds out either when something it needed is blocked,
 * or never.
 *
 * Run: node bin/spec.test.mjs
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSpec, toEgress, toLimits, governs, globToRegExp, readDevcontainer,
} from "./spec.mjs";

let failures = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};
const block = (body) => "# doc\n\n```spec\n" + body + "\n```\n\nprose\n";
const work = mkdtempSync(join(tmpdir(), "spec-test-"));
const devFile = (obj, name = "devcontainer.json") => {
  const p = join(work, name);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return p;
};

/* ------------------------------------------------------------------ parsing */

{
  const r = parseSpec(block("hosts: api.stripe.com, api.resend.com\ngoverns: src/lib/*, docs/*.md"));
  ok("a well-formed block parses", r.ok, r.errors.join("; "));
  ok("lists are split and trimmed", r.spec.hosts.length === 2 && r.spec.hosts[1] === "api.resend.com");
}

ok("a file with no spec block is refused", parseSpec("# just prose\n").ok === false);

{
  // Hosts reach the proxy's argv and a shell script; only host names may.
  const r = parseSpec(block("hosts: api.example.com, .example.org, $(touch${IFS}/tmp/x), *, .com, com\ngoverns: src/**"));
  ok("a host that is not a host name is an error, named", !r.ok && ["$(touch${IFS}/tmp/x)", "*", ".com", "com"].every((h) => r.errors.some((e) => e.includes(`"${h}"`))), r.errors.join("; "));
  ok("…and is dropped, so it never reaches an allowlist or a shell", JSON.stringify(r.spec.hosts) === '["api.example.com",".example.org"]', JSON.stringify(r.spec.hosts));
}

{
  const r = parseSpec(block("host: api.stripe.com\ngoverns: src/**"));
  ok(
    "a TYPO'D FIELD is an error, not silently ignored",
    r.ok === false && r.errors.some((e) => e.includes("host")),
    "the most important refusal here: `host:` for `hosts:` would leave a project believing " +
      "it declared an allowlist entry that does not exist",
  );
}

{
  const r = parseSpec(block("runtime: node@22\ngoverns: src/**"));
  ok(
    "a field that belongs in devcontainer.json is refused, and says so",
    r.ok === false && r.errors.some((e) => e.includes("devcontainer.json")),
    "an earlier version of this parser declared runtime, services, memory and cpus, all of " +
      "which devcontainer.json already carries",
  );
}

{
  const r = parseSpec(block("hosts: api.stripe.com"));
  ok(
    "governs is required — a spec governing nothing is decoration",
    r.ok === false && r.errors.some((e) => e.includes("governs")),
  );
}

ok(
  "a field declared twice is an error rather than last-wins",
  parseSpec(block("governs: src/**\ngoverns: other/**")).ok === false,
);

ok(
  "a line that is not key: value is an error",
  parseSpec(block("governs: src/**\nthis line has no colon")).ok === false,
);

{
  const r = parseSpec(block("governs: src/**   # everything under src"));
  ok("a trailing comment is stripped", r.ok && r.spec.governs[0] === "src/**", r.spec?.governs?.[0]);
}

{
  const md = "```spec\ngoverns: src/**\n```\n\n```spec\ngoverns: other/**\n```\n";
  const r = parseSpec(md);
  ok(
    "only the FIRST block is read, so a second cannot merge in unnoticed",
    r.ok && r.spec.governs[0] === "src/**",
    r.spec?.governs?.[0],
  );
}

/* -------------------------------------------------------- devcontainer.json */

{
  const p = devFile('{\n  // a comment, which devcontainer.json permits\n  "image": "node:22",\n  "features": { "ghcr.io/devcontainers/features/node:1": {} },\n}\n');
  const dev = readDevcontainer(p);
  ok(
    "JSONC parses — comments and trailing commas are legal here and real files use both",
    dev && !dev.__error && dev.image === "node:22",
    dev?.__error,
  );
}

ok("a missing devcontainer.json is null, not a throw", readDevcontainer(join(work, "nope.json")) === null);

{
  const dev = readDevcontainer(devFile("{ this is not json }"));
  ok("an unparseable devcontainer reports the error rather than throwing", Boolean(dev?.__error));
}

/* ------------------------------------------------------------------ limits */

{
  const dev = readDevcontainer(devFile({ hostRequirements: { cpus: 4, memory: "8gb" }, image: "node:22" }));
  const l = toLimits(dev);
  ok("declared limits are read from hostRequirements", l.memory === "8gb" && l.cpus === "4");
  ok("the image comes through", l.image === "node:22");
}

{
  const l = toLimits(readDevcontainer(devFile({ image: "node:22" })));
  ok("an undeclared memory limit still gets one", l.memory === "2gb");
  ok("an undeclared cpu limit still gets one", l.cpus === "2");
  ok("the root filesystem is read-only", l.readOnlyRoot === true);
  ok("the container socket is never mounted", l.containerSocket === false);
}

/* ------------------------------------------------------------------ egress */

{
  const { spec } = parseSpec(block("hosts: api.stripe.com\ngoverns: src/**"));
  const dev = readDevcontainer(devFile({ features: { "ghcr.io/devcontainers/features/node:1": {} } }));
  const e = toEgress(spec, dev);
  ok("declared hosts are allowed", e.allow.includes("api.stripe.com"));
  ok("the registry is implied from the declared feature", e.allow.includes("registry.npmjs.org"));
  ok("everything else is denied", e.denyByDefault === true);
  ok("refusals are logged, so a block is not mistaken for a network fault", e.logRefusals === true);
}

{
  const { spec } = parseSpec(block("governs: src/**"));
  const dev = readDevcontainer(devFile({ features: { "ghcr.io/devcontainers/features/python:1": {} } }));
  ok("the registry follows the toolchain", toEgress(spec, dev).allow.includes("pypi.org"));
}

{
  const { spec } = parseSpec(block("governs: src/**"));
  const dev = readDevcontainer(devFile({ features: { "ghcr.io/acme/cobol:1": {} } }));
  ok(
    "an unrecognised toolchain implies NOTHING rather than guessing",
    toEgress(spec, dev).allow.length === 0,
    "guessing a registry for a toolchain we do not know would open a host nobody declared, " +
      "which is the one direction this must never fail in",
  );
}

{
  // The reviewer's cases: a toolchain name inside another word, or in the
  // devcontainer's free-text name, opened hosts nobody declared.
  const { spec } = parseSpec(block("governs: src/**"));
  const allow = (dev) => toEgress(spec, dev).allow;
  ok("an image named javascript-node does not imply java's registry", !allow({ image: "mcr.microsoft.com/devcontainers/javascript-node:1" }).includes("repo1.maven.org"));
  ok("the devcontainer's free-text name implies nothing", allow({ name: "Let us go, trustworthy rust" }).length === 0, JSON.stringify(allow({ name: "Let us go, trustworthy rust" })));
  ok("a feature whose name only CONTAINS a toolchain implies nothing", allow({ features: { "ghcr.io/acme/trustworthy:1": {}, "ghcr.io/acme/golden:2": {} } }).length === 0);
  ok("an image that IS a toolchain implies its registry", allow({ image: "docker.io/library/node:22-alpine" }).join() === "registry.npmjs.org");
  ok("a prototype key is not a toolchain", allow({ features: { "x/constructor:1": {}, "x/__proto__:1": {} } }).length === 0);
}

{
  const { spec } = parseSpec(block("governs: src/**"));
  ok("no devcontainer at all still yields an empty, closed allowlist",
    toEgress(spec, null).allow.length === 0 && toEgress(spec, null).denyByDefault === true);
}

/* ----------------------------------------------------------------- governs */

{
  const { spec } = parseSpec(block("governs: src/lib/pricing*, src/api/**"));
  ok("a prefix glob matches", governs(spec, "src/lib/pricing.ts"));
  ok("a double-star matches deeply", governs(spec, "src/api/checkout/route.ts"));
  ok("an unrelated path does not match", !governs(spec, "src/components/hero.tsx"));
  ok(
    "a single star does not cross a directory boundary",
    !governs(spec, "src/lib/pricing/nested/file.ts"),
    "src/lib/pricing* must not swallow a whole subtree",
  );
}

ok("a/**/b matches a/b with no directory between", globToRegExp("a/**/b").test("a/b"));
ok("a/**/b matches a/x/y/b", globToRegExp("a/**/b").test("a/x/y/b"));
ok("a dot is literal, not any-character", !globToRegExp("a.ts").test("axts"));

console.log(failures === 0 ? "\n[spec] all checks passed" : `\n[spec] ${failures} FAILURE(S) above.`);
process.exit(failures === 0 ? 0 : 1);
