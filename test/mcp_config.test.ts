import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, parseMcpConfig, serversToStart } from "../src/mcp/config.ts";

const parse = (json: unknown) => parseMcpConfig(json, "mcp.json");

test("reads servers in Claude Code's mcpServers format", () => {
  const servers = parse({
    mcpServers: {
      rea: {
        type: "stdio",
        command: "npx",
        args: ["-y", "rea-agents@6.4.0", "mcp"],
        env: { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
        tools: ["open_binary", "procedure_*"],
        callTimeoutMs: 3_600_000,
      },
    },
  });
  assert.deepEqual(servers, [
    {
      name: "rea",
      command: "npx",
      args: ["-y", "rea-agents@6.4.0", "mcp"],
      env: { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      tools: ["open_binary", "procedure_*"],
      interactive: false,
      callTimeoutMs: 3_600_000,
    },
  ]);
});

test("args, env and tools are optional", () => {
  assert.deepEqual(parse({ mcpServers: { x: { command: "srv" } } }), [{ name: "x", command: "srv", args: [], interactive: false }]);
});

test("rejects what it can't use, naming the problem", () => {
  const cases: [unknown, RegExp][] = [
    [[], /must be a JSON object/],
    [{ servers: {} }, /unknown key\(s\) "servers"/],
    [{ mcpServers: { x: {} } }, /"mcpServers\.x\.command" must be/],
    [{ mcpServers: { x: { command: "s", type: "http" } } }, /only "stdio" servers/],
    [{ mcpServers: { x: { command: "s", args: [1] } } }, /"mcpServers\.x\.args" must be a list of strings/],
    [{ mcpServers: { x: { command: "s", env: { A: 1 } } } }, /"mcpServers\.x\.env" must map names to strings/],
    [{ mcpServers: { x: { command: "s", tools: [] } } }, /"mcpServers\.x\.tools" must be a non-empty list/],
    [{ mcpServers: { x: { command: "s", interactive: "yes" } } }, /"mcpServers\.x\.interactive" must be true or false/],
    [{ mcpServers: { x: { command: "s", callTimeoutMs: 0 } } }, /"mcpServers\.x\.callTimeoutMs" must be a whole number/],
    [{ mcpServers: { x: { command: "s", cwd: "/x" } } }, /unknown key\(s\) "cwd" in "mcpServers\.x"/],
    [{ mcpServers: { "bad name": { command: "s" } } }, /server name "bad name"/],
  ];
  for (const [json, error] of cases) assert.throws(() => parse(json), error, JSON.stringify(json));
});

test("a missing file means no servers, unless the file was asked for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-"));
  assert.deepEqual(await loadMcpConfig(join(dir, "mcp.json"), false), []);
  await assert.rejects(loadMcpConfig(join(dir, "mcp.json"), true), /could not read/);
});

test("a broken file is an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-"));
  await writeFile(join(dir, "mcp.json"), "{ not json");
  await assert.rejects(loadMcpConfig(join(dir, "mcp.json"), false), /not valid JSON/);
});

test("normal mode starts only servers marked interactive; unattended mode starts them all", () => {
  const servers = parse({ mcpServers: { rea: { command: "a" }, docs: { command: "b", interactive: true } } });
  assert.deepEqual(serversToStart(servers, false).map((s) => s.name), ["docs"]);
  assert.deepEqual(serversToStart(servers, true).map((s) => s.name), ["rea", "docs"]);
});
