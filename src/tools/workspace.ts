import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves `p` against the workspace root and returns its real path, rejecting anything that
 * lands outside the root: `..` traversal, absolute paths elsewhere, and symlinks that escape.
 * Errors are written for the model to read, so they say what to do instead.
 */
export async function resolveInWorkspace(root: string, p: string): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const target = resolve(realRoot, p);
  const outside = `path "${p}" is outside the workspace. Use a path relative to the workspace root, such as "." or "src".`;

  if (!isInside(realRoot, target)) throw new Error(outside);

  let real: string;
  try {
    real = await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`"${p}" does not exist. Use list_dir to see which files are available.`);
    }
    throw err;
  }

  if (!isInside(realRoot, real)) throw new Error(outside);
  return real;
}
