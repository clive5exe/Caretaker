/**
 * WORKFLOW STEPS — read one step of a Warp workflow so it can be run as
 * written, instead of rewritten (docs/plan.md: Warp's code is copied, never
 * rewritten). `caretaker review` runs Warp's own review steps this way.
 *
 * Not a YAML parser. It reads the shape Warp's workflow files have: jobs at
 * two spaces, `- name:` steps at six, step keys at eight, and `run: |` or
 * `prompt: |` block scalars below them. Anything it cannot find throws by
 * name, so a changed upstream layout fails loudly rather than running half a
 * step.
 */

export class WorkflowStepError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowStepError";
  }
}

const indentOf = (l) => l.length - l.trimStart().length;

/** Lines strictly deeper than `indent`, from `start`, with `indent + 2` stripped. */
function blockBelow(lines, start, indent) {
  const out = [];
  let i = start;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && indentOf(l) <= indent) break;
    out.push(l.slice(indent + 2));
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return { text: `${out.join("\n")}\n`, end: i };
}

/**
 * One step: { run, env, with }, where `run` is the script, `env` and `with`
 * map keys to raw (unevaluated) values, block scalars as their text.
 */
export function readStep(workflowText, job, stepName) {
  const lines = String(workflowText).split("\n");
  const jobAt = lines.findIndex((l) => l === `  ${job}:`);
  if (jobAt === -1) throw new WorkflowStepError(`no job "${job}" in the workflow`);
  let jobEnd = lines.findIndex((l, i) => i > jobAt && /^ {2}\S/.test(l));
  if (jobEnd === -1) jobEnd = lines.length;
  const stepAt = lines.findIndex((l, i) => i > jobAt && i < jobEnd && l === `      - name: ${stepName}`);
  if (stepAt === -1) throw new WorkflowStepError(`no step "${stepName}" in job "${job}"`);
  let stepEnd = lines.findIndex((l, i) => i > stepAt && l.trim() && indentOf(l) <= 6);
  if (stepEnd === -1 || stepEnd > jobEnd) stepEnd = jobEnd;

  const step = { run: null, env: {}, with: {} };
  for (let i = stepAt + 1; i < stepEnd; i++) {
    const l = lines[i];
    if (indentOf(l) !== 8 || !l.trim()) continue;
    const m = /^ {8}([a-z_-]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === "run") {
      if (rest !== "|") step.run = `${rest}\n`;
      else step.run = blockBelow(lines, i + 1, 8).text;
    } else if (key === "env" || key === "with") {
      const map = step[key];
      let j = i + 1;
      while (j < stepEnd && (!lines[j].trim() || indentOf(lines[j]) > 8)) {
        const e = /^ {10}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[j]);
        if (e) {
          if (e[2] === "|") {
            const b = blockBelow(lines, j + 1, 10);
            map[e[1]] = b.text;
            j = b.end;
            continue;
          }
          map[e[1]] = e[2].replace(/^"(.*)"$/, "$1");
        }
        j += 1;
      }
    }
  }
  return step;
}

/**
 * `${{ ... }}` filled from `ctx` (dotted names). Supports what Warp's steps
 * use: a name, a quoted string, and `a || b`. An unknown name throws: a
 * silently empty SHA or PR number would make Warp's own checks meaningless.
 */
export function evaluate(text, ctx) {
  return String(text).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    for (const part of expr.split("||").map((s) => s.trim())) {
      const lit = /^'(.*)'$/.exec(part);
      if (lit) {
        if (lit[1]) return lit[1];
        continue;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(part)) throw new WorkflowStepError(`cannot evaluate \${{ ${expr} }}`);
      if (!(part in ctx)) throw new WorkflowStepError(`\${{ ${part} }} has no value here`);
      if (ctx[part] !== "" && ctx[part] !== null && ctx[part] !== undefined) return String(ctx[part]);
    }
    return "";
  });
}

/** $GITHUB_OUTPUT's text as an object: `k=v` lines and `k<<DELIM ... DELIM` blocks. */
export function parseGithubOutput(text) {
  const out = {};
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const body = [];
      for (i += 1; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]);
      out[heredoc[1]] = body.join("\n");
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(lines[i]);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}
