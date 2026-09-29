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
 * turn as it happens; a CLI that prints one JSON result at exit is captured at
 * exit.)
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
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stateDirFor } from "./statedir.mjs";
import { transcriptTexts } from "./transcript.mjs";

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
  for (const t of transcriptTexts(raw)) {
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
 * The document that already records a decision, or null. Recorded means at
 * least 80% of the decision's significant words appear in one document: a
 * spec or ADR saying the same thing in its own sentence still counts, and a
 * document sharing a couple of words with it does not.
 */
export function recordedIn(decision, docs, threshold = 0.8) {
  const want = significant(decision.text);
  if (!want.size) return null;
  let best = null;
  for (const d of docs) {
    const have = d.words ?? significant(d.text);
    const share = [...want].filter((w) => have.has(w)).length / want.size;
    if (share >= threshold && (!best || share > best.share)) best = { id: d.id, share };
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
  return docs.map((d) => ({ ...d, words: significant(d.text) }));
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
  const KNOWN = new Set(["config", "run", "id", "by", "reason", "state-dir", "specs"]);
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
    throw new HarvestError("USAGE", "usage: harvest.mjs run|keep|discard|pending --run r_… [--id dN] [--reason …]");
  } catch (e) {
    console.error(`[harvest] ${e.name}: ${e.message}`);
    process.exit(2);
  }
}
