/**
 * Specs and drift (PRODUCT.md §7). Read-only for drift: dismissal stays with
 * drift.mjs, and the page shows the exact command.
 */
import { useResource } from "../api/store";
import type { Specs } from "../api/types";
import { Failed, fmtWhen, Loading, NotRecorded, PageHead, TaskLink, Verdict } from "../components/ui";

export function SpecsPage() {
  const { data, error } = useResource<Specs>("/specs");
  if (error) return <Failed error={error} />;
  if (!data) return <Loading what="specs" />;
  return (
    <>
      <PageHead title="Specs & drift" lede={`Every spec under ${data.specsDir}/, what it governs, and what drift.mjs reports about it.`} />
      <div className="card flush">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Spec</th>
                <th>Governs</th>
                <th>Parse</th>
              </tr>
            </thead>
            <tbody>
              {data.specs.length ? (
                data.specs.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.id}</td>
                    <td className="mono">{s.governs.length ? s.governs.join(", ") : <span className="muted">nothing declared</span>}</td>
                    <td>{s.errors.length ? <span className="chip fail">{s.errors.join("; ")}</span> : <span className="chip pass">ok</span>}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="muted">
                    No spec with a spec block under {data.specsDir}/.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {data.skipped.length ? <p className="ft">{data.skipped.length} file(s) skipped: {data.skipped.map((s) => s.path).join(", ")}</p> : null}

      <div className="grid g2">
        <div className="card">
          <h3>Ownership map</h3>
          <div className="tw" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Glob</th>
                  <th>Spec</th>
                  <th className="num">Files</th>
                </tr>
              </thead>
              <tbody>
                {data.claims.map((c) => (
                  <tr key={`${c.spec}${c.glob}`}>
                    <td className="mono">{c.glob}</td>
                    <td className="mono">{c.spec}</td>
                    <td className="num">{c.matches == null ? <span className="muted">unknown</span> : c.matches === 0 ? <span className="chip warn">0 orphaned</span> : c.matches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.orphaned.length ? <p className="ft">{data.orphaned.length} glob(s) match nothing in the tree.</p> : null}
        </div>
        <div className="card">
          <h3>Unowned changed paths</h3>
          {data.unowned === null ? (
            <div style={{ marginTop: 8 }}>
              <NotRecorded what="Not a git checkout, so changed paths are unknown." />
            </div>
          ) : data.unowned.length ? (
            <pre className="code" style={{ marginTop: 8 }}>
              {data.unowned.join("\n")}
            </pre>
          ) : (
            <p className="dim" style={{ margin: "6px 0 0" }}>
              Every changed path ({data.changed?.length ?? 0}) is claimed by a spec.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Latest drift verdicts</h3>
        {data.drift === null ? (
          <div style={{ marginTop: 8 }}>
            <NotRecorded what="No event log yet." why="The drift gate records its verdicts and dismissals in the event log." />
          </div>
        ) : data.drift.length ? (
          <div className="tw" style={{ marginTop: 8 }}>
            <table>
              <tbody>
                {data.drift.map((e, i) => (
                  <tr key={i}>
                    <td className="mono muted" style={{ whiteSpace: "nowrap" }}>
                      {fmtWhen(e.t)}
                    </td>
                    <td>{e.verdict ? <Verdict v={e.verdict} /> : <span className="chip">{e.level}</span>}</td>
                    <td>{e.task ? <TaskLink id={e.task} /> : null}</td>
                    <td>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim" style={{ margin: "6px 0 0" }}>
            The event log has no drift verdict yet.
          </p>
        )}
        <p className="dim" style={{ margin: "12px 0 6px" }}>
          Dismissals stay in the terminal, with a reason and a name:
        </p>
        <pre className="code">{data.dismissCommand}</pre>
      </div>

      <div className="card flush">
        <div style={{ padding: "14px 20px 4px" }}>
          <h3>Spec approval by work item</h3>
        </div>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Work item</th>
                <th>Spec</th>
                <th>State</th>
                <th>Last review</th>
              </tr>
            </thead>
            <tbody>
              {data.approvals.map((a) => (
                <tr key={a.task}>
                  <td>
                    <TaskLink id={a.task} /> <span className="dim">{a.title}</span>
                  </td>
                  <td className="mono">{a.path}</td>
                  <td>
                    {!a.exists ? (
                      <span className="chip fail">missing file</span>
                    ) : !a.governing ? (
                      <span className="muted">context doc, no approval needed</span>
                    ) : a.needed ? (
                      <span className="chip warn">needs approval</span>
                    ) : (
                      <span className="chip pass">approved</span>
                    )}
                  </td>
                  <td>{a.last ? `${a.last.decision} ${a.last.blob.slice(0, 7)} ${a.last.by ? `by ${a.last.by}` : ""} ${fmtWhen(a.last.at) ?? ""}` : <span className="muted">never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
