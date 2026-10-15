import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.ts";
import type { AgentResult } from "./agent.ts";
import { createAnthropicClient } from "./client.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { createTranscriptLogger } from "./log.ts";
import { createPolicyStore, runPolicyCommand } from "./policy_command.ts";
import { createRegistry } from "./registry.ts";
import { createSpinner } from "./spinner.ts";
import { getTimeTool } from "./tools/get_time.ts";
import { createListDirTool } from "./tools/list_dir.ts";
import { createReadFileTool } from "./tools/read_file.ts";
import { createWebFetchTool } from "./tools/web_fetch.ts";
import { loadWebPolicy } from "./tools/web_policy.ts";
import type { CompiledPolicy } from "./tools/web_policy.ts";
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

  // A policy file that exists but is broken stops startup, rather than running without a policy.
  let webPolicy: CompiledPolicy | undefined;
  try {
    webPolicy = await loadWebPolicy(config.webPolicyPath, config.webPolicyRequired);
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // With piped input, stdin can hit EOF (closing readline) while buffered lines are still being processed.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

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
  // web_fetch asks before every fetch, because a fetched URL can carry workspace data out.
  // "a" approves the host for the rest of the session.
  const approvedHosts = new Map<string, string>(); // host -> origin, so /policy save can keep them as rules
  const confirmFetch = async (url: URL): Promise<boolean> => {
    if (approvedHosts.has(url.host)) return true;
    spinner.stop();
    endLine();
    const shown = url.href.length > 500 ? `${url.href.slice(0, 500)}… (${url.href.length - 500} more chars)` : url.href;
    let answer: string;
    try {
      answer = (await rl.question(`  Allow web_fetch of ${shown}?\n  [y]es / [n]o / [a]lways for ${url.host}: `)).trim().toLowerCase();
    } catch {
      return false; // input closed: treat as declined
    }
    const allowed = answer === "y" || answer === "yes" || answer === "a" || answer === "always";
    if ((answer === "a" || answer === "always") && !approvedHosts.has(url.host)) approvedHosts.set(url.host, url.origin);
    transcript.log("tool_call", { approval: { url: url.href, answer, allowed } });
    return allowed;
  };

  const policyStore = createPolicyStore(config.webPolicyPath, webPolicy);
  const webFetch = createWebFetchTool({
    confirm: confirmFetch,
    pageChars: Math.max(500, config.maxToolOutputChars - 500),
    policy: () => policyStore.current(),
    onDecision: ({ url, stage, decision }) =>
      transcript.log("tool_call", { web_policy: { url, stage, action: decision.action, rule: decision.rule?.match ?? "default" } }),
  });
  const registry = createRegistry([
    getTimeTool,
    createListDirTool(config.workspaceRoot),
    createReadFileTool(config.workspaceRoot),
    webFetch,
  ]);
  const messages: Message[] = [];

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
    `harness · ${config.model} · ${registry.definitions().length} tool(s) · ${config.stream ? "streaming" : "non-streaming"} · /exit /reset /history /policy`,
  );
  console.log(`transcript: ${transcript.path}`);
  console.log(
    webPolicy
      ? `web policy: ${config.webPolicyPath} (${webPolicy.policy.rules.length} rule(s), default ${webPolicy.policy.default}) · /policy to view or change`
      : "web policy: none (web_fetch asks before every fetch) · /policy to set one",
  );
  rl.setPrompt("> ");
  prompt();

  // Set when /policy changes the policy mid-conversation; the next message carries a note to the model.
  let policyChangedSinceDescription = false;
  let exitWarned = false;

  for await (const raw of rl) {
    const input = raw.trim();
    if (input === "") {
      prompt();
      continue;
    }
    if (input === "/exit") {
      if (policyStore.dirty() && !exitWarned) {
        exitWarned = true;
        console.log("The web policy has unsaved changes. Run /policy save to keep them, or /exit again to discard them.");
        prompt();
        continue;
      }
      break;
    }
    exitWarned = false;
    if (input === "/reset") {
      messages.length = 0;
      // With no history, the tool description can safely pick up the current policy.
      webFetch.refreshDescription();
      policyChangedSinceDescription = false;
      console.log("History cleared.");
      prompt();
      continue;
    }
    if (input === "/policy" || input.startsWith("/policy ")) {
      const result = await runPolicyCommand(input.slice("/policy".length), {
        store: policyStore,
        approvals: approvedHosts,
        ask: async (question) => {
          try {
            return await rl.question(question);
          } catch {
            return "";
          }
        },
      });
      console.log(result.output);
      if (result.changed) {
        transcript.log("tool_call", { web_policy_changed: { by: "user", policy: policyStore.current().policy } });
        if (messages.length === 0) webFetch.refreshDescription();
        else policyChangedSinceDescription = true;
      }
      prompt();
      continue;
    }
    if (input === "/history") {
      console.log(describeHistory(messages));
      prompt();
      continue;
    }

    webFetch.newMessage();
    let text = input;
    const noteAdded = policyChangedSinceDescription;
    if (noteAdded) {
      // Appended to history rather than editing the tool definitions, which would rewrite the prompt's start.
      const summary = policyStore.current().policy.rules.length || policyStore.current().policy.default !== "ask"
        ? policyStore.current().summary()
        : "the user must approve each fetch";
      text += `\n\n[harness note: the user changed the web_fetch site policy. It now reads: ${summary}. This replaces the policy in the web_fetch tool description.]`;
      policyChangedSinceDescription = false;
    }
    const undo = addUserText(messages, text);
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
      if (messages.length === lengthAfterInput) {
        undo();
        if (noteAdded) policyChangedSinceDescription = true; // resend the note with the next message
      }
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
