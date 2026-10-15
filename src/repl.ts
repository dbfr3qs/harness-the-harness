import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.ts";
import type { AgentResult } from "./agent.ts";
import { createAnthropicClient } from "./client.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { createTranscriptLogger } from "./log.ts";
import { createRegistry } from "./registry.ts";
import { createSpinner } from "./spinner.ts";
import { getTimeTool } from "./tools/get_time.ts";
import { createListDirTool } from "./tools/list_dir.ts";
import { createReadFileTool } from "./tools/read_file.ts";
import type { AgentHooks } from "./agent.ts";
import type { Message } from "./types.ts";

const SYSTEM_PROMPT =
  "You are a helpful assistant running in a command-line harness. Answer concisely and accurately.";

const verbose = process.argv.includes("--verbose");

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeHistory(messages: Message[]): string {
  if (messages.length === 0) return "History is empty.";
  const lines = messages.map((m, i) => {
    const kinds = typeof m.content === "string" ? "text" : m.content.map((b) => b.type).join(", ");
    return `  ${i + 1}. ${m.role} [${kinds}]`;
  });
  return `${messages.length} message(s):\n${lines.join("\n")}`;
}

function stopNotice(result: AgentResult, config: Config): string | undefined {
  switch (result.stopReason) {
    case "max_turns":
      return `[stopped: reached MAX_TURNS (${config.maxTurns}) model calls; send another message to let it continue]`;
    case "max_tokens":
      return `[stopped: the response hit MAX_TOKENS (${config.maxTokens}) and was cut off]`;
    case "refusal":
      return "[stopped: the model declined to respond]";
    case "done":
      return undefined;
  }
}

// Adds the user's text to history and returns an undo function for when the model call fails
// before anything else is appended. If history ends in tool results (after max_turns), the text
// joins that message, because two user messages in a row would separate the results from their calls.
function addUserText(messages: Message[], text: string): () => void {
  const last = messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.at(-1)?.type === "tool_result") {
    const blocks = last.content;
    blocks.push({ type: "text", text });
    return () => {
      blocks.pop();
    };
  }
  messages.push({ role: "user", content: text });
  return () => {
    messages.pop();
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const registry = createRegistry([
    getTimeTool,
    createListDirTool(config.workspaceRoot),
    createReadFileTool(config.workspaceRoot),
  ]);
  const transcript = createTranscriptLogger(config.transcriptPath, { secrets: [config.apiKey] });

  // Streamed text arrives in pieces, so track whether the cursor is at the start of a line.
  // The spinner redraws its line with \r, so it must only ever start on an empty line.
  const spinner = createSpinner();
  let atLineStart = true;
  const write = (text: string) => {
    if (text === "") return;
    process.stdout.write(text);
    atLineStart = text.endsWith("\n");
  };
  const endLine = () => {
    if (!atLineStart) write("\n");
  };
  const say = (line: string) => {
    spinner.stop();
    endLine();
    write(`${line}\n`);
  };

  const model = createAnthropicClient(config, {
    onRequest: (body) => {
      transcript.log("request", body);
      endLine();
      spinner.start();
    },
    onRetry: (info) => {
      transcript.log("error", { message: `retrying: ${info.reason}`, ...info });
      spinner.stop();
      endLine();
      console.error(`  [retry ${info.attempt}/${config.maxRetries} in ${info.delayMs} ms: ${info.reason}]`);
      spinner.start();
    },
    onTextDelta: (text) => {
      spinner.stop();
      write(text);
    },
  });
  const hooks: AgentHooks = {
    onResponse: (res) => {
      spinner.stop();
      transcript.log("response", res);
    },
    onToolCall: (call) => {
      transcript.log("tool_call", { id: call.id, name: call.name, input: call.input });
      if (verbose) say(`  → ${call.name} ${JSON.stringify(call.input)}`);
    },
    onToolResult: (call, outcome) => {
      transcript.log("tool_result", { tool_use_id: call.id, name: call.name, ...outcome });
      if (verbose) say(`  ← ${outcome.isError ? "error" : "ok"}: ${oneLine(outcome.content)}`);
    },
  };
  const messages: Message[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // With piped input, stdin can hit EOF (closing readline) while buffered lines are still being processed.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };
  rl.on("SIGINT", () => {
    spinner.stop();
    console.log("\nBye.");
    rl.close();
    void transcript.flush().finally(() => process.exit(0));
  });

  console.log(
    `harness · ${config.model} · ${registry.definitions().length} tool(s) · ${config.stream ? "streaming" : "non-streaming"} · /exit /reset /history`,
  );
  console.log(`transcript: ${transcript.path}`);
  rl.setPrompt("> ");
  prompt();

  for await (const raw of rl) {
    const input = raw.trim();
    if (input === "") {
      prompt();
      continue;
    }
    if (input === "/exit") break;
    if (input === "/reset") {
      messages.length = 0;
      console.log("History cleared.");
      prompt();
      continue;
    }
    if (input === "/history") {
      console.log(describeHistory(messages));
      prompt();
      continue;
    }

    const undo = addUserText(messages, input);
    const lengthAfterInput = messages.length;
    try {
      const result = await runAgent({
        model,
        registry,
        system: SYSTEM_PROMPT,
        messages,
        maxTurns: config.maxTurns,
        maxToolOutputChars: config.maxToolOutputChars,
        hooks,
      });
      // When streaming, the text has already been printed as it arrived.
      if (!config.stream && result.finalText) say(result.finalText);
      const notice = stopNotice(result, config);
      if (notice) say(notice);
      say(`[tokens: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out · ${result.turns} model call(s)]`);
    } catch (err) {
      // Nothing from the model landed, so take back the user's text and keep history valid.
      if (messages.length === lengthAfterInput) undo();
      const message = err instanceof Error ? err.message : String(err);
      transcript.log("error", { message });
      spinner.stop();
      endLine();
      console.error(`Error: ${message}`);
    }
    prompt();
  }

  rl.close();
  await transcript.flush();
  console.log("Bye.");
}

await main();
