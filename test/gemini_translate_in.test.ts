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
