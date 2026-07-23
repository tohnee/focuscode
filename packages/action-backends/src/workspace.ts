import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export class WorkspaceGuard {
  private constructor(
    readonly root: string,
    private readonly realRoot: string,
  ) {}

  static async create(root: string): Promise<WorkspaceGuard> {
    const resolved = resolve(root);
    const stats = await lstat(resolved);
    if (!stats.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    return new WorkspaceGuard(resolved, await realpath(resolved));
  }

  async resolvePath(
    relativePath: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<string> {
    if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) {
      throw new Error(`Path must be a non-empty workspace-relative path: ${relativePath}`);
    }
    const candidate = resolve(this.root, relativePath);
    if (!isWithin(this.root, candidate) || candidate === this.root) {
      throw new Error(`Path escapes the workspace: ${relativePath}`);
    }

    if (await exists(candidate)) {
      const realCandidate = await realpath(candidate);
      if (!isWithin(this.realRoot, realCandidate)) {
        throw new Error(`Symlink resolves outside the workspace: ${relativePath}`);
      }
      return candidate;
    }
    if (!options.allowMissing) throw new Error(`Workspace path does not exist: ${relativePath}`);

    let ancestor = dirname(candidate);
    while (!(await exists(ancestor))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Cannot resolve parent for: ${relativePath}`);
      ancestor = parent;
    }
    const realAncestor = await realpath(ancestor);
    if (!isWithin(this.realRoot, realAncestor)) {
      throw new Error(`Parent symlink resolves outside the workspace: ${relativePath}`);
    }
    return candidate;
  }

  displayPath(absolutePath: string): string {
    return relative(this.root, absolutePath).split(sep).join("/");
  }
}
