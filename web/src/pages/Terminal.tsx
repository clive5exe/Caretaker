/** Terminal view: the same project over SSH with nothing listening (U-2). */
import { PageHead } from "../components/ui";

const SCREENS: [string, string, string][] = [
  ["1", "Runs", "Runs on the left; the selected run's transcript tail, token breakdown and gate state on the right."],
  ["2", "Board", "The lifecycle columns, rework and active items first."],
  ["3", "Inbox", "The same four kinds; the selected item shows the fact that put it there."],
  ["4", "Metrics", "The Metrics page's figures from dashboard.mjs, as text."],
];

export function Terminal() {
  return (
    <>
      <PageHead title="Terminal view" lede="The same screens in your terminal. It reads the same read model and lifecycle rules as this page, so the two cannot disagree." />
      <div className="term">
        <div className="tbar">
          <i />
          <i />
          <i />
          <span>terminal</span>
        </div>
        <pre className="tpre">
          {`$ node bin/tui.mjs ops/foreman/config.json\n\n  1 Runs   2 Board   3 Inbox   4 Metrics      : command   j/k move   q quit\n`}
        </pre>
      </div>
      <div className="card flush">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Screen</th>
                <th>Shows</th>
              </tr>
            </thead>
            <tbody>
              {SCREENS.map(([k, n, d]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td>{n}</td>
                  <td>{d}</td>
                </tr>
              ))}
              <tr>
                <td className="mono">:</td>
                <td>Command line</td>
                <td>Lists only what core offers for the selected work item, like the command menu here.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="ft">
        The transcript tail is the raw redacted transcript, the same as Run detail. Per-tool lines would need the harness to emit normalised events first. Over SSH, run it
        on the machine that holds the repo; nothing listens on a port.
      </p>
    </>
  );
}
