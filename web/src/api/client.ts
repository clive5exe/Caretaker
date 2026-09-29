/**
 * The one typed client over /api/v1 (TECH.md §2). Same origin only: the
 * session is an HttpOnly cookie the page never sees, and every write carries
 * the three things a cross-site request cannot: the exact Origin (the browser
 * adds it), application/json and X-Caretaker: 1.
 */
import type { CommandResult, WorkItem } from "./types";

export const API = "/api/v1";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function errorOf(r: Response): Promise<ApiError> {
  let msg = `${r.status} ${r.statusText}`;
  try {
    const body = await r.json();
    if (body && typeof body.error === "string") msg = body.error;
  } catch {
    /* not json */
  }
  return new ApiError(r.status, msg);
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!r.ok) throw await errorOf(r);
  return (await r.json()) as T;
}

/** An archived run file from a byte offset; null when it was not recorded. */
export async function getRunFile(id: string, file: "transcript" | "stderr" | "diff" | "egress", from = 0): Promise<{ text: string; next: number; size: number } | null> {
  const r = await fetch(`${API}/runs/${encodeURIComponent(id)}/${file}?from=${from}`, { credentials: "same-origin" });
  if (r.status === 404) return null;
  if (!r.ok) throw await errorOf(r);
  return { text: await r.text(), next: Number(r.headers.get("X-Next-Offset") ?? 0), size: Number(r.headers.get("X-Size") ?? 0) };
}

/**
 * Send one command core offered. Core checks again; a refusal comes back in
 * core's own words and is shown as it is.
 */
export async function runCommand(task: string, cmd: string, args: Record<string, string>): Promise<CommandResult> {
  const r = await fetch(`${API}/work/${encodeURIComponent(task)}/commands`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Caretaker": "1", Accept: "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  let body: { task?: WorkItem; refused?: { missing: string[]; docsOnly: boolean }; error?: string } = {};
  try {
    body = await r.json();
  } catch {
    /* empty */
  }
  if (r.ok && body.task) return { ok: true, task: body.task };
  return { ok: false, status: r.status, refused: body.refused, error: body.error ?? (body.refused ? undefined : `${r.status} ${r.statusText}`) };
}
