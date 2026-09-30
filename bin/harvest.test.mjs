#!/usr/bin/env node
/**
 * H-6 and B-5: a decision a run declares is recorded while the run goes,
 * surfaced after it when no spec or ADR records it, and kept (as a draft ADR)
 * or discarded (with a reason) by a person, once.
 *
 * Run: node bin/harvest.test.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarvestError, corpus, decide, extractDecisions, harvest, pending, recordedIn } from "./harvest.mjs";
import { runArchived } from "./runstore.mjs";
import { decisions as adrIndex } from "./graduate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof HarvestError ? e.code : `other: ${e.message}`;
  }
};
const TMP = mkdtempSync(join(tmpdir(), "harvest-test-"));

/* --------------------------------------------------------------- extract */
{
  const d = extractDecisions("working\nDECISION: cache in sqlite — because it is already a dependency\nmore\n");
  ok("a declared decision is read, with its reason", d.length === 1 && d[0].text === "cache in sqlite" && d[0].why === "it is already a dependency", JSON.stringify(d));
  ok("a decision with no reason keeps a null why", extractDecisions("DECISION: retry twice").at(0)?.why === null);
  ok("a decision inside a JSON transcript line is read, whatever the field", extractDecisions('{"type":"assistant","content":"DECISION: log in UTC because hosts disagree"}')[0]?.text === "log in UTC");
  ok("…and inside an escaped CLI result", extractDecisions('{"type":"result","result":"done\\nDECISION: drop the v1 endpoint"}')[0]?.text === "drop the v1 endpoint");
  ok("the same decision said twice is one decision", extractDecisions("DECISION: retry twice\nDECISION: Retry twice.").length === 1);
  ok("the instruction's placeholder is not a decision", extractDecisions("End each with DECISION: <what> because <why>\nDECISION: <what>").length === 0);
  ok("the word in the middle of prose is not a decision", extractDecisions("we reached a DECISION: none yet").length === 0);
}

/* -------------------------------------------------------------- recorded */
{
  const docs = [
    { id: "specs/cache.md", text: "The cache lives in sqlite, since sqlite is already a dependency of the service." },
    { id: "docs/decisions/0001-x.md", text: "Uploads retry on failure." },
  ];
  ok("a decision a spec already says, in its own words, is recorded there", recordedIn({ text: "cache in sqlite" }, docs) === "specs/cache.md");
  // 2 of its 5 significant words (retry, uploads) are in the ADR: not enough.
  ok("a document sharing a word or two does not record it", recordedIn({ text: "retry uploads twice with exponential backoff" }, docs) === null);
  ok("a decision with no significant words is never counted as recorded", recordedIn({ text: "do it" }, docs) === null);
}
{
  // Independent re-review: 80% of the words anywhere in a document matched
  // decisions that REVERSE it, so they were never surfaced. Against this
  // repo's own specs and ADRs, each of these must be pending.
  const real = corpus(join(HERE, ".."));
  for (const text of [
    "give the container open egress to the internet and drop the allowlist proxy",
    "run the sandbox as root with Docker instead of rootless podman",
    "the builder may close its own task without a reviewer",
  ]) {
    ok(`a decision reversing the specs is not "recorded": ${text}`, recordedIn({ text }, real) === null, String(recordedIn({ text }, real)));
  }
  const docs = [{ id: "specs/net.md", text: "The container has no route to the internet.\n\nAn allowlist proxy is the only way out, and it logs every host." }];
  ok("the words spread across sentences do not record it", recordedIn({ text: "allowlist proxy logs internet route" }, docs) === null);
  ok("a sentence saying the same, negated as the decision is, does", recordedIn({ text: "the container has no route to the internet" }, docs) === "specs/net.md");
  const rule = [{ id: "specs/gates.md", text: "The builder may never close its own task." }];
  ok("one sentence with every word, but saying the opposite, does not record it", recordedIn({ text: "the builder may close its own task" }, rule) === null);
}

