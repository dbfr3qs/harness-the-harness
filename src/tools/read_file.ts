import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { defineTool } from "../registry.ts";
import { createPrivacyCheck } from "./private_paths.ts";
import type { PrivatePath } from "./private_paths.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const MAX_FILE_BYTES = 256 * 1024;

// .env, .env.local, .env.production, ...: these hold secrets such as ANTHROPIC_API_KEY.
function isEnvFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === ".env" || name.startsWith(".env.");
}

export function createReadFileTool(root: string, privatePaths: PrivatePath[] = [], confined = true) {
  const privacy = createPrivacyCheck(root, privatePaths);
  const scope = confined
    ? "inside the workspace"
    : "anywhere on the filesystem (pass an absolute path, or one relative to the workspace root)";
  return defineTool({
    name: "read_file",
    description:
      `Read a UTF-8 text file ${scope} and return its full contents. Use list_dir first if you are unsure of the path. ` +
      "Refuses files over 256 KB, binary or non-UTF-8 files, directories, .env files (they hold secrets), and private directories (.git and the harness's transcripts). " +
      (confined ? "Paths outside the workspace are refused. " : "") +
      "Very long contents may be truncated, with a note saying how much was cut.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: confined ? "Path relative to the workspace root" : "Absolute path, or one relative to the workspace root" },
      },
      required: ["path"],
    },
    handler: async (input) => {
      const p = input.path as string;
      const envRefusal = `"${p}" is an environment file (.env) that may hold secrets, so read_file will never read it. Do not try other paths to it; ask the user for any value you need.`;
      // Check the path as given and the real path, so a symlink to .env is refused too.
      if (isEnvFile(resolve(root, p))) throw new Error(envRefusal);
      const privateRefusal = (why: string) =>
        new Error(`"${p}" is off limits: ${why}. The harness keeps it private, so read_file will not read it. Do not try other paths to it.`);
      const givenWhy = await privacy.reason(resolve(root, p));
      if (givenWhy) throw privateRefusal(givenWhy);
      const file = await resolveInWorkspace(root, p, confined);
      if (isEnvFile(file)) throw new Error(envRefusal);
      const realWhy = await privacy.reason(file);
      if (realWhy) throw privateRefusal(realWhy);
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
