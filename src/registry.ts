import type { JsonSchema, ToolDefinition } from "./types.ts";

export interface Tool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function defineTool(tool: Tool): Tool {
  return tool;
}

export function createRegistry(tools: Tool[]) {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match ${NAME_PATTERN}`);
    }
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    byName.set(tool.name, tool);
  }

  function definitions(): ToolDefinition[] {
    return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  // Never throws: every failure becomes an instructive error result for the model.
  async function dispatch(name: string, input: unknown): Promise<ToolOutcome> {
    const tool = byName.get(name);
    if (!tool) {
      const valid = [...byName.keys()].join(", ") || "(none)";
      return fail(`unknown tool "${name}". Valid tools are: ${valid}.`);
    }

    const problem = validateInput(tool, input);
    if (problem) return fail(problem);

    try {
      const content = await tool.handler(input as Record<string, unknown>);
      return { content: String(content), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message.replace(/^Error:\s*/, ""));
    }
  }

  return { definitions, dispatch };
}

export type Registry = ReturnType<typeof createRegistry>;

function fail(message: string): ToolOutcome {
  return { content: `Error: ${message}`, isError: true };
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
