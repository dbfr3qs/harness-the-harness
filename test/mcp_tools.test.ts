import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/registry.ts";
import type { McpConnection, McpToolInfo } from "../src/mcp/client.ts";
import { createMcpTools } from "../src/mcp/tools.ts";

const schema = (props: Record<string, unknown> = {}) => ({ type: "object" as const, properties: props, additionalProperties: false });

function fakeConnection(tools: McpToolInfo[], calls: unknown[] = []): McpConnection {
  return {
    name: "rea",
    tools,
    close: () => {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name === "broken" ? { text: "no binary is open", isError: true } : { text: `ran ${name}`, isError: false };
    },
  };
}

const TOOLS: McpToolInfo[] = [
  { name: "open_binary", description: "Open a binary.", inputSchema: schema({ path: { $ref: "#/$defs/p" } }) },
  { name: "procedure_info", description: "Info.", inputSchema: schema() },
  { name: "procedure_callers", description: "Callers.", inputSchema: schema() },
  { name: "install_adb_package", description: "Install an APK.", inputSchema: schema() },
  { name: "broken", inputSchema: schema() },
];

test("exposes each tool as <server>__<tool> with its schema unchanged", () => {
  const { tools } = createMcpTools(fakeConnection(TOOLS), {});
  assert.deepEqual(tools.map((t) => t.name), ["rea__open_binary", "rea__procedure_info", "rea__procedure_callers", "rea__install_adb_package", "rea__broken"]);
  assert.equal(tools[0]!.description, "Open a binary.");
  assert.deepEqual(tools[0]!.input_schema, TOOLS[0]!.inputSchema);
  assert.equal(tools[4]!.description, "");
});

test("an allowlist keeps exact names and prefix* matches, and reports patterns that matched nothing", () => {
  const { tools, unmatched } = createMcpTools(fakeConnection(TOOLS), { allow: ["open_binary", "procedure_*", "list_strings"] });
  assert.deepEqual(tools.map((t) => t.name), ["rea__open_binary", "rea__procedure_info", "rea__procedure_callers"]);
  assert.deepEqual(unmatched, ["list_strings"]);
});

test("skips a tool whose prefixed name is too long for the API", () => {
  const long = { name: "x".repeat(130), inputSchema: schema() };
  const { tools, skipped } = createMcpTools(fakeConnection([long, TOOLS[1]!]), {});
  assert.deepEqual(tools.map((t) => t.name), ["rea__procedure_info"]);
  assert.deepEqual(skipped, [long.name]);
});

test("a call goes to the server under the tool's own name, through the registry", async () => {
  const calls: unknown[] = [];
  const registry = createRegistry(createMcpTools(fakeConnection(TOOLS, calls), {}).tools);
  assert.deepEqual(await registry.dispatch("rea__open_binary", { path: "/bin/ls" }), { content: "ran open_binary", isError: false });
  assert.deepEqual(calls, [{ name: "open_binary", args: { path: "/bin/ls" } }]);
});

test("the server's error result reaches the model as an error", async () => {
  const registry = createRegistry(createMcpTools(fakeConnection(TOOLS), {}).tools);
  assert.deepEqual(await registry.dispatch("rea__broken", {}), { content: "Error: no binary is open", isError: true });
});

test("with confirm, a declined call never reaches the server", async () => {
  const calls: unknown[] = [];
  const asked: unknown[] = [];
  const { tools } = createMcpTools(fakeConnection(TOOLS, calls), {
    confirm: async (tool, input) => (asked.push({ tool, input }), false),
  });
  const out = await createRegistry(tools).dispatch("rea__procedure_info", {});
  assert.equal(out.isError, true);
  assert.match(out.content, /the user declined to run rea__procedure_info/);
  assert.deepEqual(asked, [{ tool: "rea__procedure_info", input: {} }]);
  assert.deepEqual(calls, []);
});
