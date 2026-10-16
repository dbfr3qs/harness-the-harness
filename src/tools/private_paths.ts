import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** A file or directory the file tools must not read or list. */
export interface PrivatePath {
  path: string; // relative to the workspace root, or absolute
  name: string; // how to refer to it, e.g. "transcripts/"
  holds: string; // what it holds, so the model understands why
}

/**
 * Decides whether a path is private: any `.git` directory (repository internals), or anything at
 * or inside one of `extra` (such as the transcript directory, which holds past conversations).
 * Callers check both the path as given and its real path, so a symlink can't get around it.
 */
export function createPrivacyCheck(root: string, extra: PrivatePath[] = []) {
  // Bases to compare against: the root and each extra path, both as given and as real paths,
  // since callers pass either. A path that doesn't exist yet (the transcript directory before
  // the first write) has no real path and is compared as given.
  let bases: Promise<{ roots: string[]; extras: (PrivatePath & { abs: string[] })[] }> | undefined;
  const both = async (p: string) => [...new Set([p, await realpath(p).catch(() => p)])];
  const load = () =>
    (bases ??= (async () => ({
      roots: await both(resolve(root)),
      extras: await Promise.all(extra.map(async (e) => ({ ...e, abs: await both(resolve(root, e.path)) }))),
    }))());

  /** Why `absPath` is private, as text for the model, or undefined if it isn't. */
  async function reason(absPath: string): Promise<string | undefined> {
    const { roots, extras } = await load();
    for (const e of extras) {
      if (e.abs.some((base) => within(base, absPath))) return `${e.name}, which holds ${e.holds}`;
    }
    for (const r of roots) {
      if (!within(r, absPath)) continue;
      const parts = relative(r, absPath).split(sep);
      const git = parts.findIndex((part) => part.toLowerCase() === ".git");
      if (git >= 0) return `${[...parts.slice(0, git + 1)].join("/")}/, which holds the repository's internal data`;
    }
    return undefined;
  }

  return { reason };
}

export type PrivacyCheck = ReturnType<typeof createPrivacyCheck>;

function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
