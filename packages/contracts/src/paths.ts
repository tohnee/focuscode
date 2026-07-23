/**
 * Normalizes a path for policy comparisons: unifies separators, drops "."
 * segments, and collapses ".." segments so variants such as "src/../.env"
 * cannot bypass protected-path matching. Semantics mirror path.posix.normalize
 * for the workspace-relative inputs policy layers receive; a leading ".."
 * that cannot be collapsed is preserved.
 */
export function normalizeRelativePath(path: string): string {
  const unified = path.replaceAll("\\", "/");
  const absolute = unified.startsWith("/");
  const resolved: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = resolved[resolved.length - 1];
      if (last !== undefined && last !== "..") resolved.pop();
      else if (!absolute) resolved.push("..");
      continue;
    }
    resolved.push(segment);
  }
  return (absolute ? "/" : "") + resolved.join("/");
}
