import { readdir, stat } from "node:fs/promises";
import { defineTool } from "../registry.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const MAX_ENTRIES = 200;

export function createListDirTool(root: string) {
  return defineTool({
    name: "list_dir",
    description:
      "List the entries of a directory inside the workspace. Use it to discover which files exist before reading them. " +
      `Returns one name per line, sorted, with a trailing "/" on directories; at most ${MAX_ENTRIES} entries are shown, ` +
      "and a note says how many were left out. Paths outside the workspace are refused.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Directory path relative to the workspace root. Defaults to ".".' },
      },
    },
    handler: async (input) => {
      const p = typeof input.path === "string" && input.path !== "" ? input.path : ".";
      const dir = await resolveInWorkspace(root, p);
      if (!(await stat(dir)).isDirectory()) {
        throw new Error(`"${p}" is a file, not a directory. Use read_file to read it.`);
      }
      const entries = (await readdir(dir, { withFileTypes: true }))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      if (entries.length === 0) return "(empty directory)";
      const shown = entries.slice(0, MAX_ENTRIES);
      const hidden = entries.length - shown.length;
      return hidden > 0 ? `${shown.join("\n")}\n[truncated: ${hidden} more entries]` : shown.join("\n");
    },
  });
}
