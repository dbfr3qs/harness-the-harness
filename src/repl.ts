import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runAgent } from "./agent.ts";
import type { AgentResult } from "./agent.ts";
import { createAnthropicClient, fetchModelLimits, returnsThinkingOnRequest } from "./client.ts";
import type { ModelLimits } from "./client.ts";
import { runMaxTokensCommand } from "./max_tokens_command.ts";
import { contextAfter, contextSummary, describeContext, fullWarning, WARN_AT } from "./context_meter.ts";
import type { ContextReading } from "./context_meter.ts";
import type { ClientHooks } from "./client.ts";
import { COMMANDS } from "./complete.ts";
import type { CompletionState } from "./complete.ts";
import { ConfigError, isProvider, loadConfig, PROVIDERS, providerSettings } from "./config.ts";
import type { Config, Provider } from "./config.ts";
import { runModelCommand, runProviderCommand } from "./model_command.ts";
import type { ModelCommandContext } from "./model_command.ts";
import { createTranscriptLogger } from "./log.ts";
import { createPolicyStore, runPolicyCommand } from "./policy_command.ts";
import { createRegistry, defineTool } from "./registry.ts";
import type { Tool } from "./registry.ts";
import { runDefaultsCommand } from "./defaults_command.ts";
import { DEFAULT_SETTINGS_PATH, formatSettings, loadSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";
import { createScreen } from "./screen.ts";
import { createBatchTerminal, createLineTerminal } from "./terminal.ts";
import type { Terminal } from "./terminal.ts";
import { describeTurns, runTurnsCommand } from "./turns_command.ts";
import { assembleTools } from "./agent_tools.ts";
import type { PrivatePath } from "./tools/private_paths.ts";
import { createWebFetchTool } from "./tools/web_fetch.ts";
import { loadWebPolicy } from "./tools/web_policy.ts";
import { buildSessionState, createSessionStore, loadSession, resumeId, sessionPrivatePaths } from "./session_store.ts";
import type { SessionState } from "./session_store.ts";
import { loadMcpConfig, serversToStart } from "./mcp/config.ts";
import type { McpServerConfig } from "./mcp/config.ts";
import { startMcpServers, startOneServer } from "./mcp/start.ts";
import { libraryPaths } from "./library/paths.ts";
import { loadManifest } from "./library/manifest.ts";
import { createLibrarySession } from "./library/session.ts";
import type { LibrarySession } from "./library/session.ts";
import { createLibraryTools } from "./tools/unattended/library.ts";
import { formatDiff, formatInventory, parseLibraryCommand } from "./library_command.ts";
import type { CompiledPolicy } from "./tools/web_policy.ts";
import type { AgentHooks } from "./agent.ts";
import { addUserText } from "./history.ts";
import type { Message, ToolUseBlock } from "./types.ts";

const SYSTEM_PROMPT =
  "You are a helpful assistant running in a command-line harness. Answer concisely and accurately.";

const verbose = process.argv.includes("--verbose");
// --prompt-file <path> (or PROMPT_FILE) runs one prompt from a file non-interactively and exits:
// batch mode, for running the harness as an agent inside a sandbox. Pair it with --unattended.
function promptFilePath(): string | undefined {
  const i = process.argv.indexOf("--prompt-file");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith("--prompt-file="));
  return eq ? eq.slice("--prompt-file=".length) : process.env.PROMPT_FILE || undefined;
}
// --resume <id> (or HARNESS_RESUME) restores a saved session; may throw ConfigError for a malformed id.
const resumeIdArg = (): string | undefined => resumeId(process.argv, process.env);
// The full-screen layout needs a terminal on both sides; --plain and batch mode ask for a plain one.
const useScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.argv.includes("--plain");
// Commands that only read state, so they can run while the model is working.
const BUSY_OK = new Set(["/context", "/history"]);
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
function usageLine(result: AgentResult, context?: string): string {
  const u = result.usage;
  const cached = u.cache_read_input_tokens ? ` + ${u.cache_read_input_tokens} cached` : "";
  const tools = result.toolCalls ? ` · ${result.toolCalls} tool call(s)` : "";
  return `[tokens: ${u.input_tokens + u.cache_creation_input_tokens} in${cached}, ${u.output_tokens} out · ${result.turns} model call(s)${tools}${context ? ` · ${context}` : ""}]`;
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
      return `[stopped: the response hit max tokens (${config.maxTokens.toLocaleString("en-US")}) and was cut off; raise it with /maxtokens <n> (thinking counts toward it), then send "continue"]`;
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
  // Saved defaults (harness.json): environment variables still win over them.
  const settingsPath = process.env.HARNESS_SETTINGS || DEFAULT_SETTINGS_PATH;
  let savedSettings: Settings;
  let resumed: SessionState | undefined;
  let sessionId: string = randomUUID();
  const sessionsDir = process.env.SESSIONS_DIR || "sessions";
  try {
    savedSettings = await loadSettings(settingsPath);
    config = loadConfig(process.env, savedSettings);
    if (process.argv.includes("--unattended")) config = { ...config, unattended: true };
    const wanted = resumeIdArg();
    if (wanted) {
      resumed = await loadSession(resolve(config.workspaceRoot, sessionsDir), wanted);
      sessionId = wanted;
      const st = resumed.settings;
      if (!isProvider(st.provider)) throw new ConfigError(`session ${wanted} names unknown provider "${st.provider}"`);
      // The session wins over the environment for mode and settings; the key and base URL come from the environment.
      config = {
        ...config,
        ...providerSettings(process.env, st.provider, st.model, savedSettings),
        model: st.model,
        unattended: resumed.unattended,
        showThinking: st.showThinking,
        maxTurns: st.maxTurns === "unlimited" ? Infinity : st.maxTurns,
        maxTokens: st.maxTokens,
        ...(st.contextWindow !== undefined ? { contextWindow: st.contextWindow } : {}),
        transcriptPath: resumed.transcriptPath || config.transcriptPath,
      };
    }
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
    // A resumed session carries its own policy, so a broken file on disk doesn't stop it.
    if (!resumed) {
      console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    webPolicy = undefined;
  }

  let mcpServers: McpServerConfig[];
  try {
    mcpServers = await loadMcpConfig(config.mcpConfigPath, config.mcpConfigRequired);
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Batch mode: read the one prompt now, so a missing file fails before any setup.
  const promptFile = promptFilePath();
  let batchPrompt: string | undefined;
  if (promptFile !== undefined) {
    try {
      batchPrompt = await readFile(promptFile, "utf8");
    } catch (err) {
      console.error(`Config error: could not read --prompt-file ${promptFile}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Tab completes slash commands; the state is filled in once the policy store exists.
  let completionState = (): CompletionState => ({ models: [], policyPatterns: [] });
  const term: Terminal =
    batchPrompt !== undefined
      ? createBatchTerminal(batchPrompt)
      : useScreen
        ? createScreen({ completion: () => completionState() })
        : createLineTerminal({ completion: () => completionState() });

  const transcript = createTranscriptLogger(config.transcriptPath, { secrets: config.secrets });

  // Thinking prints dimmed, after a "✻", with continuation lines indented to match.
  let inThinking = false;
  const showThinking = (text: string) => {
    if (!inThinking) {
      term.endLine();
      term.write(dim("✻ "));
      inThinking = true;
    }
    term.write(dim(text.replace(/\n/g, "\n  ")));
  };
  const endThinking = () => {
    if (!inThinking) return;
    inThinking = false;
    term.endLine();
  };
  const say = (line: string) => {
    endThinking();
    term.endLine();
    term.write(`${line}\n`);
  };

  // What the agent is doing, for the status bar (screen) or the waiting dots (line mode, which
  // only animates while nothing is being printed).
  let currentActivity: string | undefined;
  const activity = (label: string | undefined) => {
    if (label === currentActivity) return;
    currentActivity = label;
    if (term.screen) term.activity(label);
    else term.activity(label === "waiting for the model" ? label : undefined);
  };

  // --- status bar: provider and model, live context, turns, queued messages -----------------
  let contextUsed = 0;
  let contextStale: string | undefined; // set after a switch, until the next response re-measures
  let streamedChars = 0; // text and thinking streamed in the current response, for a live estimate
  let windowNow: number | undefined;
  let turnsThisRun = 0;
  const pendingInput: string[] = []; // sent while busy; delivered at the model's next step
  const showQueued = () =>
    term.notes(pendingInput.map((t) => `↳ for the model's next step: ${oneLine(t, 200)}`));
  const updateStatus = () => {
    if (!term.screen) return;
    const estimate = streamedChars ? Math.ceil(streamedChars / 4) : 0; // ~4 characters per token
    const used = contextUsed + estimate;
    const ctx = messages.length || estimate
      ? contextSummary({ used, window: windowNow, ...(contextStale || estimate ? { stale: "estimate" } : {}) })
      : `context empty${windowNow ? ` (${formatTokensShort(windowNow)} window)` : ""}`;
    const parts = [`${config.provider} / ${config.model}`, ctx];
    if (running) parts.push(`turn ${turnsThisRun}${Number.isFinite(config.maxTurns) ? `/${config.maxTurns}` : ""}`);
    if (pendingInput.length) parts.push(`${pendingInput.length} queued for the next step`);
    if (config.showThinking) parts.push("thinking shown");
    term.status(parts.join(" · "));
  };

  const clientHooks: ClientHooks = {
    onRequest: (body) => {
      transcript.log("request", body);
      endThinking();
      term.endLine();
      streamedChars = 0;
      turnsThisRun++; // the model call starting now
      activity("waiting for the model");
      updateStatus();
    },
    onRetry: (info) => {
      transcript.log("error", { message: `retrying: ${info.reason}`, ...info });
      say(`  [retry ${info.attempt}/${config.maxRetries} in ${info.delayMs} ms: ${info.reason}]`);
      activity(undefined);
      activity("waiting for the model");
    },
    onTextDelta: (text) => {
      endThinking();
      activity("writing");
      term.write(text);
      streamedChars += text.length;
      updateStatus();
    },
    onThinkingDelta: (text) => {
      activity("thinking");
      showThinking(text);
      streamedChars += text.length;
      updateStatus();
    },
  };
  // Replaced when /provider or /model changes the settings.
  let model = createAnthropicClient(config, clientHooks);
  const hooks: AgentHooks = {
    onResponse: (res) => {
      transcript.log("response", res);
      contextUsed = contextAfter(res);
      contextStale = undefined;
      streamedChars = 0;
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
      activity(undefined);
      updateStatus();
    },
    onToolCall: (call) => {
      transcript.log("tool_call", { id: call.id, name: call.name, input: call.input });
      // Always shown, so a run of tool calls with no text in between isn't just a silent wait.
      say(verbose ? `  → ${call.name} ${JSON.stringify(call.input)}` : dim(`  → ${describeCall(call)}`));
      activity(`running ${call.name}`);
    },
    onToolResult: (call, outcome) => {
      transcript.log("tool_result", { tool_use_id: call.id, name: call.name, ...outcome });
      if (verbose) say(`  ← ${outcome.isError ? "error" : "ok"}: ${oneLine(outcome.content)}`);
      else if (outcome.isError) say(dim(`    ✗ ${oneLine(outcome.content.replace(/^Error:\s*/, ""), 100)}`));
    },
    onUserInput: (texts) => {
      transcript.log("session", { deliveredWhileBusy: texts });
      // Shown in the conversation now, between steps, rather than when typed (mid-output).
      for (const t of texts) say(`\x1b[1m> \x1b[0m${t}`);
      say(dim("  (sent to the model at its next step)"));
      showQueued();
      updateStatus();
    },
  };
  // web_fetch asks before every fetch, because a fetched URL can carry workspace data out.
  // "a" approves the host for the rest of the session.
  const approvedHosts = new Map<string, string>(); // host -> origin, so /policy save can keep them as rules
  const confirmFetch = async (url: URL, signal: AbortSignal): Promise<boolean> => {
    if (config.unattended) {
      transcript.log("tool_call", { approval: { url: url.href, answer: "auto", allowed: true } });
      return true; // unattended mode approves every tool; the sandbox is the boundary
    }
    if (approvedHosts.has(url.host)) return true;
    activity("waiting for your approval");
    endThinking();
    const shown = url.href.length > 500 ? `${url.href.slice(0, 500)}… (${url.href.length - 500} more chars)` : url.href;
    const answer = (await term.ask(`  Allow web_fetch of ${shown}?\n  [y]es / [n]o / [a]lways for ${url.host}: `, signal))
      .trim()
      .toLowerCase();
    activity("running web_fetch");
    const allowed = answer === "y" || answer === "yes" || answer === "a" || answer === "always";
    if ((answer === "a" || answer === "always") && !approvedHosts.has(url.host)) approvedHosts.set(url.host, url.origin);
    transcript.log("tool_call", { approval: { url: url.href, answer, allowed } });
    return allowed;
  };

  // Tools of an MCP server marked "interactive" ask before every call in normal mode, since the
  // server can do whatever its program can. "a" approves that tool for the rest of the session.
  const approvedMcpTools = new Set<string>();
  const confirmMcp = async (tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean> => {
    if (approvedMcpTools.has(tool)) return true;
    activity("waiting for your approval");
    endThinking();
    const answer = (await term.ask(`  Allow ${oneLine(`${tool} ${JSON.stringify(input)}`, 300)}?\n  [y]es / [n]o / [a]lways for ${tool}: `, signal))
      .trim()
      .toLowerCase();
    activity(`running ${tool}`);
    const allowed = ["y", "yes", "a", "always"].includes(answer);
    if (answer === "a" || answer === "always") approvedMcpTools.add(tool);
    transcript.log("tool_call", { approval: { tool, answer, allowed } });
    return allowed;
  };

  const policyStore = createPolicyStore(config.webPolicyPath, webPolicy);
  // Restore before createWebFetchTool: the tool description captures the policy.
  if (resumed) {
    const onDisk = webPolicy?.policy ?? { default: "ask", rules: [] };
    policyStore.restore(resumed.webPolicy, !isDeepStrictEqual(JSON.parse(JSON.stringify(onDisk)), JSON.parse(JSON.stringify(resumed.webPolicy))));
  }
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
  // The model's file tools can't read these. No tool can write anything (test/boundaries.test.ts
  // keeps it that way); settings files change only through /defaults and /policy, typed by the user.
  const privatePaths: PrivatePath[] = [
    ...transcriptPrivatePaths(config),
    ...sessionPrivatePaths(resolve(config.workspaceRoot, sessionsDir), config.workspaceRoot),
    { path: resolve(settingsPath), name: settingsPath, holds: "the harness's saved settings" },
    { path: resolve(config.webPolicyPath), name: config.webPolicyPath, holds: "the web_fetch site policy" },
    { path: resolve(config.mcpConfigPath), name: config.mcpConfigPath, holds: "the MCP server config" },
  ];
  // Only servers this mode may start (see serversToStart); API keys never reach them.
  const starting = serversToStart(mcpServers, config.unattended);
  if (starting.length) say(dim(`starting MCP server(s): ${starting.map((s) => s.name).join(", ")}…`));
  // Environment variables that hold a secret (an API key). No MCP server — started now, or later by
  // the model through the library — may see them; model-started servers reuse this exact list.
  const hiddenEnv = Object.keys(process.env).filter((k) => config.secrets.includes(process.env[k] ?? ""));
  const mcp = await startMcpServers(starting, {
    hiddenEnv,
    ...(config.unattended ? {} : { confirm: confirmMcp }),
  });
  for (const w of mcp.warnings) transcript.log("error", { message: w });
  const systemPrompt = SYSTEM_PROMPT + mcp.systemPrompt;

  // The self-extending library: tools, skills and MCP servers the user curated into a manifest, with
  // model tools to add more and REPL commands to review and persist them. Gated entirely on unattended
  // mode — the normal, read-only harness wires none of it (no session, no tools, no baseline loaded).
  const libPaths = libraryPaths();
  let librarySession: LibrarySession | undefined;
  let libraryTools: Tool[] | undefined;
  if (config.unattended) {
    const manifest = await loadManifest(libPaths.manifestPath);
    librarySession = await createLibrarySession({
      paths: libPaths,
      manifest,
      toolDeps: { defineTool, workspaceRoot: config.workspaceRoot, privatePaths },
      // The harness's own registry, so tools the library loads and servers it starts join the live
      // tool set. the library tools run only after `registry` below is created.
      registry: { add: (t) => registry.add(t), remove: (n) => registry.remove(n), has: (n) => registry.has(n) },
      // Same hiddenEnv as the boot-time servers: a model-started server never sees a secret.
      startServer: (server) => startOneServer(server, { hiddenEnv }),
    });
    libraryTools = createLibraryTools(librarySession);
  }

  const registry = createRegistry(
    assembleTools({
      workspaceRoot: config.workspaceRoot,
      privatePaths,
      webFetch,
      unattended: config.unattended,
      mcpTools: mcp.tools,
      ...(libraryTools ? { libraryTools } : {}),
    }),
  );

  // Resume: rebuild the loaded working set and seed the conversation.
  let restoreNote: string | undefined;
  if (resumed?.library && librarySession) {
    const { warnings } = await librarySession.restore(resumed.library);
    for (const w of warnings) transcript.log("error", { message: `session restore: ${w}` });
    if (warnings.length) restoreNote = `[harness note: this session was resumed; some saved library items did not restore: ${warnings.join(" ")}]`;
  }
  const messages: Message[] = resumed ? [...resumed.messages] : [];
  const store = createSessionStore(resolve(config.workspaceRoot, sessionsDir), { secrets: config.secrets });
  let saved = false;
  const saveSession = () => {
    store.save(
      buildSessionState({
        config,
        sessionId,
        ...(resumed ? { createdAt: resumed.createdAt } : {}),
        policy: policyStore.current().policy,
        messages,
        ...(librarySession ? { library: librarySession.snapshot() } : {}),
      }),
    );
    saved = true;
  };
  const resumeLine = () => (saved ? `Resume this session: npm start -- --resume ${sessionId}  (saved to ${store.path(sessionId)})\n` : "");
  const lastModel = new Map<Provider, string>(); // per provider, for /provider switching back

  // The model's limits (context window, most it can write): known, or looked up once per model.
  const limitsCache = new Map<string, Promise<ModelLimits>>();
  const modelLimits = (): Promise<ModelLimits> => {
    const key = `${config.provider}/${config.model}`;
    let limits = limitsCache.get(key);
    if (!limits) {
      const known = PROVIDERS[config.provider].models.find((m) => m.id === config.model);
      limits = known?.contextWindow || known?.maxOutput
        ? Promise.resolve({ contextWindow: known.contextWindow, maxOutput: known.maxOutput })
        : fetchModelLimits(config);
      limitsCache.set(key, limits);
    }
    return limits;
  };
  const contextWindow = async (): Promise<number | undefined> => config.contextWindow ?? (await modelLimits()).contextWindow;
  let maxOutputNow: number | undefined;
  // A max_tokens above what the model can write would make every request fail, so it's lowered.
  const applyLimits = (limits: ModelLimits) => {
    maxOutputNow = limits.maxOutput;
    windowNow = config.contextWindow ?? limits.contextWindow;
    if (limits.maxOutput && config.maxTokens > limits.maxOutput) {
      say(dim(`(max tokens lowered from ${config.maxTokens.toLocaleString("en-US")} to ${limits.maxOutput.toLocaleString("en-US")}, the most ${config.model} can write)`));
      config = { ...config, maxTokens: limits.maxOutput };
      model = createAnthropicClient(config, clientHooks);
    }
    updateStatus();
  };
  const refreshWindow = () => {
    const key = `${config.provider}/${config.model}`;
    void modelLimits().then((limits) => {
      if (key === `${config.provider}/${config.model}`) applyLimits(limits); // unless switched again meanwhile
    });
  };
  refreshWindow();
  const contextReading = async (): Promise<ContextReading> => ({
    used: contextUsed,
    window: await contextWindow(),
    ...(contextStale ? { stale: contextStale } : {}),
  });

  let running: AbortController | undefined; // set while a message is being answered
  let runFinishedAt = 0; // when the last run ended without an interrupt
  let quitArmed = false;
  // On the way out, remind the user of new library installs not yet folded into the saved library:
  // they are lost next session unless persisted with /library.
  const unpersistedLibraryAlert = (): string | undefined => {
    if (!librarySession) return undefined;
    const d = librarySession.diff();
    if (d.added.length === 0) return undefined;
    return "⚠ This session has unpersisted library changes (see /library). They are not saved to the library and will be gone next session.";
  };
  const quit = () => {
    endThinking();
    term.endLine();
    saveSession();
    librarySession?.closeAll();
    const alert = unpersistedLibraryAlert();
    if (alert) term.write(`${alert}\n`);
    term.write("Bye.\n");
    term.write(resumeLine());
    term.close();
    mcp.close();
    void Promise.all([store.flush(), transcript.flush()]).finally(() => process.exit(0));
  };
  // Ctrl+C: during a run, the first press stops the run and a second quits (in case it doesn't
  // stop promptly); at the prompt, it clears typed text, and on an empty line it quits.
  term.onInterrupt(() => {
    if (running) {
      if (running.signal.aborted) return quit();
      running.abort();
      activity(undefined);
      say(dim("  [interrupting… press Ctrl+C again to quit]"));
      return;
    }
    if (term.inputText() !== "") {
      term.setInput("");
      return;
    }
    // A press meant to interrupt can land just after the run finished on its own; don't let
    // that quit. After an interrupt, the next press quits as expected.
    if (!quitArmed && Date.now() - runFinishedAt < QUIT_GRACE_MS) {
      quitArmed = true;
      say(dim("(the run had already finished; press Ctrl+C again to quit)"));
      term.ready();
      return;
    }
    if (!term.screen) term.write("\n");
    quit();
  });

  say(
    `harness · ${config.provider} / ${config.model} · ${registry.definitions().length} tool(s) · ${config.stream ? "streaming" : "non-streaming"} · /exit /reset /history /policy /provider /model /thinking /turns /maxtokens /defaults /context${librarySession ? " /tools /skills /mcp /library" : ""}`,
  );
  say(`transcript: ${transcript.path}`);
  say(
    resumed
      ? `web policy: restored from session (${policyStore.current().policy.rules.length} rule(s), default ${policyStore.current().policy.default})${policyStore.dirty() ? " · differs from the file; /policy save to keep it" : ""}`
      : webPolicy
      ? `web policy: ${config.webPolicyPath} (${webPolicy.policy.rules.length} rule(s), default ${webPolicy.policy.default}) · /policy to view or change`
      : "web policy: none (web_fetch asks before every fetch) · /policy to set one",
  );
  for (const note of mcp.notes) say(note);
  for (const w of mcp.warnings) say(`⚠ ${w}`);
  const skippedServers = mcpServers.length - starting.length;
  if (skippedServers) say(dim(`(${skippedServers} MCP server(s) in ${config.mcpConfigPath} start only with --unattended, or with "interactive": true)`));
  if (term.screen) say(dim("Type while the model works: your message reaches it at its next step. Ctrl+C stops a run."));
  if (config.unattended) {
    say(
      "⚠ UNATTENDED MODE: run_shell and write_file are enabled and every tool is auto-approved, with no confirmation. " +
        "The model can run programs and write files with this process's permissions. Use this only inside an isolated sandbox.",
    );
  }
  if (resumed) say(`resumed session ${sessionId} (${messages.length} message(s))`);
  updateStatus();
  term.ready();

  // Set when /policy changes the policy mid-conversation; the next message carries a note to the model.
  let policyChangedSinceDescription = false;
  let exitWarned = false;
  const autoSend: string[] = []; // messages typed during a run that it ended before delivering

  // While a run is going, what's typed goes here: read-only commands run at once, other
  // commands wait, and anything else is delivered to the model at its next step.
  const onBusyInput = (text: string) => {
    const input = text.trim();
    const command = /^\/[a-z]+(?=\s|$)/i.exec(input)?.[0];
    if (command && COMMANDS.includes(command)) {
      if (BUSY_OK.has(input)) {
        if (input === "/history") say(describeHistory(messages));
        else void contextReading().then((r) => say(describeContext(r, config.model, messages.length)));
      } else {
        say(dim(`${command} can't run while the model is working. Use it when the run finishes, or press Ctrl+C to stop the run.`));
        term.setInput(text);
      }
      return;
    }
    if (command) {
      say(`Unknown command ${command}. Commands: ${COMMANDS.join(" ")} (Tab completes them)`);
      term.setInput(text);
      return;
    }
    pendingInput.push(input);
    showQueued();
    updateStatus();
  };

  // Runs one /tools, /skills, /mcp or /library command against the live session. Only reached in
  // unattended mode, where librarySession is defined. Each toggle/persist is a thin call to it.
  const runLibraryCommand = async (input: string): Promise<void> => {
    const session = librarySession!;
    const action = parseLibraryCommand(input);
    switch (action.type) {
      case "error":
        say(action.message);
        return;
      case "list":
        say(formatInventory(session.inventory().filter((it) => it.kind === action.kind)));
        return;
      case "enable":
      case "disable":
        try {
          say(await session.setEnabled(action.kind, action.name, action.type === "enable"));
        } catch (err) {
          say(`Not changed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      case "persist-review": {
        const d = session.diff();
        say(formatDiff(d));
        if (d.added.length) say("Run /library persist to fold these into the saved library.");
        return;
      }
      case "persist": {
        const d = session.diff();
        if (d.added.length === 0) {
          say("No unpersisted session changes.");
          return;
        }
        say(formatDiff(d));
        const answer = (await term.ask("Persist these changes to the library? [y/n] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          say("Not persisted.");
          return;
        }
        const selection = d.added;
        try {
          await session.persist(selection, libPaths.manifestPath);
          transcript.log("session", { libraryPersisted: selection });
          say(`Persisted ${selection.length} change(s) to ${libPaths.manifestPath}.`);
        } catch (err) {
          say(`Not persisted: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }
  };

  const lines = term.lines()[Symbol.asyncIterator]();
  while (true) {
    let raw: string;
    if (autoSend.length) {
      raw = autoSend.shift()!;
      say(`\x1b[1m> \x1b[0m${raw}`); // typed during the last run, which ended before it could deliver it
    } else {
      const next = await lines.next();
      if (next.done) break;
      raw = next.value;
    }
    const input = raw.trim();
    if (input === "") {
      term.ready();
      continue;
    }
    if (input === "/exit") {
      if (policyStore.dirty() && !exitWarned) {
        exitWarned = true;
        say("The web policy has unsaved changes. Run /policy save to keep them, or /exit again to discard them.");
        term.ready();
        continue;
      }
      break;
    }
    exitWarned = false;
    if (input === "/context") {
      say(describeContext(await contextReading(), config.model, messages.length));
      term.ready();
      continue;
    }
    if (input === "/reset") {
      messages.length = 0;
      contextUsed = 0;
      contextStale = undefined;
      // With no history, the tool description can safely pick up the current policy.
      webFetch.refreshDescription();
      policyChangedSinceDescription = false;
      saveSession();
      say("History cleared.");
      updateStatus();
      term.ready();
      continue;
    }
    if (input === "/policy" || input.startsWith("/policy ")) {
      const result = await runPolicyCommand(input.slice("/policy".length), {
        store: policyStore,
        approvals: approvedHosts,
        ask: (question) => term.ask(question),
      });
      say(result.output);
      if (result.changed) {
        transcript.log("tool_call", { web_policy_changed: { by: "user", policy: policyStore.current().policy } });
        if (messages.length === 0) webFetch.refreshDescription();
        else policyChangedSinceDescription = true;
      }
      term.ready();
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
        settings: savedSettings,
        ...(term.choose ? { choose: term.choose } : {}),
      };
      const result = providerCmd
        ? await runProviderCommand(providerCmd[1] ?? "", ctx)
        : await runModelCommand(modelCmd![1] ?? "", ctx);
      say(result.output);
      if (result.settings) {
        // Providers count tokens differently, and a switch may remove thinking blocks, so the last
        // reading is only approximate until the next response measures it again.
        if (messages.length > 0) {
          const changedProvider = result.settings.provider !== config.provider;
          contextStale = `measured with ${changedProvider ? `${config.provider} / ` : ""}${config.model}${
            changedProvider ? ", and providers count tokens differently" : ""
          }; it updates after the next response`;
        }
        config = { ...config, ...result.settings };
        windowNow = undefined;
        refreshWindow();
        model = createAnthropicClient(config, clientHooks);
        transcript.log("session", {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          ...(result.thinkingRemoved ? { thinkingRemoved: result.thinkingRemoved } : {}),
        });
        updateStatus();
      }
      term.ready();
      continue;
    }
    const defaultsCmd = /^\/defaults(?:\s+(.*))?$/.exec(input);
    if (defaultsCmd) {
      const result = await runDefaultsCommand(defaultsCmd[1] ?? "", {
        env: process.env,
        path: settingsPath,
        saved: savedSettings,
        current: {
          provider: config.provider,
          model: config.model,
          showThinking: config.showThinking,
          maxTurns: config.maxTurns,
          maxTokens: config.maxTokens,
        },
        lastModel,
      });
      if (result.saved) {
        savedSettings = result.saved;
        transcript.log("session", { defaults: formatSettings(savedSettings).trim() });
      }
      say(result.output);
      term.ready();
      continue;
    }
    const maxTokensCmd = /^\/maxtokens(?:\s+(.*))?$/.exec(input);
    if (maxTokensCmd) {
      applyLimits(await modelLimits()); // so the model's ceiling is known and applied
      const result = runMaxTokensCommand(maxTokensCmd[1] ?? "", config.maxTokens, config.model, maxOutputNow);
      if (result.maxTokens !== undefined) {
        config = { ...config, maxTokens: result.maxTokens };
        model = createAnthropicClient(config, clientHooks);
        transcript.log("session", { maxTokens: config.maxTokens });
      }
      say(result.output);
      term.ready();
      continue;
    }
    const turnsCmd = /^\/turns(?:\s+(.*))?$/.exec(input);
    if (turnsCmd) {
      const result = runTurnsCommand(turnsCmd[1] ?? "", config.maxTurns);
      if (result.maxTurns !== undefined) {
        config = { ...config, maxTurns: result.maxTurns };
        transcript.log("session", { maxTurns: describeTurns(config.maxTurns) });
      }
      say(result.output);
      updateStatus();
      term.ready();
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
        say("Usage: /thinking [on|off]");
        term.ready();
        continue;
      }
      say(describeThinking(config));
      updateStatus();
      term.ready();
      continue;
    }
    if (input === "/history") {
      say(describeHistory(messages));
      term.ready();
      continue;
    }
    // The library commands exist only when the library is wired (unattended mode); in normal mode
    // they fall through to the unknown-command guard below, so nothing library-related is offered.
    if (librarySession && /^\/(tools|skills|mcp|library)(?=\s|$)/.test(input)) {
      await runLibraryCommand(input);
      term.ready();
      continue;
    }

    // A mistyped command shouldn't go to the model as a message. Paths like /etc/hosts still do.
    const unknown = /^\/[a-z]+(?=\s|$)/i.exec(input);
    if (unknown && !COMMANDS.includes(unknown[0])) {
      say(`Unknown command ${unknown[0]}. Commands: ${COMMANDS.join(" ")} (Tab completes them)`);
      term.ready();
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
    const restoreNoteAdded = restoreNote !== undefined;
    if (restoreNote !== undefined) {
      text += `\n\n${restoreNote}`;
      restoreNote = undefined;
    }
    const undo = addUserText(messages, text);
    const lengthAfterInput = messages.length;
    const delivered: string[] = []; // messages typed during this run that reached the model
    let takenBack = false; // the message was removed again: nothing came back for it
    let backToInput = false; // put undelivered (or taken-back) messages back in the input box
    running = new AbortController();
    turnsThisRun = 0;
    term.onBusyInput = term.screen ? onBusyInput : undefined;
    updateStatus();
    try {
      const result = await runAgent({
        model,
        registry,
        system: systemPrompt,
        messages,
        maxTurns: config.maxTurns,
        maxToolOutputChars: config.maxToolOutputChars,
        hooks,
        signal: running.signal,
        // In unattended/batch runs there's no user to resume a cut-off reply, so continue it
        // automatically rather than ending the run at a max_tokens stop.
        continueOnMaxTokens: config.unattended,
        takeUserInput: () => {
          const texts = pendingInput.splice(0);
          delivered.push(...texts);
          return texts;
        },
      });
      if (result.stopReason === "interrupted") {
        transcript.log("session", { interrupted: true, turns: result.turns, toolCalls: result.toolCalls });
        backToInput = true;
        // Interrupted before any reply landed: take the message back, as after an error.
        if (messages.length === lengthAfterInput) {
          undo();
          takenBack = true;
          if (noteAdded) policyChangedSinceDescription = true;
          if (restoreNoteAdded) restoreNote = text.slice(text.lastIndexOf("[harness note: this session was resumed"));
        } else {
          delivered.length = 0; // they're in the conversation
        }
      } else {
        delivered.length = 0;
      }
      // When streaming, the text has already been printed as it arrived.
      if (!config.stream && result.finalText && result.stopReason !== "interrupted") say(result.finalText);
      const notice = stopNotice(result, config);
      if (notice) say(notice);
      const reading = await contextReading();
      say(usageLine(result, messages.length ? contextSummary(reading) : undefined));
      if (reading.window && reading.used / reading.window >= WARN_AT) say(fullWarning(reading.used / reading.window));
    } catch (err) {
      // Nothing from the model landed, so take back the user's text and keep history valid.
      if (messages.length === lengthAfterInput) {
        undo();
        takenBack = true;
        if (noteAdded) policyChangedSinceDescription = true; // resend the note with the next message
        if (restoreNoteAdded) restoreNote = text.slice(text.lastIndexOf("[harness note: this session was resumed"));
      } else {
        delivered.length = 0;
      }
      backToInput = true;
      const message = err instanceof Error ? err.message : String(err);
      transcript.log("error", { message });
      say(`Error: ${message}`);
    } finally {
      if (!running.signal.aborted) runFinishedAt = Date.now();
      running = undefined;
      quitArmed = false;
      term.onBusyInput = undefined;
      streamedChars = 0; // an interrupted response leaves no estimate behind
      activity(undefined);
    }
    saveSession(); // the run is over and history is well-formed again
    // Messages typed while the run was going that it didn't get to: sent next, unless the run
    // was stopped or failed, in which case they go back in the input box to send or change.
    // A message that got no reply goes back in the box too (screen only: line mode can't edit it).
    const leftover = [...(takenBack && term.screen ? [input] : []), ...delivered, ...pendingInput.splice(0)];
    showQueued();
    if (leftover.length) {
      if (backToInput) {
        term.setInput([leftover.join("\n"), term.inputText()].filter(Boolean).join("\n"));
        say(dim("(your message is back in the input box: Enter sends it again)"));
      } else {
        autoSend.push(leftover.join("\n\n"));
      }
    }
    updateStatus();
    term.ready();
  }

  saveSession();
  librarySession?.closeAll();
  const exitAlert = unpersistedLibraryAlert();
  if (exitAlert) say(exitAlert);
  term.close();
  mcp.close();
  await Promise.all([store.flush(), transcript.flush()]);
  console.log("Bye.");
  if (saved) console.log(resumeLine().trimEnd());
}

function formatTokensShort(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

await main();
