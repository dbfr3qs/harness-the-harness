import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// A Model Context Protocol client for servers that speak stdio: one JSON-RPC message per line on
// the server's stdin and stdout, with its stderr kept only for error messages. It does just what
// the harness needs: the handshake, tools/list and tools/call.

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>; // added to the harness's own environment
  cwd?: string;
}

export interface McpConnectOptions {
  startupTimeoutMs?: number; // for the process to start and finish the handshake
  callTimeoutMs?: number; // for one tools/call; past it the call is cancelled and fails
  hiddenEnv?: string[]; // names of variables never passed to the server (API keys)
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpConnection {
  name: string;
  instructions?: string;
  tools: McpToolInfo[];
  /** Never rejects for a failed call (that's an error result); rejects only when interrupted. */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  close(): void;
}

const PROTOCOL_VERSION = "2025-06-18";
const STDERR_LINES = 20;
const seconds = (ms: number) => `${ms / 1000} s`;

class RpcError extends Error {}

export async function connectMcpServer(spec: McpServerSpec, opts: McpConnectOptions): Promise<McpConnection> {
  const startupTimeoutMs = opts.startupTimeoutMs ?? 120_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 600_000;
  const label = `MCP server "${spec.name}"`;

  const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
  for (const key of opts.hiddenEnv ?? []) delete env[key];

  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const stderrTail: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_LINES) stderrTail.shift();
  });

  type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let exited: Error | undefined;

  const write = (msg: object) => {
    if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };
  const fail = (err: Error) => {
    exited ??= err;
    for (const p of pending.values()) p.reject(exited);
    pending.clear();
  };
  const describeExit = (how: string) => {
    const tail = stderrTail.join("\n").trim();
    return new Error(`${label} ${how}${tail ? `. Its last output:\n${tail}` : ""}`);
  };
  child.on("error", (err) => fail(new Error(`${label} could not be started (${spec.command}): ${err.message}`)));
  child.on("exit", (code, sig) => {
    // stderr may still be draining; give it a moment so the error carries the server's last words.
    setTimeout(() => fail(describeExit(`exited (${sig ? `signal ${sig}` : `code ${code}`})`)), 20);
  });
  child.stdin.on("error", () => {}); // a write after exit; the exit handler reports it

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours to interpret, e.g. a stray log line
    }
    if (msg.method !== undefined) {
      // A request from the server. Only ping is answered; the client offers no other capabilities.
      if (msg.id !== undefined) {
        write(msg.method === "ping"
          ? { id: msg.id, result: {} }
          : { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      return; // notifications are ignored
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id as number);
    if (msg.error) p.reject(new RpcError(`${label}: ${msg.error.message ?? "unknown error"}`));
    else p.resolve(msg.result);
  });

  const request = (method: string, params: object, timeoutMs: number, timeoutMessage: string, signal?: AbortSignal): Promise<any> => {
    if (exited) return Promise.reject(exited);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (err: Error) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        write({ method: "notifications/cancelled", params: { requestId: id, reason: err.message } });
        p.reject(err);
      };
      const timer = setTimeout(() => cancel(new Error(timeoutMessage)), timeoutMs);
      const onAbort = () => cancel(new DOMException("interrupted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      pending.set(id, {
        resolve: (r) => (done(), resolve(r)),
        reject: (e) => (done(), reject(e)),
      });
      write({ id, method, params });
    });
  };

  const close = () => {
    fail(new Error(`${label} was closed`));
    child.stdin.end();
    child.kill();
  };

  try {
    const deadline = Date.now() + startupTimeoutMs;
    const startup = (method: string, params: object) =>
      request(method, params, Math.max(1, deadline - Date.now()), `${label} did not start within ${seconds(startupTimeoutMs)}`);
    const init = await startup("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "harness", version: "0.1.0" },
    });
    write({ method: "notifications/initialized" });
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await startup("tools/list", cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);

    return {
      name: spec.name,
      instructions: typeof init.instructions === "string" && init.instructions.trim() ? init.instructions : undefined,
      tools,
      close,
      async callTool(name, args, signal) {
        try {
          const result = await request(
            "tools/call",
            { name, arguments: args },
            callTimeoutMs,
            `no reply from ${label} within ${seconds(callTimeoutMs)}; the call was cancelled`,
            signal,
          );
          return { text: resultText(result), isError: result?.isError === true };
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          return { text: (err as Error).message, isError: true };
        }
      },
    };
  } catch (err) {
    close();
    throw exited && !(err instanceof RpcError) && exited.message !== `${label} was closed` ? exited : err;
  }
}

// MCP results are a list of content parts; the model gets them as one string.
function resultText(result: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type === "text") parts.push(String(c.text));
    else if (c?.type === "image" || c?.type === "audio") {
      const bytes = typeof c.data === "string" ? Math.floor((c.data.replace(/=+$/, "").length * 3) / 4) : 0;
      parts.push(`[${c.mimeType ?? c.type} ${c.type} omitted, ${bytes} bytes]`);
    } else if (c?.type === "resource") {
      parts.push(typeof c.resource?.text === "string" ? c.resource.text : `[binary resource ${c.resource?.uri ?? ""} omitted]`);
    } else if (c?.type === "resource_link") parts.push(`[resource: ${c.uri}]`);
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}
