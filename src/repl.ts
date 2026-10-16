import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.ts";
import type { AgentResult } from "./agent.ts";
import { createAnthropicClient, returnsThinkingOnRequest } from "./client.ts";
import type { ClientHooks } from "./client.ts";
import { COMMANDS, completeSlashCommand } from "./complete.ts";
import type { CompletionState } from "./complete.ts";
import { ConfigError, loadConfig, PROVIDERS } from "./config.ts";
import type { Config, Provider } from "./config.ts";
import { selectFromMenu } from "./menu.ts";
import { runModelCommand, runProviderCommand } from "./model_command.ts";
import type { ModelCommandContext } from "./model_command.ts";
import { createTranscriptLogger } from "./log.ts";
import { createPolicyStore, runPolicyCommand } from "./policy_command.ts";
import { createRegistry } from "./registry.ts";
import { createSpinner } from "./spinner.ts";
import { describeTurns, runTurnsCommand } from "./turns_command.ts";
import { getTimeTool } from "./tools/get_time.ts";
import { createListDirTool } from "./tools/list_dir.ts";
import type { PrivatePath } from "./tools/private_paths.ts";
import { createReadFileTool } from "./tools/read_file.ts";
import { createWebFetchTool } from "./tools/web_fetch.ts";
import { loadWebPolicy } from "./tools/web_policy.ts";
import type { CompiledPolicy } from "./tools/web_policy.ts";
import type { AgentHooks } from "./agent.ts";
import type { Message, ToolUseBlock } from "./types.ts";

const SYSTEM_PROMPT =
  "You are a helpful assistant running in a command-line harness. Answer concisely and accurately.";

const verbose = process.argv.includes("--verbose");
const QUIT_GRACE_MS = 1500;
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// "read_file .git/config", "web_fetch https://x.test offset=8000": the call at a glance.
function describeCall(call: ToolUseBlock): string {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const parts = Object.entries(input).map(([key, value]) =>
    (key === "path" || key === "url") && typeof value === "string" ? value : `${key}=${JSON.stringify(value)}`,
  );
  return oneLine([call.name, ...parts].join(" "), 100);
}

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

// Cached input is reported separately by the API; it still counts as input the model read.
function usageLine(result: AgentResult): string {
  const u = result.usage;
  const cached = u.cache_read_input_tokens ? ` + ${u.cache_read_input_tokens} cached` : "";
  const tools = result.toolCalls ? ` · ${result.toolCalls} tool call(s)` : "";
  return `[tokens: ${u.input_tokens + u.cache_creation_input_tokens} in${cached}, ${u.output_tokens} out · ${result.turns} model call(s)${tools}]`;
}

function describeThinking(config: Config): string {
  if (!config.showThinking) return "Thinking: hidden. /thinking on to show it.";
  const what =
    config.provider === "deepseek"
      ? "DeepSeek returns its thinking as written."
      : returnsThinkingOnRequest(config.provider, config.model)
        ? `${config.model} will return a summary of its thinking (Claude never returns the raw reasoning).`
        : `${config.model} only thinks when thinking is turned on in the request, which the harness doesn't do, so there may be nothing to show.`;
  return `Thinking: shown, dimmed, as it arrives. ${what} The model may skip thinking on simple requests.`;
}

