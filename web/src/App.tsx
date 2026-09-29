/**
 * The shell: sidebar, top bar with breadcrumbs and the one black primary
 * button, the command menu, and the routes (PRODUCT.md §Layout).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createBrowserRouter, Link, NavLink, Outlet, RouterProvider, useLocation, useMatch } from "react-router";
import { itemKey, useRead } from "./api/read";
import { useResource, useSignedIn, useStream } from "./api/store";
import type { Inbox, Snapshot } from "./api/types";
import { CommandMenu } from "./components/CommandMenu";
import { Icon, type IconName } from "./components/Icons";
import { Activity } from "./pages/Activity";
import { Agents } from "./pages/Agents";
import { Dashboard } from "./pages/Dashboard";
import { GettingStarted } from "./pages/GettingStarted";
import { InboxPage } from "./pages/Inbox";
import { MetricsPage } from "./pages/Metrics";
import { RunDetailPage } from "./pages/RunDetail";
import { RunsPage } from "./pages/Runs";
import { SettingsPage } from "./pages/Settings";
import { SpecsPage } from "./pages/Specs";
import { Terminal } from "./pages/Terminal";
import { WorkItemPage } from "./pages/WorkItem";

const NAMES: Record<string, string> = {
  "": "Dashboard",
  activity: "Activity",
  work: "Activity",
  inbox: "Inbox",
  runs: "Runs",
  agents: "Agents",
  specs: "Specs & drift",
  metrics: "Metrics",
  settings: "Settings",
  terminal: "Terminal view",
  start: "Getting started",
};
const BASE: Record<string, string> = { work: "/activity", runs: "/runs" };

function Nav({ to, icon, label, extra, sub, end }: { to: string; icon?: IconName; label: string; extra?: ReactNode; sub?: boolean; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav${sub ? " sub" : ""}${isActive ? " active" : ""}`} title={label}>
      {icon ? <Icon name={icon} /> : null}
      <span className="label">{label}</span>
      {extra}
    </NavLink>
  );
}

function Sidebar({ collapsed, onCollapse, onSearch }: { collapsed: boolean; onCollapse: () => void; onSearch: () => void }) {
  const inbox = useResource<Inbox>("/inbox");
  const snap = useResource<Snapshot>("/snapshot");
  const read = useRead();
  const unread = inbox.data ? inbox.data.items.filter((i) => !read[itemKey(i)]).length : null;
  const name = snap.data?.name ?? "project";
  const onWork = useMatch("/work/:id");
  return (
    <aside className="side" aria-label="Navigation">
      <div className="brand">
        <Link to="/" className="wordmark" aria-label="Caretaker home">
          CARETAKER
        </Link>
        <span className="sp" />
        <button className="ib" type="button" aria-label="Search" title="Search (Ctrl-K)" onClick={onSearch}>
          <Icon name="search" />
        </button>
        <button className="ib" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={collapsed} onClick={onCollapse}>
          <Icon name="panel" />
        </button>
      </div>
      <Nav to="/inbox" icon="inbox" label="Inbox" extra={unread ? <span className="ct hot" aria-label={`${unread} unread`}>{unread}</span> : null} />
      <Nav to="/runs" icon="runs" label="Runs" />
      <div className="sechead">Project</div>
      <div className="proj">
        <span className="av">{name.charAt(0).toLowerCase()}</span>
        {name}
      </div>
      <Nav to="/" end icon="home" label="Dashboard" sub />
      <NavLink to="/activity" className={({ isActive }) => `nav sub${isActive || onWork ? " active" : ""}`} title="Activity">
        <Icon name="board" />
        <span className="label">Activity</span>
      </NavLink>
      <Nav to="/agents" icon="bot" label="Agents" sub />
      <Nav to="/specs" icon="doc" label="Specs & drift" sub />
      <Nav to="/metrics" icon="chart" label="Metrics" sub />
      <Nav to="/settings" icon="cog" label="Settings" sub />
      <div className="sechead">Also in your terminal</div>
      <Nav to="/terminal" icon="play" label="Terminal view" />
      <div className="foot">
        <Nav to="/start" icon="book" label="Getting started" />
      </div>
    </aside>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const loc = useLocation();
  const stream = useStream();
  const parts = loc.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const first = parts[0] ?? "";
  const crumbs: [string, string | null][] = [["Caretaker", "/"]];
  if (BASE[first]) {
    crumbs.push([NAMES[first], BASE[first]]);
    if (parts[1]) crumbs.push([parts[1], null]);
  } else if (first) crumbs.push([NAMES[first] ?? first, null]);
  else crumbs.push(["Dashboard", null]);
  const onItem = first === "work" && parts[1];
  return (
    <div className="top">
      <nav className="crumb" aria-label="Breadcrumbs">
        {crumbs.map(([label, to], i) =>
          i === crumbs.length - 1 || !to ? (
            <span key={i} className="cur">
              {label}
            </span>
          ) : (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Link to={to}>{label}</Link>
              <Icon name="chev" />
            </span>
          ),
        )}
      </nav>
      <span className="sp" />
      <span className={`live${stream.connected ? "" : " off"}`} title={stream.connected ? "Live: the page refreshes when the files change" : "Reconnecting to the live stream"}>
        <i />
        {stream.connected ? "live" : "reconnecting"}
      </span>
      <button className="ib box" type="button" aria-label="Search" title="Search (Ctrl-K)" onClick={onMenu}>
        <Icon name="search" />
      </button>
      <button className="ib box" type="button" aria-label="Filter" title="Filter: jump to a page, work item or run" onClick={onMenu}>
        <Icon name="filter" />
      </button>
      <button className="btn pri" type="button" onClick={onMenu} aria-haspopup="dialog" title="Ctrl-K">
        {onItem ? "Actions" : "Go to"} <Icon name="down" />
      </button>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="page" style={{ maxWidth: 640, margin: "48px auto" }}>
      <span className="wordmark">CARETAKER</span>
      <h1 className="h1">Not signed in</h1>
      <p className="dim">
        Open the sign-in address the server printed when it started (it ends in <span className="mono">/auth?t=…</span>). The token lives only in that
        process; restart the server for a new one.
      </p>
      <pre className="code">node bin/serve.mjs ops/caretaker/config.json</pre>
    </div>
  );
}

function Shell() {
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("caretaker.side") === "collapsed";
    } catch {
      return false;
    }
  });
  const signedIn = useSignedIn();
  const loc = useLocation();
  const itemMatch = useMatch("/work/:id");
  const task = itemMatch?.params.id ? decodeURIComponent(itemMatch.params.id) : null;
  const open = useCallback(() => setMenu(true), []);
  const close = useCallback(() => setMenu(false), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMenu((m) => !m);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const name = NAMES[loc.pathname.split("/")[1] ?? ""] ?? "Caretaker";
    document.title = `${name} · Caretaker`;
  }, [loc.pathname]);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("caretaker.side", c ? "open" : "collapsed");
      } catch {
        /* per-tab only */
      }
      return !c;
    });
  };
  if (signedIn === false) return <SignedOut />;
  return (
    <div className={`app${collapsed ? " collapsed" : ""}`}>
      <Sidebar collapsed={collapsed} onCollapse={toggle} onSearch={open} />
      <div className="main" id="main">
        <TopBar onMenu={open} />
        <main className="page">
          <Outlet />
        </main>
      </div>
      {menu ? <CommandMenu task={task} onClose={close} /> : null}
    </div>
  );
}

function NotFound() {
  return (
    <div className="nr">
      <b>No such page.</b> <Link to="/">Back to the dashboard</Link>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/activity", element: <Activity /> },
      { path: "/work/:id", element: <WorkItemPage /> },
      { path: "/inbox", element: <InboxPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/:id", element: <RunDetailPage /> },
      { path: "/agents", element: <Agents /> },
      { path: "/specs", element: <SpecsPage /> },
      { path: "/metrics", element: <MetricsPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/terminal", element: <Terminal /> },
      { path: "/start", element: <GettingStarted /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
