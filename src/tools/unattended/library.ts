import { defineTool, type Tool } from "../../registry.ts";
import type { LibrarySession } from "../../library/session.ts";
import type { McpServerConfig } from "../../mcp/config.ts";
import type { ArtifactKind } from "../../library/manifest.ts";

// The model's half of the self-extending library. Each tool is a thin dispatch to one LibrarySession
// method (the session owns all the loading, starting and overlay bookkeeping); these tools only turn
// the model's JSON into a safe call and the result into instructive text. They can load code and
// start servers, so they live under unattended/ and are registered only in unattended mode — see
// src/agent_tools.ts and test/boundaries.test.ts. There is deliberately NO persist tool: folding the
// session's changes into the saved manifest is a human decision made from the REPL.

const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Turn the model's add_mcp_server input into a validated McpServerConfig, or throw a fix-it error. */
function toServerConfig(input: Record<string, unknown>): McpServerConfig {
  const name = input.name;
  if (typeof name !== "string" || !MCP_NAME_PATTERN.test(name)) {
    throw new Error(`"name" must be 1 to 32 letters, digits, "_" or "-" (got ${JSON.stringify(name)}). Pick a short identifier for the server, such as "rea".`);
  }
  const command = input.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new Error(`"command" must be the program that runs the server, such as "npx" or "/usr/bin/rea-server". Give the executable, with arguments in "args".`);
  }
  const config: McpServerConfig = { name, command, args: [], interactive: false };
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === "string")) {
      throw new Error(`"args" must be a list of strings, one command-line argument each (e.g. ["--stdio"]). Leave it out when the command needs no arguments.`);
    }
    config.args = input.args as string[];
  }
  if (input.env !== undefined) {
    const env = input.env;
    const ok = typeof env === "object" && env !== null && !Array.isArray(env) && Object.values(env).every((v) => typeof v === "string");
    if (!ok) throw new Error(`"env" must map variable names to string values (e.g. {"TOKEN": "abc"}). Leave it out when the server needs no extra environment.`);
    config.env = env as Record<string, string>;
  }
  return config;
}

/** The model-facing library tools, each dispatching to `session`. Unattended mode only. */
export function createLibraryTools(session: LibrarySession): Tool[] {
  const reloadTools = defineTool({
    name: "reload_tools",
    description:
      `Rescan the library tools directory (${session.toolsDir}) and load every tool file in it, adding them to the live tool set. ` +
      `Author a tool by writing a .ts file into that directory with run_shell (write_file cannot reach it: it only writes inside the workspace). ` +
      "A tool file there is installed (in the catalog, costing nothing) and loading it puts it in the live tool set. " +
      "Reports which tools loaded and which files failed (with the reason). Call it once after writing or editing a tool file; changing the tool set resets the prompt cache.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const { loaded, failed } = await session.reloadTools();
      const lines: string[] = [];
      lines.push(`Tools directory: ${session.toolsDir} (write tool files here with run_shell).`);
      lines.push(loaded.length ? `Loaded ${loaded.length} tool(s): ${loaded.join(", ")}.` : "No tools loaded.");
      if (failed.length) {
        lines.push(`Failed to load ${failed.length} file(s):`);
        for (const { file, error } of failed) lines.push(`  - ${file}: ${error}`);
      }
      lines.push("These tools are session-only: they vanish when the session ends unless the user persists them to the library.");
      lines.push("Changing the tool set resets the prompt cache, so the next turn re-reads the full context and costs more — reload once you are done writing, not after each edit.");
      return lines.join("\n");
    },
  });

  const addMcpServer = defineTool({
    name: "add_mcp_server",
    description:
      "Install an MCP server in the catalog and load it: start it now and add its tools to the live tool set. Give a short description so list_catalog can show what it is for. Prefer a reputable, existing server (one the user or the wider ecosystem already trusts) over writing your own; " +
      "an MCP server is a program that runs with the harness's privileges. The server's own usage instructions are appended to the result so you can see how to drive its tools. " +
      "Load deliberately and unload it with set_artifact_enabled when done: changing the tool set resets the prompt cache. It lasts only this session unless the user persists it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short identifier for the server (1-32 of letters, digits, _ or -), used to prefix its tool names" },
        command: { type: "string", description: "The program to run, such as \"npx\" or an absolute path" },
        args: { type: "array", description: "Command-line arguments for the program (optional)" },
        env: { type: "object", description: "Extra environment variables for the program, name to string value (optional)" },
        description: { type: "string", description: "A one-line description of what the server is for, shown by list_catalog (optional)" },
      },
      required: ["name", "command"],
    },
    handler: async (input) => {
      const config = toServerConfig(input);
      const description = typeof input.description === "string" && input.description.trim() ? input.description : undefined;
      const { tools, instructions } = await session.addServer(config, description);
      const head = tools.length
        ? `Added MCP server "${config.name}" with ${tools.length} tool(s): ${tools.join(", ")}.`
        : `Added MCP server "${config.name}", but it offered no tools.`;
      const note = "This server is session-only until the user persists it.";
      return instructions ? `${head}\n${note}\n\nServer instructions:\n${instructions}` : `${head}\n${note}`;
    },
  });

  const setArtifactEnabled = defineTool({
    name: "set_artifact_enabled",
    description:
      "Load or unload one installed library artifact (see list_catalog). Installed means it is in the catalog, which costs nothing; loading a tool adds it to the live tool set, " +
      "and loading an MCP server starts it. Unloading removes the tool or stops the server but keeps it installed. For a skill, enabled only controls whether list_catalog shows it. " +
      "Load deliberately and unload when done: changing the tool set resets the prompt cache.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tool", "skill", "mcp"], description: "Which kind of artifact to change" },
        name: { type: "string", description: "The artifact's name" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["kind", "name", "enabled"],
    },
    handler: async (input) => session.setEnabled(input.kind as ArtifactKind, input.name as string, input.enabled as boolean),
  });

  const listCatalog = defineTool({
    name: "list_catalog",
    description:
      "List what is installed in the library catalog: tools and MCP servers (each marked [loaded] in the live tool set or [available] to load with set_artifact_enabled) and skills. " +
      "A skill is a written how-to; read one with use_skill before a task it covers.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const lines: string[] = [];
      for (const row of session.inventory()) {
        const desc = row.description ? `: ${row.description}` : "";
        if (row.kind === "skill") {
          if (row.enabled) lines.push(`skill ${row.name}${desc}`);
        } else {
          lines.push(`${row.kind} ${row.name} [${row.enabled ? "loaded" : "available"}]${desc}`);
        }
      }
      return lines.length ? lines.join("\n") : "No tools, servers, or skills are installed yet.";
    },
  });

  const useSkill = defineTool({
    name: "use_skill",
    description: "Read a skill's instructions (its SKILL.md) by name. Use list_catalog first to see the available names.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name, exactly as list_catalog shows it" } },
      required: ["name"],
    },
    handler: async (input) => {
      const name = input.name as string;
      // Guard traversal here: the skills layer joins this straight onto the skills directory, so a
      // name with a path separator or ".." could reach outside it. A skill name is a plain folder name.
      if (name.includes("/") || name.includes("\\") || name === ".." || name.split(/[\\/]/).includes("..")) {
        throw new Error(`"${name}" is not a skill name: it contains a path separator or "..". Use a plain name as shown by list_catalog, such as "writing".`);
      }
      return session.readSkill(name);
    },
  });

  return [reloadTools, addMcpServer, setArtifactEnabled, listCatalog, useSkill];
}
