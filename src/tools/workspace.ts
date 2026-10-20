import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves `p` against the workspace root and returns its real path. When `confined` (the default),
 * anything landing outside the root is rejected: `..` traversal, absolute paths elsewhere, and
 * symlinks that escape. When `confined` is false — unattended mode, where run_shell can already
 * reach the whole filesystem, so confinement only wastes turns — those geometric checks are
 * dropped and any readable path resolves; the not-found error is kept. Errors are written for the
 * model to read, so they say what to do instead.
 */
export async function resolveInWorkspace(root: string, p: string, confined = true): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const target = resolve(realRoot, p);
  const outside = `path "${p}" is outside the workspace. Use a path relative to the workspace root, such as "." or "src".`;

  if (confined && !isInside(realRoot, target)) throw new Error(outside);

  let real: string;
  try {
    real = await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`"${p}" does not exist. Use list_dir to see which files are available.`);
    }
    throw err;
  }

  if (confined && !isInside(realRoot, real)) throw new Error(outside);
  return real;
}
