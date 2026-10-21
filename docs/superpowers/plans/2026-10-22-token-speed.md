# Token Speed in the Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live prefill and decode token-speed in the bottom status bar while a reply streams.

**Architecture:** The client measures time-to-first-token and the decode window (it owns the request/stream) and reports them through two optional hooks; the REPL holds a small speed state, computes a live decode estimate inside the status redraw it already does per delta, and renders two extra fields. Two pure helpers carry the arithmetic/formatting for unit testing.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), zero runtime deps, tests in `node:test` + `node:assert/strict`, `tsc --noEmit`.

**Spec:** [`docs/superpowers/specs/2026-10-22-token-speed-design.md`](../specs/2026-10-22-token-speed-design.md)

## Global Constraints

- Zero runtime dependencies; Node 24; `npm run check` clean; `npm test` green.
- Streaming-only: in non-streaming mode (`config.stream === false`) no prefill/decode figure is shown and neither hook fires.
- Status bar renders only in screen mode (`updateStatus` already returns early when `!term.screen`); nothing changes in plain/piped output.
- Timing is measured in `src/client.ts` using an injectable clock (`ClientDeps.now`, default a monotonic clock) so timing is deterministically testable.
- No change to the `MessageResponse` shape, the non-streaming branch, or existing streaming output.

## Review Focus

- Zero/near-zero elapsed time (ttft or decode window is 0, or no chars streamed yet): the rate is 0, never `NaN`/`Infinity` in the bar. (Task 2)
- Non-streaming mode: neither hook fires and no speed field appears. (Task 1)
- A tool-only model call (streams no visible text): neither hook fires, the bar keeps the last figures, nothing crashes. (Task 1)
- A retried attempt (stream error before any token): `onFirstToken` does not fire on the failed attempt and fires once on the successful one — no double count. (Task 1)
- Formatting extremes: a sub-1000 rate shows no `k`; a ≥1000 rate shows the `k` suffix; rounding is stable. (Task 2)

---

### Task 1: Measure timing in the client and report it via hooks

**Files:**
- Modify: `src/client.ts` (`ClientHooks`, `ClientDeps`, the streaming `attempt` loop)
- Test: `test/client.test.ts`

**Interfaces:**
- Produces on `ClientHooks` (both optional, streaming-only, at most once per model call):
  - `onFirstToken?(info: { inputTokens: number; ttftMs: number }): void`
  - `onStreamDone?(info: { outputTokens: number; decodeMs: number }): void`
- Produces on `ClientDeps`: `now?: () => number` (default `() => performance.now()`).
- `ttftMs` = first-visible-token time minus the time just before the request is sent; `decodeMs` = stream-complete time minus first-visible-token time; `inputTokens` from the `message_start` event's `message.usage.input_tokens`; `outputTokens` from the finished message's `usage.output_tokens`.

- [ ] **Step 1: Write the failing tests** in `test/client.test.ts`, reusing the existing scripted-SSE + fake-fetch setup, with an injected `deps.now` returning scripted values:
  - A stream (`message_start` usage.input_tokens=100 → a `text_delta` → `message_delta` usage.output_tokens=40 → `message_stop`) with `now` yielding 0 at send, 200 at the first delta, 700 at done: `onFirstToken` fires exactly once with `{ inputTokens: 100, ttftMs: 200 }` and `onStreamDone` fires once with `{ outputTokens: 40, decodeMs: 500 }`.
  - A non-streaming request (`config.stream = false`) fires neither hook.
  - A tool-only stream (`message_start` → `content_block_start` tool_use → `input_json_delta` → `message_stop`, no visible text) fires neither hook.
  - A first attempt that emits a retryable `error` event before any text (triggering a retry) followed by a clean second attempt: `onFirstToken` fires exactly once (on the successful attempt), not per attempt.
