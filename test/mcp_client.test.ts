import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "../src/mcp/client.ts";
import type { McpConnection } from "../src/mcp/client.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake_mcp_server.ts", import.meta.url));
const noSignal = () => new AbortController().signal;

const connect = (env: Record<string, string> = {}, opts: { startupTimeoutMs?: number; callTimeoutMs?: number } = {}) =>
  connectMcpServer({ name: "fake", command: process.execPath, args: [FAKE], env }, opts);

async function withServer(fn: (c: McpConnection) => Promise<void>, env: Record<string, string> = {}, opts = {}) {
  const c = await connect(env, opts);
  try {
    await fn(c);
  } finally {
    c.close();
  }
}

test("connects and returns the server's instructions and every page of tools", async () => {
  await withServer(async (c) => {
    assert.equal(c.instructions, "Use echo to repeat things.");
    assert.deepEqual(
      c.tools.map((t) => t.name),
      ["echo", "fail", "slow", "mixed", "structured", "cancelled_ids", "pong_received", "env", "crash"],
    );
    assert.deepEqual(c.tools[0]!.inputSchema.required, ["text"]);
  });
});

test("calls a tool and returns its text", async () => {
  await withServer(async (c) => {
    assert.deepEqual(await c.callTool("echo", { text: "hi" }, noSignal()), { text: "hi", isError: false });
  });
});

test("reports a tool's own error result as an error", async () => {
  await withServer(async (c) => {
    assert.deepEqual(await c.callTool("fail", {}, noSignal()), { text: "the target is not open", isError: true });
  });
});

test("a JSON-RPC error becomes an error result naming the server", async () => {
  await withServer(async (c) => {
    const out = await c.callTool("nope", {}, noSignal());
    assert.equal(out.isError, true);
    assert.match(out.text, /fake.*Unknown tool: nope/);
  });
});

test("joins text content, and describes images and resources rather than dropping them silently", async () => {
  await withServer(async (c) => {
    const { text } = await c.callTool("mixed", {}, noSignal());
    assert.equal(text, "first\n[image/png image omitted, 5 bytes]\nresource text\nlast");
  });
});

test("falls back to structured content when there is no text", async () => {
  await withServer(async (c) => {
    assert.deepEqual(await c.callTool("structured", {}, noSignal()), { text: '{"count":2}', isError: false });
  });
});

test("answers requests the server sends, such as ping", async () => {
  await withServer(async (c) => {
    assert.equal((await c.callTool("pong_received", {}, noSignal())).text, "true");
  });
});

test("an interrupt rejects the call and tells the server to cancel it", async () => {
  await withServer(async (c) => {
    const ac = new AbortController();
    const call = c.callTool("slow", {}, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(call, /interrupted/);
    const ids = JSON.parse((await c.callTool("cancelled_ids", {}, noSignal())).text);
    assert.equal(ids.length, 1);
  });
});

test("a call past the timeout is cancelled with an error saying so", async () => {
  await withServer(
    async (c) => {
      const out = await c.callTool("slow", {}, noSignal());
      assert.equal(out.isError, true);
      assert.match(out.text, /no reply from MCP server "fake" within 0\.1 s/);
      const ids = JSON.parse((await c.callTool("cancelled_ids", {}, noSignal())).text);
      assert.equal(ids.length, 1);
    },
    {},
    { callTimeoutMs: 100 },
  );
});

test("a server that exits mid-call fails the call with its last stderr output", async () => {
  await withServer(async (c) => {
    const out = await c.callTool("crash", {}, noSignal());
    assert.equal(out.isError, true);
    assert.match(out.text, /MCP server "fake" exited \(code 7\).*segfault in the decompiler/s);
    // Later calls fail at once rather than hanging.
    assert.match((await c.callTool("echo", { text: "x" }, noSignal())).text, /exited/);
  });
});

test("a server that exits at startup is reported with its stderr", async () => {
  await assert.rejects(connect({ FAKE_MCP_MODE: "exit-at-start" }), /"fake" exited \(code 3\).*could not find the analysis engine/s);
});

test("a command that doesn't exist is reported clearly", async () => {
  await assert.rejects(
    connectMcpServer({ name: "ghost", command: "/nonexistent/mcp-server", args: [] }, {}),
    /MCP server "ghost".*\/nonexistent\/mcp-server/,
  );
});

test("a server that never finishes the handshake times out", async () => {
  await assert.rejects(connect({ FAKE_MCP_MODE: "silent" }, { startupTimeoutMs: 200 }), /"fake" did not start within 0\.2 s/);
});

test("passes the configured environment to the server", async () => {
  await withServer(
    async (c) => {
      assert.equal((await c.callTool("env", { name: "GHIDRA_INSTALL_DIR" }, noSignal())).text, "/opt/ghidra");
    },
    { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
  );
});

test("withholds environment variables listed as secret", async () => {
  process.env.FAKE_PROVIDER_KEY = "sk-secret";
  try {
    const c = await connectMcpServer(
      { name: "fake", command: process.execPath, args: [FAKE] },
      { hiddenEnv: ["FAKE_PROVIDER_KEY"] },
    );
    try {
      assert.equal((await c.callTool("env", { name: "FAKE_PROVIDER_KEY" }, noSignal())).text, "(unset)");
      assert.notEqual((await c.callTool("env", { name: "PATH" }, noSignal())).text, "(unset)");
    } finally {
      c.close();
    }
  } finally {
    delete process.env.FAKE_PROVIDER_KEY;
  }
});
