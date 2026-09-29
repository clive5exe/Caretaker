/**
 * The state directory for a repo. The ONE definition: runstore.mjs writes
 * there and re-exports this, readmodel.mjs and skills.mjs read from it, so the
 * writer and the readers cannot drift apart on where runs live.
 *
 * Its own module, importing nothing of ours, because skills.mjs sits under
 * harness.mjs and runstore.mjs imports the harness: taking this from runstore
 * made a cycle, and `runstore.mjs run` deadlocked on it (exit 13).
 */
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export function stateDirFor(root, cfg = {}) {
  return resolve(
    cfg.stateDir ??
      join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "caretaker", basename(resolve(root))),
  );
}
