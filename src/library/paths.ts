import { homedir } from "node:os";
import { join } from "node:path";

export interface LibraryPaths {
  root: string;
  toolsDir: string;
  skillsDir: string;
  manifestPath: string;
}

// Where the harness's artifact library lives. Pure: resolves paths, does no I/O.
export function libraryPaths(env: NodeJS.ProcessEnv = process.env): LibraryPaths {
  const root = env.HARNESS_LIBRARY_ROOT || join(homedir(), ".harness", "library");
  return {
    root,
    toolsDir: join(root, "tools"),
    skillsDir: join(root, "skills"),
    manifestPath: join(root, "manifest.json"),
  };
}
