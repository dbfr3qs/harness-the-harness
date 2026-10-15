import type { Registry, ToolOutcome } from "./registry.ts";
import type { Message, MessageResponse, ModelFn, ToolResultBlock, ToolUseBlock } from "./types.ts";
import { isText, isToolUse } from "./types.ts";

export interface AgentHooks {
  onResponse?: (res: MessageResponse) => void; // usage, logging
  onToolCall?: (call: ToolUseBlock) => void;
  onToolResult?: (call: ToolUseBlock, outcome: ToolOutcome) => void;
}

export type AgentStopReason = "done" | "max_turns" | "max_tokens" | "refusal";

export interface AgentResult {
  finalText: string; // text blocks of the last assistant message, joined
  turns: number;
  stopReason: AgentStopReason;
  usage: { input_tokens: number; output_tokens: number }; // summed across turns
}

const CUT_OFF_MESSAGE =
  "Error: this tool call was not run because your response hit the max_tokens limit and its input may be incomplete. " +
  "Call the tool again with a shorter response.";

export async function runAgent(opts: {
  model: ModelFn;
  registry: Registry;
  system: string;
  messages: Message[]; // mutated in place: the single source of truth
  maxTurns: number;
  maxToolOutputChars: number;
  hooks?: AgentHooks;
}): Promise<AgentResult> {
  const { model, registry, system, messages, maxTurns, maxToolOutputChars, hooks = {} } = opts;
  const tools = registry.definitions();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let turns = 0;

  const finish = (stopReason: AgentStopReason): AgentResult => ({
    finalText: lastAssistantText(messages),
    turns,
    stopReason,
    usage,
  });

  while (turns < maxTurns) {
    const res = await model({ system, messages, tools });
    turns++;
    hooks.onResponse?.(res);
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;

    // Verbatim: never edit, filter or reorder the assistant's content blocks.
    messages.push({ role: "assistant", content: res.content });

    const calls = res.content.filter(isToolUse);
    if (calls.length === 0) {
      if (res.stop_reason === "max_tokens") return finish("max_tokens");
      if (res.stop_reason === "refusal") return finish("refusal");
      return finish("done");
    }

    const cutOff = res.stop_reason === "max_tokens";
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      hooks.onToolCall?.(call);
      const outcome: ToolOutcome = cutOff
        ? { content: CUT_OFF_MESSAGE, isError: true }
        : truncate(await registry.dispatch(call.name, call.input), maxToolOutputChars);
      hooks.onToolResult?.(call, outcome);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    // All results for this turn in one user message, in the order the model gave.
    messages.push({ role: "user", content: results });
  }

  return finish("max_turns");
}

function truncate(outcome: ToolOutcome, max: number): ToolOutcome {
  if (outcome.content.length <= max) return outcome;
  const dropped = outcome.content.length - max;
  return { ...outcome, content: `${outcome.content.slice(0, max)}\n[truncated: ${dropped} more chars]` };
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m.content.filter(isText).map((b) => b.text).join("");
  }
  return "";
}
