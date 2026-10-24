/**
 * Activity, the work board (PRODUCT.md §2). Columns by lifecycle stage, as
 * the server derived it, or by the status columns board.html uses.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { isBlockedStatus, isDropped, isFinished, isQueued, laneOf, stageLabel } from "../api/labels";
import { useResource } from "../api/store";
import type { Work, WorkSummary } from "../api/types";
import { Failed, fmtTokens, Loading, PageHead, Rail, Seg } from "../components/ui";

function Card({ t, gates }: { t: WorkSummary; gates: string[] }) {
  return (
    <Link className="wi" to={`/work/${encodeURIComponent(t.id)}`}>
      <div className="id">
        {t.id}
        {t.blocked ? <span className="chip warn">blocked</span> : null}
        {t.rework ? <span className="chip fail">rework {t.rework}</span> : null}
        {t.openQuestions ? <span className="chip run">{t.openQuestions} open question{t.openQuestions === 1 ? "" : "s"}</span> : null}
      </div>
      <div className="ti">{t.title}</div>
      <div className="mt">
        <Rail gates={gates} cells={t.gates} missing={t.missingGates} />
        <span>{t.owner ?? "no owner"}</span>
        <span>{t.est ?? "no estimate"}</span>
        {t.runs ? <span>{t.runs} run{t.runs === 1 ? "" : "s"}</span> : null}
        {t.tokens != null ? <span>{fmtTokens(t.tokens)} tokens</span> : null}
        {t.specPath ? <span className="mono">spec {t.specPath}</span> : null}
        {t.missingGates.length && !isFinished(t.lifecycle) ? <span>needs {t.missingGates.join(", ")}</span> : null}
      </div>
      {!isQueued(t.lifecycle) && !isFinished(t.lifecycle) ? <div className="why">{t.blocked ? `blocked: ${t.blocked}` : t.reason}</div> : null}
    </Link>
  );
}

export function Activity() {
  const { data: w, error } = useResource<Work>("/work");
  const [group, setGroup] = useState<"lifecycle" | "status">(() => {
    try {
      return localStorage.getItem("caretaker.activity.group") === "status" ? "status" : "lifecycle";
    } catch {
      return "lifecycle";
    }
  });
  const [phase, setPhase] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const pick = (g: "lifecycle" | "status") => {
    setGroup(g);
    try {
      localStorage.setItem("caretaker.activity.group", g);
    } catch {
      /* per-tab only */
    }
  };
  const shown = useMemo(() => {
    if (!w) return [];
    const ph = phase ?? w.activePhase ?? "all";
    const needle = q.trim().toLowerCase();
    return w.tasks.filter(
      (t) => (ph === "all" || t.phase === ph) && (!needle || `${t.id} ${t.title} ${t.owner ?? ""} ${t.reason}`.toLowerCase().includes(needle)),
    );
  }, [w, phase, q]);
  if (error) return <Failed error={error} />;
  if (!w) return <Loading what="the board" />;
  const ph = phase ?? w.activePhase ?? "all";
  // Dropped is outside the lifecycle: excluded from the columns.
  const live = shown.filter((t) => !isDropped(t.lifecycle));
  const dropped = shown.length - live.length;
  const lanes: { key: string; label: string; items: WorkSummary[] }[] =
    group === "lifecycle"
      ? w.stages.map((st) => ({ key: st, label: stageLabel(st), items: live.filter((t) => laneOf(t.lifecycle) === st) }))
      : w.columns.map((c) => ({ key: c.key, label: c.label, items: live.filter((t) => t.status === c.key) }));
  // Rework and active items first, queued after them, as the TUI orders them.
  const order = (t: WorkSummary) => (t.rework ? 0 : isQueued(t.lifecycle) ? 2 : 1);
  return (
    <>
      <PageHead title="Activity" lede="Work items by stage. The stage is derived from recorded facts on every read, never set by hand." />
      <div className="toolbar">
        <Seg value={group} onChange={pick} label="Group by" options={[["lifecycle", "By stage"], ["status", "By status"]]} />
        <select className="search" aria-label="Phase" value={ph} onChange={(e) => setPhase(e.target.value)}>
          <option value="all">All phases</option>
          {w.phases.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input className="search" placeholder="Search work items" aria-label="Search work items" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {live.length} item{live.length === 1 ? "" : "s"}
          {dropped ? ` · ${dropped} dropped, not shown` : ""}
        </span>
      </div>
      <div className="lanes">
        {lanes.map((l) => {
          const items = [...l.items].sort((a, b) => order(a) - order(b));
          const active = group === "lifecycle" ? items.filter((t) => !isQueued(t.lifecycle)) : items;
          const queued = group === "lifecycle" ? items.filter((t) => isQueued(t.lifecycle)) : [];
          return (
            <section key={l.key} className={`lane${items.length ? "" : " empty"}`} aria-label={l.label}>
              <h5>
                {l.label}
                <span>{items.length}</span>
              </h5>
              <div className="stackc">
                {items.length ? null : <div className="none">Nothing here</div>}
                {active.map((t) => (
                  <Card key={t.id} t={t} gates={w.gates} />
                ))}
                {queued.length ? <div className="qh">Queued · {queued.length}</div> : null}
                {queued.map((t) => (
                  <Card key={t.id} t={t} gates={w.gates} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="ft">
        The gate rail is {w.gates.join(" · ")}: filled on pass, red on fail, hollow if not run, faded when not required.
        {group === "status" ? " Status columns are the ones docs/board.html uses, from config.columns." : ""}
        {shown.some((t) => isBlockedStatus(t.status)) ? " Blocked is a badge at the item's stage, not a stage." : ""}
      </p>
    </>
  );
}
