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
  // The self-extension tools (see src/tools/unattended/library.ts). They can load code and start
  // servers, so like run_shell/write_file they are added only in unattended mode — never in the
  // normal, read-only harness, even if a caller passes them.
  libraryTools?: Tool[];
  mcpTools?: Tool[]; // from the MCP servers this mode may start (see serversToStart in src/mcp/config.ts)
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
    // Only after the shell and file tools, and only when unattended: these are gated the same way,
    // so a normal-mode caller that passes them by mistake still gets a read-only tool set.
    tools.push(...(deps.libraryTools ?? []));
  }
  tools.push(...(deps.mcpTools ?? []));
  return tools;
}
