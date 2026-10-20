import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMcpServers } from "../src/mcp/start.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake_mcp_server.ts", import.meta.url));
const server = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  command: process.execPath,
  args: [FAKE],
  interactive: false,
  ...extra,
});

test("starts each server, keeps going past one that fails, and reports both", async () => {
  const mcp = await startMcpServers(
    [server("good", { tools: ["echo", "fail", "missing_tool"] }), server("bad", { env: { FAKE_MCP_MODE: "exit-at-start" } })],
    { hiddenEnv: [] },
  );
  try {
    assert.deepEqual(mcp.tools.map((t) => t.name), ["good__echo", "good__fail"]);
    assert.equal(mcp.notes.length, 1);
    assert.match(mcp.notes[0]!, /^MCP server "good": 2 tool\(s\), ~\d+ tokens of definitions per request$/);
    assert.equal(mcp.warnings.length, 2);
    assert.match(mcp.warnings[0]!, /"good".*"missing_tool" matched no tool/);
    assert.match(mcp.warnings[1]!, /"bad" exited \(code 3\)/);
  } finally {
    mcp.close();
  }
});

test("adds each server's instructions to the system prompt, saying how its tools are named", async () => {
  const mcp = await startMcpServers([server("rea")], { hiddenEnv: [] });
  try {
    assert.match(mcp.systemPrompt, /MCP server "rea".*rea__<tool>.*\nUse echo to repeat things\./s);
  } finally {
    mcp.close();
  }
});

test("no servers: nothing to add", async () => {
  const mcp = await startMcpServers([], { hiddenEnv: [] });
  assert.deepEqual({ tools: mcp.tools, prompt: mcp.systemPrompt, notes: mcp.notes, warnings: mcp.warnings }, { tools: [], prompt: "", notes: [], warnings: [] });
});

test("asks before each call to an interactive server's tools, but not an unattended one's", async () => {
  const asked: string[] = [];
  const confirm = async (tool: string) => (asked.push(tool), true);
  const mcp = await startMcpServers([server("docs", { interactive: true, tools: ["echo"] }), server("rea", { tools: ["echo"] })], {
    hiddenEnv: [],
    confirm,
  });
  try {
    const signal = new AbortController().signal;
    for (const t of mcp.tools) await t.handler({ text: "x" }, { signal });
    assert.deepEqual(asked, ["docs__echo"]);
  } finally {
    mcp.close();
  }
});
