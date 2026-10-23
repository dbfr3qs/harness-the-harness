# Terminal Markdown Rendering — Design

**Date:** 2026-10-23
**Status:** Approved for planning (pending human sign-off)

## Intent & Why

The harness prints the model's answer text to the terminal exactly as it
arrives from the API: raw Markdown source. Because text streams in
token-by-token (`onTextDelta → term.write(text)`, `src/repl.ts:306`),
nothing on the output path ever sees a complete Markdown construct — a
whole `**bold**` span, a closed ```` ``` ```` fence, a full heading line —
so nothing can be styled. The result (see the motivating screenshot) is a
wall of literal markup: `**3. File Upload → webshell → RCE**`, backticks
around every code span, `##` and `**N.**` headings, no visual hierarchy,
no color, and little vertical breathing room. It is hard to scan and hard
to parse.

This feature adds a small, zero-dependency Markdown→ANSI renderer for
model answer text, so headings, emphasis, code, lists, quotes, and rules
are shown as styled, spaced, colored terminal output instead of raw
source — while keeping the live, streaming feel of watching the model
produce the answer.

## Goals

- Model answer text is rendered as styled ANSI, not raw Markdown markup.
- Rendering is **progressive during streaming**: prose flows out roughly
  word-by-word (styled text is emitted up to the last safe boundary — the
  last whitespace that is not inside an open inline span — holding only a
  small tail that might still begin markup), so the turn keeps today's
  live typing feel. Block constructs (headings, list items, blockquotes,
  rules) get their styled prefix as soon as the line's kind is known, then
  their text streams progressively in that context; a fenced code block's
  contents stream as verbatim code, with the fence lines themselves not
  printed. The decode-speed indicator keeps ticking.
