# Google Gemini Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Gemini as a first-class model provider via a native-API translation adapter that mirrors the harness's existing `callModel` contract.

**Architecture:** A new `src/gemini/` module: pure translation (`translate.ts`, both directions, with `thoughtSignature` carried in conversation history, parallel-call id threading, cache-aware usage) and a `createGeminiClient` (`client.ts`) that mirrors `createAnthropicClient`'s HTTP/retry/SSE/hooks/abort behaviour but talks Gemini's native `generateContent`/`streamGenerateContent`. A `createClient` factory dispatches by provider; `src/config.ts` gains a `gemini` provider entry. The agent loop, tools, MCP, and UI are untouched.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), `node:test` + `node:assert/strict`, zero runtime dependencies, Gemini native REST + SSE.

**Spec:** docs/superpowers/specs/2026-11-03-gemini-provider-design.md

## Global Constraints

- Zero runtime dependencies (hand-rolled fetch + SSE, reusing `src/sse.ts`); Node 24; `npx tsc --noEmit` clean; TDD with `node:test`; `npm test` (baseline passes).
- `createGeminiClient(config, hooks, deps)` honours the exact `createAnthropicClient` contract: returns `callModel(req: ModelRequest) => Promise<MessageResponse>`, fires the same `ClientHooks`, honours `signal`, and matches its retry/backoff/idle-timeout/mid-stream-error behaviour (anti-goal: no divergent behaviour).
- `GEMINI_API_KEY` is a secret handled like the other provider keys; never written to session/transcript files.
- `thoughtSignature` is carried in `Message[]` history (opaque thinking-family blocks), never in client-closure state.
- Usage contract (types.ts:54): `input_tokens` EXCLUDES cache-reads → `input_tokens = promptTokenCount − (cachedContentTokenCount ?? 0)`.
- Gemini endpoint: `POST ${baseUrl}/v1beta/models/${model}:generateContent` or `:streamGenerateContent?alt=sse`, header `x-goog-api-key: ${apiKey}`, baseUrl `https://generativelanguage.googleapis.com`.
- Must not regress the Anthropic/DeepSeek path; the factory dispatch and the `Provider` union are the only edits outside `src/gemini/`.

## Review Focus

- **thoughtSignature survives a client rebuild** — after `/thinking` or `/maxtokens` rebuilds the client mid-conversation, the next Gemini-3 tool turn must still carry each prior `functionCall`'s signature (read from history), or it 400s. *(Task 3 — `buildGeminiRequest` reads companion blocks.)*
- **Parallel same-name tool calls don't misbind** — two concurrent calls to the same tool must be disambiguated by id on both `functionCall` and `functionResponse`. *(Task 3.)*
- **Usage not inflated by implicit cache** — a response with nonzero `cachedContentTokenCount` must not double-count it into `input_tokens`. *(Task 2.)*
- **Stream aborts on interrupt; mid-stream error not retried** — `signal` abort stops the stream promptly; a failure after output began is surfaced, not retried. *(Task 4.)*
- **Nested tool schemas map intact** — a tool whose `input_schema` has nested `object`/`array`/`enum` must reach Gemini as a usable `functionDeclarations` schema, or the model can't call it. *(Task 3.)*

## Shared wire types (defined in `src/gemini/translate.ts`, used across tasks)

```ts
type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { id?: string; name: string; args: unknown }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: unknown } };
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }
interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
}
```
**Companion signature block** (an `OpaqueBlock`, type `"thinking"` so `removeThinking` strips it on a model/provider switch): a thought summary is `{ type:"thinking", thinking: <text>, thoughtSignature }`; a functionCall-signature companion is `{ type:"thinking", thinking:"", toolUseId: <id>, thoughtSignature }`.

---

### Task 1: Gemini provider entry

**Files:**
- Modify: `src/config.ts` (`Provider` union, `PROVIDERS`)
- Test: `test/config.test.ts` (or the existing provider test)