- [ ] **Step 2: Run the tests, verify they fail.** Run: `node --test test/client.test.ts`
- [ ] **Step 3: Implement.** Resolve `now` from `deps`. In the streaming branch of `attempt`, before `doFetch`, record `t0 = now()`; keep per-attempt locals `inputTokens`, `firstAt`, `fired = false`. In the SSE loop, on an `ev.type === "message_start"` read `inputTokens = ev.message?.usage?.input_tokens ?? 0`; when `acc.apply(ev)` returns a visible `out` and `!fired`, set `firstAt = now()`, `fired = true`, and call `hooks.onFirstToken?.({ inputTokens, ttftMs: firstAt - t0 })`. On the successful-return path, capture `const response = acc.finish()`; if `fired`, call `hooks.onStreamDone?.({ outputTokens: response.usage.output_tokens, decodeMs: now() - firstAt })`; then return it. Touch neither hook in the non-streaming branch.
- [ ] **Step 4: Run the tests, verify they pass, and `npm run check`.**
- [ ] **Step 5: Commit** (`feat: client measures and reports prefill/decode timing`).

---

### Task 2: Speed helpers, status-bar rendering, and docs

**Files:**
- Create: `src/token_speed.ts`
- Modify: `src/repl.ts` (speed state, the two new hooks in `clientHooks`, `updateStatus`), `README.md`
- Test: `test/token_speed.test.ts`

**Interfaces:**
- Consumes: `onFirstToken`/`onStreamDone` from Task 1; the REPL's existing `streamedChars`, `updateStatus`, and `parts` array.
- Produces in `src/token_speed.ts`:
  - `tokensPerSec(tokens: number, ms: number): number` — `ms <= 0 ? 0 : tokens / (ms / 1000)`.
  - `formatSpeed(prefill: number | undefined, decode: number | undefined): string[]` — returns 0–2 `parts`; a figure that is `undefined` or `0` is omitted; a rate `< 1000` renders as `"<kind> <n> tok/s"` (n rounded to a whole number), a rate `≥ 1000` as `"<kind> <n.n>k tok/s"` (one decimal). Kinds are `prefill` and `decode`.

- [ ] **Step 1: Write the failing tests** in `test/token_speed.test.ts`:
  - `tokensPerSec(100, 200) === 500`; `tokensPerSec(40, 0) === 0`; `tokensPerSec(0, 100) === 0`.
  - `formatSpeed(3100, 84)` deep-equals `["prefill 3.1k tok/s", "decode 84 tok/s"]`.
  - `formatSpeed(undefined, undefined)` deep-equals `[]`; `formatSpeed(3100, undefined)` deep-equals `["prefill 3.1k tok/s"]`; `formatSpeed(0, 84)` deep-equals `["decode 84 tok/s"]` (a 0 figure is omitted).
- [ ] **Step 2: Run the tests, verify they fail.** Run: `node --test test/token_speed.test.ts`
- [ ] **Step 3: Implement the helpers**, then wire the REPL:
  - Add state near `streamedChars`: `let speedPrefill: number | undefined; let speedDecode: number | undefined; let decodeStart: number | undefined;` (use `performance.now()` directly in the REPL).
  - Add to `clientHooks`: `onFirstToken: ({ inputTokens, ttftMs }) => { speedPrefill = tokensPerSec(inputTokens, ttftMs); decodeStart = performance.now(); speedDecode = undefined; updateStatus(); }` and `onStreamDone: ({ outputTokens, decodeMs }) => { speedDecode = tokensPerSec(outputTokens, decodeMs); decodeStart = undefined; updateStatus(); }`. Do not clear the figures in `onRequest` — they persist as the most-recent call's numbers and are overwritten when the next call's first token arrives.
  - In `updateStatus`, after the existing fields, compute the decode figure: `speedDecode` if set, else if `decodeStart !== undefined` the live estimate `tokensPerSec(Math.ceil(streamedChars / 4), performance.now() - decodeStart)`, else `undefined`; then `parts.push(...formatSpeed(speedPrefill, decodeFigure))`.
  - README: add a line (near the streaming/status-bar material) noting the status bar shows live prefill and decode tok/s while a reply streams (streaming mode only; decode is an estimate that snaps to exact when the reply completes).
- [ ] **Step 4: Run `node --test test/token_speed.test.ts`, `npm run check`, and the full `npm test`; verify green.** In the report, describe how the live estimate and the exact snap were confirmed (reasoning from the wiring, since `updateStatus` isn't unit-tested).
- [ ] **Step 5: Commit** (`feat: show prefill/decode speed in the status bar`).
