import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeminiRequest, toGeminiSchema } from "../src/gemini/translate.ts";

test("system, tools, and a plain user message translate", () => {
  const { body } = buildGeminiRequest({ system: "S", messages: [{ role: "user", content: "hi" }], tools: [{ name: "run", description: "d", input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }] }, 1024, true);
  assert.deepEqual((body as any).systemInstruction, { parts: [{ text: "S" }] });
  assert.deepEqual((body as any).contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.equal((body as any).tools[0].functionDeclarations[0].name, "run");
  assert.deepEqual((body as any).generationConfig, { maxOutputTokens: 1024, thinkingConfig: { includeThoughts: true } });
});
test("empty system and tools are omitted; no thinkingConfig when off", () => {
  const { body } = buildGeminiRequest({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] }, 64, false);
  assert.equal("systemInstruction" in (body as any), false);
  assert.equal("tools" in (body as any), false);
  assert.deepEqual((body as any).generationConfig, { maxOutputTokens: 64 });
});
test("a tool_use + its signature companion re-attach the signature to the functionCall", () => {
  const { body } = buildGeminiRequest({ system: "", tools: [], messages: [
    { role: "assistant", content: [ { type: "tool_use", id: "fc1", name: "run", input: { a: 1 } }, { type: "thinking", thinking: "", toolUseId: "fc1", thoughtSignature: "SIG" } as any ] },
    { role: "user", content: [ { type: "tool_result", tool_use_id: "fc1", content: "ok" } ] },
  ] }, 512, false);
  const parts = (body as any).contents;
  assert.equal(parts[0].role, "model");
  assert.equal(parts[0].parts.length, 1);
  assert.deepEqual(parts[0].parts[0], { functionCall: { id: "fc1", name: "run", args: { a: 1 } }, thoughtSignature: "SIG" });
  assert.equal(parts[1].role, "user");
  assert.deepEqual(parts[1].parts[0], { functionResponse: { id: "fc1", name: "run", response: { result: "ok" } } });
});
test("is_error wraps as {error}", () => {
  const { body } = buildGeminiRequest({ system: "", tools: [], messages: [
    { role: "assistant", content: [ { type: "tool_use", id: "a", name: "run", input: {} } ] },
    { role: "user", content: [ { type: "tool_result", tool_use_id: "a", content: "boom", is_error: true } ] },
  ] }, 512, false);
  assert.deepEqual((body as any).contents[1].parts[0].functionResponse.response, { error: "boom" });
});
test("assistant thinking with text becomes a thought part with signature", () => {
  const { body } = buildGeminiRequest({ system: "", tools: [], messages: [
    { role: "assistant", content: [ { type: "thinking", thinking: "hmm", thoughtSignature: "T" } as any, { type: "text", text: "yo" } ] },
  ] }, 512, false);
  assert.deepEqual((body as any).contents[0].parts, [{ text: "hmm", thought: true, thoughtSignature: "T" }, { text: "yo" }]);
});
test("parallel same-name calls stay disambiguated by id", () => {
  const { body } = buildGeminiRequest({ system: "", tools: [], messages: [
    { role: "assistant", content: [ { type: "tool_use", id: "a", name: "run", input: {} }, { type: "tool_use", id: "b", name: "run", input: {} } ] },
    { role: "user", content: [ { type: "tool_result", tool_use_id: "b", content: "RB" }, { type: "tool_result", tool_use_id: "a", content: "RA" } ] },
  ] }, 512, false);
  const resp = (body as any).contents[1].parts;
  assert.ok(resp.some((p: any) => p.functionResponse.id === "a" && p.functionResponse.response.result === "RA"));
  assert.ok(resp.some((p: any) => p.functionResponse.id === "b" && p.functionResponse.response.result === "RB"));
});
test("toGeminiSchema recurses through nested object/array/enum", () => {
  const g = toGeminiSchema({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { k: { type: "string", enum: ["a", "b"] } } } } } }) as any;
  assert.equal(g.type, "object");
  assert.equal(g.properties.items.items.properties.k.enum[0], "a");
});
test("toGeminiSchema drops unsupported keys", () => {
  const g = toGeminiSchema({ type: "object", additionalProperties: false, $schema: "x", properties: { a: { type: "string", default: "z" } } } as any) as any;
  assert.deepEqual(g, { type: "object", properties: { a: { type: "string" } } });
});
