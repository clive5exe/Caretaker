/**
 * Agents (PRODUCT.md §6): roles from the project's agent definitions, and
 * what the run log says each one did. Caretaker has no orchestrating agent.
 */
import { useResource } from "../api/store";
import type { Agents as AgentsT } from "../api/types";
import { Failed, fmtTokens, Loading, NotRecorded, PageHead, RunLink, Tile } from "../components/ui";

// Category colors by position, in the chart-series order, so the same agent
// keeps its color on every page that lists agents in name order.
const TILES = ["violet", "blue", "orange", "pink"] as const;

export function Agents() {
  const { data, error } = useResource<AgentsT>("/agents");
  if (error) return <Failed error={error} />;
  if (!data) return <Loading what="agents" />;
  return (
    <>
      <PageHead title="Agents" lede="Roles from your agent definitions (config agentsDir). Code and gates decide what runs, not an agent." />
      {!data.defined ? (
        <NotRecorded
          what={data.agentsDir ? `No agent definitions at ${data.agentsDir}.` : "No agentsDir in config.json."}
          why="Point agentsDir at a folder of agent files that declare a model:, and each role appears here with its model and current work."
        />
      ) : null}
      <div className="row">
        <Tile tone="grey" icon="flow" />
        <div>
          <div className="t">Gates and the loop</div>
          <div className="d">board.mjs, the drift gate and loop.sh decide what runs next. Not an agent.</div>
        </div>
      </div>
      {data.agents.length ? (
        <div className="stack">
          {data.agents.map((a, i) => (
            <div key={a.name} className="row">
              <Tile tone={TILES[i % TILES.length]} icon="bot" />
              <div style={{ minWidth: 0 }}>
                <div className="t">{a.name}</div>
                <div className="d">
                  {a.defined ? "defined" : "seen in the run log only"} · {a.runs} run{a.runs === 1 ? "" : "s"} · {a.tokens == null ? "tokens not recorded" : `${fmtTokens(a.tokens)} tokens`} ·{" "}
                  {a.firstPass ? `${a.firstPass.pct}% first-pass over ${a.firstPass.gated} gated task${a.firstPass.gated === 1 ? "" : "s"} it owns` : "no gated task it owns"} · {a.openTasks} open
                </div>
              </div>
              <span className="r">
                {a.current.map((c) => (
                  <span key={c.id} className="chip run">
                    running <RunLink id={c.id} />
                  </span>
                ))}
                <span className="chip">{a.model ?? "model unknown"}</span>
              </span>
            </div>
          ))}
        </div>
      ) : data.defined ? (
        <div className="nr">No agents defined, and none named in the run log.</div>
      ) : null}
      <p className="ft">Agents are defined in files, not created here. Edit the file in {data.agentsDir ?? "agentsDir"}, not the browser.</p>
    </>
  );
}
