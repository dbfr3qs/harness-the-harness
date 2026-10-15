export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

// thinking, redacted_thinking, or anything new: never inspect, always pass back unchanged
export type OpaqueBlock = { type: string; [key: string]: unknown };

export type AssistantBlock = TextBlock | ToolUseBlock | OpaqueBlock;

export type Message =
  | { role: "user"; content: string | (ToolResultBlock | TextBlock)[] }
  | { role: "assistant"; content: AssistantBlock[] };

export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolDefinition {
  name: string; // ^[a-zA-Z0-9_-]{1,128}$
  description: string;
  input_schema: JsonSchema;
}

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens"
  | "stop_sequence" | "pause_turn" | "refusal";

export interface MessageResponse {
  id: string;
  model: string;
  role: "assistant";
  content: AssistantBlock[];
  stop_reason: StopReason | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
}

export type ModelFn = (req: ModelRequest) => Promise<MessageResponse>;

export function isToolUse(b: AssistantBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

export function isText(b: AssistantBlock): b is TextBlock {
  return b.type === "text";
}
