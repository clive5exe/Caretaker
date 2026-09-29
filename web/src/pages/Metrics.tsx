/**
 * Metrics (PRODUCT.md §8). Every figure comes from dashboard.mjs's exported
 * functions through the server and is labelled with where it comes from. The
 * range applies to dated rows (the run log and gate verdicts); a figure with
 * no dates behind it says "all time".
 */
import { useState } from "react";
import { gateLabel } from "../api/labels";
import { useResource } from "../api/store";
import type { GateStats, Kpis, Metrics } from "../api/types";
import { BarChart, Failed, fmtTokens, LineChart, Loading, NotRecorded, PageHead, Provenance, Seg, shortDay } from "../components/ui";

function Head({ title, source, range }: { title: string; source: string; range: string }) {
  return (
    <div className="head">
      <h3>{title}</h3>
      <span style={{ display: "inline-flex", gap: 6 }}>
        <span className="tag outline">{range}</span>
        <Provenance>{source}</Provenance>
      </span>
    </div>
  );
}

function GateBars({ stats }: { stats: GateStats }) {
  const rows = stats.filter(([, s]) => s.pass + s.fail > 0);
  if (!rows.length) return <p className="dim" style={{ margin: "8px 0 0" }}>No verdict recorded in this range.</p>;
  return (
    <div className="hbar" style={{ marginTop: 12 }}>
      {rows.map(([g, s]) => {
        const pct = Math.round((s.pass / (s.pass + s.fail)) * 100);
        return (
          <div key={g} style={{ display: "contents" }}>
            <span>{gateLabel(g)}</span>
            <span className="t">
              <i className={pct >= 80 ? "g" : pct < 50 ? "r" : "a"} style={{ width: `${pct}%` }} />
            </span>
            <span>
              {pct}% · {s.pass}/{s.pass + s.fail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) => (v === null ? null : v < 48 ? `${v}h` : `${Math.round((v / 24) * 10) / 10}d`);

/** One figure, or "not recorded" with the reason; never a zero standing in for nothing. */
function Figure({ label, value, basis }: { label: string; value: string | number | null; basis?: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value === null ? <span className="dim">not recorded</span> : <strong>{value}</strong>}
        {basis ? <span className="dim"> · {basis}</span> : null}
      </dd>
    </>
  );
}

function KpiCards({ k, range }: { k: Kpis; range: string }) {
  const d = k.delivery;
  const a = k.ai;
  const r = k.estimates.remaining;
  return (
    <>
      <div className="grid g2">
        <div className="card">
          <Head title="Delivery" source="git: merges on main" range={range} />
          <dl className="kv" style={{ marginTop: 8 }}>
            <Figure label="Deploys per week" value={d.deploysPerWeek} basis={d.reason ?? `${d.deploys ?? 0} merge(s)`} />
            <Figure label="Lead time" value={hrs(d.leadTimeHours)} basis="branch's first commit to merge, median" />
            <Figure label="Change failure rate" value={pct(d.changeFailureRate)} basis="merges reverted after landing" />
            <Figure label="Time to restore" value={hrs(d.timeToRestoreHours)} basis="merge to its revert, median" />
          </dl>
        </div>
        <div className="card">
          <Head title="AI" source="run log, board, git" range={range} />
          <dl className="kv" style={{ marginTop: 8 }}>
            <Figure label="Tokens per closed task" value={fmtTokens(a.tokensPerClosedTask)} basis={a.tokensPerClosedTaskBasis} />
            <Figure label="Tokens per merged line" value={a.tokensPerMergedLine} basis={a.dollarsPerMergedLine === null ? a.costBasis : null} />
            {a.dollarsPerMergedLine !== null ? <Figure label="Dollars per merged line" value={`$${a.dollarsPerMergedLine}`} basis={a.costBasis} /> : null}
            <Figure label="First-pass rate" value={pct(a.firstPassRate)} basis={`${a.gatedTasks} gated task(s)`} />
            <Figure label="Rework rate" value={pct(a.reworkRate)} />
            <Figure label="Model mix" value={a.modelMix && a.modelMix.length ? a.modelMix.map((m) => `${m.model} ${pct(m.share)}`).join(", ") : null} />
            <Figure label="Estimate calibration" value={a.estimateCalibration === null ? null : `x${a.estimateCalibration}`} basis="actual over estimated tokens, closed work" />
            <Figure label="Human intervention" value={pct(a.humanInterventionRate)} basis={a.humanInterventionBasis} />
          </dl>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <Head title="Open work, in tokens" source="run log and estimates" range="all time" />
          {r ? (
            <p style={{ margin: "8px 0" }}>
              <strong>{fmtTokens(r.tokens)}</strong> over {r.estimated} task(s){r.unestimated ? `; ${r.unestimated} with no basis to estimate` : ""}.
            </p>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what="No basis to estimate in tokens yet." why="A closed task with token actuals in the run log calibrates the rest." />
            </div>
          )}
          {k.estimates.calibration.filter((c) => c.type !== "*").length ? (
            <dl className="kv">
              {k.estimates.calibration
                .filter((c) => c.type !== "*")
                .map((c) => (
                  <Figure key={c.type} label={c.type} value={c.factor === null ? null : `x${c.factor}`} basis={`${c.closed} closed${c.tokensPerHour !== null ? `, ${fmtTokens(c.tokensPerHour)}/h` : ""}`} />
                ))}
            </dl>
          ) : null}
        </div>
        <div className="card">
          <h3>Left out on purpose</h3>
          <dl className="kv" style={{ marginTop: 8 }}>
            {k.antiKpis.map((x) => (
              <Figure key={x.name} label={x.name} value={null} basis={x.why} />
            ))}
          </dl>
        </div>
      </div>
    </>
  );
}

export function MetricsPage() {
  const [days, setDays] = useState(14);
  const { data: m, error } = useResource<Metrics>(`/metrics?days=${days}`);
  const range = `last ${days} days`;
  if (error) return <Failed error={error} />;
  if (!m) return <Loading what="metrics" />;
  const noLog = m.sources.runs === "absent";
  const labels = m.window.map(shortDay);
  const t = m.tokens;
  return (
    <>
      <PageHead
        title="Metrics"
        lede="Everything Caretaker measures, each figure labelled with where it comes from."
        right={<Seg value={days} onChange={setDays} label="Range" options={[[7, "7d"], [14, "14d"], [30, "30d"]]} />}
      />
      <div className="grid g2">
        <div className="card">
          <Head title="Tokens by kind, per day" source="run log" range={range} />
          {noLog ? (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what="No run log (ops/caretaker/runs.jsonl)." why="bin/run.mjs writes one row per agent run, with in, cached, write and out when the CLI reports them." />
            </div>
          ) : m.tokensPerDay && m.tokensPerDay.some((d) => d.comp) ? (
            <>
              <LineChart
                label="Tokens by kind per day"
                labels={labels}
                fmt={(v) => fmtTokens(v) ?? String(v)}
                series={(["cached", "in", "write", "out"] as const).map((k) => ({ name: k, values: m.tokensPerDay!.map((d) => d.comp?.[k] ?? 0) }))}
              />
              <div className="legend" style={{ marginTop: 8 }}>
                {["cached", "in", "write", "out"].map((k, i) => (
                  <span key={k}>
                    <i className={`s${i + 1}`} />
                    {k}
                  </span>
                ))}
              </div>
              <p className="ft">Days with runs but no breakdown count as 0 here; their totals are in the card beside this one.</p>
            </>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what={`No run in the ${range} reported a token breakdown.`} />
            </div>
          )}
        </div>
        <div className="card">
          <Head title="Token spend" source="run log" range={range} />
          {t ? (
            <>
              <div className="big">{fmtTokens(t.total)}</div>
              <div className="sub">
                {t.liveCount} live row{t.liveCount === 1 ? "" : "s"}
                {t.reconCount ? `, ${t.reconCount} reconstructed (kept apart)` : ""} · {t.turns ? `${t.turns} turns` : "turns not recorded"}
              </div>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>Context churn</dt>
                <dd>{t.churnShare == null ? <span className="muted">not recorded</span> : `${Math.round(t.churnShare * 100)}% of context the cache could not match`}</dd>
                <dt>Generated share</dt>
                <dd>{t.outShare == null ? <span className="muted">not recorded</span> : `${Math.round(t.outShare * 100)}% output`}</dd>
                <dt>Per turn</dt>
                <dd>{t.perTurn == null ? <span className="muted">not recorded</span> : fmtTokens(t.perTurn)}</dd>
                <dt>Rework spend</dt>
                <dd>
                  {m.reworkSpend ? `${fmtTokens(m.reworkSpend.wasted)} (${m.reworkSpend.pct}%) on ${m.reworkSpend.tasks} task${m.reworkSpend.tasks === 1 ? "" : "s"} that failed a gate, up to the day each last failed` : <span className="muted">not recorded</span>}
                </dd>
              </dl>
            </>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what={noLog ? "No run log." : `No run in the ${range} logged tokens.`} />
            </div>
          )}
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <Head title="Pass rate per gate" source="board.json verdicts" range={range} />
          <GateBars stats={m.gateStats} />
          <p className="ft">Every attempt counts, from the appended verdict history.</p>
        </div>
        <div className="card">
          <Head title="First-pass rate" source="board.json verdicts" range={range} />
          <div className="big">{m.quality.gated ? `${m.quality.firstPassPct}%` : "—"}</div>
          <div className="sub">
            {m.quality.gated
              ? `${m.quality.firstPass} of ${m.quality.gated} gated tasks passed every gate first time · ${m.quality.attempts} attempts`
              : `no verdict in the ${range}`}
          </div>
          <p className="ft">
            All time: {m.allTime.quality.gated ? `${m.allTime.quality.firstPassPct}% of ${m.allTime.quality.gated}` : "no gated task"}. Verdicts carry a date, so the range applies to them.
          </p>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <Head title="Estimate against elapsed" source="git + board.json" range="all time" />
          {m.cycle.length ? (
            <div className="tw" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Work item</th>
                    <th className="num">Estimate</th>
                    <th className="num">Elapsed</th>
                    <th className="num">Commits</th>
                  </tr>
                </thead>
                <tbody>
                  {m.cycle.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.id} <span className="dim">{c.title}</span>
                      </td>
                      <td className="num">{c.est}h</td>
                      <td className="num">
                        {c.days} day{c.days === 1 ? "" : "s"}
                      </td>
                      <td className="num">{c.commits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what="No closed task with commits naming it." why="Elapsed runs from the first commit that names the task to its close date." />
            </div>
          )}
          {m.medDays != null ? <p className="ft">Median {m.medDays} days against a median estimate of {m.medEst}h.</p> : null}
        </div>
        <div className="card">
          <Head title="Commits and closes per day" source="git" range={`last ${m.closedWindow.length} days`} />
          <BarChart values={m.commitsByDay} labels={m.closedWindow.map(shortDay)} label="Commits per day" height={120} />
          <p className="ft">
            Commits per day. Closed in the same window: {m.closedByDay.reduce((a, b) => a + b, 0)}. The window is the dashboard's, not the range above.
          </p>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <Head title="Tokens by agent" source="run log" range={range} />
          {t?.byAgent.length ? (
            <div className="hbar" style={{ marginTop: 12 }}>
              {t.byAgent.map(([name, v]) => (
                <div key={name} style={{ display: "contents" }}>
                  <span>{name ?? "unnamed"}</span>
                  <span className="t">
                    <i style={{ width: `${(v.tokens / t.total) * 100}%` }} />
                  </span>
                  <span>
                    {fmtTokens(v.tokens)} · {v.runs} run{v.runs === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what="No tokens by agent." />
            </div>
          )}
        </div>
        <div className="card">
          <Head title="Tokens by model" source="run log" range={range} />
          {t?.byModel.length ? (
            <div className="hbar" style={{ marginTop: 12 }}>
              {t.byModel.map(([name, v]) => (
                <div key={name} style={{ display: "contents" }}>
                  <span className="mono">{name}</span>
                  <span className="t">
                    <i style={{ width: `${(v.tokens / t.total) * 100}%` }} />
                  </span>
                  <span>{fmtTokens(v.tokens)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <NotRecorded what={t ? "No run-log row names its model." : "No tokens by model."} />
            </div>
          )}
        </div>
      </div>

      <KpiCards k={m.kpis} range={range} />

      <div className="card">
        <h3>Not in v1</h3>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Cycle time per stage</dt>
          <dd>Stages are derived on every read, so time in each one needs dated transitions from the event log (B-7).</dd>
          <dt>Cost in money</dt>
          <dd>Caretaker records tokens. Dollars appear per merged line only when the config's <code>pricing</code> prices every model in the run log; subscription CLIs have no per-token price.</dd>
        </dl>
      </div>
    </>
  );
}
