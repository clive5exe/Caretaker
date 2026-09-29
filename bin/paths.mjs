/**
 * Is a path inside a directory? The ONE answer, because four copies of it
 * disagreed and two were wrong (independent review, reproduced):
 *
 *   - `rel.startsWith("..")` counted `<ws>/..state` as OUTSIDE the workspace,
 *     so a state dir there was accepted and a full run archive landed where the
 *     next agent could read it. A parent is `..` as a whole path segment.
 *   - comparing unresolved paths let a symlink into the workspace, or a
 *     workspace given by a symlinked path, through.
 *
 * `real` resolves symlinks through the nearest part of the path that exists,
 * so a directory that has not been created yet is judged by where it WILL be.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function real(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(head.slice(up.length).replace(/^[/\\]/, ""));
    head = up;
  }
  let base = head;
  try {
    base = realpathSync(head);
  } catch {
    /* unreadable: judged as written */
  }
  return tail.length ? join(base, ...tail) : base;
}

/** `p` is `root` itself or anything under it, after resolving symlinks. */
export function within(p, root) {
  const rel = relative(real(root), real(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Strictly under `root`: `within`, and not `root` itself. */
export const under = (p, root) => within(p, root) && real(p) !== real(root);
