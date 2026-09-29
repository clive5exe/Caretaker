/**
 * Inbox (PRODUCT.md §3). Derived by the server from recorded facts: an item
 * leaves when its fact changes, so there is no Resolve button. Read and
 * unread live in this browser only.
 */
import { useState } from "react";
import { Link } from "react-router";
import { gateLabel, KIND, KIND_ORDER } from "../api/labels";
import { itemKey, setRead, useRead } from "../api/read";
import { useResource } from "../api/store";
import type { Inbox, InboxItem, InboxKind } from "../api/types";
import { ago, CommandForm, Failed, fmtWhen, Loading, PageHead, Tile, Verdict } from "../components/ui";

const WHY: Record<InboxKind, [string, string]> = {
  question: ["An agent or person asked on a work item and nobody has answered.", "Answered."],
  "spec-approval": ["The work item's governing spec changed since it was approved, or was never approved.", "Approved or rejected at its current content."],
  "gate-failure": ["Security failed, the drift gate failed, or the same gate failed repeatedly.", "A later pass, or the item is dropped."],
  "pr-review": ["Every required gate passed and a PR is recorded.", "Merged outside Caretaker, then closed."],
};

function Pane({ item, read }: { item: InboxItem; read: boolean }) {
  const k = KIND[item.kind];
  return (
    <div className="card pane">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Tile tone={k.tile} icon={k.icon} />
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {k.label} · {item.since ? `since ${fmtWhen(item.since)}` : "undated"}
          </div>
          <h3>
            {item.task} {item.title}
          </h3>
        </div>
      </div>
      <div className="chips">
        <Link className="chip" to={`/work/${encodeURIComponent(item.task)}`}>
          Work item {item.task}
        </Link>
        {item.owner ? <span className="chip">{item.owner}</span> : null}
      </div>
      <p style={{ margin: 0 }}>{item.fact}</p>
      {item.kind === "question" && item.question ? <p className="dim">“{item.question.q}”</p> : null}
      {item.kind === "spec-approval" && item.spec ? (
        <pre className="code" style={{ marginTop: 12 }}>
          {`${item.spec.path}\ncontent now: ${item.spec.blob ?? "not hashable"}\nApproving records this exact content; editing the spec reopens it.`}
        </pre>
      ) : null}
      {item.kind === "gate-failure" && item.gateHistory ? (
        <pre className="code" style={{ marginTop: 12 }}>
          {Object.entries(item.gateHistory)
            .map(([g, h]) => `${gateLabel(g)}: ${h.map((a) => `${a.verdict} ${a.at ?? "undated"}`).join(" → ")}`)
            .join("\n")}
        </pre>
      ) : null}
      {item.kind === "gate-failure" && item.gateHistory ? (
        <div className="chips">
          {Object.entries(item.gateHistory).map(([g, h]) => (
            <span key={g}>
              {gateLabel(g)} <Verdict v={h[h.length - 1]?.verdict ?? "not run"} />
            </span>
          ))}
        </div>
      ) : null}
      {item.dismissCommand ? (
        <>
          <p className="dim" style={{ margin: "12px 0 6px" }}>
            A drift dismissal stays in the terminal, with a reason and a name:
          </p>
          <pre className="code">{item.dismissCommand}</pre>
        </>
      ) : null}
      {item.kind === "pr-review" && item.pr ? (
        <p className="ft">
          Review and merge <span className="mono">{item.pr}</span> outside Caretaker, then close with done.
        </p>
      ) : null}
      <div className="stack" style={{ marginTop: 14, gap: 10 }}>
        {item.actions.map((c, i) => (
          <CommandForm key={`${item.task}${c.cmd}${i}`} task={item.task} command={c} />
        ))}
        {!item.actions.length && item.kind === "gate-failure" ? (
          <Link className="btn pri" to={`/work/${encodeURIComponent(item.task)}`} style={{ alignSelf: "flex-start" }}>
            Open work item
          </Link>
        ) : null}
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn sm" type="button" onClick={() => setRead(item, !read)}>
          Mark {read ? "unread" : "read"}
        </button>
      </div>
      <p className="ft">No Resolve button: the item leaves when its fact changes. Read and unread are kept in this browser only.</p>
    </div>
  );
}

export function InboxPage() {
  const { data, error } = useResource<Inbox>("/inbox");
  const read = useRead();
  const [kind, setKind] = useState<InboxKind | "all">("all");
  const [q, setQ] = useState("");
  const [selKey, setSelKey] = useState<string | null>(null);
  if (error) return <Failed error={error} />;
  if (!data) return <Loading what="the Inbox" />;
  const needle = q.trim().toLowerCase();
  const items = data.items.filter((i) => (kind === "all" || i.kind === kind) && (!needle || `${i.task} ${i.title} ${i.fact}`.toLowerCase().includes(needle)));
  const sel = items.find((i) => itemKey(i) === selKey) ?? items[0];
  const head = <PageHead title="Inbox" lede="Only what needs a human, derived from recorded facts. An item clears by itself the moment its fact is answered." />;
  if (!data.items.length) {
    return (
      <>
        {head}
        <div className="card">
          <h3>Nothing needs you right now.</h3>
          <p className="dim" style={{ margin: "4px 0 14px" }}>
            Here is what would put something here.
          </p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Appears when</th>
                  <th>Clears when</th>
                </tr>
              </thead>
              <tbody>
                {KIND_ORDER.map((k) => (
                  <tr key={k}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <Tile tone={KIND[k].tile} icon={KIND[k].icon} small />
                        {KIND[k].label}
                      </span>
                    </td>
                    <td>{k === "gate-failure" ? `${WHY[k][0]} The threshold is ${data.threshold}.` : WHY[k][0]}</td>
                    <td>{WHY[k][1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Kind">
          <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
            All <span className="muted">{data.items.length}</span>
          </button>
          {KIND_ORDER.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {KIND[k].plural} <span className="muted">{data.counts[k]}</span>
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search the Inbox" aria-label="Search the Inbox" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="split">
        <div className="ilist" role="listbox" aria-label="Inbox items">
          {items.length ? null : (
            <div style={{ padding: 16 }} className="muted">
              No items match.
            </div>
          )}
          {items.map((i) => {
            const k = KIND[i.kind];
            const key = itemKey(i);
            const isRead = !!read[key];
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={i === sel}
                className={`irow${i === sel ? " on" : ""}${isRead ? " read" : ""}`}
                onClick={() => {
                  setSelKey(key);
                  setRead(i, true);
                }}
              >
                <span>{isRead ? null : <span className="dot" aria-label="unread" />}</span>
                <Tile tone={k.tile} icon={k.icon} small />
                <span style={{ minWidth: 0 }}>
                  <div className="t">
                    {k.label} · {i.task} {i.title}
                  </div>
                  <div className="s">{i.fact}</div>
                </span>
                <span className="w">{ago(i.since) ?? "undated"}</span>
              </button>
            );
          })}
        </div>
        {sel ? <Pane item={sel} read={!!read[itemKey(sel)]} /> : null}
      </div>
    </>
  );
}
