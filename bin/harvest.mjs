#!/usr/bin/env node
/**
 * HARVEST — H-6 and B-5. Decisions settled in a transcript, and recorded in
 * no spec or ADR, are surfaced for a person to keep or discard.
 *
 * Prompt-driven development makes the prompt the real spec, transiently:
 * intent gets settled in a conversation and lands nowhere. So an agent states
 * a decision the way a refuter states its verdict, on a line of its own:
 *
 *     DECISION: retry the upload twice, not three times — because the API rate-limits a third
 *
 * WHAT IS HARVESTED IS WHAT WAS DECLARED. Reading intent out of free prose is a
 * model's job and would make this step probabilistic; a declared line is not.
 * A decision an agent made without saying so is not found here, and the
 * prompt is where that is fixed.
 *
 * B-5: AS THE RUN GOES, NOT AT THE END. runstore's live mirror hands each
 * complete transcript line to `onLine`, which appends any decision to the
 * run's `decisions.live.jsonl` the moment it is written. A run that is killed
 * or a session that is compacted loses nothing it had already decided. (This
 * is as live as the adapter's output: the openai-compatible adapter logs every
 * turn as it happens, and the claude preset streams its events (stream-json).
 * A CLI that prints one JSON result at exit is captured at exit.)
 *
 * The unattended loop does not go through runstore. It streams too, and
 * harvests its output with `import` whether the pass ended cleanly or not.
 *
 * After the run, `harvest` checks each decision against every spec and ADR.
 * One whose significant words are all but absent from each document is
 * pending, and shows in the Inbox. `keep` writes it as a DRAFT ADR, citing the
 * run; `discard` needs a reason. Either is recorded once, and never again.
 *
 * Usage:
 *   node bin/harvest.mjs run     --run r_… [--config ops/caretaker/config.json]
 *   node bin/harvest.mjs keep    --run r_… --id d1 [--by NAME]
 *   node bin/harvest.mjs discard --run r_… --id d1 --reason "…" [--by NAME]
 *   node bin/harvest.mjs pending [--config …]
 *   node bin/harvest.mjs import  --transcript FILE [--task T-1] [--cli claude] [--source loop.sh]
 *   <cli> | node bin/harvest.mjs record --run r_… [--task T-1] [--cli claude] [--source loop.sh]
 *
 * `import` is for a run that did not go through runstore: the unattended loop
 * calls its CLI directly. Its output is archived as a run (redacted) and
 * harvested, and the run id is printed so the loop can log it on its row.
 */
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeRedactor } from "./secrets.mjs";
import { stateDirFor } from "./statedir.mjs";
import { agentTexts } from "./harness.mjs";

export class HarvestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarvestError";
    this.code = code;
  }
}

