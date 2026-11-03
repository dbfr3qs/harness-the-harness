# Google Gemini Provider — Design

**Date:** 2026-11-03
**Status:** Approved for planning (pending human sign-off)

## Intent & Why

The harness supports model providers (`anthropic`, `deepseek`) that all speak
the **Anthropic Messages API** wire format: `createAnthropicClient`
(`src/client.ts`) builds `/v1/messages` requests, parses Anthropic streaming
SSE and non-streaming responses into the harness's `MessageResponse`, and
the agent loop consumes one contract — `callModel(req: ModelRequest) →
Promise<MessageResponse>` (`src/types.ts`). DeepSeek works only because it
exposes an Anthropic-compatible endpoint.

Google Gemini has **no Anthropic-compatible surface**. Adding it as a
first-class provider therefore means a **translation adapter**: a
`createGeminiClient` with the same `callModel` contract and the same
`ClientHooks`, but talking Gemini's **native API** underneath
(`generativelanguage.googleapis.com`), translating the harness's
Anthropic-shaped requests/responses/streaming/tools/thinking to and from
Gemini's format. This gives the user Gemini (2.5 and 3-preview) as a
`/provider`-selectable option with full tool use and thinking display,
without adding any runtime dependency.

## Goals

- `gemini` is a selectable provider (`/provider`, `PROVIDER=gemini`), keyed
  by `GEMINI_API_KEY`, that works in streaming and non-streaming modes with
  tools, thinking, and usage/context reporting, like the existing providers.
- A new `createGeminiClient(config, hooks, deps)` implements the exact same
  contract as `createAnthropicClient`: returns `callModel(ModelRequest) →
  Promise<MessageResponse>`, fires the same `ClientHooks`
  (`onRequest`/`onResponse`/`onTextDelta`/`onThinkingDelta`/`onRetry`/`onFirstToken`/`onStreamDone`),
  honours `signal`, and does the same retry/backoff/idle-timeout behaviour.
- The harness picks the client by provider through one factory
  (`createClient(config, hooks, deps)`); `src/repl.ts`'s client-construction
  sites call the factory instead of `createAnthropicClient` directly.
- **Native Gemini API**, chosen over Gemini's OpenAI-compat endpoint, so
  thinking summaries and Gemini-3's `thoughtSignature` round-trip are
  available (the harness surfaces thinking and relies on reliable multi-turn
  tool use).
- Models wired (current lineup as of 2026-11-03; the 2.5 line and
  `gemini-3-pro-preview` the user first named are now deprecated / shut down):
  **`gemini-3.1-pro-preview`** (default, Pro; 1,048,576 context / 65,536 max
  output), **`gemini-3.5-flash-lite`** (Flash; 1,048,576 / 65,536), and
  **`gemini-3.8-flash`** (Flash; limits to confirm). Exact ids/limits are
  re-verified against `GET /v1beta/models` at build time (and if
  `gemini-3.8-flash` isn't live on the key, it's dropped with a note). Context-window
  and max-output limits are hard-coded in the provider entry (as DeepSeek's
  are), so no model-limits fetch is needed for Gemini.
- Correct `thoughtSignature` handling so Gemini-3 tool use does not 400:
  signatures the model returns are preserved and echoed back on the next turn.

## Non-Goals

- No Vertex AI / GCP service-account auth — API-key (`GEMINI_API_KEY`,
  AI Studio / `generativelanguage.googleapis.com`) only.
- No Gemini-specific features beyond what the harness already models: no
  grounding/search tools, no multimodal *input* beyond what the harness
  already sends (it sends text + tool results today), no caching API, no
  safety-setting configuration (defaults used).
- No change to the agent loop, the tool registry, MCP, or the UI. The
  adapter is self-contained behind the existing contract.
- Not removing or changing `createAnthropicClient`; Gemini is additive.

## Anti-Goals (would make this a failure even if it "worked")

- Silently dropping thinking or `thoughtSignature`, so Gemini-3 tool-use
  turns 400 or lose reasoning continuity.
