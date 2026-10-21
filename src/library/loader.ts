import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NAME_PATTERN, type defineTool, type Tool } from "../registry.ts";
import type { PrivatePath } from "../tools/private_paths.ts";

/** What a model-authored tool file's factory receives, so the file needs to import no harness code. */
export interface ToolFactoryDeps {
  defineTool: typeof defineTool;
  workspaceRoot: string;
  privatePaths: PrivatePath[];
}

export type ToolFactory = (deps: ToolFactoryDeps) => Tool;

// A monotonic counter, not Date.now(): two loads within one millisecond must not share a ?v= query.
let loadCounter = 0;

/**
 * Imports a tool file fresh (the query string defeats the module cache, so an edited file is
 * re-read), calls its default-exported factory, and checks the result is a usable Tool.
 */
export async function loadToolFile(file: string, deps: ToolFactoryDeps): Promise<Tool> {
  const mod = await import(pathToFileURL(file).href + "?v=" + ++loadCounter);
  const factory = mod.default;
  if (factory === undefined) {
    throw new Error(`${file} has no default export. Write \`export default (deps) => deps.defineTool({ name, description, input_schema, handler })\`.`);
  }
  if (typeof factory !== "function") {
    throw new Error(`${file}: the default export must be a function (deps) => Tool, but it is ${typeof factory}.`);
  }
  const tool = await factory(deps);
  if (tool === null || typeof tool !== "object") {
    throw new Error(`${file}: the factory must return a tool object (use deps.defineTool({...})), but returned ${tool === null ? "null" : typeof tool}.`);
  }
  const t = tool as Record<string, unknown>;
  if (typeof t.name !== "string") throw new Error(`${file}: the tool needs a string "name".`);
  if (!NAME_PATTERN.test(t.name)) {
    throw new Error(`${file}: invalid tool name "${t.name}": must match ${NAME_PATTERN}. Use only letters, digits, "_" and "-".`);
  }
  if (typeof t.description !== "string") throw new Error(`${file}: the tool needs a string "description".`);
  if (t.input_schema === null || typeof t.input_schema !== "object") throw new Error(`${file}: the tool needs an object "input_schema".`);
  if (typeof t.handler !== "function") throw new Error(`${file}: the tool needs a function "handler".`);
  return tool as Tool;
}

/** Absolute paths of the `.ts` files directly in `dir` (not subdirectories); a missing dir gives []. */
export async function scanToolsDir(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => join(dir, e.name)).sort();
}
