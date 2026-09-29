/**
 * The text a transcript holds, in order, whatever the adapter.
 *
 * A transcript line that is JSON is read as the strings it holds, whatever
 * the field names, so no vendor's output shape is known here. A reply that IS
 * a marker line (`VERDICT:`, `DECISION:`) then starts a line, as those rules
 * require, instead of sitting after `"content":"`. Any other line is read with
 * `\n` escapes unfolded. Both are properties of JSON, not of any vendor.
 */
export function transcriptTexts(raw) {
  const texts = [];
  const walk = (v) => {
    if (typeof v === "string") texts.push(v);
    else if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  // Consecutive plain lines stay ONE text, so a multi-line block (a fenced
  // diff) is still a block; a JSON line ends it.
  let plain = [];
  const flush = () => {
    if (plain.length) texts.push(plain.join("\n"));
    plain = [];
  };
  for (const line of String(raw ?? "").split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") {
        flush();
        walk(v);
        continue;
      }
    } catch {}
    plain.push(line.replace(/\\n/g, "\n"));
  }
  flush();
  return texts;
}
