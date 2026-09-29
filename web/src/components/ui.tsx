/** Small shared pieces. Nothing here decides anything; it draws what it is given. */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { refreshAll } from "../api/store";
import { runCommand } from "../api/client";
import { commandHint, commandLabel, gateLabel, runTone, stageLabel, stageTone, verdictTone } from "../api/labels";
import type { Command, CommandResult, GateCell } from "../api/types";
import { Icon, type IconName } from "./Icons";

/* ------------------------------------------------------------ formatting */
export const fmtNum = (n: number | null | undefined) => (n == null ? null : n.toLocaleString("en-US"));
export function fmtTokens(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}
export function fmtWhen(t: string | null | undefined): string | null {
  if (!t) return null;
  if (/^\d{4}-\d\d-\d\d$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function ago(t: string | null | undefined): string | null {
  if (!t) return null;
  const d = Date.parse(t);
  if (!Number.isFinite(d)) return t;
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A value, or "unknown" — never a 0 standing in for a missing number. */
export function Val({ v, unit = "" }: { v: string | number | null | undefined; unit?: string }) {
  if (v == null || v === "") return <span className="muted">unknown</span>;
  return <>{typeof v === "number" ? v.toLocaleString("en-US") : v}{unit}</>;
}

/* ------------------------------------------------------------- building blocks */
export function NotRecorded({ what, why }: { what: ReactNode; why?: ReactNode }) {
  return (
    <div className="nr" role="note">
      <b>Not recorded.</b> {what}
      {why ? <div className="why">{why}</div> : null}
    </div>
  );
}

export function PageHead({ title, lede, right }: { title: ReactNode; lede?: ReactNode; right?: ReactNode }) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Tile({ tone, icon, small }: { tone: string; icon: IconName; small?: boolean }) {
  return (
    <span className={`tile ${tone}${small ? " sm" : ""}`}>
      <Icon name={icon} />
    </span>
  );
}

export function StageChip({ stage, rework }: { stage: string; rework?: number | null }) {
  return (
    <span className={`chip ${stageTone(stage, rework ?? null)}`}>
      {stageLabel(stage)}
      {rework ? ` · rework ${rework}` : ""}
    </span>
  );
}
export function RunStatus({ status }: { status: string }) {
  const t = runTone(status);
  return <span className={`chip ${t.cls}`}>{t.label}</span>;
}
export function Verdict({ v }: { v: string }) {
  return <span className={`chip ${verdictTone(v)}`}>{v}</span>;
}
export const Provenance = ({ children, proposed }: { children: ReactNode; proposed?: boolean }) => <span className={`tag${proposed ? " proposed" : ""}`}>{children}</span>;

/** One segment per gate: filled on pass, red on fail, hollow if not run, faded if not required. */
export function Rail({ gates, cells, missing }: { gates: string[]; cells: Record<string, GateCell | null>; missing: string[] }) {
  return (
    <span className="rail" aria-label={gates.map((g) => `${gateLabel(g)}: ${cells[g]?.verdict ?? (missing.includes(g) ? "not run" : "not required")}`).join(", ")}>
      {gates.map((g) => {
        const v = cells[g]?.verdict;
        const cls = v === "pass" ? "p" : v === "fail" ? "f" : missing.includes(g) ? "" : "x";
        return <i key={g} className={cls} title={`${gateLabel(g)}: ${v ?? (missing.includes(g) ? "not run" : "not required")}`} />;
      })}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: [T, ReactNode][] }) {
  return (
    <div className="ptabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, ReactNode][]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={String(k)} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export const TaskLink = ({ id }: { id: string }) => <Link to={`/work/${encodeURIComponent(id)}`}>{id}</Link>;
export const RunLink = ({ id }: { id: string }) => (
  <Link className="mono" to={`/runs/${id}`}>
    {id}
  </Link>
);

export function Loading({ what }: { what?: string }) {
  return <p className="muted">Loading{what ? ` ${what}` : ""}…</p>;
}
export function Failed({ error }: { error: { status: number; message: string } }) {
  return <div className="toast">{error.status ? `${error.status}: ` : ""}{error.message}</div>;
}

/* ----------------------------------------------------------------- charts */
/** Line chart: 2.5px lines, 16% area fill, series in violet, blue, orange, pink order. */
export function LineChart({ series, labels, height = 150, fmt = (v) => String(v), label, fill }: {
  series: { name: string; values: number[] }[];
  labels: string[];
  height?: number;
  fmt?: (v: number) => string;
  label: string;
  fill?: boolean;
}) {
  const W = 560, H = height, L = 44, B = 24, T = 8, R = 8;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = labels.length;
  const x = (i: number) => L + ((W - L - R) * (n <= 1 ? 0 : i)) / Math.max(1, n - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <svg className="ch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
          <text x={L - 8} y={y(t) + 4} textAnchor="end">{fmt(Math.round(t * 10) / 10)}</text>
        </g>
      ))}
      {series.map((s, si) => {
        const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
        return (
          <g key={s.name} className={`s${(si % 4) + 1}`}>
            {fill ? <polygon points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} /> : null}
            <polyline points={pts} />
            {s.values.map((v, i) => (
              <circle key={i} className="hit" cx={x(i)} cy={y(v)} r={9}>
                <title>{`${labels[i]} · ${s.name} ${fmt(v)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {labels.map((l, i) =>
        (i % every === 0 && n - 1 - i >= every / 2) || i === n - 1 ? (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function BarChart({ values, labels, height = 140, label, unit = "" }: { values: number[]; labels: string[]; height?: number; label: string; unit?: string }) {
  const W = 560, H = height, L = 34, B = 22, T = 8;
  const max = Math.max(1, ...values);
  const n = values.length;
  const bw = (W - L) / Math.max(1, n);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <svg className="ch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {[0, max].map((t) => (
        <g key={t}>
          <line className="grid" x1={L} x2={W} y1={y(t)} y2={y(t)} />
          <text x={L - 8} y={y(t) + 4} textAnchor="end">{t}</text>
        </g>
      ))}
      <g className="s1">
        {values.map((v, i) => {
          const h = Math.max(v ? 3 : 0, ((H - T - B) * v) / max);
          return (
            <rect key={i} className="bar" x={L + i * bw + bw * 0.2} y={y(0) - h} width={bw * 0.6} height={h} rx={3}>
              <title>{`${labels[i]} · ${v}${unit}`}</title>
            </rect>
          );
        })}
      </g>
      <text x={L} y={H - 5}>{labels[0]}</text>
      <text x={W} y={H - 5} textAnchor="end">{labels[n - 1]}</text>
    </svg>
  );
}

/* --------------------------------------------------------------- commands */
/**
 * One command core offered, with the fields it needs. Submitting calls core,
 * which checks again; a refusal is shown in core's own words.
 */
export function CommandForm({ task, command, onDone, autoFocus }: { task: string; command: Command; onDone?: (r: CommandResult) => void; autoFocus?: boolean }) {
  const fields = [...(command.needs ?? []), ...(command.optional ?? [])];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const missing = (command.needs ?? []).some((f) => !vals[f]?.trim());
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    const r = await runCommand(task, command.cmd, { ...(command.fixed ?? {}), ...vals });
    setBusy(false);
    setResult(r);
    if (r.ok) {
      setVals({});
      refreshAll();
    }
    onDone?.(r);
  }
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 8 }}>
      {fields.map((f, i) =>
        f === "text" ? (
          <textarea
            key={f}
            autoFocus={autoFocus && i === 0}
            aria-label={`${commandLabel(command)}: ${f}`}
            placeholder={command.optional?.includes(f) ? "Optional note" : commandHint(command)}
            value={vals[f] ?? ""}
            onChange={(e) => setVals({ ...vals, [f]: e.target.value })}
          />
        ) : (
          <input
            key={f}
            className="text"
            autoFocus={autoFocus && i === 0}
            aria-label={`${commandLabel(command)}: ${f}`}
            placeholder={f === "url" ? "The pull request URL" : f}
            value={vals[f] ?? ""}
            onChange={(e) => setVals({ ...vals, [f]: e.target.value })}
          />
        ),
      )}
      <div className="toolbar">
        <button className="btn pri" type="submit" disabled={missing || busy}>
          {busy ? "Sending…" : commandLabel(command)}
        </button>
        <span className="ft" style={{ margin: 0 }}>Recorded by the operator, via web.</span>
      </div>
      {result ? <CommandOutcome result={result} /> : null}
    </form>
  );
}

export function CommandOutcome({ result }: { result: CommandResult }) {
  if (result.ok) return <div className="toast ok">Done. Core recorded it.</div>;
  if (result.refused) {
    return (
      <div className="toast" role="alert">
        {`Refused by core: missing ${result.refused.missing.join(", ")}${result.refused.docsOnly ? " (docs-only task)" : ""}`}
      </div>
    );
  }
  return (
    <div className="toast" role="alert">
      {`Refused by core: ${result.error ?? `HTTP ${result.status}`}`}
    </div>
  );
}

/** The offered commands as buttons; the one chosen opens its form below. */
export function CommandBar({ task, commands, limit = 4 }: { task: string; commands: Command[]; limit?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const [instant, setInstant] = useState<CommandResult | null>(null);
  const shown = commands.slice(0, limit);
  async function click(i: number) {
    const c = commands[i];
    setInstant(null);
    if ((c.needs ?? []).length || (c.optional ?? []).length) {
      setOpen(open === i ? null : i);
      return;
    }
    setOpen(null);
    const r = await runCommand(task, c.cmd, { ...(c.fixed ?? {}) });
    setInstant(r);
    if (r.ok) refreshAll();
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="toolbar">
        {shown.map((c, i) => (
          <button key={`${c.cmd}-${i}`} type="button" className={`btn${i === 0 ? " pri" : ""}`} onClick={() => click(i)} aria-expanded={open === i}>
            {commandLabel(c)}
          </button>
        ))}
        {commands.slice(limit).map((c, j) => (
          <button key={`${c.cmd}-m${j}`} type="button" className="btn sm" onClick={() => click(limit + j)} aria-expanded={open === limit + j}>
            {commandLabel(c)}
          </button>
        ))}
      </div>
      {open !== null && commands[open] ? <CommandForm key={open} task={task} command={commands[open]} autoFocus onDone={(r) => r.ok && setOpen(null)} /> : null}
      {instant ? <CommandOutcome result={instant} /> : null}
    </div>
  );
}