**Interfaces:**
- Produces: `Provider` now includes `"gemini"`; `PROVIDERS.gemini` = `{ env: "Google Gemini", keyVar: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com", strict: true, defaultModel: "gemini-3.1-pro-preview", models: [{id:"gemini-3.1-pro-preview", contextWindow:1_048_576, maxOutput:65_536}, {id:"gemini-3.5-flash-lite", contextWindow:1_048_576, maxOutput:65_536}, {id:"gemini-3.8-flash", contextWindow:1_048_576, maxOutput:65_536}] }` (match the existing `ProviderInfo` field names exactly; re-verify ids/limits against `GET /v1beta/models` at build time — drop `gemini-3.8-flash` with a ledger note if it isn't live on the key).

- [ ] **Step 1: Write the failing tests** (mirror the existing provider tests' style):
```ts
test("gemini is a provider keyed by GEMINI_API_KEY", () => {
  assert.ok(isProvider("gemini"));
  const s = providerSettings({ GEMINI_API_KEY: "k" } as any, "gemini", undefined, {});
  assert.equal(s.provider, "gemini");
  assert.equal(s.apiKey, "k");
  assert.equal(s.baseUrl, "https://generativelanguage.googleapis.com");
  assert.equal(s.model, "gemini-3.1-pro-preview");
});
test("gemini rejects an unknown model (strict)", () => {
  assert.throws(() => checkModel("gemini", "gpt-5"));
  assert.doesNotThrow(() => checkModel("gemini", "gemini-3.5-flash-lite"));
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/config.test.ts`. Expected: FAIL (gemini not a provider).

- [ ] **Step 3: Add the `gemini` entry** to `Provider` and `PROVIDERS` in `src/config.ts`.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/config.test.ts`; then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: gemini provider entry"
```

---

### Task 2: Inbound translation — Gemini response/stream → MessageResponse

**Files:**
- Create: `src/gemini/translate.ts` (the shared wire types above + inbound functions)
- Test: `test/gemini_translate_in.test.ts`

**Interfaces:**
- Produces:
  - `parseGeminiResponse(res: GeminiResponse, model: string, id: string): MessageResponse` — maps `candidates[0].content.parts` to `AssistantBlock[]`: `{text, thought:false|undefined}`→`TextBlock`; `{text, thought:true, thoughtSignature}`→`{type:"thinking", thinking:text, thoughtSignature}`; `{functionCall:{id?,name,args}, thoughtSignature?}`→ a `ToolUseBlock` (`id` = functionCall.id ?? a generated id) immediately followed by a `{type:"thinking", thinking:"", toolUseId, thoughtSignature}` companion when a signature was present. `stop_reason`: `STOP`→`end_turn`, `MAX_TOKENS`→`max_tokens`, any functionCall present→`tool_use`, `SAFETY`→`refusal`, else `end_turn`. `usage`: `input_tokens = promptTokenCount − (cachedContentTokenCount ?? 0)`, `cache_read_input_tokens = cachedContentTokenCount`, `output_tokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`.
  - `createGeminiStreamAccumulator()` → `{ push(chunk: GeminiResponse): { textDelta?: string; thinkingDelta?: string }; finish(): MessageResponse }` — folds streamed chunks into the same `MessageResponse` the non-stream path yields; `push` returns the visible text/thinking delta for a chunk (for the client's `onTextDelta`/`onThinkingDelta`); `finish` applies the last chunk's `usageMetadata`.
- Consumes: `MessageResponse`, `AssistantBlock`, `StopReason` (`src/types.ts`).

- [ ] **Step 1: Write the failing tests** in `test/gemini_translate_in.test.ts`:
```ts
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
  assert.equal(r.usage.input_tokens, 70);           // 100 − 30 cached
  assert.equal(r.usage.cache_read_input_tokens, 30);
  assert.equal(r.usage.output_tokens, 25);          // 20 + 5 thoughts
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
  assert.equal(final.content.find((b: any) => b.type === "text").text, "hello");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/gemini_translate_in.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement the wire types + `parseGeminiResponse` + `createGeminiStreamAccumulator`** in `src/gemini/translate.ts`.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/gemini_translate_in.test.ts`; `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/gemini/translate.ts test/gemini_translate_in.test.ts
git commit -m "feat: gemini inbound translation (response + stream)"
```

---

### Task 3: Outbound translation — ModelRequest → Gemini request body

**Files:**
- Modify: `src/gemini/translate.ts` (add outbound functions)
- Test: `test/gemini_translate_out.test.ts`

**Interfaces:**
- Consumes: the wire types and the companion-block shape from Task 2.
- Produces:
  - `toGeminiSchema(s: JsonSchema): object` — maps the harness `JsonSchema` subset (type/description/properties/required/items/enum) to Gemini's OpenAPI-subset schema (structural; recurse into properties/items; keep enum/required; drop any key Gemini rejects — confirm at build time).
  - `buildGeminiRequest(req: ModelRequest, maxTokens: number, includeThoughts: boolean): { body: object }` — `system`→`systemInstruction` (omit if empty); `messages`→`contents` with roles `user`/`model`; a user `ToolResultBlock`→a `user` part `{functionResponse:{id: tool_use_id, name, response}}` where `name` is recovered from the matching `ToolUseBlock` (search prior assistant turns by id) and `response` wraps the content (`{result}` or `{error}` when `is_error`); an assistant `ToolUseBlock`→`{functionCall:{id: tool_use_id, name, args: input}}` with `thoughtSignature` attached from the companion `{type:"thinking", toolUseId, thoughtSignature}` block in the same assistant content; an assistant thinking block with text→`{text, thought:true, thoughtSignature}`; companion signature blocks are consumed (not emitted as their own part); `tools`→`[{functionDeclarations: req.tools.map(t => ({name, description, parameters: toGeminiSchema(t.input_schema)}))}]` (omit when empty); `generationConfig: {maxOutputTokens: maxTokens, ...(includeThoughts ? {thinkingConfig:{includeThoughts:true}} : {})}`.

- [ ] **Step 1: Write the failing tests** in `test/gemini_translate_out.test.ts`:
```ts
test("system, tools, and a plain user message translate", () => {
  const { body } = buildGeminiRequest({ system: "S", messages: [{ role: "user", content: "hi" }], tools: [{ name: "run", description: "d", input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }] }, 1024, true);
  assert.deepEqual((body as any).systemInstruction, { parts: [{ text: "S" }] });
  assert.deepEqual((body as any).contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.equal((body as any).tools[0].functionDeclarations[0].name, "run");
  assert.deepEqual((body as any).generationConfig, { maxOutputTokens: 1024, thinkingConfig: { includeThoughts: true } });
});
test("a tool_use + its signature companion re-attach the signature to the functionCall", () => {
  const { body } = buildGeminiRequest({ system: "", tools: [], messages: [
    { role: "assistant", content: [ { type: "tool_use", id: "fc1", name: "run", input: { a: 1 } }, { type: "thinking", thinking: "", toolUseId: "fc1", thoughtSignature: "SIG" } as any ] },
    { role: "user", content: [ { type: "tool_result", tool_use_id: "fc1", content: "ok" } ] },
  ] }, 512, false);
  const parts = (body as any).contents;
  assert.deepEqual(parts[0].parts[0], { functionCall: { id: "fc1", name: "run", args: { a: 1 } }, thoughtSignature: "SIG" });
  assert.deepEqual(parts[1].parts[0], { functionResponse: { id: "fc1", name: "run", response: { result: "ok" } } });
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
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/gemini_translate_out.test.ts`. Expected: FAIL (functions missing).

- [ ] **Step 3: Implement `toGeminiSchema` + `buildGeminiRequest`** in `src/gemini/translate.ts`.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/gemini_translate_out.test.ts`; `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/gemini/translate.ts test/gemini_translate_out.test.ts
git commit -m "feat: gemini outbound translation (request body)"
```

---

### Task 4: `createGeminiClient` + `createClient` factory + REPL wiring

**Files:**
- Create: `src/gemini/client.ts`
- Modify: `src/client.ts` (export a `createClient` factory) and `src/repl.ts` (use it at the client-construction sites)
- Test: `test/gemini_client.test.ts`

**Interfaces:**
- Consumes: `buildGeminiRequest`, `parseGeminiResponse`, `createGeminiStreamAccumulator` (Tasks 2–3); `ClientConfig`, `ClientHooks`, `ClientDeps`, `InterruptedError` (`src/client.ts`); `parseSSE`/the SSE reader (`src/sse.ts`).
- Produces:
  - `createGeminiClient(config: ClientConfig, hooks?: ClientHooks, deps?: ClientDeps)` → `callModel(req: ModelRequest) => Promise<MessageResponse>`. POSTs to `:generateContent` or `:streamGenerateContent?alt=sse` with `x-goog-api-key`; fires `onRequest`/`onFirstToken`/`onTextDelta`/`onThinkingDelta`/`onStreamDone`/`onRetry` exactly as the Anthropic client; same retry/backoff/idle-timeout; honours `req.signal`; maps Gemini error bodies (`{error:{code,status,message}}`) to the same retry policy (429/5xx retryable with `Retry-After`; 4xx fatal); a mid-stream failure after output began is surfaced not retried.
  - `createClient(config, hooks?, deps?)` in `src/client.ts` → `config.provider === "gemini" ? createGeminiClient(...) : createAnthropicClient(...)`.
  - `src/repl.ts`: every `createAnthropicClient(config, clientHooks)` site becomes `createClient(config, clientHooks)`.

- [ ] **Step 1: Write the failing tests** in `test/gemini_client.test.ts` using an injected `deps.fetch`:
```ts
// non-stream: fake fetch returns a GenerateContentResponse; assert callModel maps it.
test("non-stream callModel posts to generateContent and returns a mapped response", async () => {
  let seen: any;
  const fetchMock = async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }), { status: 200 }); };
  const client = createGeminiClient({ provider: "gemini", apiKey: "k", baseUrl: "https://x", model: "gemini-3.1-pro-preview", maxTokens: 100, timeoutMs: 1000, maxRetries: 0, stream: false }, {}, { fetch: fetchMock as any });
  const r = await client({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.match(seen.url, /:generateContent/);
  assert.equal(seen.init.headers["x-goog-api-key"], "k");
  assert.equal(r.content[0].type === "text" && r.content[0].text, "hi");
  assert.equal(r.usage.input_tokens, 5);
});
test("a 429 is retried and a 400 is fatal", async () => { /* fetchMock returns 429 then 200 with maxRetries:1 → resolves; a 400 → rejects */ });
test("signal abort rejects with InterruptedError and stops", async () => { /* abort mid-request → InterruptedError */ });
test("createClient dispatches gemini vs anthropic by provider", () => {
  // construct with a fetch that records the URL path; gemini → /v1beta/..., anthropic → /v1/messages
});
```
(Flesh out the 429/abort/dispatch tests to the shapes above.)

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/gemini_client.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `createGeminiClient`** in `src/gemini/client.ts` (reuse the Anthropic client's retry/timeout/SSE-read structure — factor shared helpers out of `src/client.ts` if clean, else mirror), **and** `createClient` in `src/client.ts`.

- [ ] **Step 4: Wire `src/repl.ts`** to call `createClient` at every client-construction site (startup and the `/provider`,`/model`,`/maxtokens`,`/thinking` rebuilds).

- [ ] **Step 5: Run the tests.** Run: `node --test test/gemini_client.test.ts`; then full `npm test`; then `npx tsc --noEmit`. Expected: all pass, clean.

- [ ] **Step 6: Commit.**
```bash
git add src/gemini/client.ts src/client.ts src/repl.ts test/gemini_client.test.ts
git commit -m "feat: gemini client + provider factory, wired into the repl"
```

**Note for the reviewer:** the REPL client-construction wiring is not unit-tested (no repl harness); it is covered by the factory test, `tsc`, the full suite, and review-by-reading. A live end-to-end call against the real Gemini API (needs `GEMINI_API_KEY`) is the manual acceptance check and is out of the automated suite.

---

## Build-time verification (fold into the owning task)

- Task 1: hit `GET https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY` (or the model pages) to confirm the three ids and their input/output limits; adjust the entry; drop `gemini-3.8-flash` (ledger note) if absent.
- Task 3: confirm `toGeminiSchema` emits nothing Gemini rejects for the schemas the harness's real tools produce.
- Task 4: confirm where `usageMetadata` lands in the SSE stream (final chunk vs every chunk) and that `functionResponse` is accepted as a `user`-role turn, against a real response if a key is available.
