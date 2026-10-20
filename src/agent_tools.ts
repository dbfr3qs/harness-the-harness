import type { Tool } from "./registry.ts";
import type { PrivatePath } from "./tools/private_paths.ts";
import { getTimeTool } from "./tools/get_time.ts";
import { createListDirTool } from "./tools/list_dir.ts";
import { createReadFileTool } from "./tools/read_file.ts";
import { createRunShellTool } from "./tools/unattended/run_shell.ts";
import { createWriteFileTool } from "./tools/unattended/write_file.ts";

export interface ToolDeps {
  workspaceRoot: string;
  privatePaths: PrivatePath[];
  webFetch: Tool; // built in the REPL, which owns the approval prompt and the site policy
  unattended: boolean; // adds the shell and file-writing tools; only safe inside a sandbox
}

/**
 * The single place that decides which tools the model gets. The read-only tools are always
 * present; run_shell and write_file are added only in unattended mode. Keeping this in one
 * function lets test/boundaries.test.ts prove the normal harness never exposes a tool that can
 * run programs or write files.
 */
export function assembleTools(deps: ToolDeps): Tool[] {
  // In unattended mode run_shell can already read the whole filesystem, so confining the read-only
  // file tools to the workspace adds no safety and only wastes turns — let them reach outside it.
  const confined = !deps.unattended;
  const tools: Tool[] = [
    getTimeTool,
    createListDirTool(deps.workspaceRoot, deps.privatePaths, confined),
    createReadFileTool(deps.workspaceRoot, deps.privatePaths, confined),
    deps.webFetch,
  ];
  if (deps.unattended) {
    tools.push(createRunShellTool(deps.workspaceRoot), createWriteFileTool(deps.workspaceRoot, deps.privatePaths));
  }
  return tools;
}
