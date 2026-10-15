import { readFile, stat } from "node:fs/promises";
import { defineTool } from "../registry.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const MAX_FILE_BYTES = 256 * 1024;

export function createReadFileTool(root: string) {
  return defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace and return its full contents. Use list_dir first if you are unsure of the path. " +
      "Refuses files over 256 KB, binary or non-UTF-8 files, directories, and paths outside the workspace. " +
      "Very long contents may be truncated, with a note saying how much was cut.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
      },
      required: ["path"],
    },
    handler: async (input) => {
      const p = input.path as string;
      const file = await resolveInWorkspace(root, p);
      const info = await stat(file);
      if (info.isDirectory()) throw new Error(`"${p}" is a directory. Use list_dir to see its contents.`);
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `"${p}" is ${(info.size / 1024).toFixed(1)} KB (${info.size} bytes); read_file refuses files over 256 KB.`,
        );
      }
      const bytes = await readFile(file);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`"${p}" is not valid UTF-8 text (it may be a binary file), so it cannot be read.`);
      }
    },
  });
}
