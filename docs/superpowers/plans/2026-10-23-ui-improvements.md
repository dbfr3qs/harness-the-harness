# Terminal UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six sequenced UI improvements to the harness terminal: richer tool call/result display, syntax-highlighted code blocks, turn separators, markdown-rendered (dim) thinking, clickable OSC 8 links, and a visual context gauge.

**Architecture:** Build on the existing TUI (`src/screen.ts`, `src/terminal.ts`, `src/repl.ts`) and the merged markdown renderer (`src/markdown.ts`, which already exposes `createMarkdownStream`, `createMarkdownSink`, `renderInline`, `renderMarkdown`, palette consts, and a `term.interactive` TTY gate). New pure, unit-tested modules (`src/tool_display.ts`, `src/highlight.ts`) hold formatting logic; `src/repl.ts`/`src/screen.ts` wire it in. All ANSI styling stays gated to interactive TTYs; batch/piped output is unchanged.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), `node:test` + `node:assert/strict`, zero runtime dependencies, ANSI SGR + OSC escape codes.

**Spec:** none (design decisions captured inline per feature below, per the user's request to skip a separate design doc).

## Global Constraints

- Zero runtime dependencies; Node 24; `npx tsc --noEmit` stays clean; TDD with `node:test` + `node:assert/strict`; test command `npm test` (baseline 421 passing).
- Reuse existing building blocks: `src/markdown.ts` (`createMarkdownStream`, `createMarkdownSink`, `renderInline`, palette consts, `styled()`), `src/context_meter.ts` (`contextBar`, `contextSummary`), `src/terminal.ts` (`dimText`, `Terminal.interactive`).
- All new ANSI styling applies ONLY on an interactive TTY (`term.interactive`). Batch (`createBatchTerminal`) and non-TTY line mode must be unaffected: structural additions (e.g. a result preview) may still appear as plain text, but no raw escape sequence may leak — OSC 8 sequences in particular are NOT stripped by the existing `\x1b[...m` filter, so they must only be emitted on a TTY.
- Pure formatting modules (`src/tool_display.ts`, `src/highlight.ts`) are deterministic and unit-tested; **syntax highlighting never alters code characters** — stripping ANSI from highlighted output must equal the original input exactly.
- No ANSI leak: every styled span/line ends reset; a style never bleeds into the next line, the input box, or the status bar.
- Width math stays correct: `src/screen.ts` `outputBytes` must skip BOTH CSI (`\x1b[…`) and OSC (`\x1b]…` terminated by `\x07` or `\x1b\\`) sequences when measuring columns, so styled/linked output wraps at the right visible column.
- New palette colors are pinned to exact SGR codes in the task that introduces them.

## Review Focus

- **Screen-mode width with OSC/CSI** — a line containing an OSC 8 link (or any styled run) must wrap at the correct *visible* column; `outputBytes` must not count escape bytes. (Task 6.)
- **Huge / binary tool results** — a multi-megabyte or thousand-line tool result must be bounded by the preview truncation (never dumped), and non-TTY output must keep today's behavior. (Task 1.)
- **Highlighting must be lossless** — strip-ANSI(highlight(code)) === code for every language and for unknown languages; no color leaks past a code line. (Tasks 2–3.)
- **Thinking vs answer isolation** — dim thinking must not bleed color into the following answer text or the status bar, and the thinking/answer flush ordering must not interleave their bytes. (Task 5.)
- **Non-TTY / batch safety** — tool previews, highlighting, separators, links, and the gauge must be absent or cleanly stripped on non-TTY/batch, so programs/evals consuming stdout are unaffected (OSC 8 especially). (Tasks 1, 6, all wiring.)

---

## Feature 1 — Tool call & result display

Design calls: the tool-call line keeps its `→` but the arrow+tool name are colored (cyan `\x1b[36m`) with the arguments dim; in NON-verbose mode a *successful* result now shows a compact preview (previously hidden) — indented 4 spaces, dim, at most 8 lines and 800 chars, with a final `    … +K more lines` / `… (truncated)` marker when clipped; errors keep the `✗` marker plus the same preview. Verbose mode is unchanged (full JSON call + full result). All formatting lives in a pure module so it is unit-tested; the preview is bounded so a huge result can never flood the screen.

### Task 1: Tool call & result formatting

**Files:**
- Create: `src/tool_display.ts`
- Test: `test/tool_display.test.ts`
- Modify: `src/repl.ts` (tool-call line at ~363, result handling at ~368-369)

**Interfaces:**
- Produces:
  - `toolCallLine(name: string, description: string): string` — `  → ` with `→ ` + `name` in cyan (`\x1b[36m`) + `description` dimmed, each span reset.
  - `formatToolResult(content: string, opts?: { maxLines?: number; maxChars?: number; error?: boolean }): string[]` — preview lines, each dimmed and indented 4 spaces; defaults `maxLines: 8`, `maxChars: 800`; when truncated the last line is `    … +<K> more lines` (by line count) or `    … (truncated)` (by char cap); `error: true` prefixes the first line with `✗ `. Empty/whitespace content → `[]`.
- Consumes: `dimText` from `src/terminal.ts`, `describeCall`/`oneLine` already in `src/repl.ts` (keep producing the description string there and pass it in).

- [ ] **Step 1: Write failing tests** in `test/tool_display.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallLine, formatToolResult } from "../src/tool_display.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("call line colors the arrow and tool name, dims the args", () => {
  const line = toolCallLine("run_shell", "run_shell id");
  assert.equal(strip(line), "  → run_shell id");
  assert.match(line, /\x1b\[36m/); // cyan present
});
test("result preview is dimmed, indented, and bounded by lines", () => {
  const out = formatToolResult("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", { maxLines: 3 });
  assert.equal(out.length, 4); // 3 lines + the truncation marker
  assert.equal(strip(out[0]!), "    a");
  assert.equal(strip(out[3]!), "    … +7 more lines");
});
test("result preview is bounded by chars", () => {
  const out = formatToolResult("x".repeat(5000), { maxChars: 100 });
  assert.ok(strip(out.join("\n")).length <= 140); // content + marker, well under 5000
  assert.match(strip(out.at(-1)!), /truncated/);
});
test("error result is marked", () => {
  const out = formatToolResult("boom", { error: true });
  assert.match(strip(out[0]!), /^    ✗ boom/);
});
test("empty content yields no preview", () => {
  assert.deepEqual(formatToolResult("   "), []);
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/tool_display.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/tool_display.ts`** with `toolCallLine` and `formatToolResult` per the interfaces.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/tool_display.test.ts`. Expected: PASS.

- [ ] **Step 5: Wire into `src/repl.ts`.** In `onToolCall`, non-verbose branch, print `say(toolCallLine(call.name, describeCall(call)))`. In `onToolResult`, non-verbose branch, print each line of `formatToolResult(oneLine-free raw content string, { error: outcome.isError })` via `say` (use the raw result content, not `oneLine`, so multi-line preview works). Keep the verbose branch unchanged.

- [ ] **Step 6: Run full suite + tsc.** Run: `npm test` (all pass) and `npx tsc --noEmit` (clean).

- [ ] **Step 7: Commit.**
```bash
git add src/tool_display.ts test/tool_display.test.ts src/repl.ts
git commit -m "feat: richer tool call lines and bounded result previews"
```

---

## Feature 2 — Syntax highlighting in code blocks

Design calls: a zero-dependency, best-effort, per-line highlighter. The fenced block's info string selects a language; `sh`/`bash`/`zsh`/`shell` get a shell pass, everything else (and unknown/none) gets a generic pass (double/single-quoted strings, `#` and `//` line comments, numbers, and a common keyword set). Highlighting only ADDS color — characters are never changed. Indented and inline code stay single-color (no language context). Colors (pinned): strings green `\x1b[32m`, comments dim `\x1b[2m`, numbers/keywords magenta `\x1b[35m`, base code yellow `\x1b[33m` (the existing `CODE`). Highlighting is per-line (block comments / multi-line strings are highlighted line-by-line, best-effort).

### Task 2: The highlighter

**Files:**
- Create: `src/highlight.ts`
- Test: `test/highlight.test.ts`

**Interfaces:**
- Produces: `highlightCodeLine(line: string, lang?: string): string` — returns the line fully styled with the base code color (`\x1b[33m`) plus token colors, ending in a single reset; token spans re-assert the base color after their own reset so the base color never drops mid-line. For an unknown/empty `lang` it returns the generic-pass highlight (NOT plain) — but `highlightCodeLine(line)` with no recognizable tokens equals `\x1b[33m` + line + `\x1b[0m`. **Stripping all ANSI from the result always equals `line` exactly.**

- [ ] **Step 1: Write failing tests** in `test/highlight.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCodeLine } from "../src/highlight.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("characters are never altered (lossless)", () => {
  for (const [line, lang] of [["const x = 42; // hi", "js"], ["echo \"hi\" # c", "bash"], ["weird ~!@#$ stuff", undefined]] as const) {
    assert.equal(strip(highlightCodeLine(line, lang)), line);
  }
});
test("plain line with no tokens is just base code color", () => {
  assert.equal(highlightCodeLine("plain text", "text"), "\x1b[33mplain text\x1b[0m");
});
test("a string literal is colored green and line still ends reset", () => {
  const out = highlightCodeLine('x = "hi"', "python");
  assert.match(out, /\x1b\[32m"hi"/);
  assert.ok(out.endsWith("\x1b[0m"));
});
test("a comment is dimmed", () => {
  assert.match(highlightCodeLine("x = 1 # note", "python"), /\x1b\[2m# note/);
});
test("a keyword is colored", () => {
  assert.match(highlightCodeLine("if x:", "python"), /\x1b\[35mif\x1b/);
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/highlight.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/highlight.ts`.** A single-pass tokenizer over the line: recognize strings, line comments (`#` for shell/python-like, `//` for c-like; pick by lang, default both), numbers, and keywords (a shared keyword set plus shell command/flag heuristics). Non-token runs keep the base code color; token spans use their color then re-assert `\x1b[33m`. Normalize the lang via a small alias map.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/highlight.test.ts`. Expected: PASS. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/highlight.ts test/highlight.test.ts
git commit -m "feat: lossless per-line code syntax highlighter"
```

### Task 3: Integrate highlighting into markdown code blocks

**Files:**
- Modify: `src/markdown.ts` (fenced code-block rendering; capture the fence info string as the language)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: `highlightCodeLine(line, lang?)` from Task 2; the existing code-block state machine in `createMarkdownStream`.
- Produces: fenced code lines rendered via `highlightCodeLine(line, lang)` where `lang` is the fence info string (first word). Indented code blocks and inline code are unchanged (plain `\x1b[33m`, no highlighting). Chunk-split invariance and no-ANSI-leak still hold.

- [ ] **Step 1: Write failing tests** in `test/markdown.test.ts` (reuse the existing `render`/`assertChunkInvariant` helpers at the top):
```ts
test("fenced code is syntax-highlighted by its info string", () => {
  const out = render("```python\nx = \"hi\" # c\n```");
  assert.match(out, /\x1b\[32m"hi"/);   // string green
  assert.match(out, /\x1b\[2m# c/);     // comment dim
  // still lossless: stripping ANSI leaves the code line
  assert.ok(out.replace(/\x1b\[[0-9;]*m/g, "").includes('x = "hi" # c'));
});
test("fenced code with no/unknown info string stays plain yellow", () => {
  assert.equal(render("```\nplain\n```"), "\x1b[33mplain\x1b[0m");
});
test("highlighted fenced block is still chunk-invariant", () => {
  assertChunkInvariant("text\n```js\nconst a = 1; // x\n```\nmore");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='highlighted|info string'`. Expected: FAIL (code rendered plain).

- [ ] **Step 3: Implement.** Capture the opening fence's info string (first token) as `lang`; render each in-fence content line with `highlightCodeLine(line, lang)` instead of the plain `CODE`+line+reset. Leave indented/inline code untouched.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/markdown.test.ts` (all pass). Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/markdown.ts test/markdown.test.ts
git commit -m "feat: syntax-highlight fenced code blocks by language"
```

---

## Feature 3 — Turn & section separators

Design calls: a dim full-width horizontal rule marks the boundary between turns, printed at the start of each assistant turn (both screen and line mode), and the screen-mode user-input echo gains a colored prompt glyph. The rule width comes from the terminal width (`cols()` in screen mode; `process.stdout.columns ?? 80` in line mode). Minimal and reversible — no change to how tool/thinking lines themselves are printed (grouping of tool results under calls is Feature 1's indentation).

### Task 4: Turn separators and user-echo styling

**Files:**
- Create: `src/turn_marks.ts`
- Test: `test/turn_marks.test.ts`
- Modify: `src/repl.ts` (print the rule at the start of a user-initiated turn), `src/screen.ts` (`submit`, line ~284 — color the echoed prompt)

**Interfaces:**
- Produces: `turnRule(width: number): string` — a dim rule `\x1b[2m` + `"─".repeat(Math.max(1, width))` + `\x1b[0m`. Default caller width: screen `cols()`, line `process.stdout.columns ?? 80`.
- Consumes: nothing new.

- [ ] **Step 1: Write failing tests** in `test/turn_marks.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnRule } from "../src/turn_marks.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
test("turnRule is a dim rule of the given width", () => {
  assert.equal(strip(turnRule(5)), "─────");
  assert.match(turnRule(5), /^\x1b\[2m/);
  assert.ok(turnRule(5).endsWith("\x1b[0m"));
});
test("turnRule clamps to at least one cell", () => {
  assert.equal(strip(turnRule(0)), "─");
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/turn_marks.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/turn_marks.ts`** with `turnRule`.

- [ ] **Step 4: Wire in.** In `src/repl.ts`, print `turnRule(width)` (via `say`) once at the start of each turn that begins from a user prompt (not between the model's own tool steps), only when `term.interactive`. In `src/screen.ts` `submit`, change the echoed prompt from `\x1b[1m${PROMPT}\x1b[0m` to a cyan glyph form (e.g. `\x1b[36m❯ \x1b[0m`) — keep the text itself unstyled.

- [ ] **Step 5: Add a screen-echo assertion** to `test/screen.test.ts`: after typing and submitting, the echoed line contains the new colored prompt glyph and the text (assert on `t.output()`/`t.raw()`).

- [ ] **Step 6: Run full suite + tsc.** Run: `npm test` (all pass), `npx tsc --noEmit` (clean).

- [ ] **Step 7: Commit.**
```bash
git add src/turn_marks.ts test/turn_marks.test.ts src/repl.ts src/screen.ts test/screen.test.ts
git commit -m "feat: turn separators and a colored user-prompt glyph"
```

---

## Feature 4 — Render thinking through the markdown pipeline (dim)

Design calls: add a `dim` option to the markdown stream/sink. In dim mode, all markup markers are still removed and block structure (headings, bullets, quotes, rules) is still produced, but every style is `\x1b[2m` (dim) instead of the colored palette, and code is dim (no syntax highlighting). The REPL feeds thinking deltas through a dim markdown sink, keeping the leading `✻` marker, so thinking reads like muted markdown instead of raw markup. The dim option defaults off, so Features 1–3/5/6 (answer rendering) are unaffected.

### Task 5: Dim markdown mode + thinking wiring

**Files:**
- Modify: `src/markdown.ts` (`createMarkdownStream`, `createMarkdownSink`, `renderMarkdown` gain an options arg with `dim?: boolean`)
- Modify: `src/repl.ts` (`showThinking`/`onThinkingDelta`/`endThinking` use a dim markdown sink)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `createMarkdownStream(opts?: { dim?: boolean })`, `createMarkdownSink(write, enabled, opts?: { dim?: boolean })`, `renderMarkdown(text, opts?: { dim?: boolean })`. In dim mode every emitted style is `\x1b[2m` and no syntax highlighting is applied; markers are still removed and structure still produced; still ends every span reset; still chunk-invariant.
- Consumes: the existing stream machinery; the `term.interactive` gate and flush points from the merged markdown integration.

- [ ] **Step 1: Write failing tests** in `test/markdown.test.ts`:
```ts
const renderDim = (md: string) => { const s = createMarkdownStream({ dim: true }); return s.write(md) + s.flush(); };
test("dim mode styles everything dim, no palette colors, markers gone", () => {
  const out = renderDim("# H\n\n**b** `c`");
  assert.ok(!out.includes("\x1b[1;36m") && !out.includes("\x1b[33m")); // no heading cyan / code yellow
  assert.match(out, /\x1b\[2m/);                                       // dim present
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!stripped.includes("#") && !stripped.includes("**") && !stripped.includes("`")); // markers removed
});
test("dim mode still ends reset and is chunk-invariant", () => {
  const whole = renderDim("a **b** c");
  assert.ok(whole.endsWith("\x1b[0m") || !whole.includes("\x1b["));
  // split invariance in dim mode
  for (let i = 0; i <= "a **b** c".length; i++) {
    const s = createMarkdownStream({ dim: true });
    assert.equal(s.write("a **b** c".slice(0, i)) + s.write("a **b** c".slice(i)) + s.flush(), whole);
  }
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='dim mode'`. Expected: FAIL (option unsupported).

- [ ] **Step 3: Implement the `dim` option** in `src/markdown.ts`: thread a flag so `styled()`/block prefixes use `\x1b[2m` and code paths skip `highlightCodeLine` (emit dim). Keep the default (no opts) identical to today.

- [ ] **Step 4: Wire thinking in `src/repl.ts`.** Replace the ad-hoc dim thinking printing with a dim markdown sink (`createMarkdownSink((s) => term.write(s), term.interactive, { dim: true })`), fed by `onThinkingDelta`, prefixed by the `✻ ` marker on first output of a thinking run; flush it in `endThinking` and at the turn boundaries where the answer sink flushes. Keep thinking visually distinct (the `✻` + dim).

- [ ] **Step 5: Run full suite + tsc.** Run: `npm test` (all pass), `npx tsc --noEmit` (clean).

- [ ] **Step 6: Commit.**
```bash
git add src/markdown.ts src/repl.ts test/markdown.test.ts
git commit -m "feat: render thinking as muted (dim) markdown"
```

---

## Feature 5 — Clickable links (OSC 8)

Design calls: rendered links wrap their text in an OSC 8 hyperlink so terminals that support it make the text clickable; the dim `(url)` suffix stays for visibility and as a fallback. OSC 8 is emitted only inside the renderer, which already runs only on an interactive TTY — important because the non-TTY color filter does NOT strip OSC sequences. Because OSC 8 sequences are non-printing, `src/screen.ts` `outputBytes` must be taught to skip them when measuring width (today it only skips CSI), or links would wrap at the wrong column and show escape bytes.

### Task 6: OSC 8 links + screen width handling

**Files:**
- Modify: `src/markdown.ts` (link rendering)
- Modify: `src/screen.ts` (`outputBytes` width scan, ~line 128; and `textWidth`/`fit` if they share the escape regex)
- Test: `test/markdown.test.ts`, `test/screen.test.ts`

**Interfaces:**
- Consumes: the existing link rendering in `renderInline`.
- Produces: a link `[text](url)` renders as `\x1b]8;;url\x1b\\` + `\x1b[4mtext\x1b[0m` + `\x1b]8;;\x1b\\` + ` ` + `\x1b[2m(url)\x1b[0m` (OSC 8 open, styled text, OSC 8 close, space, dim url). `src/screen.ts` width measurement treats an OSC sequence (`\x1b]` … terminated by `\x07` or `\x1b\\`) as zero-width, same as CSI.

- [ ] **Step 1: Write failing tests.** In `test/markdown.test.ts`:
```ts
test("a link is wrapped in an OSC 8 hyperlink and keeps the dim url", () => {
  const out = render("[docs](http://x)");
  assert.ok(out.includes("\x1b]8;;http://x\x1b\\")); // OSC 8 open
  assert.ok(out.includes("\x1b]8;;\x1b\\"));          // OSC 8 close
  assert.match(out, /\x1b\[4mdocs\x1b\[0m/);          // styled text
  assert.match(out, /\x1b\[2m\(http:\/\/x\)\x1b\[0m/); // dim url kept
});
```
In `test/screen.test.ts` (an OSC 8 link counts only its visible text width):
```ts
test("textWidth ignores OSC 8 hyperlink sequences", () => {
  assert.equal(textWidth("\x1b]8;;http://x\x1b\\docs\x1b]8;;\x1b\\"), 4);
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm test -- --test-name-pattern='OSC 8|ignores OSC'`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/markdown.ts` link rendering, wrap the text span in OSC 8 open/close around the existing styled text, keeping the dim url. In `src/screen.ts`, extend the escape-skipping in `outputBytes` (and the shared `textWidth`/`fit` regex) to also match OSC sequences `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/markdown.test.ts test/screen.test.ts` (pass). Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Run full suite.** Run: `npm test` (all pass).

- [ ] **Step 6: Commit.**
```bash
git add src/markdown.ts src/screen.ts test/markdown.test.ts test/screen.test.ts
git commit -m "feat: OSC 8 clickable links with correct screen width"
```

---

## Feature 6 — Visual context gauge

Design calls: the status bar's context segment gains a short colored bar. Reuse `contextBar` for the glyphs at a small width (10), colored by fill: green `\x1b[32m` under 0.7, yellow `\x1b[33m` from 0.7 to the existing `WARN_AT` region up to 0.9, red `\x1b[31m` at/above 0.9. The gauge is a new helper used by the screen status bar; the end-of-turn `[tokens…]` line and the `/context` report are unchanged.

### Task 7: Context gauge

**Files:**
- Modify: `src/context_meter.ts` (add `contextGauge`)
- Modify: `src/repl.ts` (`updateStatus` — use the gauge in the context segment)
- Test: `test/context_meter.test.ts`

**Interfaces:**
- Consumes: `contextBar(fraction, width)` (exists).
- Produces: `contextGauge(fraction: number, width?: number): string` — `<color>` + `contextBar(fraction, width ?? 10)` + `\x1b[0m`, color = green `<0.7`, yellow `0.7..<0.9`, red `>=0.9`. Stripping ANSI equals `contextBar(fraction, width)`.

- [ ] **Step 1: Write failing tests** in `test/context_meter.test.ts`:
```ts
import { contextGauge, contextBar } from "../src/context_meter.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
test("gauge glyphs match contextBar and strip cleanly", () => {
  assert.equal(strip(contextGauge(0.3, 10)), contextBar(0.3, 10));
});
test("gauge color reflects fill level", () => {
  assert.match(contextGauge(0.3), /\x1b\[32m/); // green
  assert.match(contextGauge(0.8), /\x1b\[33m/); // yellow
  assert.match(contextGauge(0.95), /\x1b\[31m/); // red
  assert.ok(contextGauge(0.5).endsWith("\x1b[0m"));
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/context_meter.test.ts`. Expected: FAIL (`contextGauge` missing).

- [ ] **Step 3: Implement `contextGauge`** in `src/context_meter.ts`.

- [ ] **Step 4: Wire into `src/repl.ts` `updateStatus`.** When the window is known, prefix (or replace the `(NN%)` of) the context segment with `contextGauge(used/window)` so the status bar shows the bar; keep the textual `used/window` figure. Screen-only (the status bar is screen-only already).

- [ ] **Step 5: Run full suite + tsc.** Run: `npm test` (all pass), `npx tsc --noEmit` (clean).

- [ ] **Step 6: Commit.**
```bash
git add src/context_meter.ts src/repl.ts test/context_meter.test.ts
git commit -m "feat: colored context gauge in the status bar"
```

---

## Notes for execution

- Features are independent and ordered; the branch can be merged or paused after any feature's task(s). Tasks 2→3 (highlighter then its integration) and Task 5's dim option both touch `src/markdown.ts`; Task 6 also touches `src/screen.ts` — sequence them in order to avoid conflicts.
- REPL wiring (Tasks 1, 4, 5, 7) is not unit-testable (no repl harness); it is covered by the pure modules' tests, `tsc`, the full suite, and review-by-reading — call this out in each of those tasks' reports.
