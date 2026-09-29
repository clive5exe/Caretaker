/** Settings (PRODUCT.md §9): read-only in v1. */
import { useResource } from "../api/store";
import type { Settings } from "../api/types";
import { Failed, Loading, PageHead } from "../components/ui";

const SOURCE_NAMES: Record<string, string> = {
  board: "Board",
  runs: "Run log",
  events: "Event log",
  archive: "Run archive",
  agents: "Agent definitions",
  history: "Daily history",
};

export function SettingsPage() {
  const { data: s, error } = useResource<Settings>("/settings");
  if (error) return <Failed error={error} />;
  if (!s) return <Loading what="settings" />;
  const where: Record<string, string | null> = {
    board: s.paths.board,
    runs: s.paths.runs,
    events: s.eventsDir,
    archive: s.paths.archive,
    agents: s.paths.agents,
    history: s.paths.history,
  };
  return (
    <>
      <PageHead title="Settings" lede="Read-only in v1. Edit config.json and restart the server to change anything here." />
      <div>
        <h2 className="sec">Data sources</h2>
        <p className="dim" style={{ margin: "2px 0 12px" }}>
          What exists on disk. A missing source shows as not recorded on every page, never as zero.
        </p>
        <div className="card flush">
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>State</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(s.sources).map(([k, v]) => (
                  <tr key={k}>
                    <td>{SOURCE_NAMES[k] ?? k}</td>
                    <td>{v === "present" ? <span className="chip pass">present</span> : <span className="chip">absent</span>}</td>
                    <td className="mono">{where[k] ?? <span className="muted">not configured</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div>
        <h2 className="sec">Server</h2>
        <p className="dim" style={{ margin: "2px 0 12px" }}>
          Bound to loopback only. There is no daemon, pidfile or database.
        </p>
        <div className="fields">
          <span className="k">Binding</span>
          <span className="v mono">
            {s.server.host}:{s.server.port}
          </span>
          <span className="k">Remote access</span>
          <span className="v mono">ssh -L {s.server.port}:127.0.0.1:{s.server.port} &lt;this-host&gt;</span>
          <span className="k">Access token</span>
          <span className="v">{s.server.rotate}</span>
          <span className="k">Operator</span>
          <span className="v">{s.operator} (recorded as by on every command, with via web)</span>
          <span className="k">State directory</span>
          <span className="v mono">{s.stateDir}</span>
          <span className="k">Repository</span>
          <span className="v mono">{s.root}</span>
          <span className="k">Config</span>
          <span className="v mono">{s.configPath}</span>
        </div>
      </div>
      <div>
        <h2 className="sec">Resolved config</h2>
        <p className="dim" style={{ margin: "2px 0 12px" }}>
          As the server read it at start.
        </p>
        <pre className="code">{JSON.stringify(s.config, null, 2)}</pre>
      </div>
    </>
  );
}
