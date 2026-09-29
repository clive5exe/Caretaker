/** Getting started (PRODUCT.md §10). Commands from TECH.md §1. */
import { PageHead } from "../components/ui";

export function GettingStarted() {
  return (
    <>
      <div className="hero">
        <span className="wordmark big">CARETAKER</span>
        <p>
          A local window onto the board, the runs and the gates. It reads the same files and calls the same core functions as the CLI, so the two can never disagree. Paths
          and commands still say <span className="mono">caretaker</span>; the UI says Caretaker.
        </p>
      </div>
      <PageHead title="Getting started" />
      {/*
        W-16: a new repo, walked to its first closed task. Every block marked
        data-walk is run, in order, by bin/getting-started.test.mjs in a scratch
        repo, with the two /path/to placeholders filled in. A step whose command
        stops working fails that test.
      */}
      <div className="card">
        <h3>From a new repo to its first closed task</h3>
        <p className="dim">None of this needs the web client. Every step is a command in your terminal; this page and the CLI read the same files.</p>
        <h4>1 · Install into your repo</h4>
        <pre className="code" data-walk="ok">{`cd /path/to/your-repo
bash /path/to/caretaker/install.sh . "My project"`}</pre>
        <p className="ft">It refuses to overwrite an existing ops/caretaker. It writes a starter board with one real task, T-001.</p>
        <h4>2 · Try to close it</h4>
        <pre className="code" data-walk="refused">{`node ops/caretaker/board.mjs done T-001`}</pre>
        <p className="ft">Refused, and it names the gates that are missing. A builder saying it is finished is a status report, not a completion.</p>
        <h4>3 · Start it, and do the work</h4>
        <pre className="code" data-walk="ok">{`node ops/caretaker/board.mjs start T-001`}</pre>
        <p className="ft">Edit docs/board.json so it describes work this project is really doing: that is T-001's acceptance criterion.</p>
        <h4>4 · Someone else checks it</h4>
        <pre className="code" data-walk="ok">{`node ops/caretaker/board.mjs reviewer T-001 pass "read it: the board describes real work"
node ops/caretaker/board.mjs qa T-001 pass "checked the board against the plan"`}</pre>
        <p className="ft">Nobody closes their own work. A task that touches money, auth or isolation needs a security verdict too. Verdicts are recorded here, never from the browser.</p>
        <h4>5 · Close it</h4>
        <pre className="code" data-walk="ok">{`node ops/caretaker/board.mjs done T-001`}</pre>
        <p className="ft">Now it closes. Every move above is on the task with who made it and when.</p>
      </div>
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
          <pre className="code" style={{ marginTop: 10 }}>node bin/serve.mjs ops/caretaker/config.json</pre>
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
