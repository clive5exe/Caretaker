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
  for (const line of String(raw ?? "").split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") {
        walk(v);
        continue;
      }
    } catch {}
    texts.push(line.replace(/\\n/g, "\n"));
  }
  return texts;
}
