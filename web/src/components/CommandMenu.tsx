/**
 * The command menu: Ctrl-K or the primary button. It lists the pages, work
 * items and runs, and on a work item the commands core offers for it right
 * now. It adds no command of its own, and choosing one does exactly what the
 * same button on the page does (CommandForm).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { commandHint, commandLabel } from "../api/labels";
import { useResource } from "../api/store";
import type { Command, Runs, Work, WorkItem } from "../api/types";
import { CommandForm } from "./ui";

export const PAGES: [string, string][] = [
  ["/", "Dashboard"],
  ["/activity", "Activity"],
  ["/inbox", "Inbox"],
  ["/runs", "Runs"],
  ["/agents", "Agents"],
  ["/specs", "Specs & drift"],
  ["/metrics", "Metrics"],
  ["/settings", "Settings"],
  ["/terminal", "Terminal view"],
  ["/start", "Getting started"],
];

type Item = { key: string; group: string; label: string; hint: string; go?: string; command?: Command };

export function CommandMenu({ task, onClose }: { task: string | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [chosen, setChosen] = useState<Command | null>(null);
  const nav = useNavigate();
  const work = useResource<Work>("/work");
  const runs = useResource<Runs>("/runs");
  const item = useResource<WorkItem>(task ? `/work/${encodeURIComponent(task)}` : null);
  const input = useRef<HTMLInputElement>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (task && item.data) {
      item.data.commands.forEach((c, i) => out.push({ key: `c${i}`, group: `Offered by core for ${task}`, label: `${commandLabel(c)}`, hint: commandHint(c), command: c }));
    }
    for (const [path, name] of PAGES) out.push({ key: `p${path}`, group: "Pages", label: name, hint: "page", go: path });
    for (const t of work.data?.tasks ?? []) out.push({ key: `t${t.id}`, group: "Work items", label: `${t.id} · ${t.title}`, hint: t.owner ?? "", go: `/work/${encodeURIComponent(t.id)}` });
    for (const r of runs.data?.runs ?? []) out.push({ key: `r${r.id}`, group: "Runs", label: `${r.id}${r.task ? ` · ${r.task}` : ""}`, hint: r.agent ?? "", go: `/runs/${r.id}` });
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((x) => `${x.label} ${x.hint}`.toLowerCase().includes(needle)) : out;
  }, [q, task, item.data, work.data, runs.data]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function choose(x: Item | undefined) {
    if (!x) return;
    if (x.go) {
      nav(x.go);
      onClose();
    } else if (x.command) {
      // A command with no fields still opens its form, so a click is never a surprise mutation.
      setChosen(x.command);
    }
  }

  let lastGroup = "";
  return (
    <div className="palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="box" role="dialog" aria-modal="true" aria-label="Command menu">
        {chosen && task ? (
          <>
            <div className="hd">
              {commandLabel(chosen)} · {task}
            </div>
            <CommandForm task={task} command={chosen} autoFocus onDone={(r) => r.ok && setTimeout(onClose, 700)} />
          </>
        ) : (
          <>
            <input
              ref={input}
              autoFocus
              value={q}
              placeholder={task ? `Commands core would accept for ${task} right now, pages, work items` : "Go to a page, work item or run"}
              aria-label="Search commands"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(items.length - 1, s + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  choose(items[sel]);
                }
              }}
            />
            <div className="list" role="listbox">
              {items.length ? null : <div className="empty">Nothing matches.</div>}
              {items.slice(0, 80).map((x, i) => {
                const head = x.group !== lastGroup ? <div className="hd">{x.group}</div> : null;
                lastGroup = x.group;
                return (
                  <div key={x.key}>
                    {head}
                    <button type="button" role="option" aria-selected={i === sel} className={`it${i === sel ? " on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(x)}>
                      <span>{x.label}</span>
                      <span className="dd">{x.hint}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
