import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeminiResponse, createGeminiStreamAccumulator } from "../src/gemini/translate.ts";

test("text + thought + functionCall map to blocks with a signature companion", () => {
  const r = parseGeminiResponse({
    candidates: [{ content: { parts: [
      { text: "hi", thought: false },
      { text: "reasoning", thought: true, thoughtSignature: "S1" },
      { functionCall: { id: "fc1", name: "run", args: { x: 1 } }, thoughtSignature: "S2" },
    ] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 30 },
  }, "gemini-3.1-pro-preview", "id1");
  assert.deepEqual(r.content[0], { type: "text", text: "hi" });
  assert.equal((r.content[1] as any).type, "thinking");
  assert.equal((r.content[1] as any).thoughtSignature, "S1");
  assert.deepEqual(r.content[2], { type: "tool_use", id: "fc1", name: "run", input: { x: 1 } });
  assert.deepEqual(r.content[3], { type: "thinking", thinking: "", toolUseId: "fc1", thoughtSignature: "S2" });
  assert.equal(r.stop_reason, "tool_use");
  assert.equal(r.usage.input_tokens, 70);
  assert.equal(r.usage.cache_read_input_tokens, 30);
  assert.equal(r.usage.output_tokens, 25);
});
test("a functionCall with no id gets a generated id used on its companion", () => {
  const r = parseGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "run", args: {} }, thoughtSignature: "S" }] }, finishReason: "STOP" }] }, "m", "id");
  const tu = r.content.find((b: any) => b.type === "tool_use") as any;
  const comp = r.content.find((b: any) => b.type === "thinking") as any;
  assert.ok(tu.id && tu.id === comp.toolUseId);
});
test("stream accumulator folds chunks and emits deltas", () => {
  const acc = createGeminiStreamAccumulator();
  assert.equal(acc.push({ candidates: [{ content: { parts: [{ text: "he" }] } }] }).textDelta, "he");
  assert.equal(acc.push({ candidates: [{ content: { parts: [{ text: "llo" }] } }] }).textDelta, "llo");
  assert.equal(acc.push({ candidates: [{ content: { parts: [{ text: "t", thought: true }] } }] }).thinkingDelta, "t");
  const final = acc.finish();
  assert.equal((final.content.find((b: any) => b.type === "text") as any).text, "hello");
});

const one = (parts: any[], finishReason?: string, usageMetadata?: any) =>
  ({ candidates: [{ content: { parts }, finishReason }], usageMetadata });

test("stop_reason mapping", () => {
  assert.equal(parseGeminiResponse(one([{ text: "a" }], "MAX_TOKENS"), "m", "i").stop_reason, "max_tokens");
  assert.equal(parseGeminiResponse(one([{ text: "a" }], "SAFETY"), "m", "i").stop_reason, "refusal");
  assert.equal(parseGeminiResponse(one([{ text: "a" }], "STOP"), "m", "i").stop_reason, "end_turn");
});

test("a functionCall without a signature emits no companion", () => {
  const r = parseGeminiResponse(one([{ functionCall: { id: "f", name: "run", args: {} } }], "STOP"), "m", "i");
  assert.deepEqual(r.content, [{ type: "tool_use", id: "f", name: "run", input: {} }]);
});

test("empty non-thought text parts produce no text block", () => {
  const r = parseGeminiResponse(one([{ text: "" }, { text: "x" }], "STOP"), "m", "i");
  assert.deepEqual(r.content, [{ type: "text", text: "x" }]);
  const acc = createGeminiStreamAccumulator();
  acc.push(one([{ functionCall: { id: "f", name: "run", args: {} } }]));
  acc.push(one([{ text: "" }]));
  assert.ok(!acc.finish().content.some((b: any) => b.type === "text"));
});

test("stream preserves functionCall whole and retains signatures", () => {
  const acc = createGeminiStreamAccumulator();
  acc.push(one([{ text: "think", thought: true }]));
  acc.push(one([{ text: "", thought: true, thoughtSignature: "T" }]));
  acc.push(one([{ functionCall: { id: "f", name: "run", args: { a: 1 } } }]));
  acc.push(one([{ text: "", thoughtSignature: "TRAIL" }]));
  const c = acc.finish().content as any[];
  assert.deepEqual(c[0], { type: "thinking", thinking: "think", thoughtSignature: "T" });
  assert.deepEqual(c[1], { type: "tool_use", id: "f", name: "run", input: { a: 1 } });
  assert.ok(c.some((b) => b.type === "thinking" && b.thoughtSignature === "TRAIL"));
});

test("finish applies the last chunk's usage and finishReason", () => {
  const acc = createGeminiStreamAccumulator();
  acc.push(one([{ text: "a" }], undefined, { promptTokenCount: 1, candidatesTokenCount: 1 }));
  acc.push(one([{ text: "b" }], "MAX_TOKENS", { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 10 }));
  const f = acc.finish();
  assert.equal(f.stop_reason, "max_tokens");
  assert.deepEqual(f.usage, { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 10 });
});

test("interleaved text/thought/text stays ordered and separate", () => {
  const acc = createGeminiStreamAccumulator();
  acc.push(one([{ text: "a" }]));
  acc.push(one([{ text: "reasoning", thought: true }]));
  acc.push(one([{ text: "b" }]));
  assert.deepEqual(acc.finish().content, [
    { type: "text", text: "a" },
    { type: "thinking", thinking: "reasoning" },
    { type: "text", text: "b" },
  ]);
});
