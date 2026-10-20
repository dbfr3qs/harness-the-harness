// A minimal MCP server over stdio (newline-delimited JSON-RPC) for test/mcp_client.test.ts.
// FAKE_MCP_MODE changes how it misbehaves: "exit-at-start" exits before answering, "silent"
// never answers initialize.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "";
if (mode === "exit-at-start") {
  process.stderr.write("fake server: could not find the analysis engine\n");
  process.exit(3);
}

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const cancelled: unknown[] = [];
let pongReceived = false;
const PING_ID = "server-ping-1";

const TOOLS = [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Never finishes on its own.", inputSchema: { type: "object", properties: {} } },
  { name: "mixed", description: "Returns text, an image and a resource.", inputSchema: { type: "object", properties: {} } },
  { name: "structured", description: "Returns only structured content.", inputSchema: { type: "object", properties: {} } },
  { name: "cancelled_ids", description: "Request IDs the client has cancelled.", inputSchema: { type: "object", properties: {} } },
  { name: "pong_received", description: "Whether the client answered the server's ping.", inputSchema: { type: "object", properties: {} } },
  { name: "env", description: "Reads an environment variable.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "crash", description: "Exits mid-call.", inputSchema: { type: "object", properties: {} } },
];

function callTool(id: unknown, name: string, args: Record<string, unknown>) {
  const text = (t: string, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], isError } });
  switch (name) {
    case "echo":
      return text(String(args.text));
    case "fail":
      return text("the target is not open", true);
    case "slow":
      return; // never answers
    case "mixed":
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///x.txt", text: "resource text" } },
            { type: "text", text: "last" },
          ],
        },
      });
    case "structured":
      return send({ jsonrpc: "2.0", id, result: { content: [], structuredContent: { count: 2 } } });
    case "cancelled_ids":
      return text(JSON.stringify(cancelled));
    case "pong_received":
      return text(String(pongReceived));
    case "env":
      return text(process.env[String(args.name)] ?? "(unset)");
    case "crash":
      process.stderr.write("fake server: segfault in the decompiler\n");
      process.exit(7);
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === PING_ID && !msg.method) {
    pongReceived = msg.result !== undefined;
    return;
  }
  switch (msg.method) {
    case "initialize":
      if (mode === "silent") return;
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
          instructions: "Use echo to repeat things.",
        },
      });
    case "notifications/initialized":
      // A server may send requests of its own; the client must answer them.
      send({ jsonrpc: "2.0", id: PING_ID, method: "ping" });
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "ready" } });
      return;
    case "tools/list": {
      // Two pages, to exercise nextCursor.
      const page = msg.params?.cursor === "page2" ? TOOLS.slice(4) : TOOLS.slice(0, 4);
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: page, ...(msg.params?.cursor ? {} : { nextCursor: "page2" }) } });
    }
    case "tools/call":
      return callTool(msg.id, msg.params.name, msg.params.arguments ?? {});
    case "notifications/cancelled":
      cancelled.push(msg.params.requestId);
      return;
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