const RUN_ID = /^r_[0-9a-f]{8}$/;
/** A decision line: the marker, then what was decided, optionally "because" why. */
export const DECISION_LINE = /^[ \t>*`_-]*DECISION:[ \t]*(.+)$/gm;
const BECAUSE = /\s+(?:—|--|-|,)?\s*because\s+/i;

/** Decisions declared in text (a transcript, or a single line of one). Deduplicated, in order. */
export function extractDecisions(raw) {
  const out = [];
  const seen = new Set();
  for (const t of agentTexts(raw)) {
    for (const m of t.matchAll(DECISION_LINE)) {
      const line = m[1].replace(/\\"/g, '"').replace(/["}\]]+$/, "").trim();
      if (!line || /^<.*>$/.test(line)) continue; // the instruction's own placeholder
      const [what, ...why] = line.split(BECAUSE);
      const key = norm(what);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ text: what.trim(), why: why.length ? why.join(" because ").trim() : null });
    }
  }
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(("that this with from have will should would could they them their there then than when what which while into onto over under about after before because does done make made using used also only just very more most less each every other some such same your ours".split(" ")));
/** The words that carry a sentence's meaning: four letters or more, not glue. */
export const significant = (s) => new Set(norm(s).split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));

/**
 * Negation and reversal words. A sentence that says "no open egress" does not
 * record a decision to open egress, though it shares every word with it.
 */
const NEGATION = /\b(not|no|never|none|nobody|nothing|without|cannot|can't|don't|doesn't|won't|isn't|aren't|mustn't|instead|rather|drop|remove|stop|forbid(s|den)?|refuse[sd]?|only)\b/i;

/** A document's sentences: paragraphs joined, split at sentence ends and at list items and headings. */
export function sentencesOf(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.|#{1,6})\s)/)
    .flatMap((p) => p.replace(/\s+/g, " ").split(/(?<=[.!?;:])\s+/))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The document that already records a decision, or null. Recorded means ONE
 * SENTENCE of a spec or ADR holds at least 80% of the decision's significant
 * words, with the same polarity: both negated, or neither. A document whose
 * words are all there but scattered, or a sentence that says the opposite,
 * does not count (independent re-review: "drop the allowlist proxy", "run as
 * root with Docker" and "the builder may close its own task" each matched the
 * very documents that forbid them). Missing a real match costs a person one
 * glance in the Inbox; matching a reversal loses the decision silently.
 */
export function recordedIn(decision, docs, threshold = 0.8) {
  const want = significant(decision.text);
  if (!want.size) return null;
  const neg = NEGATION.test(decision.text);
  let best = null;
  for (const d of docs) {
    for (const s of d.sentences ?? sentencesOf(d.text).map((t) => ({ words: significant(t), neg: NEGATION.test(t) }))) {
      if (s.neg !== neg) continue;
      const share = [...want].filter((w) => s.words.has(w)).length / want.size;
      if (share >= threshold && (!best || share > best.share)) best = { id: d.id, share };
    }
  }
  return best?.id ?? null;
}

/** Every spec (under specsDir) and ADR (docs/decisions), as { id, text }. */
export function corpus(root, specsDir = "specs") {
  const docs = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mdx?$/.test(e.name)) docs.push({ id: relative(root, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, specsDir));
  walk(join(root, "docs", "decisions"));
  return docs.map((d) => ({ ...d, sentences: sentencesOf(d.text).map((t) => ({ words: significant(t), neg: NEGATION.test(t) })) }));
}

/** B-5: the mirror's line hook. Appends each decision to `<runDir>/decisions.live.jsonl` as it is written. */
export function liveRecorder(runDir, { now = () => new Date() } = {}) {
  const seen = new Set();
  return (line) => {
    for (const d of extractDecisions(line)) {
      const key = norm(d.text);
      if (seen.has(key)) continue;
      seen.add(key);
      mkdirSync(runDir, { recursive: true });
      appendFileSync(join(runDir, "decisions.live.jsonl"), `${JSON.stringify({ t: now().toISOString(), ...d })}\n`);
    }
  };
}

const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];

/**
 * Harvest one archived run: every decision it declared (the live record and
 * the final transcript, merged), each marked with the document that already
 * records it, or pending. Writes `<runDir>/harvest.json`.
 */
export function harvest({ root, runDir, specsDir = "specs" }) {
  if (!existsSync(runDir)) throw new HarvestError("NO_RUN", `no archived run at ${runDir}`);
  const rec = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
  const fromTranscript = ["transcript.log", "transcript.live.log"].map((f) => join(runDir, f)).find(existsSync);
  const found = [...readJsonl(join(runDir, "decisions.live.jsonl")), ...(fromTranscript ? extractDecisions(readFileSync(fromTranscript, "utf8")) : [])];
  const seen = new Set();
  const docs = corpus(root, specsDir);
  const decisions = [];
  for (const d of found) {
    const key = norm(d.text);
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push({ id: `d${decisions.length + 1}`, text: d.text, why: d.why ?? null, recordedIn: recordedIn(d, docs) });
  }
  const out = { run: rec.runId ?? null, task: rec.task ?? null, harvestedAt: new Date().toISOString(), decisions };
  writeFileSync(join(runDir, "harvest.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/**
 * B-5: archive the output of a run that did not go through runstore, and
 * harvest it. Only the transcript is known, so run.json records no diff,
 * verdict or egress, and says why rather than leaving them to read as empty.
 *
 * Redacted before it is written: by key shape, and by the value of any
 * credential variable this process holds, since that is the environment the
 * loop's CLI ran in.
 */
export const LOOP_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"];
export function importRun({ root, stateDir, transcript, task = null, cli = null, source = null, env = process.env, specsDir = "specs" }) {
  const runId = `r_${randomBytes(4).toString("hex")}`;
  const runDir = join(stateDir, "runs", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const held = Object.fromEntries(LOOP_CREDENTIALS.filter((k) => String(env[k] ?? "").length >= 8).map((k) => [k, env[k]]));
  const redact = makeRedactor(held);
  const text = String(transcript ?? "");
  writeFileSync(join(runDir, "transcript.log"), text.split("\n").map((l) => (l ? redact(l) : l)).join("\n"));
  const rec = {
    runId,
    task,
    parent: null,
    adapter: cli ? "cli" : null,
    cli,
    source,
    notRecorded: "diff, verdict and egress: this run did not go through runstore, so only its output was archived",
    transcript: { bytes: Buffer.byteLength(text), lines: text ? text.split("\n").length : 0 },
    archivedAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, "run.json"), `${redact(JSON.stringify(rec, null, 2))}\n`);
  return { runId, runDir, ...harvest({ root, runDir, specsDir }) };
}

/**
 * B-5: record a run AS IT PROCEEDS. The loop pipes its CLI's stream in; each
 * line is redacted and appended to the archive the moment it arrives, and any
 * decision in it goes to decisions.live.jsonl. Nothing raw is ever written.
 * The loop used to keep the whole stream in /tmp and archive it at the end,
 * so killing loop.sh itself archived nothing and left the unredacted stream
 * behind (independent re-review).
 *
 * Ends the run when the stream ends, or on SIGTERM/SIGINT/SIGHUP. A SIGKILL
 * cannot be caught: what streamed until then is already archived, and the
 * next `record` finishes any run left "recording" (recover).
 */
export async function recordRun({ root, stateDir, runId, input, task = null, cli = null, source = null, env = process.env, specsDir = "specs", signals = true }) {
  if (!RUN_ID.test(String(runId))) throw new HarvestError("BAD_RUN", `run id ${JSON.stringify(runId)} is not r_ plus eight hex digits`);
  recover({ root, stateDir, specsDir });
  const runDir = join(stateDir, "runs", runId);
  if (existsSync(runDir)) throw new HarvestError("EXISTS", `run ${runId} already exists`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const held = Object.fromEntries(LOOP_CREDENTIALS.filter((k) => String(env[k] ?? "").length >= 8).map((k) => [k, env[k]]));
  const redact = makeRedactor(held);
  const rec = {
    runId, task, parent: null, adapter: cli ? "cli" : null, cli, source, state: "recording",
    notRecorded: "diff, verdict and egress: this run did not go through runstore, so only its output was archived",
    startedAt: new Date().toISOString(),
  };
  const writeRec = () => writeFileSync(join(runDir, "run.json"), `${redact(JSON.stringify(rec, null, 2))}\n`);
  writeRec();
  const out = join(runDir, "transcript.log");
  writeFileSync(out, "");
  const live = liveRecorder(runDir);
  let bytes = 0;
  let lines = 0;
  const take = (line) => {
    const clean = line ? redact(line) : line;
    appendFileSync(out, `${clean}\n`);
    bytes += Buffer.byteLength(line) + 1;
    lines += 1;
    live(clean);
  };
  let done = false;
  let pendingLine = "";
  const finish = (state) => {
    if (done) return null;
    done = true;
    Object.assign(rec, { state, endedAt: new Date().toISOString(), transcript: { bytes, lines } });
    writeRec();
    return harvest({ root, runDir, specsDir });
  };
  const handlers = [];
  if (signals) {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      const h = () => {
        if (pendingLine) take(pendingLine);
        finish(`stopped by ${sig}`);
        process.exit(1);
      };
      process.on(sig, h);
      handlers.push([sig, h]);
    }
  }
  const decoder = new StringDecoder("utf8");
  for await (const chunk of input) {
    const text = pendingLine + decoder.write(chunk);
    const parts = text.split("\n");
    pendingLine = parts.pop();
    for (const l of parts) take(l);
  }
  pendingLine += decoder.end();
  if (pendingLine) take(pendingLine);
  pendingLine = "";
  const h = finish("recorded");
  for (const [sig, fn] of handlers) process.off(sig, fn);
  return { runId, runDir, ...h };
}

/** Finish runs a killed recorder left "recording": harvest what they archived, and say they were cut off. */
export function recover({ root, stateDir, specsDir = "specs" }) {
  const runs = join(stateDir, "runs");
  if (!existsSync(runs)) return [];
  const out = [];
  for (const id of readdirSync(runs).filter((r) => RUN_ID.test(r))) {
    const dir = join(runs, id);
    const p = join(dir, "run.json");
    if (!existsSync(p)) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (rec.state !== "recording") continue;
    rec.state = "cut off: the recorder was killed, so this holds what streamed until then";
    rec.recoveredAt = new Date().toISOString();
    writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
    harvest({ root, runDir: dir, specsDir });
    out.push(id);
  }
  return out;
}

const decisionsLog = (runDir) => join(runDir, "harvest-decisions.jsonl");

/** Pending decisions across every archived run: declared, recorded nowhere, not yet kept or discarded. */
export function pending(stateDir) {
  const runs = join(stateDir, "runs");
  if (!existsSync(runs)) return [];
  const out = [];
  for (const id of readdirSync(runs).filter((r) => RUN_ID.test(r)).sort()) {
    const dir = join(runs, id);
    if (!existsSync(join(dir, "harvest.json"))) continue;
    const h = JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8"));
    const decided = new Set(readJsonl(decisionsLog(dir)).map((x) => x.id));
    for (const d of h.decisions) if (!d.recordedIn && !decided.has(d.id)) out.push({ run: id, task: h.task, since: h.harvestedAt, ...d });
  }
  return out;
}

const slug = (s) => norm(s).split(" ").slice(0, 6).join("-") || "decision";

/** Keep a pending decision as a draft ADR, or discard it with a reason. Once only. */
export function decide({ root, stateDir, run, id, decision, by = null, reason = null, now = new Date() }) {
  if (!RUN_ID.test(String(run))) throw new HarvestError("BAD_RUN", `run id ${run} is not r_ plus eight hex digits`);
  const runDir = join(stateDir, "runs", run);
  if (!existsSync(join(runDir, "harvest.json"))) throw new HarvestError("NOT_HARVESTED", `run ${run} has not been harvested; run: node bin/harvest.mjs run --run ${run}`);
  const h = JSON.parse(readFileSync(join(runDir, "harvest.json"), "utf8"));
  const d = h.decisions.find((x) => x.id === id);
  if (!d) throw new HarvestError("NO_DECISION", `run ${run} has no decision ${id}; it has ${h.decisions.map((x) => x.id).join(", ") || "none"}`);
  if (d.recordedIn) throw new HarvestError("ALREADY_RECORDED", `${id} is already recorded in ${d.recordedIn}`);
  const prior = readJsonl(decisionsLog(runDir)).find((x) => x.id === id);
  if (prior) throw new HarvestError("DECIDED", `${id} was already ${prior.decision === "keep" ? "kept" : "discarded"} by ${prior.by} at ${prior.at}`);
  if (decision === "discard" && !String(reason ?? "").trim()) throw new HarvestError("NO_REASON", "a discard needs --reason: a decision thrown away without one cannot be told from one that was lost");
  if (!["keep", "discard"].includes(decision)) throw new HarvestError("USAGE", `decision must be keep or discard, not ${decision}`);
  const who = by ?? process.env.USER ?? userInfo().username;
  let adr = null;
  if (decision === "keep") {
    const dir = join(root, "docs", "decisions");
    mkdirSync(dir, { recursive: true });
    const nums = readdirSync(dir).map((f) => /^(\d{4})-/.exec(f)?.[1]).filter(Boolean).map(Number);
    const n = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
    const day = now.toISOString().slice(0, 10);
    const title = d.text.length > 80 ? `${d.text.slice(0, 77)}…` : d.text;
    adr = `docs/decisions/${n}-${slug(d.text)}.md`;
    writeFileSync(
      join(root, adr),
      [
        "---",
        `title: "ADR-${n}: ${title.replace(/"/g, "'")}"`,
        "status: draft",
        `updated: ${day}`,
        "---",
        "",
        `# ADR-${n}: ${title}`,
        "",
        d.text,
        "",
        `**Why.** ${d.why ?? "The transcript gave no reason; add one before accepting this."}`,
        "",
        `Harvested from run ${run}${h.task ? ` (task ${h.task})` : ""}, where it was decided in the transcript and recorded in no spec or ADR. Kept by ${who} on ${day}.`,
        "",
      ].join("\n"),
    );
  }
  const entry = { id, decision, by: who, at: now.toISOString(), ...(reason ? { reason: String(reason) } : {}), ...(adr ? { adr } : {}) };
  appendFileSync(decisionsLog(runDir), `${JSON.stringify(entry)}\n`);
  return entry;
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const [cmd, ...argv] = process.argv.slice(2);
  const KNOWN = new Set(["config", "run", "id", "by", "reason", "state-dir", "specs", "transcript", "task", "cli", "source"]);
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !KNOWN.has(key)) {
      console.error(`harvest.mjs: unknown argument ${argv[i]}`);
      process.exit(2);
    }
    f[key] = argv[++i];
  }
  const cfgPath = resolve(f.config ?? "ops/caretaker/config.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const root = resolve(dirname(cfgPath), "..", "..", cfg.repo ?? ".");
  const stateDir = f["state-dir"] ? resolve(f["state-dir"]) : stateDirFor(root, cfg);
  try {
    if (cmd === "run") {
      if (!RUN_ID.test(String(f.run))) throw new HarvestError("BAD_RUN", "run needs --run r_…");
      const h = harvest({ root, runDir: join(stateDir, "runs", f.run), specsDir: f.specs ?? "specs" });
      for (const d of h.decisions) console.log(`${d.id}  ${d.recordedIn ? `recorded in ${d.recordedIn}` : "PENDING"}  ${d.text}`);
      console.error(`[harvest] ${f.run}: ${h.decisions.length} decision(s), ${h.decisions.filter((d) => !d.recordedIn).length} recorded nowhere`);
      process.exit(0);
    }
    if (cmd === "import") {
      if (!f.transcript || !existsSync(f.transcript)) throw new HarvestError("USAGE", `import needs --transcript FILE${f.transcript ? `; ${f.transcript} does not exist` : ""}`);
      const h = importRun({ root, stateDir, transcript: readFileSync(f.transcript, "utf8"), task: f.task ?? null, cli: f.cli ?? null, source: f.source ?? null, specsDir: f.specs ?? "specs" });
      console.log(h.runId);
      console.error(`[harvest] ${h.runId}: ${h.decisions.length} decision(s), ${h.decisions.filter((d) => !d.recordedIn).length} recorded nowhere`);
      process.exit(0);
    }
    if (cmd === "record") {
      // Prints the run's archive directory when the stream ends, so the loop
      // can read its (redacted) transcript afterwards without keeping its own.
      const h = await recordRun({ root, stateDir, runId: f.run, input: process.stdin, task: f.task ?? null, cli: f.cli ?? null, source: f.source ?? null, specsDir: f.specs ?? "specs" });
      console.log(h.runDir);
      console.error(`[harvest] ${h.runId}: recorded, ${h.decisions.length} decision(s), ${h.decisions.filter((d) => !d.recordedIn).length} recorded nowhere`);
      process.exit(0);
    }
    if (cmd === "keep" || cmd === "discard") {
      const r = decide({ root, stateDir, run: f.run, id: f.id, decision: cmd, by: f.by, reason: f.reason });
      console.log(`[harvest] ${f.run} ${f.id} ${cmd === "keep" ? `kept as ${r.adr} (draft)` : "discarded"} by ${r.by}`);
      process.exit(0);
    }
    if (cmd === "pending") {
      const p = pending(stateDir);
      for (const d of p) console.log(`${d.run} ${d.id}  ${d.task ?? "(no task)"}  ${d.text}`);
      console.error(`[harvest] ${p.length} pending`);
      process.exit(0);
    }
    throw new HarvestError("USAGE", "usage: harvest.mjs run|keep|discard|pending|import|record --run r_… [--id dN] [--reason …] [--transcript FILE]");
  } catch (e) {
    console.error(`[harvest] ${e.name}: ${e.message}`);
    process.exit(2);
  }
}
