import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool } from "../../registry.ts";
import { createPrivacyCheck } from "../private_paths.ts";
import type { PrivatePath } from "../private_paths.ts";

// .env, .env.local, ...: these hold secrets such as ANTHROPIC_API_KEY.
function isEnvFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === ".env" || name.startsWith(".env.");
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Creates or overwrites a UTF-8 text file in the workspace. Registered only in unattended mode
 * (see src/agent_tools.ts). It still refuses .env, the harness's settings and its transcripts,
 * and paths outside the workspace; run_shell can reach past those, which is why unattended mode
 * is meant for a sandbox rather than a real machine.
 */
export function createWriteFileTool(root: string, privatePaths: PrivatePath[] = []) {
  const privacy = createPrivacyCheck(root, privatePaths);
  return defineTool({
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the workspace, creating parent directories as needed. " +
      "Use it to save scripts, exploit inputs and notes. Refuses .env files (they hold secrets), the harness's own settings and transcripts, and paths outside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "The file's full new contents" },
      },
      required: ["path", "content"],
    },
    handler: async (input) => {
      const p = input.path as string;
      const content = input.content as string;
      const realRoot = await realpath(resolve(root)).catch(() => resolve(root));
      const abs = resolve(realRoot, p);
      const outside = `path "${p}" is outside the workspace. Use a path relative to the workspace root, such as "exploit.py".`;
      if (!inside(realRoot, abs)) throw new Error(outside);
      if (abs === realRoot) throw new Error(`"${p}" is the workspace root, not a file.`);
      if (isEnvFile(abs)) {
        throw new Error(`"${p}" is an environment file (.env) that may hold secrets, so write_file will never write it.`);
      }
      const why = await privacy.reason(abs);
      if (why) throw new Error(`"${p}" is off limits: ${why}. The harness keeps it private, so write_file will not write it.`);

      // Walk up to the nearest existing ancestor and resolve it, so a symlinked parent can't
      // place the file outside the workspace.
      let ancestor = dirname(abs);
      for (;;) {
        try {
          const real = await realpath(ancestor);
          if (!inside(realRoot, real)) throw new Error(outside);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          const up = dirname(ancestor);
          if (up === ancestor) break;
          ancestor = up;
        }
      }

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return `Wrote ${bytes} byte(s) to ${relative(realRoot, abs) || p}.`;
    },
  });
}
