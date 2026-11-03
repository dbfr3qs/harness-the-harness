import { randomUUID } from "node:crypto";
import type { AssistantBlock, JsonSchema, Message, MessageResponse, ModelRequest, StopReason } from "../types.ts";

// Gemini wire types (generateContent / streamGenerateContent).
export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: unknown;
}

export interface GeminiFunctionResponse {
  id?: string;
  name: string;
  response: unknown;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

export interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

// Opaque block carrying a Gemini thought signature. With toolUseId set it is the
// companion of that tool_use (a functionCall's signature); otherwise it is a thought.
export type GeminiSignatureBlock = {
  type: "thinking";
  thinking: string;
  thoughtSignature?: string;
  toolUseId?: string;
};

function stopReason(finish: string | undefined, hasCall: boolean): StopReason {
  if (hasCall) return "tool_use";
  switch (finish) {
    case "MAX_TOKENS": return "max_tokens";
    case "SAFETY": return "refusal";
    default: return "end_turn";
  }
}

function partsToBlocks(parts: GeminiPart[]): { blocks: AssistantBlock[]; hasCall: boolean } {
  const blocks: AssistantBlock[] = [];
  let hasCall = false;
  for (const p of parts) {
    if (p.functionCall) {
      hasCall = true;
      const id = p.functionCall.id ?? `gemini_${randomUUID()}`;
      blocks.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      if (p.thoughtSignature) {
        const comp: GeminiSignatureBlock = { type: "thinking", thinking: "", toolUseId: id, thoughtSignature: p.thoughtSignature };
        blocks.push(comp);
      }
    } else if (p.text !== undefined) {
      if (p.thought) {
        const b: GeminiSignatureBlock = { type: "thinking", thinking: p.text };
        if (p.thoughtSignature) b.thoughtSignature = p.thoughtSignature;
        blocks.push(b);
      } else {
        // Outbound paths reject empty text, so never emit an empty text block;
        // a signature carried by this part survives as a signature-only thought.
        if (p.text) blocks.push({ type: "text", text: p.text });
        if (p.thoughtSignature) {
          const sig: GeminiSignatureBlock = { type: "thinking", thinking: "", thoughtSignature: p.thoughtSignature };
          blocks.push(sig);
        }
      }
    }
  }
  return { blocks, hasCall };
}

function usageOf(u: GeminiUsageMetadata | undefined): MessageResponse["usage"] {
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    input_tokens: (u?.promptTokenCount ?? 0) - cached,
    output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: cached,
  };
}

export function parseGeminiResponse(res: GeminiResponse, model: string, id: string): MessageResponse {
  const cand = res.candidates?.[0];
  const { blocks, hasCall } = partsToBlocks(cand?.content?.parts ?? []);
  return {
    id,
    model,
    role: "assistant",
    content: blocks,
    stop_reason: stopReason(cand?.finishReason, hasCall),
    usage: usageOf(res.usageMetadata),
  };
}

export interface GeminiStreamAccumulator {
  push(chunk: GeminiResponse): { textDelta?: string; thinkingDelta?: string };
  finish(): MessageResponse;
}

export function createGeminiStreamAccumulator(model = "", id = ""): GeminiStreamAccumulator {
  const parts: GeminiPart[] = [];
  let finishReason: string | undefined;
  let usage: GeminiUsageMetadata | undefined;
  return {
    push(chunk) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      let textDelta: string | undefined;
      let thinkingDelta: string | undefined;
      for (const p of cand?.content?.parts ?? []) {
        if (p.functionCall) {
          parts.push({ ...p });
          continue;
        }
        if (p.text === undefined) continue;
        const thought = p.thought === true;
        if (p.text) {
          if (thought) thinkingDelta = (thinkingDelta ?? "") + p.text;
          else textDelta = (textDelta ?? "") + p.text;
        }
        const last = parts[parts.length - 1];
        if (last && last.text !== undefined && (last.thought === true) === thought) {
          last.text += p.text;
          if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
        } else {
          parts.push({ text: p.text, thought, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) });
        }
      }
      const out: { textDelta?: string; thinkingDelta?: string } = {};
      if (textDelta !== undefined) out.textDelta = textDelta;
      if (thinkingDelta !== undefined) out.thinkingDelta = thinkingDelta;
      return out;
    },
    finish() {
      const { blocks, hasCall } = partsToBlocks(parts);
      return {
        id,
        model,
        role: "assistant",
        content: blocks,
        stop_reason: stopReason(finishReason, hasCall),
        usage: usageOf(usage),
      };
    },
  };
}

// Gemini accepts an OpenAPI-subset schema; keep only the keys it understands.
export function toGeminiSchema(s: JsonSchema): object {
  const out: Record<string, unknown> = { type: s.type };
  if (s.description !== undefined) out.description = s.description;
  if (s.enum !== undefined) out.enum = s.enum;
  if (s.required !== undefined) out.required = s.required;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

function contentsOf(messages: Message[]): GeminiContent[] {
  const names = new Map<string, string>(); // tool_use id -> name, from prior assistant turns
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const sigs = new Map<string, string>();
      for (const b of m.content) {
        const c = b as GeminiSignatureBlock;
        if (b.type === "thinking" && c.toolUseId && c.thoughtSignature) sigs.set(c.toolUseId, c.thoughtSignature);
      }
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          const t = (b as { text: string }).text;
          if (t) parts.push({ text: t });
        } else if (b.type === "tool_use") {
          const tu = b as { id: string; name: string; input: unknown };
          names.set(tu.id, tu.name);
          const sig = sigs.get(tu.id);
          parts.push({ functionCall: { id: tu.id, name: tu.name, args: tu.input }, ...(sig ? { thoughtSignature: sig } : {}) });
        } else if (b.type === "thinking") {
          const c = b as GeminiSignatureBlock;
          if (c.toolUseId) continue; // companion: consumed by its functionCall
          if (c.thinking) {
            parts.push({ text: c.thinking, thought: true, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) });
          }
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (typeof m.content === "string") {
      if (m.content) contents.push({ role: "user", parts: [{ text: m.content }] });
    } else {
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          parts.push({ functionResponse: {
            id: b.tool_use_id,
            name: names.get(b.tool_use_id) ?? "unknown",
            response: b.is_error ? { error: b.content } : { result: b.content },
          } });
        } else if (b.text) {
          parts.push({ text: b.text });
        }
      }
      if (parts.length) contents.push({ role: "user", parts });
    }
  }
  return contents;
}

export function buildGeminiRequest(req: ModelRequest, maxTokens: number, includeThoughts: boolean): { body: object } {
  const body: Record<string, unknown> = {
    contents: contentsOf(req.messages),
    generationConfig: { maxOutputTokens: maxTokens, ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}) },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }];
  }
  return { body };
}
