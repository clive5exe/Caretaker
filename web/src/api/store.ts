/**
 * One small store keyed by resource path, and the one EventSource.
 *
 * Every page reads through useResource(path). The stream says when something
 * changed (invalidate, or a new log line) and every resource on screen is
 * fetched again, so the page shows what the files say, never a local guess.
 */
import { useEffect, useSyncExternalStore } from "react";
import { API, ApiError, getJson } from "./client";
import type { LogEvent } from "./types";

interface Entry {
  data?: unknown;
  error?: ApiError;
  loading: boolean;
  listeners: Set<() => void>;
  snap: Snap<unknown>;
}
export interface Snap<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
}

const cache = new Map<string, Entry>();

function entry(path: string): Entry {
  let e = cache.get(path);
  if (!e) {
    e = { loading: false, listeners: new Set(), snap: { loading: true } };
    cache.set(path, e);
  }
  return e;
}
function publish(e: Entry) {
  e.snap = { data: e.data, error: e.error, loading: e.loading };
  for (const l of e.listeners) l();
}

async function load(path: string) {
  const e = entry(path);
  if (e.loading) return;
  e.loading = true;
  publish(e);
  try {
    e.data = await getJson(path);
    e.error = undefined;
    if (authState.signedIn !== true) setAuth(true);
  } catch (err) {
    e.error = err instanceof ApiError ? err : new ApiError(0, String(err));
    if (e.error.status === 401) setAuth(false);
  } finally {
    e.loading = false;
    publish(e);
  }
}

/** Fetch every resource something is showing; forget the rest. */
let pending: ReturnType<typeof setTimeout> | null = null;
export function refreshAll() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const [path, e] of cache) {
      if (e.listeners.size) void load(path);
      else cache.delete(path);
    }
  }, 120);
}

export function useResource<T>(path: string | null): Snap<T> & { reload: () => void } {
  const key = path ?? "";
  const snap = useSyncExternalStore(
    (cb) => {
      if (!path) return () => {};
      const e = entry(path);
      e.listeners.add(cb);
      if (e.data === undefined && !e.loading && !e.error) void load(path);
      return () => e.listeners.delete(cb);
    },
    () => (path ? entry(key).snap : EMPTY),
  ) as Snap<T>;
  return { ...snap, reload: () => path && void load(path) };
}
const EMPTY: Snap<never> = { loading: false };

/* ------------------------------------------------------------ auth state */
const authState: { signedIn: boolean | null; listeners: Set<() => void> } = { signedIn: null, listeners: new Set() };
function setAuth(v: boolean) {
  authState.signedIn = v;
  for (const l of authState.listeners) l();
}
export function useSignedIn(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      authState.listeners.add(cb);
      return () => authState.listeners.delete(cb);
    },
    () => authState.signedIn,
  );
}

/* ----------------------------------------------------------------- stream */
interface StreamState {
  connected: boolean;
  log: LogEvent[];
  version: number;
}
const stream: StreamState & { listeners: Set<() => void>; snap: StreamState } = {
  connected: false,
  log: [],
  version: 0,
  listeners: new Set(),
  snap: { connected: false, log: [], version: 0 },
};
function publishStream() {
  stream.version += 1;
  stream.snap = { connected: stream.connected, log: stream.log, version: stream.version };
  for (const l of stream.listeners) l();
}

let source: EventSource | null = null;
/** Open the one EventSource. The browser resumes it with Last-Event-ID itself. */
export function startStream() {
  if (source) return;
  source = new EventSource(`${API}/stream`, { withCredentials: true });
  source.addEventListener("open", () => {
    stream.connected = true;
    publishStream();
    // Anything could have changed while we were away.
    refreshAll();
  });
  source.addEventListener("error", () => {
    stream.connected = false;
    publishStream();
  });
  source.addEventListener("invalidate", () => refreshAll());
  source.addEventListener("log", (ev) => {
    try {
      const e = JSON.parse((ev as MessageEvent).data) as LogEvent;
      stream.log = [e, ...stream.log].slice(0, 200);
      publishStream();
    } catch {
      /* the server only sends JSON; a bad line is dropped, not shown */
    }
    refreshAll();
  });
}

export function useStream(): StreamState {
  useEffect(() => startStream(), []);
  return useSyncExternalStore(
    (cb) => {
      stream.listeners.add(cb);
      return () => stream.listeners.delete(cb);
    },
    () => stream.snap,
  );
}
