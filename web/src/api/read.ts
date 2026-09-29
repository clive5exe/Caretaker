/**
 * Inbox read and unread, kept in this browser only (PRODUCT.md §Inbox).
 * Marking an item read changes nothing in core and nothing for anyone else.
 * An item's key includes its `since`, so a new fact on the same work item
 * arrives unread.
 */
import { useSyncExternalStore } from "react";
import type { InboxItem } from "./types";

const KEY = "caretaker.inbox.read";
const listeners = new Set<() => void>();
let snap: Record<string, true> = loadRead();

function loadRead(): Record<string, true> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export const itemKey = (i: InboxItem) => `${i.task}|${i.kind}|${i.since ?? ""}|${i.question?.id ?? ""}`;

export function setRead(i: InboxItem, read: boolean) {
  const next = { ...snap };
  if (read) next[itemKey(i)] = true;
  else delete next[itemKey(i)];
  snap = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: read state lasts for this tab only */
  }
  for (const l of listeners) l();
}

export function useRead(): Record<string, true> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snap,
  );
}
