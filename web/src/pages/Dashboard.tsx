/** Dashboard (PRODUCT.md §1): the same figures as docs/board.html, live. */
import { useState } from "react";
import { Link } from "react-router";
import { KIND, levelTone } from "../api/labels";
import { useResource, useStream } from "../api/store";
import type { LogEvent, Snapshot } from "../api/types";
import { ago, BarChart, Failed, fmtDuration, fmtTokens, fmtWhen, Loading, NotRecorded, PageHead, Provenance, RunLink, RunStatus, Seg, shortDay, TaskLink, Tile } from "../components/ui";

const LEVELS = ["all", "warn", "error"] as const;

export function Dashboard() {
  const { data: s, error } = useResource<Snapshot>("/snapshot");
  const stream = useStream();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  if (error) return <Failed error={error} />;
  if (!s) return <Loading what="the dashboard" />;
  const p = s.progress;
  const gap = Math.abs(p.pctEffort - p.pctTasks);
  // The stream's lines first (newest), then what the snapshot read; deduped by time and detail.
  const seen = new Set<string>();
  const feed: LogEvent[] = [...stream.log, ...(s.events ?? [])].filter((e) => {
    const k = `${e.t}|${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return level === "all" || (level === "warn" ? e.level === "warn" || e.level === "error" : e.level === "error");
  });
  return (
    <>
      <PageHead title="Dashboard" lede={`${s.name ?? "Caretaker"} · ${s.activePhase ?? "no active phase"}`} />
      <div className="grid g3">
        <div className="card">
          <div className="head nw">
            <div>
              <h3>First-pass rate</h3>
              <div className="big">{s.quality.gated ? `${s.quality.firstPassPct}%` : "—"}</div>
              <div className="sub">
                {s.quality.gated
                  ? `${s.quality.firstPass} of ${s.quality.gated} gated tasks passed every gate first time`
                  : "no task has reached a gate yet"}
              </div>
            </div>
            <Provenance>board.html today</Provenance>
          </div>
          <p className="ft">
            {s.sources.history === "present"
              ? "The trend needs the rate in history.jsonl's daily row, which it does not record yet."
              : "The trend needs history.jsonl, which the dashboard appends daily."}
          </p>
        </div>
        <div className="card">
          <div className="head nw">
            <div>
              <h3>Cycle time</h3>
              <div className="big">{s.cycle.medDays != null ? `${s.cycle.medDays} day${s.cycle.medDays === 1 ? "" : "s"}` : "—"}</div>
              <div className="sub">
                {s.cycle.medDays != null
                  ? `median, first commit to close · estimate ${s.cycle.medEst ?? "unknown"}h · ${s.cycle.closed} closed`
                  : s.cycle.closed
                    ? `${s.cycle.closed} closed task; a median of one is not a trend`
                    : "no closed task with commits to measure"}
              </div>
            </div>
            <Provenance>board.html today</Provenance>
          </div>
        </div>
        <div className="card">
          <div className="head nw">
            <div>
              <h3>Tokens per closed task</h3>
              <div className="big">{s.tokensPerClosedTask ? fmtTokens(s.tokensPerClosedTask.tokens) : "—"}</div>
              <div className="sub">
                {s.tokensPerClosedTask
                  ? `mean over ${s.tokensPerClosedTask.tasks} closed task${s.tokensPerClosedTask.tasks === 1 ? "" : "s"} with runs logged`
                  : s.sources.runs === "absent"
                    ? "no run log, so not recorded"
                    : "no closed task has tokens in the run log"}
              </div>
            </div>
            <Provenance>board.html today</Provenance>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="head">
            <div>
              <h3>Phase progress</h3>
              <div className="big">
                {p.pctEffort}%{" "}
                <span className="sub" style={{ fontSize: 14, fontWeight: 400 }}>
                  by effort · {p.pctTasks}% by count · {p.doneCount} of {p.total} tasks
                </span>
              </div>
            </div>
            <Link className="btn sm" to="/activity">
              Open Activity
            </Link>
          </div>
          <div className="prog" role="img" aria-label={`${p.pctEffort}% by effort, ${p.pctTasks}% by task count`}>
            <i style={{ width: `${p.pctEffort}%` }} />
            <b style={{ left: `${p.pctTasks}%` }} />
          </div>
          <p className="ft">
            ETA: <b>{s.eta ? `${s.eta.date} (${s.eta.days} days at ${Number(s.eta.perDay).toFixed(1)}h a day)` : "no rate"}</b>
            {s.eta ? "" : ": nothing closed in the window"}. The bar is effort weighted by estimates; the notch is task count
            {gap >= 10 ? `, and they are ${gap} points apart` : ""}.
            {p.unestimated ? ` ${p.unestimated} task${p.unestimated === 1 ? " has" : "s have"} no estimate.` : ""}
          </p>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Held at a gate</dt>
            <dd>{s.held}</dd>
            <dt>Blocked</dt>
            <dd>{s.blocked}</dd>
            <dt>No finish line</dt>
            <dd>{s.noAc}</dd>
            <dt>Remaining</dt>
            <dd>{p.remainingHours}h of {p.totalHours}h</dd>
          </dl>
        </div>
        <div className="card">
          <div className="head">
            <h3>Waiting on you · {s.inbox.count}</h3>
            <Link className="btn sm" to="/inbox">
              Open Inbox
            </Link>
          </div>
          {s.inbox.oldest.length ? (
            <div style={{ marginTop: 8 }}>
              {s.inbox.oldest.map((i) => {
                const k = KIND[i.kind];
                return (
                  <div key={`${i.task}${i.kind}${i.since}`} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
                    <Tile tone={k.tile} icon={k.icon} small />
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {k.label} · <TaskLink id={i.task} /> {i.title}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {ago(i.since) ?? "undated"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="dim" style={{ margin: "10px 0 0" }}>
              Nothing needs you right now.
            </p>
          )}
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="head">
            <h3>Executing now</h3>
            {s.sources.runs === "present" || s.sources.events === "present" || s.sources.archive === "present" ? <span className="chip run">live</span> : null}
          </div>
          {s.executing.length ? (
            <div className="tw" style={{ marginTop: 6 }}>
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Work item</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th className="num">For</th>
                  </tr>
                </thead>
                <tbody>
                  {s.executing.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <RunLink id={r.id} />
                      </td>
                      <td>{r.task ? <TaskLink id={r.task} /> : <span className="muted">none</span>}</td>
                      <td>{r.agent ?? <span className="muted">unknown</span>}</td>
                      <td>
                        <RunStatus status={r.status} />
                      </td>
                      <td className="num">{r.start ? fmtDuration(Date.now() - Date.parse(r.start)) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : s.sources.runs === "absent" && s.sources.events === "absent" && s.sources.archive === "absent" ? (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what="No run log, event log or run archive." why="This card never shows a pulse over a snapshot. bin/run.mjs writes the run log; agent events come from B-6." />
            </div>
          ) : (
            <p className="dim" style={{ margin: "10px 0 0" }}>
              Nothing is running. A start with no end past the staleness limit shows as no end recorded, not as running.
            </p>
          )}
          {s.legacyRunning?.length ? <p className="ft">{s.legacyRunning.length} legacy run-log rows without a run id say running; they are not paired by guesswork.</p> : null}
        </div>
        <div className="card">
          <div className="head">
            <h3>Closed vs started</h3>
            <Provenance proposed>proposed</Provenance>
          </div>
          {s.closedByDay.some((n) => n > 0) ? (
            <>
              <BarChart values={s.closedByDay} labels={s.windowDays.map(shortDay)} label="Tasks closed per day" height={120} />
              <p className="ft">Closed per day, from git. Started is not recorded: nothing dates a start yet.</p>
            </>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded
                what={`Nothing closed in the last ${s.windowDays.length} days, and starts are not dated.`}
                why="Closed dates come from git. Started needs a start fact from board.mjs start, which is not in v1."
              />
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="head">
          <h3>Recent events</h3>
          <Seg value={level} onChange={setLevel} label="Level" options={[["all", "All"], ["warn", "Warn"], ["error", "Error"]]} />
        </div>
        {s.events === null && !stream.log.length ? (
          <div style={{ marginTop: 10 }}>
            <NotRecorded what="No event log yet." why={`bin/events.mjs appends one per day under ops/foreman/events; the drift gate and agent runs write to it.`} />
          </div>
        ) : feed.length ? (
          <div className="tw" style={{ marginTop: 6 }}>
            <table>
              <tbody>
                {feed.slice(0, 40).map((e, i) => (
                  <tr key={`${e.t}${i}`}>
                    <td className="mono muted" style={{ whiteSpace: "nowrap" }}>
                      {fmtWhen(e.t)}
                    </td>
                    <td>
                      <span className={`chip ${levelTone(e.level)}`}>{e.level}</span>
                    </td>
                    <td className="muted">{e.kind}</td>
                    <td>
                      {e.detail}
                      {e.run ? (
                        <>
                          {" "}
                          <RunLink id={e.run} />
                        </>
                      ) : null}
                      {e.task ? (
                        <>
                          {" "}
                          · <TaskLink id={e.task} />
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim" style={{ margin: "10px 0 0" }}>
            No events at this level.
          </p>
        )}
      </div>
    </>
  );
}
