import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineTool } from "../registry.ts";
import { createPrivacyCheck } from "./private_paths.ts";
import type { PrivatePath } from "./private_paths.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const MAX_ENTRIES = 200;

export function createListDirTool(root: string, privatePaths: PrivatePath[] = []) {
  const privacy = createPrivacyCheck(root, privatePaths);
  return defineTool({
    name: "list_dir",
    description:
      "List the entries of a directory inside the workspace. Use it to discover which files exist before reading them. " +
      `Returns one name per line, sorted, with a trailing "/" on directories; at most ${MAX_ENTRIES} entries are shown, ` +
      "and a note says how many were left out. Private directories (.git and the harness's transcripts) are not listed, " +
      "and paths outside the workspace are refused.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Directory path relative to the workspace root. Defaults to ".".' },
      },
    },
    handler: async (input) => {
      const p = typeof input.path === "string" && input.path !== "" ? input.path : ".";
      const privateRefusal = (why: string) =>
        new Error(`"${p}" is off limits: ${why}. The harness keeps it private, so list_dir will not list it. Do not try other paths to it.`);
      const givenWhy = await privacy.reason(resolve(root, p));
      if (givenWhy) throw privateRefusal(givenWhy);
      const dir = await resolveInWorkspace(root, p);
      const realWhy = await privacy.reason(dir);
      if (realWhy) throw privateRefusal(realWhy);
      if (!(await stat(dir)).isDirectory()) {
        throw new Error(`"${p}" is a file, not a directory. Use read_file to read it.`);
      }
      const entries: string[] = [];
      const kept: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const name = e.isDirectory() ? `${e.name}/` : e.name;
        const full = join(dir, e.name);
        // A symlink is judged by where it points, so a link into .git/ is left out too.
        const target = e.isSymbolicLink() ? await realpath(full).catch(() => full) : full;
        ((await privacy.reason(full)) || (await privacy.reason(target)) ? kept : entries).push(name);
      }
      entries.sort((a, b) => a.localeCompare(b));
      // Say what was left out, so the model doesn't go looking for it.
      const privateNote = kept.length ? `\n[not listed: ${kept.sort().join(", ")} (kept private by the harness)]` : "";
      if (entries.length === 0) return `(empty directory)${privateNote}`;
      const shown = entries.slice(0, MAX_ENTRIES);
      const hidden = entries.length - shown.length;
      return `${shown.join("\n")}${hidden > 0 ? `\n[truncated: ${hidden} more entries]` : ""}${privateNote}`;
    },
  });
}