- A second, divergent retry/timeout/SSE implementation that behaves
  differently from the Anthropic client (different retry semantics, leaked
  timeouts, or a stream that doesn't abort on `signal`).
- Mis-translating tool schemas so tool calls silently fail or the model
  can't see a tool.
- Usage/context numbers that are wrong, so the context meter misleads.

## Constraints

- Zero runtime dependencies (hand-rolled fetch + SSE, like `src/client.ts`
  and `src/sse.ts`); Node 24, native type-stripping; `tsc --noEmit` clean;
  tests via `node:test` + `node:assert/strict`; TDD.
- The provider API key (`GEMINI_API_KEY`) is a secret: it is added to
  `config.secrets` handling exactly as the other keys, never written to
  session/transcript files.
- Must not regress the Anthropic/DeepSeek path. The factory dispatch and the
  `Provider` type change are the only edits outside the new Gemini module.

## The How — decisions made

### Provider entry & client factory

- `src/config.ts`: add `"gemini"` to `Provider`; add a `PROVIDERS.gemini`
  entry — `keyVar: "GEMINI_API_KEY"`, `baseUrl:
  "https://generativelanguage.googleapis.com"`, `strict: true`, `models` =
  the three above with hard-coded `contextWindow`/`maxOutput`
  (gemini-2.5-pro: 1_048_576 / 65_536; others verified at build time),
  `defaultModel: "gemini-2.5-pro"`.
- `src/client.ts` (or a small new `src/model_client.ts`): a factory
  `createClient(config, hooks, deps)` returning `createGeminiClient(...)` when
  `config.provider === "gemini"`, else `createAnthropicClient(...)`. Replace
  the `createAnthropicClient(...)` call sites in `src/repl.ts` with it.
- `fetchModelLimits`/`returnsThinkingOnRequest` stay Anthropic-centric; with
  hard-coded Gemini limits the repl's `known ? … : fetchModelLimits()` path
  never calls the Anthropic-shaped limits endpoint for Gemini.

### The Gemini client (`src/gemini/client.ts`)

Same signature and contract as `createAnthropicClient`. HTTP: `POST
${baseUrl}/v1beta/models/${model}:generateContent` (non-stream) or
`:streamGenerateContent?alt=sse` (stream), header `x-goog-api-key:
${apiKey}`, `Content-Type: application/json`. Reuse the Anthropic client's
retry/backoff/idle-timeout/abort scaffolding — factor the generic parts into
a shared helper if clean, otherwise mirror them exactly (the anti-goal
forbids divergent behaviour).

**Request translation (`ModelRequest` → Gemini body):**
- `system` → `systemInstruction: { parts: [{ text: system }] }` (omit if empty).
- `messages` → `contents[]` with roles `user`/`model` (Gemini has no
  "system"/"tool" role):
  - `{role:"user", content: string}` → `{role:"user", parts:[{text}]}`.
  - user `TextBlock` → `{text}`; user `ToolResultBlock` → a `user`-role part
    `{functionResponse: {id: tool_use_id, name, response: {<result>}}}` (the
    function `name` and `id` are recovered from the matching `ToolUseBlock` in
    the preceding assistant turn; the result string is wrapped, e.g.
    `{ result: <content> }` or `{ error: … }` when `is_error`).
  - `{role:"assistant", content: AssistantBlock[]}` → `{role:"model",
    parts:[…]}`: `TextBlock`→`{text}`; `ToolUseBlock`→`{functionCall:{id:
    tool_use_id, name, args: input}}` **plus its `thoughtSignature`** (from the
    companion opaque block) on that part;
    `OpaqueBlock` (a thinking block this client produced)→ its original Gemini
    part re-emitted (text/thought with `thoughtSignature`).
- `tools` → `[{ functionDeclarations: tools.map(t => ({ name: t.name,
  description: t.description, parameters: toGeminiSchema(t.input_schema) })) }]`.
  `toGeminiSchema` maps the harness `JsonSchema` (a small, closed subset —
  type/description/properties/required/items/enum) to Gemini's OpenAPI-subset
  schema; the subset is already compatible, so this is largely structural
  (verify at build time whether any key must be dropped/renamed, e.g. casing).
- `generationConfig`: `{ maxOutputTokens: config.maxTokens, thinkingConfig: {
  includeThoughts: true } }` (so thought parts come back for the thinking
  display; `thinkingBudget` left default).

**`thoughtSignature` round-trip (correctness-critical for Gemini 3):**
Gemini 3 returns a `thoughtSignature` on thought parts and on the first
`functionCall` of a step, and requires those signatures echoed back verbatim
in later turns or the request 400s. Signatures are carried **in the
conversation history** (stateless-from-history), never in client-closure
state — a session map would be wiped every time `src/repl.ts` rebuilds the
client (`/thinking`, `/maxtokens`, `/model`, `/provider`, and resume), which
would reintroduce the very 400s the anti-goal forbids. Two carriers, both in
`Message[]` the agent preserves verbatim:
- **Thinking** parts become `OpaqueBlock`s (`{type:"thinking", thinking,
  thoughtSignature}`) — the exact purpose of `OpaqueBlock` (types.ts:17); the
  client re-emits them verbatim.
- **`functionCall`** signatures can't live on the fixed-shape `ToolUseBlock`,
  so the client emits a dedicated companion opaque block adjacent to the
  tool_use — of a **thinking-family** type (so `removeThinking`
  (`src/model_command.ts`) strips it on a model/provider switch, keeping it
  out of a switched-to provider's history) — carrying `{ tool_use_id,
  thoughtSignature }`. When translating `messages` back to Gemini, the client
  reads these companions and re-attaches each signature to its matching
  `functionCall` part.
- Because both carriers live in history (and are persisted with the session),
  they survive client rebuilds and resume. They are intentionally dropped
  only on a model/provider switch — where `removeThinking` already clears
  thinking and signatures are not portable to another model anyway.

**Response translation (Gemini → `MessageResponse`), non-stream:**
Read `candidates[0].content.parts`: `{text, thought:false}`→`TextBlock`;
`{text, thought:true, thoughtSignature}`→`OpaqueBlock{type:"thinking",
thinking:text, thoughtSignature}`; `{functionCall:{id?,name,args}}`→a
`ToolUseBlock` whose `id` is the functionCall's `id` if Gemini supplied one
else a generated id (this id is the parallel-call disambiguator threaded back
as `functionResponse.id`), followed by its companion signature opaque block
when the functionCall carried a `thoughtSignature`. `stop_reason` from
`finishReason`: `STOP`→`end_turn`,
`MAX_TOKENS`→`max_tokens`, any `functionCall` present→`tool_use`,
`SAFETY`/`MALFORMED_FUNCTION_CALL`→mapped to `refusal`/`end_turn` sensibly.
`usage` from `usageMetadata`: Gemini's `promptTokenCount` *includes* any
cached tokens, but the harness contract (types.ts:54) says `input_tokens`
excludes cache-reads (the agent sums the two separately), so
`input_tokens = promptTokenCount − (cachedContentTokenCount ?? 0)`,
`cache_read_input_tokens = cachedContentTokenCount` (nonzero even without the
caching API — Gemini 2.5 implicit caching),
`output_tokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`. (Confirm
the inclusive semantics against a real response at build time.)

**Streaming (`:streamGenerateContent?alt=sse`):** each SSE `data:` line is a
partial `GenerateContentResponse`. Parse with the existing `src/sse.ts`
parser. For each chunk, walk `candidates[0].content.parts`: emit
`onTextDelta(text)` for non-thought text, `onThinkingDelta(text)` for
`thought:true` text; accumulate parts (text, thought+signature, functionCall)
to assemble the same final `MessageResponse` the non-stream path returns;
`usageMetadata` arrives on the final chunk → fire `onStreamDone` and set
`usage`. `onFirstToken` fires on the first visible text/thinking delta, as in
the Anthropic client.

### Errors & retries

Map Gemini HTTP error bodies (`{ error: { code, status, message } }`) to the
harness's retry policy using the same signals the Anthropic client uses: 429
and 5xx are retryable with backoff (honour `Retry-After` if present); 4xx
(400/401/403) are fatal config/content errors surfaced to the user. Stream
errors mirror the Anthropic client's mid-stream handling (a failure after
output began is not retried).

## What's left to the builder

- Verify at build time, against `GET
  ${baseUrl}/v1beta/models?key=…`/the models docs: the exact Gemini 3 preview
  model **id** and the `inputTokenLimit`/`outputTokenLimit` for all three
  models; pin them in the provider entry.
- Confirm the `JsonSchema → Gemini schema` mapping needs no key drops/renames
  for the subset the harness emits (and strip anything Gemini rejects).
- Confirm where `usageMetadata` appears in the SSE stream (final chunk vs
  every chunk) and that `functionResponse` is sent as a `user`-role turn.
- Decide whether to factor the shared retry/timeout/SSE-read scaffolding out
  of `src/client.ts` for reuse, or mirror it in the Gemini client — the
  anti-goal requires identical behaviour either way.
- The exact `finishReason → StopReason` and tool-result wrapping shapes, as
  long as the agent loop's observable behaviour matches the Anthropic path.
