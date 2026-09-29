/** Getting started (PRODUCT.md §10). Commands from TECH.md §1. */
import { PageHead } from "../components/ui";

export function GettingStarted() {
  return (
    <>
      <div className="hero">
        <span className="wordmark big">CARETAKER</span>
        <p>
          A local window onto the board, the runs and the gates. It reads the same files and calls the same core functions as the CLI, so the two can never disagree. Paths
          and commands still say <span className="mono">foreman</span>; the UI says Caretaker.
        </p>
      </div>
      <PageHead title="Getting started" />
      <div className="grid g2">
        <div className="card">
          <h3>1 · Build the client (once, optional)</h3>
          <pre className="code" style={{ marginTop: 10 }}>npm --prefix web ci && npm --prefix web run build</pre>
          <p className="ft">
            The only npm dependencies in the repo. Nothing in bin/ imports them. Without a build, the server shows a small page that links docs/board.html and lists the API.
          </p>
        </div>
        <div className="card">
          <h3>2 · Start the server</h3>
          <pre className="code" style={{ marginTop: 10 }}>node bin/serve.mjs ops/foreman/config.json</pre>
          <p className="ft">It prints a sign-in address once. Open it; the token becomes a cookie and leaves your address bar. Ctrl-C stops the server.</p>
        </div>
        <div className="card">
          <h3>3 · From another machine</h3>
          <pre className="code" style={{ marginTop: 10 }}>ssh -L 7420:127.0.0.1:7420 you@box</pre>
          <p className="ft">Any bind other than loopback is refused in v1: plain HTTP on a network would carry the token in clear.</p>
        </div>
        <div className="card">
          <h3>What it promises</h3>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }} className="dim">
            <li>No daemon, pidfile, service or database. The files stay authoritative.</li>
            <li>Loopback only. A 256-bit token, printed once, becomes an HttpOnly, SameSite=Strict cookie.</li>
            <li>Exact Host checks; writes need the exact Origin, JSON and a custom header; a strict CSP; no CORS.</li>
            <li>Every button calls the same core function as the CLI, and core checks again.</li>
            <li>No gate verdict can be recorded from the browser.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
