import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMcpServers, startOneServer } from "../src/mcp/start.ts";
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

test("startOneServer returns the server's tools, instructions, warnings and a per-server close", async () => {
  const s = await startOneServer(server("one", { tools: ["echo", "missing_tool"] }), { hiddenEnv: [] });
  try {
    assert.equal(s.name, "one");
    assert.deepEqual(s.tools.map((t) => t.name), ["one__echo"]);
    assert.match(s.instructions ?? "", /Use echo to repeat things\./);
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0]!, /"one".*"missing_tool" matched no tool/);
    const out = await s.tools[0]!.handler({ text: "hi" }, { signal: new AbortController().signal });
    assert.match(JSON.stringify(out), /hi/);
  } finally {
    s.close();
  }
});

test("startOneServer keeps hiddenEnv names from the server", async () => {
  process.env.SECRET_FOR_TEST = "sekrit";
  try {
    const s = await startOneServer(server("one", { tools: ["env"] }), { hiddenEnv: ["SECRET_FOR_TEST"] });
    try {
      const out = await s.tools[0]!.handler({ name: "SECRET_FOR_TEST" }, { signal: new AbortController().signal });
      assert.doesNotMatch(JSON.stringify(out), /sekrit/);
      assert.match(JSON.stringify(out), /unset/);
    } finally {
      s.close();
    }
  } finally {
    delete process.env.SECRET_FOR_TEST;
  }
});

test("startOneServer throws an instructive error when the server cannot start", async () => {
  await assert.rejects(
    startOneServer({ name: "nope", command: "/nonexistent/cmd-xyz", args: [], interactive: false }, { hiddenEnv: [] }),
    /nope/,
  );
  await assert.rejects(startOneServer(server("bad", { env: { FAKE_MCP_MODE: "exit-at-start" } }), { hiddenEnv: [] }), /"bad" exited \(code 3\)/);
});