- Covered elements (the common set), each losing its raw markers:
  - ATX headings `#`…`######` — bold cyan, blank line above.
  - `**bold**` / `__bold__` → bold; `*italic*` / `_italic_` → italic.
  - Inline code `` `x` `` → a distinct color (yellow), backticks removed.
  - Fenced code blocks (```` ``` ````/`~~~`) and indented code blocks →
    the same code color, one color only (no language highlighting). The
    fence lines themselves are not printed.
  - Unordered lists (`-`, `*`, `+`) → a `•` bullet; ordered lists keep
    their number. One level of nesting is indented; deeper nesting is
    indented uniformly (not necessarily pixel-perfect).
  - Blockquotes (`>`) → a dim `│ ` bar, then the quote's inline-rendered
    text.
  - Thematic breaks (`---`, `***`, `___`) → a dim `───…` rule.
  - Links `[text](url)` → the link text, styled, followed by the URL
    dimmed in parentheses.
- Consistent vertical spacing: one blank line around headings, code
  blocks, and thematic breaks, and between block elements, so output is
  not a wall. Runs of blank lines are collapsed to at most one.
- Rendering happens only when output goes to an interactive TTY; machines
  and pipes get raw, lossless text:
  - **Screen mode** (`createScreen`): always interactive. The renderer
    emits logical lines with inline ANSI and lets the screen do its own
    width-aware wrapping (`outputBytes`, `src/screen.ts:119`), which
    already skips ANSI escapes when measuring columns.
  - **Line mode** (`createLineTerminal`): renders only when attached to a
    TTY (the real terminal wraps). When output is **not** a TTY
    (redirected/piped), the model's text is passed through as raw Markdown
    — lossless and parseable by whatever consumes it — rather than being
    structurally rewritten.
  - **Batch mode** (`createBatchTerminal`, the `--prompt-file` /
    unattended agent path, e.g. ExploitGym): raw passthrough, no
    rendering. Its stdout is consumed programmatically, so the lossy
    structural transforms (stripped fences, `•` bullets, rewritten links)
    must not touch it.
- The `[tokens … · context … · decode …]` status/footer line and the
  tool-call/▸retry/system lines (`say(...)`) are unchanged.

## Non-Goals

- No language-aware syntax highlighting inside code blocks (v1: one color).
- No rendering of **thinking** output — it stays as it is today (dim).
  (A later change could route thinking through the same renderer.)
- No tables, footnotes, or other extended Markdown as *structured* output;
  they render as plain styled lines, never crash.
- No re-flowing or hard-wrapping of prose inside the renderer; wrapping
  stays owned by the screen / the terminal.
- No change to how tool calls, approvals, retries, or slash-command output
  are printed.
- No configurability/themes in v1 (a single built-in palette). A toggle or
  palette could come later.

## Anti-Goals (would make this a failure even if it "worked")

- Losing the live streaming feel — e.g. buffering the whole turn before
  painting (that was option B; rejected).
- Mangling code blocks: whitespace, indentation, and the literal
  characters inside a code block must be preserved verbatim (no emphasis
  parsing, no bullet parsing, no backtick stripping *inside* code).
- Wrong wrapping: colored output must wrap at the correct column in screen
  mode (relies on the ANSI-aware width math already in `outputBytes`).
- Leaking ANSI state: every styled span/line must reset (`\x1b[0m`) so a
  color can't bleed into the panel, the status bar, or a later line.
- A partial line left unstyled or unflushed when text is interrupted by a
  tool call or the turn ends.

## Constraints

- **Zero runtime dependencies.** Hand-rolled ANSI; no Markdown library.
  Node 24, native TypeScript type-stripping, `tsc --noEmit` clean.
- Tests via `node:test` + `node:assert/strict`; TDD.
- The renderer must be a pure, unit-testable module: given Markdown text
  (whole or in arbitrary streamed chunks), it produces deterministic ANSI
  output. No terminal, timers, or globals inside it.
- Must not break the existing screen/line terminal contracts or the menu
  work already merged.

## The How — decisions made

### Streaming model: a stateful progressive renderer

A new module (working name `src/markdown.ts`) exposes a small stateful
renderer, created once per model text run:

- `write(delta: string): string` — accumulates deltas and returns the ANSI
  bytes for everything it can now emit *safely*. Within prose, that is
  styled text up to the last boundary that cannot be the start of a markup
  construct (the last whitespace outside any open inline span), holding
  only the small trailing tail that might still begin `**`/`*`/`` ` ``/`[`
  etc. — so a marker is never printed as a literal and then retracted.
  Block structure is decided per line: once the current line's kind is
  known (heading, list item, blockquote, rule, code fence) its fixed prefix
  (color, `•`, `│ `) is emitted and the remaining text streams
  progressively in that context. Inside a fenced code block, content
  streams as verbatim code (no inline/list/emphasis parsing); the fence
  lines themselves are not printed.
- `flush(): string` — returns the ANSI bytes for whatever remains buffered
  (the held tail, an unterminated final line, or an unclosed code block
  rendered as code), and resets to a clean state.

State it carries across deltas within a run: whether inside a fenced code
block (and the fence marker/indent), the current line's kind, the held
inline tail, and minimal list/blockquote context needed for spacing. Block
constructs in Markdown are line-oriented; inline spans
(bold/italic/code/links) live within a single line, and the held tail is
what makes progressive emission safe across arbitrary chunk boundaries.

Rationale: prose keeps flowing word-by-word (today's live feel preserved),
while each construct is only styled once enough of it is seen to be
unambiguous, and the held tail guarantees a span is never emitted
half-recognized. This is option A2 from the brainstorm.

### Integration (left mostly to the plan, but fixed in shape)

- `repl.ts` owns one renderer instance for the current text run. In
  `onTextDelta`, feed the delta through `write(...)` and `term.write(...)`
  the returned bytes (still counting `streamedChars` for the speed meter).
- The renderer is only inserted on the interactive-TTY output paths
  (screen mode, and line mode when `tty`); the raw-passthrough paths
  (batch, non-TTY line mode) `term.write` the delta unchanged.
- The buffered partial line must be **flushed** before any non-answer
  output interrupts it and at turn end — i.e. before a tool-call line is
  printed (`onToolCall`), before thinking output is shown
  (`showThinking` / `onThinkingDelta`), before a retry/system `say(...)`,
  and at `onResponse`. Flushing resets the renderer so the next text run
  starts clean. The plan picks the exact flush points; the contract is: no
  raw partial line is ever left on screen, and no ANSI state leaks past a
  flush.
- Non-streaming mode (`config.stream === false`): the full answer text is
  available in `onResponse`; render it through the same module
  (`write(text) + flush()`) before printing.

### Palette (single built-in; ANSI SGR)

| Element        | Styling                                      |
|----------------|----------------------------------------------|
| Heading        | bold cyan (`\x1b[1;36m`), blank line above   |
| Bold           | bold (`\x1b[1m`)                             |
| Italic         | italic (`\x1b[3m`)                           |
| Inline code    | yellow (`\x1b[33m`)                          |
| Code block     | yellow (`\x1b[33m`), same color as inline    |
| Link text      | underlined (`\x1b[4m`); URL dim in parens    |
| Blockquote     | dim (`\x1b[2m`) with a `│ ` prefix           |
| Bullet         | `•`                                          |
| Thematic break | dim `─` repeated                             |

Reuses the existing `dimText` convention (`\x1b[2m`, `src/terminal.ts:53`).
Italic (`\x1b[3m`) is not universally supported; acceptable graceful
degradation. The palette is intentionally small and can be revised during
review.

## What's left to the builder

- The exact parsing approach inside `write`/`flush` (line classification +
  inline span pass), and how much list/nesting state to track — as long as
  the covered elements render correctly and code blocks are verbatim.
- The precise set of flush points in `repl.ts` and how the renderer
  instance's lifecycle is tied to a text run, meeting the flush contract
  above.
- Test cases: at minimum — each element renders and drops its markers;
  code blocks preserve contents verbatim and ignore inline/list syntax;
  chunk-splitting invariance (the same Markdown fed as one string vs. split
  at arbitrary byte boundaries, including mid-construct and mid-escape,
  produces the same bytes once flushed); a partial markup marker is never
  emitted as a literal and later retracted (e.g. a lone `*` at a chunk
  boundary is held until it resolves to emphasis or literal text);
  blank-line collap-sing; no ANSI leak (every emitted line ends reset);
  batch mode and non-TTY line mode pass the raw Markdown through unchanged
  (the renderer is not invoked).
- Whether any small refactor of the `onTextDelta`/`say` path is warranted
  to host the flush cleanly.
```
