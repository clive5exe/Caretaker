/**
 * The shapes /api/v1 returns (bin/readmodel.mjs). The server computes every
 * one of these; the client only displays them (TECH.md §5).
 *
 * `null` means NOT RECORDED: the source file does not exist, or the field was
 * never written. It is never the same as 0 or an empty list.
 */

export type SourceState = "present" | "absent";
export interface Sources {
  board: SourceState;
  runs: SourceState;
  events: SourceState;
  archive: SourceState;
  agents: SourceState;
  history: SourceState;
}

export interface Command {
  cmd: string;
  fixed?: Record<string, string>;
  needs?: string[];
  optional?: string[];
}

export interface GateCell {
  verdict: string;
  attempts: number;
}

export interface WorkSummary {
  id: string;
  title: string;
  owner: string | null;
  est: string | null;
  status: string;
  phase: string;
  deps: string[];
  lifecycle: string;
  reason: string;
  rework: number | null;
  blocked: string | null;
  missingGates: string[];
  gates: Record<string, GateCell | null>;
  runs: number;
  tokens: number | null;
  openQuestions: number;
  pr: string | null;
  specPath: string | null;
  hasAc: boolean;
  commands: Command[];
}

export interface Work {
  sources: Sources;
  phases: string[];
  activePhase: string | null;
  stages: string[];
  columns: { key: string; label: string }[];
  gates: string[];
  tasks: WorkSummary[];
}

export interface Attempt {
  verdict: string;
  at?: string;
  note?: string;
}

export interface Question {
  id: string;
  q: string;
  by?: string;
  at?: string;
  via?: string;
  answer?: { text: string; by?: string; at?: string; via?: string };
}

export interface SpecInfo {
  path: string;
  exists: boolean;
  governing: boolean;
  blob: string | null;
}

export interface Review {
  path: string;
  blob: string;
  decision: string;
  why?: string;
  by?: string;
  at?: string;
}

export interface RunRow {
  id: string;
  task: string | null;
  agent: string | null;
  model: string | null;
  adapter: string | null;
  cli: string | null;
  parent: string | null;
  status: string;
  noEndRecorded: boolean;
  start: string | null;
  end: string | null;
  durationMs: number | null;
  tokens: number | null;
  files: number | null;
  reconstructed: boolean;
  src: string[];
  children: string[];
}

export interface LegacyRow {
  t: string | null;
  kind: string | null;
  agent: string | null;
  state: string | null;
  task: string | null;
  tokens: number | null;
  model: string | null;
  src: string;
  note: string | null;
}

export interface LogEvent {
  t: string;
  kind: string;
  level: string;
  detail: string;
  run?: string;
  task?: string;
  stage?: string;
  verdict?: string;
  tokens?: number | null;
  file?: string;
  [k: string]: unknown;
}

export interface WorkItem extends WorkSummary {
  sources: Sources;
  ac: string | string[] | null;
  completed: string | null;
  blockedReason: string | null;
  notes: string[];
  gateHistory: Record<string, Attempt[]>;
  requiredGates: string[];
  questions: Question[];
  triage: { decision: string; why?: string; by?: string; at?: string }[];
  spec: SpecInfo | null;
  specReview: Review[];
  specApprovalNeeded: boolean;
  prRecord: { url: string; by?: string; at?: string } | null;
  dropped: { why: string; by?: string; at?: string } | null;
  runList: RunRow[];
  legacyRuns: LegacyRow[];
  events: LogEvent[] | null;
}

export type InboxKind = "question" | "spec-approval" | "gate-failure" | "pr-review" | "decision";
export interface InboxItem {
  /** null only for a harvested decision from a run that named no task. */
  task: string | null;
  title: string;
  owner: string | null;
  kind: InboxKind;
  since: string | null;
  fact: string;
  question?: Question;
  spec?: SpecInfo;
  pr?: string;
  gateHistory?: Record<string, Attempt[]>;
  dismissCommand?: string | null;
  decision?: { run: string; id: string; text: string; why: string | null };
  keepCommand?: string;
  discardCommand?: string;
  actions: Command[];
}
export interface Inbox {
  sources: Sources;
  threshold: number;
  counts: Record<InboxKind, number>;
  items: InboxItem[];
}

export interface Quality {
  gated: number;
  firstPass: number;
  reworked: number;
  attempts: number;
  firstPassPct: number;
  reworkPct: number;
}

export interface Snapshot {
  sources: Sources;
  name: string | null;
  activePhase: string | null;
  progress: {
    pctEffort: number;
    pctTasks: number;
    doneHours: number;
    totalHours: number;
    doneCount: number;
    total: number;
    unestimated: number;
    remainingHours: number;
  };
  eta: { days: number; perDay: number; date: string } | null;
  window: string[];
  held: number;
  blocked: number;
  noAc: number;
  quality: Quality;
  cycle: { medDays: number | null; medEst: number | null; closed: number };
  tokensPerClosedTask: { tokens: number; tasks: number } | null;
  executing: RunRow[];
  legacyRunning: LegacyRow[] | null;
  inbox: { count: number; oldest: InboxItem[] };
  events: LogEvent[] | null;
  commitsByDay: number[];
  closedByDay: number[];
  windowDays: string[];
}

