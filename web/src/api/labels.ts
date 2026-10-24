/**
 * DISPLAY LABELS — the one module in web/src allowed to name a gate or a
 * lifecycle stage (TECH.md §4). Everything here is wording and color: which
 * words to print for a value the server sent, and which category or status
 * class to paint it with. No rule lives here. Which stage an item is in, which
 * gates it needs, and which commands it may take all arrive from the server.
 *
 * bin/web-boundary.test.mjs fails if any other file under web/src names one.
 */
import type { Command, InboxKind } from "./types";

export const STAGE_LABEL: Record<string, string> = {
  intake: "Intake",
  triage: "Triage",
  spec: "Spec",
  build: "Build",
  verify: "Verify",
  review: "Review",
  human: "Human",
  done: "Done",
  ready: "Queued",
  dropped: "Dropped",
};
export const stageLabel = (s: string) => STAGE_LABEL[s] ?? s;

/** The lane a stage is drawn in. "ready" is queued at the head of Build. */
export const laneOf = (stage: string) => (stage === "ready" ? "build" : stage);
export const isQueued = (stage: string) => stage === "ready";
export const isDropped = (stage: string) => stage === "dropped";
export const isFinished = (stage: string) => stage === "done" || stage === "dropped";

/** Status chip class for a stage: status colors say how it went. */
export function stageTone(stage: string, rework: number | null): string {
  if (rework) return "fail";
  return ({ build: "run", review: "vio", human: "pass", spec: "warn", done: "pass", verify: "orange" } as Record<string, string>)[stage] ?? "";
}

/** A gate's name as printed. Gate names themselves come from the server. */
export const gateLabel = (g: string) => g;

/** Board status, as the columns in config.json name them. */
export const isClosedStatus = (status: string) => status === "done";
export const isBlockedStatus = (status: string) => status === "blocked";

/** Run status from the harness verdict or the start and end rows. */
export function runTone(status: string): { cls: string; label: string } {
  const s = status.toLowerCase();
  if (s === "running") return { cls: "run", label: "Running" };
  if (s === "no end recorded") return { cls: "warn", label: "No end recorded" };
  if (s === "completed" || s === "ok" || s === "ended") return { cls: "pass", label: s === "ended" ? "Ended" : "Completed" };
  if (s === "failed" || s === "killed" || s === "error" || s === "timeout") return { cls: "fail", label: s.charAt(0).toUpperCase() + s.slice(1) };
  return { cls: "", label: s.charAt(0).toUpperCase() + s.slice(1) };
}

export const verdictTone = (v: string) => (v === "pass" ? "pass" : v === "fail" ? "fail" : "");

export const levelTone = (l: string) => (l === "error" ? "fail" : l === "warn" ? "warn" : "");

/** Inbox kinds: category colors (questions blue, spec reviews orange, gate failures red, PRs green, decisions violet). */
export const KIND: Record<InboxKind, { label: string; plural: string; tile: string; icon: "q" | "doc" | "x" | "pr" }> = {
  question: { label: "Question", plural: "Questions", tile: "blue", icon: "q" },
  "spec-approval": { label: "Spec review", plural: "Spec reviews", tile: "orange", icon: "doc" },
  "gate-failure": { label: "Gate failure", plural: "Gate failures", tile: "red", icon: "x" },
  "pr-review": { label: "PR review", plural: "PR reviews", tile: "green", icon: "pr" },
  decision: { label: "Decision", plural: "Decisions", tile: "violet", icon: "doc" },
};
export const KIND_ORDER: InboxKind[] = ["question", "spec-approval", "gate-failure", "pr-review", "decision"];

/** What a command button says. The command itself is whatever core offered. */
export function commandLabel(c: Command): string {
  if (c.cmd === "triage") return c.fixed?.decision === "reject" ? "Reject triage" : "Accept triage";
  if (c.cmd === "answer") return `Answer ${c.fixed?.qid ?? ""}`.trim();
  return (
    ({
      start: "Start",
      done: "Close",
      block: "Block",
      todo: "Reset to todo",
      note: "Add note",
      ask: "Ask a question",
      "spec-approve": "Approve spec",
      "spec-reject": "Reject spec",
      pr: "Record PR",
      drop: "Drop",
    } as Record<string, string>)[c.cmd] ?? c.cmd
  );
}
export function commandHint(c: Command): string {
  return (
    ({
      start: "status to doing",
      done: "close; core re-checks the gates",
      block: "needs a reason",
      todo: "back to the queue",
      note: "appended to the notes",
      ask: "record a question",
      answer: "answers the open question",
      triage: c.fixed?.decision === "reject" ? "needs a reason" : "accept for building",
      "spec-approve": "approves this version of the spec",
      "spec-reject": "needs a reason",
      pr: "needs a URL",
      drop: "needs a reason; outside the lifecycle",
    } as Record<string, string>)[c.cmd] ?? ""
  );
}
/** Commands that change what happens to the work, drawn as the primary button when offered. */
export const PRIMARY_ORDER = ["done", "start", "spec-approve", "triage", "answer"];