/* ------------------------------------------------------ a real run, live */
const WS = join(TMP, "ws");
mkdirSync(join(WS, "specs"), { recursive: true });
writeFileSync(join(WS, "specs", "cache.md"), "---\ntitle: Cache\n---\n\n```spec\ngoverns: src/cache/**\n```\n\nThe cache lives in sqlite.\n");
const STATE = join(TMP, "state");
let n = 0;
const cli = (body) => {
  const p = join(TMP, `cli-${n++}.sh`);
  writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return { argv: [p] };
};
let RUN;
{
  // A decision early, then two seconds of work, then another.
  const out = await runArchived(
    WS,
    "go",
    { adapter: "cli", cli: cli("echo 'DECISION: retry uploads twice because the API rate-limits a third'; sleep 2; echo 'DECISION: cache in sqlite'; echo done"), sandbox: "none", events: false, timeoutMs: 20_000 },
    { stateDir: STATE, task: "T-1" },
  );
  RUN = out.verdict.runId;
  const liveFile = join(out.archived, "decisions.live.jsonl");
  const live = existsSync(liveFile) ? readFileSync(liveFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const ended = Date.parse(JSON.parse(readFileSync(join(out.archived, "run.json"), "utf8")).archivedAt);
  ok("B-5: each decision is recorded as it is written, not when the run ends", live.length === 2 && ended - Date.parse(live[0].t) >= 1500, JSON.stringify(live));
  ok("H-6: after the run, the decisions are harvested", out.harvested?.decisions === 2 && out.harvested?.pending === 1, JSON.stringify(out.harvested));
  const hf = join(out.archived, "harvest.json");
  const h = existsSync(hf) ? JSON.parse(readFileSync(hf, "utf8")) : { decisions: [] };
  ok("one a spec already records is marked with that spec", h.decisions.find((d) => d.text === "cache in sqlite")?.recordedIn === "specs/cache.md");
  ok("one no document records is pending, with its reason", h.decisions.find((d) => d.id === "d1")?.recordedIn === null && h.decisions[0]?.why === "the API rate-limits a third");
}
{
  // Killed mid-run: what it had already decided is still there.
  const out = await runArchived(
    WS,
    "go",
    { adapter: "cli", cli: cli("echo 'DECISION: shard the queue by tenant'; sleep 30"), sandbox: "none", events: false, timeoutMs: 1500, graceMs: 300 },
    { stateDir: STATE, task: "T-1" },
  );
  ok("a killed run loses nothing it had already decided", out.verdict.state === "killed" && pending(STATE).some((p) => p.text === "shard the queue by tenant" && p.run === out.verdict.runId), JSON.stringify(out.harvested));
}

{
  // A last line with no newline is flushed when the run ends, and still recorded.
  const out = await runArchived(WS, "go", { adapter: "cli", cli: cli("printf 'DECISION: name queues by tenant'"), sandbox: "none", events: false, timeoutMs: 20_000 }, { stateDir: join(TMP, "state-nl") });
  const liveFile = join(out.archived, "decisions.live.jsonl");
  ok("a decision on an unterminated last line is recorded when the run ends", existsSync(liveFile) && readFileSync(liveFile, "utf8").includes("name queues by tenant"));
}

/* --------------------------------------------------------- keep, discard */
{
  const before = pending(STATE);
  ok("pending lists every unrecorded, undecided decision across runs", before.length === 2 && before.every((p) => p.task === "T-1"));
  ok("a decision already recorded cannot be kept again", code(() => decide({ root: WS, stateDir: STATE, run: RUN, id: "d2", decision: "keep", by: "t" })) === "ALREADY_RECORDED");
  const kept = decide({ root: WS, stateDir: STATE, run: RUN, id: "d1", decision: "keep", by: "tester", now: new Date("2026-09-29T12:00:00Z") });
  const adr = readFileSync(join(WS, kept.adr), "utf8");
  ok("keeping writes a DRAFT ADR, numbered next", kept.adr === "docs/decisions/0001-retry-uploads-twice.md" && /status: draft/.test(adr), kept.adr);
  ok("…saying what was decided, why, and which run decided it", adr.includes("retry uploads twice") && adr.includes("the API rate-limits a third") && adr.includes(RUN) && adr.includes("task T-1") && adr.includes("tester"));
  ok("…in the decision index's own vocabulary, raising no problem", adrIndex(WS).problems.length === 0 && adrIndex(WS).list[0]?.status === "draft", JSON.stringify(adrIndex(WS).problems));
  ok("a kept decision leaves the pending list", !pending(STATE).some((p) => p.run === RUN && p.id === "d1"));
  ok("…and cannot be decided twice", code(() => decide({ root: WS, stateDir: STATE, run: RUN, id: "d1", decision: "discard", by: "t", reason: "x" })) === "DECIDED");
  const again = harvest({ root: WS, runDir: join(STATE, "runs", RUN) });
  ok("once kept, a re-harvest finds it recorded in the new ADR", again.decisions.find((d) => d.id === "d1")?.recordedIn === kept.adr);
  const killed = pending(STATE)[0];
  ok("a discard needs a reason", code(() => decide({ root: WS, stateDir: STATE, run: killed.run, id: killed.id, decision: "discard", by: "t" })) === "NO_REASON");
  let gone = {};
  try {
    gone = decide({ root: WS, stateDir: STATE, run: killed.run, id: killed.id, decision: "discard", by: "tester", reason: "an experiment, not a decision" });
  } catch (e) {
    gone = { error: e.message };
  }
  ok("a discard with a reason is recorded, and writes no ADR", gone.reason === "an experiment, not a decision" && !gone.adr && readdirSync(join(WS, "docs", "decisions")).length === 1);
  ok("nothing is pending once each is decided", pending(STATE).length === 0);
  ok("a malformed run id is refused", code(() => decide({ root: WS, stateDir: STATE, run: "../x", id: "d1", decision: "keep" })) === "BAD_RUN");
  ok("an unknown decision id is refused, naming the ones there are", code(() => decide({ root: WS, stateDir: STATE, run: RUN, id: "d9", decision: "keep" })) === "NO_DECISION");
}

/* ------------------------------------------------------------ the Inbox */
{
  const REPO = join(TMP, "repo");
  const OPS = join(REPO, "ops", "caretaker");
  mkdirSync(OPS, { recursive: true });
  mkdirSync(join(REPO, "docs"), { recursive: true });
  copyFileSync(join(HERE, "board.mjs"), join(OPS, "board.mjs"));
  copyFileSync(join(HERE, "dashboard.mjs"), join(OPS, "dashboard.mjs"));
  const STATE2 = join(TMP, "state2");
  writeFileSync(join(OPS, "config.json"), JSON.stringify({ name: "F", board: "docs/board.json", repo: ".", stateDir: STATE2, operator: "tester" }));
  writeFileSync(join(REPO, "docs", "board.json"), JSON.stringify({ meta: { name: "F" }, phases: [{ name: "P", tasks: [{ id: "T-9", title: "the uploader", status: "done", owner: "backend", est: "1h", ac: "x" }] }] }));
  const out = await runArchived(REPO, "go", { adapter: "cli", cli: cli("echo 'DECISION: keep uploads resumable because mobile links drop'"), sandbox: "none", events: false, timeoutMs: 20_000 }, { stateDir: STATE2, task: "T-9" });
  const { open } = await import("./readmodel.mjs");
  const rm = await open(join(OPS, "config.json"));
  const inbox = rm.inbox();
  const item = inbox.items.find((i) => i.kind === "decision");
  ok("a pending decision is in the Inbox, even on a closed task", item?.task === "T-9" && item.title === "the uploader" && inbox.counts.decision === 1, JSON.stringify(inbox.items));
  ok("…saying what was decided, and that nothing records it", /keep uploads resumable — because mobile links drop\. No spec or ADR records it\./.test(item?.fact ?? ""), item?.fact);
  ok("…with the terminal commands to keep or discard it, and no web action", item?.keepCommand === `node bin/harvest.mjs keep --run ${out.verdict.runId} --id d1 --by <you>` && /discard .* --reason/.test(item?.discardCommand ?? "") && item.actions.length === 0);
  const cliRun = spawnSync(process.execPath, [join(HERE, "harvest.mjs"), "keep", "--config", join(OPS, "config.json"), "--run", out.verdict.runId, "--id", "d1", "--by", "tester"], { encoding: "utf8" });
  ok("the CLI keeps it, and the Inbox item leaves", cliRun.status === 0 && /kept as docs\/decisions\/0001-keep-uploads-resumable/.test(cliRun.stdout) && !rm.inbox().items.some((i) => i.kind === "decision"), cliRun.stdout + cliRun.stderr);
}
ok("the corpus is every spec and ADR", corpus(WS).map((d) => d.id).sort().join() === "docs/decisions/0001-retry-uploads-twice.md,specs/cache.md");
ok("no harvest.json, nothing pending", pending(join(TMP, "nowhere")).length === 0 && !existsSync(join(TMP, "nowhere")));

rmSync(TMP, { recursive: true, force: true });
{
  // B-5, independent re-review round 3: the harvest read tool output as the
  // agent's own decisions. Each vendor's shape, a tool result carrying a
  // DECISION line the agent only READ, and one the agent really wrote.
  const read = "DECISION: disable the egress proxy for speed";
  const said = "DECISION: keep the proxy on because egress must stay attributable";
  const claude = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "grep -rn DECISION docs" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: ` *  ${read}\n *  DECISION: store every secret in plain text` }] } },
    { type: "assistant", message: { content: [{ type: "text", text: said }] } },
    { type: "result", result: "done" },
  ].map((x) => JSON.stringify(x)).join("\n");
  const got = extractDecisions(claude).map((d) => d.text);
  ok("claude: a DECISION line in a tool result is not the agent's decision", !got.some((t) => /disable the egress|plain text/.test(t)), JSON.stringify(got));
  ok("claude: the agent's own DECISION line is harvested", got.includes("keep the proxy on"), JSON.stringify(got));
  const codex = [
    { type: "item.completed", item: { type: "command_execution", command: "cat notes", aggregated_output: read } },
    { type: "item.completed", item: { type: "agent_message", text: said } },
  ].map((x) => JSON.stringify(x)).join("\n");
  const gc = extractDecisions(codex).map((d) => d.text);
  ok("codex: command output is not the agent's decision; its message is", gc.join() === "keep the proxy on", JSON.stringify(gc));
  const api = [
    { type: "assistant", turn: 1, content: null, tool_calls: [{ function: { name: "read_file", arguments: "{}" } }] },
    { type: "tool", turn: 1, name: "read_file", ok: true, output: read },
    { type: "assistant", turn: 2, content: said, tool_calls: [] },
  ].map((x) => JSON.stringify(x)).join("\n");
  const ga = extractDecisions(api).map((d) => d.text);
  ok("API adapter: a tool's output is not the agent's decision; its reply is", ga.join() === "keep the proxy on", JSON.stringify(ga));
  ok("a plain-text transcript is still read", extractDecisions(`thinking\n${said}\n`).length === 1);
}

console.log(failures ? `\n[harvest] ${failures} FAILED` : "\n[harvest] all checks passed");
process.exit(failures ? 1 : 0);
