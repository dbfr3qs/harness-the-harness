# Token Speed in the Status Bar — Design

**Status:** proposed
**Date:** 2026-10-22

## Intent and why

The harness's bottom status bar shows provider/model, context, and the turn
count, but nothing about how fast the model is running. When a reply streams in,
you can't see whether the prompt was slow to process or the model is decoding
slowly. This adds two live figures to that same bar: **prefill speed** (how fast
the prompt was processed) and **decode speed** (how fast the answer is being
generated), updating as the reply streams.

## Goals

- Two new fields in the existing status bar, alongside provider/model, context,
  and turn count:
  - **prefill** — `input_tokens ÷ time-to-first-token`, shown the instant the
    first token of a model call arrives (prompt processing is one shot).
  - **decode** — `output_tokens ÷ time since the first token`, ticking upward as
    text streams and snapping to the exact rate when the reply completes.
- The decode figure during streaming is an **estimate** (characters seen so far,
  ~4 chars/token) that is replaced by the **exact** rate (from the API's final
  `usage.output_tokens`) when the model call finishes. Prefill finalizes exactly
  at the same point.
- Figures reflect the current (or most recent) model call within a run. A run
  with several model calls (tool use) re-measures each call.

## Non-goals

- **Non-streaming mode** (`STREAM=0`): no live timing is possible, so no prefill
  or decode figure is shown at all. This is a streaming-only, live feature.
- Historical speed, per-provider comparison, logging speeds to the transcript,
  or any persisted record. (The status bar is live-only.)
- Measuring tool-call-only turns precisely: a model call that streams no visible
  text may show no new figure; the bar keeps the last call's numbers. The exact
  decode rate, when shown, is correct regardless of block type.

## Anti-goals (failure even if it technically works)

- Redraw storms: updating the status bar on every single delta must not cause
  visible flicker or measurable slowdown — updates are throttled.
- A wrong or wildly jumpy early estimate that misleads — the estimate is clearly
  a running decode rate over the whole generation so far, not an instantaneous
  spike, and it is replaced by the exact figure at the end.
- Any change to non-screen (`--plain`/piped) output or to non-streaming
  behavior.

## Constraints

- Zero runtime dependencies; Node 24; `npm run check` clean; `node:test`.
- Timing lives where the clock is owned: the client (`src/client.ts`) owns the
  request/stream, so time-to-first-token and the decode window are measured
  there. For deterministic tests, the client takes an injectable clock.
- The status bar only renders in screen mode (`updateStatus` already returns
  early when `!term.screen`); this feature adds nothing in plain mode.

## Decided design

### Measurement — in the client

`src/client.ts`'s streaming path (`attempt`) already loops SSE events through
`acc.apply(ev)` and fires `hooks.onTextDelta` on the first visible output. Add,
measured only on the streaming path:

- a start time `t0` captured just before the request is sent;
- on the `message_start` event, capture `inputTokens = ev.message.usage.input_tokens`;
- when the first visible output (text or thinking) arrives, record `firstTokenAt`
  and fire a new hook `onFirstToken({ inputTokens, ttftMs: firstTokenAt - t0 })`;
- when the stream completes successfully, fire a new hook
  `onStreamDone({ outputTokens, decodeMs: doneAt - firstTokenAt })`, where
  `outputTokens` comes from the finished message's `usage.output_tokens`.

Both hooks are optional and fire only for streaming requests, at most once per
model call, and only when a first visible token actually arrived (a tool-only
call that streamed no text fires neither — the bar keeps its last figures). The
non-streaming branch fires neither.

For deterministic timing tests, add an injectable clock to `ClientDeps`
(`now?: () => number`, defaulting to a monotonic clock).

### Display — in the REPL

`src/repl.ts` wires the two new hooks when it builds the client and holds a small
live `speed` state (prefill tok/s, decode tok/s, whether a decode is in
progress). On `onFirstToken` it sets prefill and marks decoding started; on each
`onTextDelta` it refreshes the decode estimate from the characters streamed so
far over the elapsed decode time; on `onStreamDone` it replaces the estimate with
the exact `output_tokens`-based rate and clears the decoding flag. Status-bar
updates are throttled so streaming doesn't cause a redraw per delta.

`updateStatus` renders the figures as extra ` · `-separated fields, e.g.
`… · prefill 3.1k tok/s · decode 84 tok/s`, shown only when a figure is
available and only in screen mode.

Two tiny pure helpers carry the arithmetic and formatting so they can be
unit-tested without the TUI: `tokensPerSec(tokens, ms)` and a formatter that
renders the available figures (with a `k` suffix for thousands) or nothing when
none are available.

## Left to the builder

- The exact hook names/shapes on `ClientHooks` (`onFirstToken`/`onStreamDone`
  above are the intent), the clock-injection detail, and where in the stream loop
  they fire.
- The throttle mechanism and interval for status updates during decode.
- The pure helpers' exact signatures and the field wording/number formatting
  (`k` suffix, rounding), kept consistent with the bar's existing style.
- Tests: client-side, a scripted SSE stream with an injected clock asserting
  `onFirstToken`/`onStreamDone` fire with the right `inputTokens`/`ttftMs` and
  `outputTokens`/`decodeMs`, that neither fires for a non-streaming request, and
  that a text-less (tool-only) stream fires neither; plus unit tests for the two
  pure helpers (including divide-by-zero / zero-elapsed guards and the `k`
  suffix).
