import type { JsonSchema, ToolDefinition } from "./types.ts";

export interface Tool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  signal: AbortSignal; // aborted when the user interrupts the run; long-running tools should stop
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function defineTool(tool: Tool): Tool {
  return tool;
}

export function createRegistry(tools: Tool[]) {
  // Built-ins are locked at construction; `dynamic` holds tools added later at runtime.
  const builtins = new Map<string, Tool>();
  const dynamic = new Map<string, Tool>();
  for (const tool of tools) {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match ${NAME_PATTERN}`);
    }
    if (builtins.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    builtins.set(tool.name, tool);
  }

  const lookup = (name: string): Tool | undefined => builtins.get(name) ?? dynamic.get(name);
  const current = (): Tool[] => [...builtins.values(), ...dynamic.values()];

  function add(tool: Tool): void {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match ${NAME_PATTERN}. Choose a name using only letters, digits, "_" and "-".`);
    }
    if (builtins.has(tool.name)) {
      throw new Error(`Cannot add "${tool.name}": it is a built-in tool and cannot be replaced. Choose a different name.`);
    }
    if (dynamic.has(tool.name)) {
      throw new Error(`Cannot add "${tool.name}": a tool with that name is already loaded. Remove it first or choose a different name.`);
    }
    dynamic.set(tool.name, tool);
  }

  function remove(name: string): void {
    if (builtins.has(name)) {
      throw new Error(`Cannot remove "${name}": it is a built-in tool. Only tools added at runtime can be removed.`);
    }
    dynamic.delete(name);
  }

  const has = (name: string): boolean => lookup(name) !== undefined;

  function definitions(): ToolDefinition[] {
    return current().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  // Never throws: every failure becomes an instructive error result for the model.
  async function dispatch(name: string, input: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolOutcome> {
    const tool = lookup(name);
    if (!tool) {
      const valid = current().map((t) => t.name).join(", ") || "(none)";
      return fail(`unknown tool "${name}". Valid tools are: ${valid}.`);
    }

    // Everything runs inside the try, so a malformed schema or a handler that throws
    // something strange still becomes an error result instead of escaping.
    try {
      const problem = validateInput(tool, input);
      if (problem) return fail(problem);
      const content = await tool.handler(input as Record<string, unknown>, { signal });
      return { content: String(content), isError: false };
    } catch (err) {
      return fail(describeError(err).replace(/^Error:\s*/, ""));
    }
  }

  return { definitions, dispatch, add, remove, has };
}

export type Registry = ReturnType<typeof createRegistry>;

function fail(message: string): ToolOutcome {
  return { content: `Error: ${message}`, isError: true };
}

// Never throws: a thrown value can be anything, including an object whose message getter
// or toString throws.
function describeError(err: unknown): string {
  try {
    const message: unknown = err instanceof Error ? err.message : err;
    return typeof message === "string" ? message : String(message);
  } catch {
    return "the tool failed with an error that could not be described. Try a different approach.";
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInput(tool: Tool, input: unknown): string | undefined {
  const schema = tool.input_schema;
  const props = schema.properties ?? {};

  if (!isPlainObject(input)) {
    const expected = Object.keys(props).join(", ") || "no properties";
    return `input for "${tool.name}" must be a JSON object, got ${describeType(input)}. Expected properties: ${expected}.`;
  }

  // Set by a client when the model's tool input could not be parsed (e.g. cut off mid-stream).
  if (typeof input._invalidJson === "string") {
    const raw = input._invalidJson.length > 200 ? `${input._invalidJson.slice(0, 200)}…` : input._invalidJson;
    return `the input for "${tool.name}" was not valid JSON (it may have been cut off): ${raw}. Call "${tool.name}" again with a complete JSON object.`;
  }

  // Rejected rather than ignored: a model that passes an argument the tool doesn't have
  // (an "offset" to read_file, say) would otherwise be misled by a result that ignored it.
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(props, key));
  if (unknown.length > 0) {
    const valid = Object.keys(props).join(", ") || "none";
    return `unknown key(s) for "${tool.name}": ${unknown.join(", ")}. "${tool.name}" takes only: ${valid}. Call it again without ${unknown.length > 1 ? "them" : "it"}.`;
  }

  const missing = (schema.required ?? []).filter((key) => input[key] === undefined);
  if (missing.length > 0) {
    return `missing required key(s) for "${tool.name}": ${missing.join(", ")}. Call it again with ${missing.length > 1 ? "these keys" : "this key"} set.`;
  }

  for (const [key, prop] of Object.entries(props)) {
    const value = input[key];
    if (value === undefined) continue;
    const typeError = checkPrimitive(key, prop, value);
    if (typeError) return `${typeError} in input for "${tool.name}".`;
  }
  return undefined;
}

function checkPrimitive(key: string, prop: JsonSchema, value: unknown): string | undefined {
  const got = describeType(value);
  switch (prop.type) {
    case "string":
      if (typeof value !== "string") return `"${key}" must be a string, got ${got}`;
      if (prop.enum && !prop.enum.includes(value)) {
        return `"${key}" must be one of ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`;
      }
      return undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : `"${key}" must be a number, got ${got}`;
    case "integer":
      return Number.isInteger(value) ? undefined : `"${key}" must be an integer, got ${got === "number" ? String(value) : got}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `"${key}" must be a boolean, got ${got}`;
    default:
      return undefined; // objects and arrays are left to the handler in v1
  }
}
