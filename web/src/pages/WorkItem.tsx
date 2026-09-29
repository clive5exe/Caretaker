/**
 * Work item detail (PRODUCT.md §2). The stage and its reason, the finish line,
 * the full gate history, runs, questions, spec and PR. Actions are exactly
 * the commands core offers; verdicts are never among them.
 */
import { useState } from "react";
import { useParams } from "react-router";
import { gateLabel, stageTone } from "../api/labels";
import { useResource } from "../api/store";
import type { WorkItem } from "../api/types";
import { CommandBar, CommandForm, Failed, fmtTokens, fmtWhen, Loading, NotRecorded, RunLink, RunStatus, StageChip, Tabs, TaskLink, Tile, Val, Verdict, fmtDuration } from "../components/ui";
import { PRIMARY_ORDER } from "../api/labels";

type Tab = "overview" | "gates" | "runs" | "notes";

export function WorkItemPage() {
  const id = decodeURIComponent(useParams().id ?? "");
  const { data: t, error } = useResource<WorkItem>(`/work/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<Tab>("overview");
  if (error) return error.status === 404 ? <NotRecorded what={`No work item ${id} on the board.`} /> : <Failed error={error} />;
  if (!t) return <Loading what={id} />;
  const rank = (cmd: string) => {
    const i = PRIMARY_ORDER.indexOf(cmd);
    return i < 0 ? PRIMARY_ORDER.length : i;
  };
  const commands = [...t.commands].sort((a, b) => rank(a.cmd) - rank(b.cmd));
  const tone = stageTone(t.lifecycle, t.rework);
  const acList = t.ac == null ? [] : Array.isArray(t.ac) ? t.ac : [t.ac];
  const gates = Object.keys(t.gates);
  const openQs = t.questions.filter((q) => !q.answer);
  return (
    <>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Tile tone={tone === "fail" ? "red" : tone === "pass" ? "green" : tone === "warn" ? "orange" : "blue"} icon="code" />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="mono muted">
            {t.id} · {t.phase}
          </div>
          <h1 className="h1">{t.title}</h1>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <StageChip stage={t.lifecycle} rework={t.rework} />
            <span className="chip">{t.owner ?? "no owner"}</span>
            <span className="chip">{t.est ?? "no estimate"}</span>
            <span className="chip">status {t.status}</span>
            {t.blocked ? <span className="chip warn">blocked: {t.blocked}</span> : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="head">
          <div>
            <h3>Actions</h3>
            <p className="ft" style={{ marginTop: 0 }}>
              What core would accept right now. Core checks again on the click. Gate verdicts are not offered: they come from gate runs and the CLI.
            </p>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <CommandBar task={t.id} commands={commands} limit={3} />
        </div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["overview", "Overview"],
          ["gates", "Gates"],
          ["runs", `Runs (${t.runList.length})`],
          ["notes", `Notes (${t.notes.length})`],
        ]}
      />

      {tab === "overview" ? (
        <>
          <div className="grid g2">
            <div className="card">
              <h3>Why it is here</h3>
              <p className="dim" style={{ margin: "4px 0 12px" }}>
                {t.reason}
              </p>
              <dl className="kv">
                <dt>Requires</dt>
                <dd>{t.requiredGates.map(gateLabel).join(", ") || "no gate"}</dd>
                <dt>Missing</dt>
                <dd>{t.missingGates.length ? <span className="warnText">{t.missingGates.join(", ")}</span> : <span className="passText">nothing</span>}</dd>
                {t.deps.length ? (
                  <>
                    <dt>Depends on</dt>
                    <dd>
                      {t.deps.map((d, i) => (
                        <span key={d}>
                          {i ? ", " : ""}
                          <TaskLink id={d} />
                        </span>
                      ))}
                    </dd>
                  </>
                ) : null}
                <dt>Spec</dt>
                <dd>
                  {t.spec ? (
                    <>
                      <span className="mono">{t.spec.path}</span>{" "}
                      {!t.spec.exists ? (
                        <span className="chip fail">missing file</span>
                      ) : !t.spec.governing ? (
                        <span className="muted">(context doc, no approval needed)</span>
                      ) : t.specApprovalNeeded ? (
                        <span className="chip warn">needs approval at {t.spec.blob?.slice(0, 7) ?? "this version"}</span>
                      ) : (
                        <span className="chip pass">approved at {t.spec.blob?.slice(0, 7)}</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
                <dt>Pull request</dt>
                <dd>{t.prRecord ? <span className="mono">{t.prRecord.url}</span> : <span className="muted">none recorded</span>}</dd>
                {t.completed ? (
                  <>
                    <dt>Closed</dt>
                    <dd>{t.completed}</dd>
                  </>
                ) : null}
                {t.dropped ? (
                  <>
                    <dt>Dropped</dt>
                    <dd>
                      {t.dropped.why} <span className="muted">{[t.dropped.by, fmtWhen(t.dropped.at)].filter(Boolean).join(" · ")}</span>
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
            <div className="card">
              <h3>Acceptance criterion</h3>
              {acList.length ? (
                acList.length === 1 ? (
                  <p style={{ margin: "6px 0 0" }}>{acList[0]}</p>
                ) : (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {acList.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="failText" style={{ margin: "6px 0 0" }}>
                  None. Nobody can tell when this is finished until it has one.
                </p>
              )}
              {t.triage.length ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Triage</h3>
                  {t.triage.map((x, i) => (
                    <p key={i} style={{ margin: "6px 0 0" }}>
                      <span className={`chip ${x.decision === "accept" ? "pass" : "fail"}`}>{x.decision}</span> {x.why ?? ""}{" "}
                      <span className="muted">{[x.by, fmtWhen(x.at)].filter(Boolean).join(" · ")}</span>
                    </p>
                  ))}
                </>
              ) : null}
            </div>
          </div>
          <div className="card">
            <h3>Questions</h3>
            {t.questions.length ? (
              t.questions.map((q) => {
                const answer = t.commands.find((c) => c.cmd === "answer" && c.fixed?.qid === q.id);
                return (
                  <div key={q.id} style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
                    <p style={{ margin: "0 0 4px" }}>
                      <b>{q.by ?? "someone"}</b> <span className="muted">{[q.id, fmtWhen(q.at), q.via].filter(Boolean).join(" · ")}</span>
                    </p>
                    <p style={{ margin: "0 0 8px" }}>{q.q}</p>
                    {q.answer ? (
                      <p style={{ margin: 0 }} className="dim">
                        <b>Answer</b> ({[q.answer.by, fmtWhen(q.answer.at), q.answer.via].filter(Boolean).join(" · ")}): {q.answer.text}
                      </p>
                    ) : answer ? (
                      <CommandForm task={t.id} command={answer} />
                    ) : (
                      <span className="muted">Open. Core does not offer an answer right now.</span>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="dim" style={{ margin: "6px 0 0" }}>
                None asked. An agent asks with <span className="mono">board.mjs ask {t.id} "…"</span> instead of guessing.
              </p>
            )}
            {openQs.length ? <p className="ft">{openQs.length} open; each one is also in the Inbox until it is answered.</p> : null}
          </div>
        </>
      ) : null}

      {tab === "gates" ? (
        <>
          <div className="card flush">
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Gate</th>
                    <th>Required</th>
                    <th className="num">Attempts</th>
                    <th>Latest</th>
                    <th>Date</th>
                    <th>Earlier</th>
                  </tr>
                </thead>
                <tbody>
                  {gates.map((g) => {
                    const hist = t.gateHistory[g] ?? [];
                    const last = hist[hist.length - 1];
                    return (
                      <tr key={g}>
                        <td>
                          <b>{gateLabel(g)}</b>
                          {last?.note ? <div className="muted" style={{ fontSize: 12.5, maxWidth: 460 }}>“{last.note}”</div> : null}
                        </td>
                        <td>{t.requiredGates.includes(g) ? "Yes" : <span className="muted">No</span>}</td>
                        <td className="num">{hist.length}</td>
                        <td>{last ? <Verdict v={last.verdict} /> : <span className="muted">not run</span>}</td>
                        <td>{last?.at ?? ""}</td>
                        <td>
                          {hist.slice(0, -1).map((a, i) => (
                            <span key={i} style={{ marginRight: 6 }}>
                              <Verdict v={a.verdict} /> <span className="muted">{a.at ?? "undated"}</span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="ft">No pass or fail buttons. Verdicts come from gate runs and the CLI; a one-click pass is the rubber stamp ADR-0001 rejects.</p>
        </>
      ) : null}

      {tab === "runs" ? (
        t.runList.length || t.legacyRuns.length ? (
          <>
            {t.runList.length ? (
              <div className="card flush">
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Agent</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th className="num">Duration</th>
                        <th className="num">Tokens</th>
                        <th className="num">Files</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.runList.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {r.parent ? <span className="kid" /> : null}
                            <RunLink id={r.id} />
                          </td>
                          <td>
                            <Val v={r.agent} />
                          </td>
                          <td>
                            <RunStatus status={r.status} />
                          </td>
                          <td>
                            <Val v={fmtWhen(r.start)} />
                          </td>
                          <td className="num">
                            <Val v={fmtDuration(r.durationMs)} />
                          </td>
                          <td className="num">
                            <Val v={fmtTokens(r.tokens)} />
                          </td>
                          <td className="num">
                            <Val v={r.files} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {t.legacyRuns.length ? (
              <div className="card">
                <h3>Legacy, unidentified · {t.legacyRuns.length} rows</h3>
                <p className="dim" style={{ margin: "6px 0 0" }}>
                  Run-log rows for this task written before runs carried an id. Shown apart, never paired into runs.
                  {` Tokens logged: ${fmtTokens(t.legacyRuns.reduce((n, r) => n + (r.tokens ?? 0), 0))}.`}
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <NotRecorded
            what="No run of this work item has been recorded."
            why={t.sources.runs === "absent" ? "There is no run log (ops/caretaker/runs.jsonl) and no run archive." : "The run log has no row naming this task."}
          />
        )
      ) : null}

      {tab === "notes" ? (
        <div className="card">
          {t.notes.length ? (
            <ol style={{ margin: 0, paddingLeft: 18 }} reversed>
              {t.notes.map((n, i) => (
                <li key={i} style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}>
                  {n}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No notes.
            </p>
          )}
          <p className="ft">Newest first. Notes are one string on the board, split where the CLI joins them.</p>
        </div>
      ) : null}
    </>
  );
}