function stopNotice(result: AgentResult, config: Config): string | undefined {
  switch (result.stopReason) {
    case "max_turns":
      // The loop only stops here when the last response still had tool calls, so any text so far
      // was commentary along the way, not an answer.
      return `[stopped: reached MAX_TURNS (${describeTurns(config.maxTurns)}) while the model was still calling tools, before it gave an answer. ` +
        "Send another message to let it continue, ask it to summarise what it found, or raise the limit with /turns <n>]";
    case "max_tokens":
      return `[stopped: the response hit MAX_TOKENS (${config.maxTokens}) and was cut off]`;
    case "refusal":
      return "[stopped: the model declined to respond]";
    case "interrupted":
      return result.turns === 0 && result.toolCalls === 0
        ? "[interrupted: nothing was added to the conversation]"
        : "[interrupted: completed steps are kept in the conversation (a partly written reply is not); send a message to continue]";
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

// Transcripts hold whole past conversations, so the model's file tools must not read them:
// otherwise one provider could be handed conversations held with another. If transcripts are
// written straight into the workspace root, only the current file can be singled out.
function transcriptPrivatePaths(config: Config): PrivatePath[] {
  const file = resolve(config.transcriptPath);
  const dir = dirname(file);
  const holds = "conversation transcripts";
  if (dir === resolve(config.workspaceRoot)) return [{ path: file, name: basename(file), holds }];
  const rel = relative(resolve(config.workspaceRoot), dir);
  return [{ path: dir, name: rel && !rel.startsWith("..") && !isAbsolute(rel) ? `${rel}/` : `${dir}/`, holds }];
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

  // Tab completes slash commands; the state is filled in once the policy store exists.
  let completionState = (): CompletionState => ({ models: [], policyPatterns: [] });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => completeSlashCommand(line, completionState()),
  });
  // With piped input, stdin can hit EOF (closing readline) while buffered lines are still being processed.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const transcript = createTranscriptLogger(config.transcriptPath, { secrets: config.secrets });

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
  // Thinking prints dimmed, after a "✻", with continuation lines indented to match.
  let inThinking = false;
  const showThinking = (text: string) => {
    spinner.stop();
    if (!inThinking) {
      endLine();
      write(dim("✻ "));
      inThinking = true;
    }
    write(dim(text.replace(/\n/g, "\n  ")));
  };
  const endThinking = () => {
    if (!inThinking) return;
    inThinking = false;
    endLine();
  };
  const say = (line: string) => {
    spinner.stop();
    endThinking();
    endLine();
    write(`${line}\n`);
  };

  const clientHooks: ClientHooks = {
    onRequest: (body) => {
      transcript.log("request", body);
      endThinking();
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
      endThinking();
      write(text);
    },
    onThinkingDelta: showThinking,
  };
  // Replaced when /provider or /model changes the settings.
  let model = createAnthropicClient(config, clientHooks);
  const hooks: AgentHooks = {
    onResponse: (res) => {
      spinner.stop();
      transcript.log("response", res);
      // Streaming already printed thinking as it arrived; otherwise print it now, before any tool calls.
      if (config.showThinking && !config.stream) {
        for (const block of res.content) {
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            showThinking(block.thinking.trim());
            endThinking();
          }
        }
      }
      endThinking();
    },
    onToolCall: (call) => {
      transcript.log("tool_call", { id: call.id, name: call.name, input: call.input });
      // Always shown, so a run of tool calls with no text in between isn't just a silent wait.
      say(verbose ? `  → ${call.name} ${JSON.stringify(call.input)}` : dim(`  → ${describeCall(call)}`));
    },
    onToolResult: (call, outcome) => {
      transcript.log("tool_result", { tool_use_id: call.id, name: call.name, ...outcome });
      if (verbose) say(`  ← ${outcome.isError ? "error" : "ok"}: ${oneLine(outcome.content)}`);
      else if (outcome.isError) say(dim(`    ✗ ${oneLine(outcome.content.replace(/^Error:\s*/, ""), 100)}`));
    },
  };
  // web_fetch asks before every fetch, because a fetched URL can carry workspace data out.
  // "a" approves the host for the rest of the session.
  const approvedHosts = new Map<string, string>(); // host -> origin, so /policy save can keep them as rules
  const confirmFetch = async (url: URL, signal: AbortSignal): Promise<boolean> => {
    if (approvedHosts.has(url.host)) return true;
    spinner.stop();
    endLine();
    const shown = url.href.length > 500 ? `${url.href.slice(0, 500)}… (${url.href.length - 500} more chars)` : url.href;
    let answer: string;
    try {
      answer = (await rl.question(`  Allow web_fetch of ${shown}?\n  [y]es / [n]o / [a]lways for ${url.host}: `, { signal }))
        .trim()
        .toLowerCase();
    } catch {
      return false; // input closed, or the run was interrupted: treat as declined
    }
    const allowed = answer === "y" || answer === "yes" || answer === "a" || answer === "always";
    if ((answer === "a" || answer === "always") && !approvedHosts.has(url.host)) approvedHosts.set(url.host, url.origin);
    transcript.log("tool_call", { approval: { url: url.href, answer, allowed } });
    return allowed;
  };

  const policyStore = createPolicyStore(config.webPolicyPath, webPolicy);
  completionState = () => ({
    models: PROVIDERS[config.provider].models.map((m) => m.id),
    policyPatterns: policyStore.current().policy.rules.map((r) => r.match),
  });
  const webFetch = createWebFetchTool({
    confirm: confirmFetch,
    pageChars: Math.max(500, config.maxToolOutputChars - 500),
    policy: () => policyStore.current(),
    onDecision: ({ url, stage, decision }) =>
      transcript.log("tool_call", { web_policy: { url, stage, action: decision.action, rule: decision.rule?.match ?? "default" } }),
  });
  const privatePaths = transcriptPrivatePaths(config);
  const registry = createRegistry([
    getTimeTool,
    createListDirTool(config.workspaceRoot, privatePaths),
    createReadFileTool(config.workspaceRoot, privatePaths),
    webFetch,
  ]);
  const messages: Message[] = [];
  const lastModel = new Map<Provider, string>(); // per provider, for /provider switching back

  const prompt = () => {
    if (!closed) rl.prompt();
  };
  const quit = () => {
    spinner.stop();
    endThinking();
    endLine();
    console.log("Bye.");
    rl.close();
    void transcript.flush().finally(() => process.exit(0));
  };
  // Ctrl+C: during a run, the first press stops the run and a second quits (in case it doesn't
  // stop promptly); at the prompt, it clears typed text, and on an empty line it quits.
  rl.on("SIGINT", () => {
    if (running) {
      if (running.signal.aborted) return quit();
      running.abort();
      spinner.stop();
      say(dim("  [interrupting… press Ctrl+C again to quit]"));
      return;
    }
    if (rl.line !== "") {
      rl.write(null, { ctrl: true, name: "e" }); // to the end of the line,
      rl.write(null, { ctrl: true, name: "u" }); // then delete back to the start
      return;
    }
    // A press meant to interrupt can land just after the run finished on its own; don't let
    // that quit. After an interrupt, the next press quits as expected.
    if (!quitArmed && Date.now() - runFinishedAt < QUIT_GRACE_MS) {
      quitArmed = true;
      process.stdout.write(`\n${dim("(the run had already finished; press Ctrl+C again to quit)")}\n`);
      prompt();
      return;
    }
    process.stdout.write("\n");
    quit();
  });

  console.log(
    `harness · ${config.provider} / ${config.model} · ${registry.definitions().length} tool(s) · ${config.stream ? "streaming" : "non-streaming"} · /exit /reset /history /policy /provider /model /thinking /turns`,
  );
  console.log(`transcript: ${transcript.path}`);
  console.log(
    webPolicy
      ? `web policy: ${config.webPolicyPath} (${webPolicy.policy.rules.length} rule(s), default ${webPolicy.policy.default}) · /policy to view or change`
      : "web policy: none (web_fetch asks before every fetch) · /policy to set one",
  );
  rl.setPrompt("> ");
  prompt();

  let running: AbortController | undefined; // set while a message is being answered
  let runFinishedAt = 0; // when the last run ended without an interrupt
  let quitArmed = false;
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
    const providerCmd = /^\/provider(?:\s+(.*))?$/.exec(input);
    const modelCmd = /^\/model(?:\s+(.*))?$/.exec(input);
    if (providerCmd || modelCmd) {
      const ctx: ModelCommandContext = {
        env: process.env,
        current: { provider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model },
        messages,
        lastModel,
        ...(process.stdin.isTTY && process.stdout.isTTY
          ? { choose: (title, items, initial) => selectFromMenu(process.stdin, process.stdout, title, items, initial) }
          : {}),
      };
      const result = providerCmd
        ? await runProviderCommand(providerCmd[1] ?? "", ctx)
        : await runModelCommand(modelCmd![1] ?? "", ctx);
      console.log(result.output);
      if (result.settings) {
        config = { ...config, ...result.settings };
        model = createAnthropicClient(config, clientHooks);
        transcript.log("session", {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          ...(result.thinkingRemoved ? { thinkingRemoved: result.thinkingRemoved } : {}),
        });
      }
      prompt();
      continue;
    }
    const turnsCmd = /^\/turns(?:\s+(.*))?$/.exec(input);
    if (turnsCmd) {
      const result = runTurnsCommand(turnsCmd[1] ?? "", config.maxTurns);
      if (result.maxTurns !== undefined) {
        config = { ...config, maxTurns: result.maxTurns };
        transcript.log("session", { maxTurns: describeTurns(config.maxTurns) });
      }
      console.log(result.output);
      prompt();
      continue;
    }
    const thinkingCmd = /^\/thinking(?:\s+(.*))?$/.exec(input);
    if (thinkingCmd) {
      const arg = (thinkingCmd[1] ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        config = { ...config, showThinking: arg === "on" };
        model = createAnthropicClient(config, clientHooks);
        transcript.log("session", { showThinking: config.showThinking });
      } else if (arg !== "") {
        console.log("Usage: /thinking [on|off]");
        prompt();
        continue;
      }
      console.log(describeThinking(config));
      prompt();
      continue;
    }
    if (input === "/history") {
      console.log(describeHistory(messages));
      prompt();
      continue;
    }

    // A mistyped command shouldn't go to the model as a message. Paths like /etc/hosts still do.
    const unknown = /^\/[a-z]+(?=\s|$)/i.exec(input);
    if (unknown && !COMMANDS.includes(unknown[0])) {
      console.log(`Unknown command ${unknown[0]}. Commands: ${COMMANDS.join(" ")} (Tab completes them)`);
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
    running = new AbortController();
    try {
      const result = await runAgent({
        model,
        registry,
        system: SYSTEM_PROMPT,
        messages,
        maxTurns: config.maxTurns,
        maxToolOutputChars: config.maxToolOutputChars,
        hooks,
        signal: running.signal,
      });
      if (result.stopReason === "interrupted") {
        transcript.log("session", { interrupted: true, turns: result.turns, toolCalls: result.toolCalls });
        // Interrupted before any reply landed: take the message back, as after an error.
        if (messages.length === lengthAfterInput) {
          undo();
          if (noteAdded) policyChangedSinceDescription = true;
        }
      }
      // When streaming, the text has already been printed as it arrived.
      if (!config.stream && result.finalText && result.stopReason !== "interrupted") say(result.finalText);
      const notice = stopNotice(result, config);
      if (notice) say(notice);
      say(usageLine(result));
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
    } finally {
      if (!running.signal.aborted) runFinishedAt = Date.now();
      running = undefined;
      quitArmed = false;
    }
    prompt();
  }

  rl.close();
  await transcript.flush();
  console.log("Bye.");
}

await main();
