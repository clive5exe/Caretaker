/**
 * Runs (PRODUCT.md §4). One row per agent execution, children under their
 * parent. Rows logged before runs carried an id are grouped apart as legacy,
 * never paired into runs by guesswork.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { runTone } from "../api/labels";
import { useResource } from "../api/store";
import type { LegacyRow, RunRow, Runs } from "../api/types";
import { Failed, fmtDuration, fmtTokens, fmtWhen, Loading, NotRecorded, PageHead, RunStatus, TaskLink, Val } from "../components/ui";

export function RunsTable({ runs }: { runs: RunRow[] }) {
  const nav = useNavigate();
  const ids = new Set(runs.map((r) => r.id));
  const roots = runs.filter((r) => !r.parent || !ids.has(r.parent));
  const rows: [RunRow, number][] = [];
  const add = (r: RunRow, depth: number) => {
    rows.push([r, depth]);
    for (const c of runs.filter((x) => x.parent === r.id)) add(c, depth + 1);
  };
  for (const r of roots) add(r, 0);
  return (
    <div className="card flush">
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Work item</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Harness</th>
              <th>Status</th>
              <th>Started</th>
              <th className="num">Duration</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([r, depth]) => (
              <tr key={r.id} className="go" onClick={() => nav(`/runs/${r.id}`)}>
                <td className="mono" style={{ whiteSpace: "nowrap", paddingLeft: 14 + depth * 18 }}>
                  {depth ? <span className="kid" /> : null}
                  <a href={`/runs/${r.id}`} onClick={(e) => e.preventDefault()}>
                    {r.id}
                  </a>
                  {r.reconstructed ? <span className="tag outline" style={{ marginLeft: 6 }}>reconstructed</span> : null}
                </td>
                <td onClick={(e) => e.stopPropagation()}>{r.task ? <TaskLink id={r.task} /> : <span className="muted">none</span>}</td>
                <td>
                  <Val v={r.agent} />
                </td>
                <td>
                  <Val v={r.model} />
                </td>
                <td>
                  <Val v={r.adapter ?? r.cli} />
                </td>
                <td>
                  <RunStatus status={r.status} />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Val v={fmtWhen(r.start)} />
                </td>
                <td className="num">
                  <Val v={fmtDuration(r.durationMs)} />
                </td>
                <td className="num">
                  <Val v={fmtTokens(r.tokens)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LegacyTable({ rows }: { rows: LegacyRow[] }) {
  return (
    <div className="card">
      <div className="head">
        <h3>Legacy, unidentified · {rows.length} rows</h3>
        <span className="chip warn">not paired</span>
      </div>
      <p className="dim" style={{ margin: "6px 0 10px" }}>
        Run-log rows written before runs carried an id. Each row is one fact as logged; a start and an end are not joined into a run by guessing.
      </p>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Kind</th>
              <th>Agent</th>
              <th>State</th>
              <th>Work item</th>
              <th>Model</th>
              <th className="num">Tokens</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(-200).reverse().map((r, i) => (
              <tr key={i}>
                <td className="mono muted" style={{ whiteSpace: "nowrap" }}>
                  <Val v={fmtWhen(r.t)} />
                </td>
                <td>
                  <Val v={r.kind} />
                </td>
                <td>
                  <Val v={r.agent} />
                </td>
                <td>
                  <Val v={r.state} />
                </td>
                <td>{r.task ? <TaskLink id={r.task} /> : <span className="muted">none</span>}</td>
                <td>
                  <Val v={r.model} />
                </td>
                <td className="num">
                  <Val v={fmtTokens(r.tokens)} />
                </td>
                <td>{r.src === "live" ? <span className="muted">live</span> : <span className="tag outline">{r.src}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RunsPage() {
  const { data, error } = useResource<Runs>("/runs");
  const [status, setStatus] = useState("all");
  const [agent, setAgent] = useState("all");
  const [model, setModel] = useState("all");
  const [task, setTask] = useState("");
  const all = data?.runs ?? [];
  const opts = useMemo(
    () => ({
      status: [...new Set(all.map((r) => r.status))].sort(),
      agent: [...new Set(all.map((r) => r.agent).filter(Boolean) as string[])].sort(),
      model: [...new Set(all.map((r) => r.model).filter(Boolean) as string[])].sort(),
    }),
    [all],
  );
  if (error) return <Failed error={error} />;
  if (!data) return <Loading what="runs" />;
  const head = <PageHead title="Runs" lede="One row per agent execution. Child runs sit under the run they examine." />;
  if (data.runs === null && data.legacy === null) {
    return (
      <>
        {head}
        <NotRecorded
          what="No run log (ops/caretaker/runs.jsonl), no agent events and no run archive."
          why="bin/run.mjs writes the run log. Run ids, parents and the archive come from the harness (C-4); until then this page stays empty rather than inventing runs."
        />
        <div className="card">
          <h3>What fills this page</h3>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Run log</dt>
            <dd>bin/run.mjs rows: t, kind, name, state, task, tokens, in, cached, write, out, turns, model</dd>
            <dt>Run ids</dt>
            <dd>rows carrying run, parent, adapter and cli; agent start and end events</dd>
            <dt>Archive</dt>
            <dd>run.json, diff.patch and a redacted transcript under the state directory</dd>
          </dl>
        </div>
      </>
    );
  }
  const needle = task.trim().toLowerCase();
  const rs = all.filter(
    (r) => (status === "all" || r.status === status) && (agent === "all" || r.agent === agent) && (model === "all" || r.model === model) && (!needle || (r.task ?? "").toLowerCase().includes(needle)),
  );
  const sel = (label: string, all: string, value: string, set: (v: string) => void, options: string[], name: (v: string) => string = (v) => v) => (
    <select className="search" aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      <option value="all">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {name(o)}
        </option>
      ))}
    </select>
  );
  return (
    <>
      {head}
      <div className="toolbar">
        {sel("Status", "All statuses", status, setStatus, opts.status, (v) => runTone(v).label)}
        {sel("Agent", "All agents", agent, setAgent, opts.agent)}
        {sel("Model", "All models", model, setModel, opts.model)}
        <input className="search" placeholder="Work item" aria-label="Filter by work item" value={task} onChange={(e) => setTask(e.target.value)} />
        <span className="muted" style={{ fontSize: 12.5 }}>
          A start with no end older than {data.staleRunHours}h shows as no end recorded, not running.
        </span>
      </div>
      {data.runs === null ? (
        <NotRecorded what="No identified runs." why="No row in the run log carries a run id, and there are no agent events or archived runs." />
      ) : rs.length ? (
        <RunsTable runs={rs} />
      ) : (
        <div className="nr">{all.length ? "No runs match." : "No identified runs yet."}</div>
      )}
      {data.legacy === null ? null : data.legacy.length ? <LegacyTable rows={data.legacy} /> : null}
    </>
  );
}
