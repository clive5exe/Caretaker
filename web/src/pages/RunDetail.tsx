/**
 * Run detail (PRODUCT.md §5): everything measured about one run. Each section
 * says where it comes from, and "not recorded" when that source is absent.
 * The transcript is raw redacted text; it is never parsed into a structured
 * session, because that would read one vendor's output above the seam.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { gateLabel } from "../api/labels";
import { getRunFile } from "../api/client";
import { useResource } from "../api/store";
import type { RunDetail, Runs } from "../api/types";
import { Failed, fmtDuration, fmtTokens, fmtWhen, Loading, NotRecorded, RunLink, RunStatus, Tabs, TaskLink, Tile, Val, Verdict } from "../components/ui";
import { RunsTable } from "./Runs";

type Tab = "overview" | "transcript" | "diff" | "egress" | "sub";
type FileName = "transcript" | "stderr" | "diff" | "egress";

/** Fetch an archived file, and keep appending from its offset while the run is in flight. */
function useRunFile(id: string, file: FileName, live: boolean, present: boolean) {
  const [state, setState] = useState<{ text: string; next: number; missing: boolean; loaded: boolean }>({ text: "", next: 0, missing: false, loaded: false });
  const ref = useRef(state);
  ref.current = state;
  useEffect(() => {
    let stop = false;
    setState({ text: "", next: 0, missing: false, loaded: false });
    if (!present) {
      setState({ text: "", next: 0, missing: true, loaded: true });
      return;
    }
    const tick = async () => {
      try {
        const r = await getRunFile(id, file, ref.current.next);
        if (stop) return;
        if (!r) setState((s) => ({ ...s, missing: true, loaded: true }));
        else if (r.next !== ref.current.next || !ref.current.loaded) setState((s) => ({ text: s.text + r.text, next: r.next, missing: false, loaded: true }));
      } catch {
        /* a failed poll is retried on the next tick */
      }
    };
    void tick();
    const t = live ? setInterval(tick, 2000) : null;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [id, file, live, present]);
  return state;
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="code tall">
      {text.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") || l.startsWith("diff ") ? "meta" : undefined}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** Why a run has no egress log, by the state core derived from its archived record (W-7). */
const EGRESS_WHY: Record<string, string> = {
  host: "This run used sandbox none: it had the host's whole network, and nothing controlled or recorded its connections.",
  proxied: "A per-run egress proxy was attached, and it recorded no connection: the run made none.",
  sealed: "No proxy was attached and the network was none: the run had no route out, so there is nothing to record.",
  network: "The run used network {net}, with no per-run proxy, so its connections were not recorded.",
  unknown: "There is no archived record of this run, so how it was networked is not known.",
};

/** One line of a run's egress.jsonl, as bin/egress.mjs writes it. */
type EgressRecord = { t?: string; kind?: string; host?: string; port?: number; reason?: string; why?: string };

export function RunDetailPage() {
  const id = useParams().id ?? "";
  const { data: r, error } = useResource<RunDetail>(`/runs/${id}`);
  const all = useResource<Runs>("/runs");
  const [tab, setTab] = useState<Tab>("overview");
  const running = r?.status === "running";
  const transcriptName = r?.archiveFiles["transcript.log"] != null ? "transcript.log" : r?.archiveFiles["transcript.live.log"] != null ? "transcript.live.log" : null;
  const transcript = useRunFile(id, "transcript", running, !!transcriptName && tab === "transcript");
  const stderr = useRunFile(id, "stderr", running, r?.archiveFiles["stderr.log"] != null && tab === "transcript");
  const diff = useRunFile(id, "diff", false, r?.archiveFiles["diff.patch"] != null && tab === "diff");
  const egress = useRunFile(id, "egress", running, r?.archiveFiles["egress.jsonl"] != null && tab === "egress");
  if (error) return error.status === 404 || error.status === 400 ? <NotRecorded what={`No run ${id} is recorded.`} why="A run appears once the run log, an agent event or the run archive names it." /> : <Failed error={error} />;
  if (!r) return <Loading what={id} />;
  const kids = (all.data?.runs ?? []).filter((x) => x.parent === r.id);
  const b = r.breakdown;
  const total = b ? ["cached", "in", "write", "out"].reduce((n, k) => n + (Number(b[k]) || 0), 0) : 0;
  const driftEvents = (r.events ?? []).filter((e) => e.kind === "gate" || e.kind === "drift");
  const egressRows = egress.text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as EgressRecord;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as EgressRecord[];
  return (
    <>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Tile tone="blue" icon="code" />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="mono muted">
            {r.id}
            {r.parent ? (
              <>
                {" "}
                · child of <RunLink id={r.parent} />
              </>
            ) : null}
          </div>
          <h1 className="h1">{r.taskTitle ?? r.task ?? "A run with no work item"}</h1>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <RunStatus status={r.status} />
            <span className="chip">{r.agent ?? "agent unknown"}</span>
            <span className="chip">
              {r.model ?? "model unknown"}
              {r.adapter || r.cli ? ` via ${r.adapter ?? r.cli}` : ""}
            </span>
            {r.reconstructed ? <span className="tag outline">reconstructed</span> : null}
            <span className="tag">from {r.src.join(", ")}</span>
          </div>
        </div>
        <div className="toolbar">
          {r.task ? (
            <Link className="btn" to={`/work/${encodeURIComponent(r.task)}`}>
              Work item {r.task}
            </Link>
          ) : null}
          <button className="btn pri" type="button" onClick={() => setTab("transcript")}>
            View transcript
          </button>
        </div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["overview", "Overview"],
          ["sub", `Sub-runs (${kids.length})`],
          ["transcript", "Transcript"],
          ["diff", "Diff"],
          ["egress", "Egress"],
        ]}
      />

      {tab === "overview" ? (
        <>
          <div className="grid g3">
            <div className="card">
              <h3>Duration</h3>
              <div className="big">
                <Val v={running && r.start ? fmtDuration(Date.now() - Date.parse(r.start)) : fmtDuration(r.durationMs)} />
              </div>
              <div className="sub">
                {r.timeoutMs ? `of a ${fmtDuration(r.timeoutMs)} ceiling · ` : "no timeout ceiling recorded · "}
                started {fmtWhen(r.start) ?? "at an unrecorded time"}
              </div>
              {r.timeoutMs && r.durationMs ? (
                <div className="prog">
                  <i style={{ width: `${Math.min(100, (r.durationMs / r.timeoutMs) * 100)}%` }} />
                </div>
              ) : null}
            </div>
            <div className="card">
              <h3>Tokens</h3>
              <div className="big">
                <Val v={fmtTokens(r.tokens)} />
              </div>
              <div className="sub">{r.tokens == null ? "the harness returned no cost; unknown is not zero" : b?.turns != null ? `${b.turns} turns` : "turns not recorded"}</div>
              {b && total ? (
                <>
                  <div className="stackbar" role="img" aria-label="Token composition">
                    {(["cached", "in", "write", "out"] as const).map((k, i) => (
                      <i key={k} className={`s${i + 1}`} style={{ width: `${((Number(b[k]) || 0) / total) * 100}%` }} title={`${k} ${b[k] ?? "unknown"}`} />
                    ))}
                  </div>
                  <div className="legend" style={{ marginTop: 8, fontSize: 12 }}>
                    {(["cached", "in", "write", "out"] as const).map((k, i) => (
                      <span key={k}>
                        <i className={`s${i + 1}`} />
                        {k} {b[k] == null ? "unknown" : fmtTokens(Number(b[k]))}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div className="card">
              <h3>Measured diff</h3>
              {r.diff ? (
                <>
                  <div className="big">{r.diff.files ? `${r.diff.files.length} files` : "unknown"}</div>
                  <div className="sub">
                    <span className="passText">+{r.diff.insertions ?? "?"}</span> <span className="failText">−{r.diff.deletions ?? "?"}</span>
                    {r.diff.truncated ? " · truncated" : ""}
                    {r.diff.ignoredPathsNotMeasured ? " · gitignored paths not measured" : ""}
                  </div>
                </>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <NotRecorded what="No measured diff for this run." why="The harness archives one in run.json when the run ends (C-4)." />
                </div>
              )}
            </div>
          </div>
          <div className="grid g2">
            <div className="card">
              <h3>Status</h3>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>State</dt>
                <dd>
                  <RunStatus status={r.status} />
                </dd>
                <dt>Reason</dt>
                <dd>
                  <Val v={r.reason} />
                </dd>
                <dt>Exit code</dt>
                <dd>
                  <Val v={r.exitCode} />
                </dd>
                <dt>Started</dt>
                <dd>
                  <Val v={fmtWhen(r.start)} />
                </dd>
                <dt>Ended</dt>
                <dd>{r.end ? fmtWhen(r.end) : r.noEndRecorded ? <span className="chip warn">no end recorded</span> : running ? "still running" : <span className="muted">unknown</span>}</dd>
                <dt>Warnings</dt>
                <dd>
                  {r.warnings.length ? (
                    r.warnings.map((w, i) => (
                      <div key={i}>
                        <span className="chip warn">warning</span> {w}
                      </div>
                    ))
                  ) : (
                    <span className="muted">none raised</span>
                  )}
                </dd>
                <dt>Work item</dt>
                <dd>{r.task ? <TaskLink id={r.task} /> : <span className="muted">none</span>}</dd>
                <dt>Children</dt>
                <dd>
                  {r.children.length
                    ? r.children.map((c, i) => (
                        <span key={c}>
                          {i ? ", " : ""}
                          <RunLink id={c} />
                        </span>
                      ))
                    : <span className="muted">none</span>}
                </dd>
              </dl>
            </div>
            <div className="card">
              <h3>Gate results</h3>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Drift</dt>
                <dd>
                  {r.events === null ? (
                    <span className="muted">not recorded: no event log</span>
                  ) : driftEvents.length ? (
                    driftEvents.map((e, i) => (
                      <div key={i}>
                        {e.verdict ? <Verdict v={e.verdict} /> : <span className="chip">{e.level}</span>} {e.detail}
                      </div>
                    ))
                  ) : (
                    <span className="muted">no gate event recorded against this run</span>
                  )}
                </dd>
                {r.taskGates
                  ? Object.entries(r.taskGates).map(([g, v]) => (
                      <div key={g} style={{ display: "contents" }}>
                        <dt>{gateLabel(g)}</dt>
                        <dd>
                          <Verdict v={v.verdict} /> <span className="muted">task-level, {v.at ?? "undated"}; not attributed to this run</span>
                        </dd>
                      </div>
                    ))
                  : null}
              </dl>
              <p className="ft">A board verdict belongs to the task and carries a date, not a time, so it is never pinned on one run.</p>
            </div>
          </div>
          <div className="card">
            <h3>Artifacts</h3>
            <dl className="kv" style={{ marginTop: 8 }}>
              {Object.entries(r.archiveFiles).map(([f, size]) => (
                <div key={f} style={{ display: "contents" }}>
                  <dt className="mono">{f}</dt>
                  <dd>{size == null ? <span className="muted">not recorded</span> : `${size.toLocaleString("en-US")} bytes`}</dd>
                </div>
              ))}
            </dl>
            {r.sources.archive === "absent" ? <p className="ft">There is no run archive in the state directory, so every file above is not recorded.</p> : null}
          </div>
        </>
      ) : null}

      {tab === "sub" ? kids.length ? <RunsTable runs={kids} /> : <div className="nr">No child runs. A verify or reconcile run that examines this one would appear here.</div> : null}

      {tab === "transcript" ? (
        <>
          <div className="card">
            <div className="head">
              <h3>Transcript</h3>
              <span className="muted" style={{ fontSize: 12.5 }}>
                redacted · raw text{running ? " · live-tailing" : ""}
              </span>
            </div>
            {!transcriptName || transcript.missing ? (
              <div style={{ marginTop: 10 }}>
                <NotRecorded what="No transcript in the run archive." why="The harness archives a redacted transcript per run (C-4)." />
              </div>
            ) : transcript.loaded ? (
              <pre className="code tall" style={{ marginTop: 10 }}>
                {transcript.text || "(empty)"}
                {running ? "▍" : ""}
              </pre>
            ) : (
              <Loading what="the transcript" />
            )}
          </div>
          <div className="card">
            <h3>stderr</h3>
            {stderr.missing ? (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Not recorded.
              </p>
            ) : (
              <pre className="code tall" style={{ marginTop: 10 }}>
                {stderr.text || "(empty)"}
              </pre>
            )}
          </div>
        </>
      ) : null}

      {tab === "diff" ? (
        diff.missing ? (
          <NotRecorded what="No patch in the run archive." why="diff.patch is written when the harness measures the run's diff." />
        ) : diff.loaded ? (
          <div className="card">
            <Diff text={diff.text} />
            {r.diff?.truncated ? <p className="ft">The patch was truncated when it was archived.</p> : null}
            <p className="ft">Gitignored paths are not measured.</p>
          </div>
        ) : (
          <Loading what="the patch" />
        )
      ) : null}

      {tab === "egress" ? (
        egress.missing ? (
          <NotRecorded
            what="No egress record for this run."
            why={
              EGRESS_WHY[r.egress?.state ?? "unknown"].replace("{net}", r.egress?.net ?? "") +
              (r.egress?.modelCalls
                ? ` That covers the run's tools only: this adapter called its model from this machine, outside the sandbox, at ${r.egress.modelCalls.endpoint ?? "its configured endpoint"}, and those calls are not recorded.`
                : "")
            }
          />
        ) : (
          <div className="card flush">
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Host</th>
                    <th>Port</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {egressRows.map((e, i) => {
                    // W-7: the proxy writes kind allowed|refused|error (bin/egress.mjs),
                    // not decision/allowed, so every row read as refused.
                    const tone = e.kind === "allowed" ? "pass" : e.kind === "refused" ? "fail" : "warn";
                    const detail = e.reason ?? e.why;
                    return (
                      <tr key={i}>
                        <td className="mono muted">
                          <Val v={fmtWhen(e.t ?? null)} />
                        </td>
                        <td className="mono">{e.host ?? "?"}</td>
                        <td>
                          <Val v={e.port ?? null} />
                        </td>
                        <td>
                          <span className={`chip ${tone}`}>{e.kind ?? "unknown"}</span>
                          {detail ? <span className="muted"> {detail}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}
    </>
  );
}
