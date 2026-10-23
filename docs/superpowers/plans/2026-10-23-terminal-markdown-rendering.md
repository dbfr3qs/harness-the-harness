# Terminal Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the model's answer text as styled, colored, spaced ANSI in the terminal instead of raw Markdown source, progressively as it streams.

**Architecture:** A new zero-dependency module `src/markdown.ts` exposes a stateful streaming renderer (`createMarkdownStream`) that turns Markdown into ANSI, emitting styled text progressively and holding only a small tail that might still begin markup. The REPL feeds streamed text deltas through it — but only when output is an interactive TTY — and flushes it at turn boundaries. Batch and piped output pass raw Markdown through untouched.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), `node:test` + `node:assert/strict`, zero runtime dependencies, ANSI SGR escape codes.

**Spec:** `docs/superpowers/specs/2026-10-23-terminal-markdown-rendering-design.md`

## Global Constraints

- Zero runtime dependencies. Hand-rolled ANSI; no Markdown library. `tsc --noEmit` stays clean.
- TDD with `node:test` + `node:assert/strict`; test command `npm test`.
- `src/markdown.ts` is pure: deterministic ANSI from input, no terminal/timers/globals inside it.
- **Chunk-split invariance:** for any Markdown string, feeding it as one `write` or split at any byte boundaries then `flush` must produce identical bytes.
- **No marker retraction:** a partial markup marker (`*`, `` ` ``, `[`, `#`, `-`, fence) at a chunk boundary is never emitted as literal text and then taken back.
- **No ANSI leak:** every styled span closes with `\x1b[0m`; no style bleeds into a following line, the input box, or the status bar.
- **Render only on an interactive TTY:** screen mode always; line mode only when `tty`; `createBatchTerminal` and non-TTY line mode pass raw Markdown through (renderer not invoked).
- Public API (stable from Task 1): `createMarkdownStream(): MarkdownStream` where `MarkdownStream = { write(delta: string): string; flush(): string }`; plus `renderMarkdown(text: string): string` (one-shot) and `createMarkdownSink(write: (s: string) => void, enabled: boolean): { text(delta: string): void; flush(): void }`.
- Palette (exact SGR): heading `\x1b[1;36m`; bold `\x1b[1m`; italic `\x1b[3m`; inline & block code `\x1b[33m`; link text `\x1b[4m`, link URL `\x1b[2m(…)\x1b[0m`; blockquote bar `\x1b[2m│ \x1b[0m`; thematic break `\x1b[2m` + `"─".repeat(32)` + `\x1b[0m`; bullet literal `• `. Reuse `dimText` where convenient.
- Must not break the screen/line terminal contracts or the merged menu work.

## Review Focus

- **Chunk boundary mid-markup** — a delta ending exactly on `*`/`` ` ``/`[`/`#`/a fence must not emit a half-marker; result identical to the unsplit input. *(Tasks 1, 2, 4 — chunk-invariance + held-tail tests.)*
- **Markup characters inside code** — `#`, `-`, `*`, backticks inside inline or fenced/indented code stay verbatim, never parsed as structure. *(Task 1 for inline code; Task 4 for blocks.)*
- **Unterminated constructs at turn end** — an unclosed `**`, unclosed `[`, or unclosed code fence must flush sensibly (literal markers, or buffered code as code), never hang or leak ANSI. *(Tasks 1, 2, 4 — flush tests.)*
- **Non-TTY / batch output** — must be raw Markdown, not structurally rewritten (no `•`, no stripped fences, no rewritten links). *(Task 5 — sink-disabled + terminal-flag tests.)*
- **ANSI leak across lines** — a style opened on one line never bleeds into the next line, the status bar, or the input box. *(Task 1 — explicit no-leak test; holds for all later tasks.)*

---

### Task 1: Streaming skeleton, held-tail boundary, and inline code spans

**Files:**
- Create: `src/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `createMarkdownStream(): MarkdownStream`, `MarkdownStream = { write(delta: string): string; flush(): string }`. `write` returns ANSI bytes safe to emit now (everything up to the last position that cannot begin a markup construct); it holds the trailing ambiguous tail internally. `flush` returns the held remainder (unmatched markers rendered literally) and resets to a clean initial state. This task handles plain text and inline code spans (`` `…` ``) only; every later task extends this same module without changing the public signatures.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.ts`. Define reusable helpers at the top of the file:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownStream } from "../src/markdown.ts";

const render = (md: string): string => {
  const s = createMarkdownStream();
  return s.write(md) + s.flush();
};
// Feeding the same text split at every boundary must match render(md).
const assertChunkInvariant = (md: string): void => {
  const whole = render(md);
  for (let i = 0; i <= md.length; i++) {
    const s = createMarkdownStream();
    assert.equal(s.write(md.slice(0, i)) + s.write(md.slice(i)) + s.flush(), whole, `split at ${i}`);
  }
};
```

Tests:
```ts
test("plain text passes through and flushes clean", () => {
  assert.equal(render("hello world"), "hello world");
});
test("inline code is colored and backticks removed", () => {
  assert.equal(render("use `x = 1` now"), "use \x1b[33mx = 1\x1b[0m now");
});
test("inline code content is verbatim (no inner parsing)", () => {
  assert.equal(render("`**not bold**`"), "\x1b[33m**not bold**\x1b[0m");
});
test("an unmatched backtick stays literal", () => {
  assert.equal(render("a ` b"), "a ` b");
});
test("the ambiguous tail is held until the span closes", () => {
  const s = createMarkdownStream();
  const a = s.write("value ");
  const b = s.write("`code");
  const c = s.write("` done") + s.flush();
  assert.equal(b, ""); // nothing emitted while the code span is open
  assert.equal(a + b + c, "value \x1b[33mcode\x1b[0m done");
});
test("every emitted styled span is reset (no ANSI leak)", () => {
  assert.ok(render("`x`").endsWith("\x1b[0m"));
});
test("chunk-split invariance over text and code spans", () => {
  assertChunkInvariant("a `b c` d `e` f");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='code|plain|tail|leak|invariance'` (or `node --test test/markdown.test.ts`). Expected: FAIL — `createMarkdownStream` not found / module missing.

- [ ] **Step 3: Implement `createMarkdownStream` in `src/markdown.ts`.** A stateful scanner over accumulated input: emit plain characters immediately until a potential markup start (`` ` `` for this task), then hold from that point; when the matching closing backtick arrives, emit `\x1b[33m` + verbatim inner + `\x1b[0m` and resume; on `flush`, emit any held text literally and reset. Define the palette SGR constants at the top of the module for reuse by later tasks.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test -- --test-name-pattern='code|plain|tail|leak|invariance'`. Expected: PASS. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/markdown.ts test/markdown.test.ts
git commit -m "feat: streaming markdown renderer skeleton with inline code"
```

---

### Task 2: Emphasis and links

**Files:**
- Modify: `src/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: the inline scanner and held-tail mechanism from Task 1 (`createMarkdownStream`), unchanged signatures.
- Produces: the same `createMarkdownStream`, now also styling `**bold**`/`__bold__` → `\x1b[1m…\x1b[0m`, `*italic*`/`_italic_` → `\x1b[3m…\x1b[0m`, and `[text](url)` → `\x1b[4mtext\x1b[0m \x1b[2m(url)\x1b[0m`. An internal `renderInline(text: string): string` (whole-string inline pass) is available for Task 3's block content.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.ts`:
```ts
test("bold and italic are styled, markers removed", () => {
  assert.equal(render("a **b** c *d* e"), "a \x1b[1mb\x1b[0m c \x1b[3md\x1b[0m e");
  assert.equal(render("__x__ _y_"), "\x1b[1mx\x1b[0m \x1b[3my\x1b[0m");
});
test("a standalone asterisk stays literal", () => {
  assert.equal(render("2 * 3 = 6"), "2 * 3 = 6");
});
test("a link shows styled text then a dim URL", () => {
  assert.equal(render("see [docs](http://x)"), "see \x1b[4mdocs\x1b[0m \x1b[2m(http://x)\x1b[0m");
});
test("unterminated emphasis flushes literally", () => {
  assert.equal(render("**oops"), "**oops");
  assert.equal(render("[text"), "[text");
});
test("chunk-split invariance over emphasis and links", () => {
  assertChunkInvariant("x **b** y [t](http://z) *i* `c`");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='bold|asterisk|link|emphasis|invariance'`. Expected: FAIL — markers passed through literally / assertions mismatch.

- [ ] **Step 3: Extend the inline scanner** in `src/markdown.ts` to recognize `**`/`__`, `*`/`_`, and `[text](url)`, each held at the tail until resolved (`*` vs `**` disambiguated when the second char arrives; a span with no closer on the line flushes literal). Factor the whole-string inline pass as `renderInline`.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test -- --test-name-pattern='bold|asterisk|link|emphasis|invariance'`. Expected: PASS. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/markdown.ts test/markdown.test.ts
git commit -m "feat: markdown emphasis and link rendering"
```

---

### Task 3: Block constructs and spacing

**Files:**
- Modify: `src/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: `renderInline` and the stream from Tasks 1–2.
- Produces: per-logical-line block classification in `createMarkdownStream` — headings, unordered/ordered lists, blockquotes, thematic breaks — plus blank-line spacing. Line kind is resolved progressively (held until the line-start marker is unambiguous, e.g. `#` is held until the following space/newline proves it a heading).

Block rules (text portions run through `renderInline`):
- `#{1,6} ` at line start → strip the `#` markers and any trailing `#`s; emit `\x1b[1;36m` + heading text + `\x1b[0m`.
- `- `, `* `, or `+ ` at line start (after optional indent) → `• ` + content; each two leading spaces of indent adds two spaces before the bullet.
- `\d+. ` at line start → keep the marker: `N. ` + content.
- `> ` at line start → `\x1b[2m│ \x1b[0m` + content.
- A line of only `-`, `*`, or `_` repeated ≥3 → `\x1b[2m` + `"─".repeat(32)` + `\x1b[0m`.
- Blank lines: collapse any run of blank lines to a single blank line. Additionally ensure exactly one blank line before a heading and before/after a thematic break. No leading or trailing blank line is added at the very start or end of the output.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.ts`:
```ts
test("ATX heading is cyan-bold with markers stripped", () => {
  assert.equal(render("# Hello"), "\x1b[1;36mHello\x1b[0m");
  assert.equal(render("## Two ##"), "\x1b[1;36mTwo\x1b[0m");
});
test("a heading gets one blank line before and after", () => {
  assert.equal(render("intro\n# H\nbody"), "intro\n\n\x1b[1;36mH\x1b[0m\n\nbody");
});
test("unordered list items get a bullet; inline still applies", () => {
  assert.equal(render("- one\n- a **b**"), "• one\n• a \x1b[1mb\x1b[0m");
});
test("ordered list keeps its number", () => {
  assert.equal(render("1. first\n2. second"), "1. first\n2. second");
});
test("blockquote gets a dim bar", () => {
  assert.equal(render("> quoted"), "\x1b[2m│ \x1b[0mquoted");
});
test("thematic break becomes a dim rule", () => {
  assert.equal(render("a\n---\nb"), "a\n\n\x1b[2m" + "─".repeat(32) + "\x1b[0m\n\nb");
});
test("runs of blank lines collapse to one", () => {
  assert.equal(render("a\n\n\n\nb"), "a\n\nb");
});
test("chunk-split invariance over mixed block content", () => {
  assertChunkInvariant("# Title\n\nsome *text*\n\n- a\n- b\n\n> q\n\n---\n\nend");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='heading|list|blockquote|thematic|blank|block'`. Expected: FAIL — block markers shown literally / spacing wrong.

- [ ] **Step 3: Add line-kind classification and spacing** to `createMarkdownStream`, routing each line's content through `renderInline` and applying the block rules and blank-line policy above.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test -- --test-name-pattern='heading|list|blockquote|thematic|blank|block'`. Expected: PASS. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/markdown.ts test/markdown.test.ts
git commit -m "feat: markdown headings, lists, quotes, rules, and spacing"
```

---

### Task 4: Fenced and indented code blocks

**Files:**
- Modify: `src/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: the block classifier and stream from Task 3.
- Produces: code-block handling in `createMarkdownStream`. A line of ```` ``` ```` or `~~~` (≥3, optional info string) toggles code mode; the fence lines themselves are not printed. Inside code mode, each content line is emitted verbatim as `\x1b[33m` + line + `\x1b[0m` with no inline/block parsing. A paragraph-level line indented ≥4 spaces (not a list continuation) is a single indented-code line, same styling. One blank line is ensured before and after a fenced block. An unclosed fence at `flush` emits its buffered lines as code.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.ts`:
```ts
test("fenced code is colored verbatim; fences removed; markup not parsed", () => {
  assert.equal(render("```\nx = 1\n# not a heading\n```"),
    "\x1b[33mx = 1\x1b[0m\n\x1b[33m# not a heading\x1b[0m");
});
test("a fenced block gets one blank line before and after", () => {
  assert.equal(render("before\n```\ncode\n```\nafter"),
    "before\n\n\x1b[33mcode\x1b[0m\n\nafter");
});
test("an unclosed fence flushes its content as code", () => {
  assert.equal(render("```\nabc\ndef"), "\x1b[33mabc\x1b[0m\n\x1b[33mdef\x1b[0m");
});
test("a 4-space indented line is code (first 4 spaces stripped)", () => {
  assert.equal(render("text\n\n    code()\n\nmore"),
    "text\n\n\x1b[33mcode()\x1b[0m\n\nmore");
});
test("chunk-split invariance over a fenced block", () => {
  assertChunkInvariant("text\n```js\nconst a = `t`;\n```\nmore");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='fenced|code block|unclosed fence'`. Expected: FAIL — fence lines printed / inner markup parsed.

- [ ] **Step 3: Add code-block detection and verbatim rendering** to `createMarkdownStream`, taking priority over inline/block parsing while in code mode.

- [ ] **Step 4: Run to verify they pass.** Run: `npm test -- --test-name-pattern='fenced|code block|unclosed fence'`. Expected: PASS. Then run the whole renderer file `node --test test/markdown.test.ts` and `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/markdown.ts test/markdown.test.ts
git commit -m "feat: markdown fenced and indented code blocks"
```

---

### Task 5: Terminal `interactive` flag, sink, and REPL wiring

**Files:**
- Modify: `src/markdown.ts` (add `renderMarkdown` and `createMarkdownSink`)
- Modify: `src/terminal.ts` (add `interactive` to the interface and all three implementations)
- Modify: `src/screen.ts` (set `interactive: true`)
- Modify: `src/repl.ts` (wire the sink and flush points; render non-stream final text)
- Modify: `README.md`
- Test: `test/markdown.test.ts`, `test/batch_terminal.test.ts`

**Interfaces:**
- Consumes: `createMarkdownStream` from Tasks 1–4; `Terminal.write`, the clientHooks (`onTextDelta`), and helpers `say`/`showThinking` in `src/repl.ts`; the non-stream print site `src/repl.ts:985`.
- Produces: `renderMarkdown(text: string): string` = a one-shot `createMarkdownStream().write(text) + .flush()`; `createMarkdownSink(write: (s: string) => void, enabled: boolean): { text(delta: string): void; flush(): void }` — when `enabled`, routes each `text(delta)` through a persistent `MarkdownStream` and calls `write` with the result, and `flush()` writes the stream's held tail and resets; when `!enabled`, `text` writes the delta raw and `flush` is a no-op. New terminal field `readonly interactive: boolean` (screen → `true`, line → `tty`, batch → `false`).

- [ ] **Step 1: Write the failing tests.** In `test/markdown.test.ts`:
```ts
import { createMarkdownSink, renderMarkdown } from "../src/markdown.ts";

test("renderMarkdown is a one-shot render", () => {
  assert.equal(renderMarkdown("**hi**"), "\x1b[1mhi\x1b[0m");
});
test("an enabled sink routes deltas through the renderer", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, true);
  sink.text("**h"); sink.text("i**"); sink.flush();
  assert.equal(out, "\x1b[1mhi\x1b[0m");
});
test("a disabled sink passes deltas through raw", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, false);
  sink.text("**hi**"); sink.flush();
  assert.equal(out, "**hi**");
});
test("flush resets the sink for the next run", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, true);
  sink.text("`a"); sink.flush();      // unterminated → literal
  out = "";
  sink.text("`b`"); sink.flush();      // fresh state
  assert.equal(out, "\x1b[33mb\x1b[0m");
});
```
In `test/batch_terminal.test.ts`:
```ts
test("batch terminal is not interactive", () => {
  assert.equal(createBatchTerminal("p", () => {}).interactive, false);
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='sink|one-shot|not interactive|resets'`. Expected: FAIL — `createMarkdownSink`/`renderMarkdown` missing, `interactive` undefined.

- [ ] **Step 3: Implement `renderMarkdown` and `createMarkdownSink`** in `src/markdown.ts`.

- [ ] **Step 4: Add `readonly interactive: boolean` to `Terminal`** in `src/terminal.ts`; set `interactive: false` in `createBatchTerminal`, `interactive: tty` in `createLineTerminal`, and `interactive: true` in `createScreen` (`src/screen.ts`).

- [ ] **Step 5: Wire the REPL** in `src/repl.ts`: after `term` is created, `const mdSink = createMarkdownSink((s) => term.write(s), term.interactive);`. In `onTextDelta`, replace `term.write(text)` with `mdSink.text(text)` (keep `streamedChars += text.length`). Call `mdSink.flush()` at the top of `say` and `showThinking`, and in the `onResponse` and `onRequest` clientHooks. At `src/repl.ts:985`, render the final text: `say(term.interactive ? renderMarkdown(result.finalText) : result.finalText)`.

- [ ] **Step 6: Run the tests.** Run: `npm test -- --test-name-pattern='sink|one-shot|not interactive|resets'`. Expected: PASS. Then the full suite `npm test` (all pass) and `npx tsc --noEmit` (clean).

- [ ] **Step 7: Document** in `README.md`: a short note that model output is rendered as styled Markdown in an interactive terminal (headings, emphasis, code, lists, quotes, rules), and that piped/`--prompt-file` output stays raw Markdown.

- [ ] **Step 8: Commit.**
```bash
git add src/markdown.ts src/terminal.ts src/screen.ts src/repl.ts README.md test/markdown.test.ts test/batch_terminal.test.ts
git commit -m "feat: render model output as markdown in interactive terminals"
```

**Note for the reviewer:** the REPL call-site wiring (Step 5) is not exercised by a unit test (there is no `repl.ts` test harness); it is covered by the sink's own tests, the terminal-flag tests, `tsc`, and the full suite. Verify the flush points and the line-985 render by reading the diff.