export interface Runs {
  sources: Sources;
  runs: RunRow[] | null;
  legacy: LegacyRow[] | null;
  staleRunHours: number;
}

export interface RunDetail extends RunRow {
  sources: Sources;
  reason: string | null;
  exitCode: number | null;
  timeoutMs: number | null;
  warnings: string[];
  breakdown: Record<string, number | null> | null;
  diff: { files: string[] | null; insertions: number | null; deletions: number | null; truncated: boolean; ignoredPathsNotMeasured: boolean } | null;
  archiveFiles: Record<string, number | null>;
  events: LogEvent[] | null;
  taskGates: Record<string, { verdict: string; at?: string }> | null;
  taskTitle: string | null;
  egress: { state: "host" | "proxied" | "sealed" | "network" | "unknown"; net: string | null };
}

export interface Agent {
  name: string;
  model: string | null;
  defined: boolean;
  runs: number;
  tokens: number | null;
  firstPass: { pct: number; gated: number } | null;
  current: { id: string; task: string | null }[];
  openTasks: number;
}
export interface Agents {
  sources: Sources;
  defined: boolean;
  agentsDir: string | null;
  agents: Agent[];
}

export interface Specs {
  sources: Sources;
  specsDir: string;
  specs: { id: string; governs: string[]; errors: string[] }[];
  skipped: { path: string; why?: string; [k: string]: unknown }[];
  claims: { spec: string; glob: string; matches: number | null }[];
  orphaned: unknown[];
  unowned: string[] | null;
  changed: string[] | null;
  drift: LogEvent[] | null;
  approvals: { task: string; title: string; path: string; governing: boolean; exists: boolean; needed: boolean; last: Review | null }[];
  dismissCommand: string;
  /** P-5/B-3, computed by bin/freshness.mjs; null when this is not a git checkout. */
  freshness: Freshness | null;
}

export interface CommitRef {
  day: string;
  sha: string;
  subject: string;
}
export interface Freshness {
  stale: { spec: string; updated: string | null; lastGoverned: CommitRef | null; governedPaths: number }[];
  lying: { doc: string; updated: string; lastCommit: CommitRef }[];
  undated: string[];
  ok: boolean;
}

export interface TokenComp {
  in: number;
  cached: number;
  write: number;
  out: number;
}
export interface TokenStats {
  total: number;
  liveCount: number;
  reconCount: number;
  byTask: [string, { tokens: number; runs: number; recon: number }][];
  byAgent: [string, { tokens: number; runs: number }][];
  byModel: [string, { tokens: number; runs: number }][];
  detailedCount: number;
  comp: TokenComp;
  compTotal: number;
  turns: number;
  outShare: number | null;
  churnShare: number | null;
  perTurn: number | null;
}

export type GateStats = [string, { pass: number; fail: number; passPct: number | null; failPct: number | null }][];

export interface CycleRow {
  id: string;
  title: string;
  est: number;
  days: number;
  commits: number;
}

export interface Metrics {
  sources: Sources;
  days: number;
  window: string[];
  tokens: TokenStats | null;
  tokensPerDay: { day: string; comp: TokenComp | null; total: number }[] | null;
  reworkSpend: { wasted: number; total: number; pct: number; tasks: number; unplaced: number } | null;
  gateStats: GateStats;
  quality: Quality;
  allTime: { gateStats: GateStats; quality: Quality };
  cycle: CycleRow[];
  medDays: number | null;
  medEst: number | null;
  commitsByDay: number[];
  closedByDay: number[];
  closedHoursByDay: number[];
  closedWindow: string[];
  kpis: Kpis;
}

/** B-2 and B-4, from bin/kpis.mjs. null means not recorded, never zero. */
export interface Kpis {
  delivery: {
    reason: string | null;
    deploys?: number;
    deploysPerWeek: number | null;
    leadTimeHours: number | null;
    changeFailureRate: number | null;
    timeToRestoreHours: number | null;
  };
  ai: {
    tokensPerClosedTask: number | null;
    tokensPerClosedTaskBasis: string;
    tokensPerMergedLine: number | null;
    dollarsPerMergedLine: number | null;
    costBasis: string;
    firstPassRate: number | null;
    reworkRate: number | null;
    gatedTasks: number;
    modelMix: { model: string; share: number; runs: number }[] | null;
    estimateCalibration: number | null;
    humanInterventionRate: number | null;
    humanInterventionBasis: string;
  };
  estimates: {
    calibration: { type: string; closed: number; factor: number | null; tokensPerHour: number | null }[];
    open: { id: string; type: string; estimate: number | null; basis: string; hours: number | null; actualSoFar: number }[];
    remaining: { tokens: number; estimated: number; unestimated: number } | null;
  };
  antiKpis: { name: string; why: string }[];
}

export interface Settings {
  sources: Sources;
  config: Record<string, unknown>;
  configPath: string;
  root: string;
  stateDir: string;
  eventsDir: string;
  specsDir: string;
  paths: Record<string, string | null>;
  operator: string;
  server: { host?: string; port?: number; loopbackOnly?: boolean; rotate?: string };
}

export interface EventsResponse {
  sources: Sources;
  events: LogEvent[] | null;
}

export type CommandResult =
  | { ok: true; task: WorkItem }
  | { ok: false; status: number; refused?: { missing: string[]; docsOnly: boolean }; error?: string };
