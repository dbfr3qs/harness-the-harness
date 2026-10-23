# Startup Splash Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an ASCII `harness` wordmark with a spinner and a live checklist of startup phases while the harness boots, then clear it and drop the user at the normal banner + prompt.

**Architecture:** A new `src/splash.ts` holds a pure renderer (`renderSplash`) and a small controller (`createSplash(term, labels)`). In screen mode the controller drives the splash entirely through `term.notes(...)` on a ~100 ms timer (and clears it with `term.notes([])`); in plain line mode it prints the logo + an animated spinner line and prints each phase as it completes; in batch/non-interactive mode it is a no-op. `src/repl.ts` `main()` creates the controller after the terminal and marks phases around the existing MCP / library / registry startup steps, then `await splash.finish()` right before the banner.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), `node:test` + `node:assert/strict`, zero runtime dependencies, ANSI SGR escape codes.

**Spec:** none (design decided in conversation; captured inline below).

## Global Constraints

- Zero runtime dependencies; Node 24; `npx tsc --noEmit` stays clean; TDD with `node:test`; `npm test` (baseline passes).
- `src/splash.ts`'s `renderSplash` is pure and deterministic given its inputs (phases + frame); no terminal, timers, or globals inside it.
- The splash appears ONLY on an interactive terminal (`term.screen`, or line mode when `term.interactive`). In batch (`createBatchTerminal`) and non-interactive line mode it is a no-op — no escape sequences, no timers, nothing printed.
- Minimum display ~400 ms: if startup finishes faster, `finish()` waits out the remainder before clearing, so the splash never just flashes; if startup already took longer, no extra wait.
- No ANSI leak: every colored line ends reset.
- Reuse `term.notes(lines: string[])` (screen; `src/screen.ts:559`), `term.write`, `term.interactive`, `term.screen`, `createSpinner` (`src/spinner.ts`). Do NOT reorder `main()`'s terminal creation or the startup steps — only insert splash calls around them.

## Review Focus

- **Instant startup (no MCP servers — the default)** — the splash must still show for the ~400 ms minimum and then clear cleanly (no flash, no leftover lines, no corrupted panel). *(Task 2.)*
- **An MCP server fails to start** — its phase shows `✗` and startup still proceeds to the prompt; the splash never hangs waiting on it. *(Task 2.)*
- **Batch / non-interactive** — zero splash output; no escape codes or timers leak into piped output or batch runs. *(Task 2.)*
- **Very small / resized terminal** — the notes block is already clamped by the screen; `renderSplash` must not assume a width or crash on a narrow terminal. *(Task 1.)*
- **Resumed session (`--resume`)** — the splash still runs (it covers the same MCP/library/registry steps a resume performs) and clears before the banner. *(Task 2.)*

---

### Task 1: `src/splash.ts` — logo, spinner, and the pure renderer

**Files:**
- Create: `src/splash.ts`
- Test: `test/splash.test.ts`

**Interfaces:**
- Produces:
  - `SPLASH_LOGO: readonly string[]` — the 5-line `harness` wordmark (below).
  - `SPINNER_BRAILLE: readonly string[]` — braille spinner frames `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`.
  - `type PhaseState = "pending" | "active" | "done" | "failed"`.
  - `interface SplashPhase { label: string; state: PhaseState }`.
  - `renderSplash(phases: readonly SplashPhase[], frame: number): string[]` — the full splash block, left-padded 3 spaces: a blank line, the logo in cyan (`\x1b[36m`), a blank line, a `<spinner> starting up…` line (the spinner frame is `SPINNER_BRAILLE[frame % len]`; this line is omitted once every phase is `done`/`failed`), a blank line, then one line per phase: `✓ <label>` (done, green `\x1b[32m`), `<spinner frame> <label>` (active, cyan), `✗ <label>` (failed, red `\x1b[31m`), or `  <label>` (pending, dim `\x1b[2m`). Every colored line ends `\x1b[0m`. No trailing blank line. Must not reference terminal width.

The wordmark (exact; mind escaping backticks/backslashes in the TS string):
```
 _                                  
| |__   __ _ _ __ _ __   ___ ___ ___ 
| '_ \ / _` | '__| '_ \ / _ / __/ __|
| | | | (_| | |  | | | |  __\__ \__ \
|_| |_|\__,_|_|  |_| |_|\___|___/___/
```

- [ ] **Step 1: Write the failing tests** in `test/splash.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSplash, SPLASH_LOGO, SPINNER_BRAILLE } from "../src/splash.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the splash includes the logo lines", () => {
  const out = renderSplash([], 0).map(strip);
  for (const line of SPLASH_LOGO) assert.ok(out.includes(line));
});
test("phase glyphs reflect state", () => {
  const out = renderSplash([
    { label: "config", state: "done" },
    { label: "MCP servers", state: "active" },
    { label: "library", state: "failed" },
    { label: "registry", state: "pending" },
  ], 0);
  const s = out.map(strip);
  assert.ok(s.some((l) => l === "   ✓ config"));
  assert.ok(s.some((l) => l === `   ${SPINNER_BRAILLE[0]} MCP servers`));
  assert.ok(s.some((l) => l === "   ✗ library"));
  assert.ok(s.some((l) => l === "     registry")); // pending: no glyph
});
test("the spinner frame advances and the 'starting up' line hides when all settled", () => {
  const active = [{ label: "x", state: "active" as const }];
  assert.ok(renderSplash(active, 1).some((l) => l.includes(SPINNER_BRAILLE[1]!)));
  const settled = [{ label: "x", state: "done" as const }];
  assert.ok(!renderSplash(settled, 0).some((l) => strip(l).includes("starting up")));
});
test("every colored line ends in a reset (no leak)", () => {
  for (const line of renderSplash([{ label: "config", state: "done" }], 0)) {
    if (line.includes("\x1b[")) assert.ok(line.endsWith("\x1b[0m"));
  }
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/splash.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/splash.ts`** with the logo, braille frames, and `renderSplash` per the interface.

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/splash.test.ts`. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit.**
```bash
git add src/splash.ts test/splash.test.ts
git commit -m "feat: startup splash renderer (logo, spinner, phase checklist)"
```

---

### Task 2: The splash controller and REPL wiring

**Files:**
- Modify: `src/splash.ts` (add `createSplash`)
- Modify: `src/repl.ts` (`main()` — wire phases around startup; replace the `starting MCP server(s)` line)
- Test: `test/splash.test.ts`

**Interfaces:**
- Consumes: `renderSplash`, `SplashPhase`, `PhaseState` (Task 1); `term.screen`, `term.interactive`, `term.notes`, `term.write` (`src/terminal.ts`); `createSpinner` (`src/spinner.ts`).
- Produces: `createSplash(term: Terminal, labels: readonly string[]): SplashHandle` where
  `interface SplashHandle { set(label: string, state: PhaseState): void; finish(): Promise<void> }`.
  - **Screen mode** (`term.screen`): phases start `pending`; a ~100 ms timer (`setInterval`, `unref()`'d) calls `term.notes(renderSplash(phases, frame++))`; `set` updates the matching phase's state and redraws once immediately; `finish()` stops the timer, awaits any remainder of a 400 ms minimum measured from creation, then calls `term.notes([])`.
  - **Plain line mode** (`!term.screen && term.interactive`): on creation `term.write(SPLASH_LOGO.join("\n") + "\n")` and start a `createSpinner()` on a `starting up…` line; `set(label, "done")` → print `✓ label`, `set(label, "failed")` → print `✗ label` (stop the spinner before printing, restart after if phases remain); `finish()` stops the spinner and awaits the 400 ms minimum. (Line mode does not clear the logo/phases — they scroll away.)
  - **Batch / non-interactive** (`!term.interactive`): every method is a no-op (`finish()` resolves immediately); nothing is printed and no timer is created.
- REPL wiring in `main()`: after `term` is created, `const splash = createSplash(term, ["config", "web policy", "MCP servers", "library", "registry"])`, then `splash.set("config", "done"); splash.set("web policy", "done")` (both already loaded by that point). Set `"MCP servers"` `active` immediately before `startMcpServers`, then `done` (or `failed` if the start throws / reports failures) after; same `active`→`done` bracketing around the library-session creation (`"library"`) and `createRegistry` (`"registry"`). Remove the `if (starting.length) say(dim("starting MCP server(s): …"))` line (the splash's MCP phase replaces it). Call `await splash.finish()` immediately before the banner `say(...)`.

- [ ] **Step 1: Write the failing tests** in `test/splash.test.ts` using a fake screen-mode terminal that records `notes` calls:
```ts
import { createSplash } from "../src/splash.ts";
const fakeScreenTerm = () => {
  const notes: string[][] = [];
  return { term: { screen: true, interactive: true, notes: (l: string[]) => { notes.push(l); }, write() {} } as any, notes };
};
test("screen splash renders phases to notes and clears on finish", async () => {
  const { term, notes } = fakeScreenTerm();
  const s = createSplash(term, ["MCP servers", "library"]);
  s.set("MCP servers", "done");
  assert.ok(notes.at(-1)!.some((l) => l.replace(/\x1b\[[0-9;]*m/g, "") === "   ✓ MCP servers"));
  await s.finish();
  assert.deepEqual(notes.at(-1), []); // cleared
});
test("finish enforces the ~400ms minimum", async () => {
  const { term } = fakeScreenTerm();
  const s = createSplash(term, ["x"]);
  const t0 = Date.now();
  await s.finish();
  assert.ok(Date.now() - t0 >= 380); // ~400ms min (small slack)
});
test("batch/non-interactive splash is a silent no-op", async () => {
  let wrote = false;
  const term = { screen: false, interactive: false, notes() {}, write() { wrote = true; } } as any;
  const s = createSplash(term, ["x"]);
  s.set("x", "done");
  await s.finish();
  assert.equal(wrote, false);
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node --test test/splash.test.ts`. Expected: FAIL (`createSplash` missing).

- [ ] **Step 3: Implement `createSplash`** in `src/splash.ts` per the interface (screen / line / no-op branches, timer `unref()`'d, 400 ms minimum from creation).

- [ ] **Step 4: Run to verify they pass.** Run: `node --test test/splash.test.ts`. Expected: PASS.

- [ ] **Step 5: Wire into `src/repl.ts` `main()`** per the Interfaces block: create the splash after `term`, mark `config`/`web policy` done, bracket `MCP servers`/`library`/`registry` with `active`→`done`/`failed`, remove the old `starting MCP server(s)` say, and `await splash.finish()` before the banner.

- [ ] **Step 6: Run the suite + tsc.** Run: `npm test` (all pass) and `npx tsc --noEmit` (clean).

- [ ] **Step 7: Commit.**
```bash
git add src/splash.ts src/repl.ts test/splash.test.ts
git commit -m "feat: show a startup splash while the harness boots"
```

**Note for the reviewer:** the `main()` wiring and the live animation are not unit-testable (no repl/TTY harness) — they are covered by the renderer tests, the controller tests (fake term), `tsc`, the full suite, and a manual launch. Verify the phase bracketing (especially `failed` on MCP start error) and the `finish()`-before-banner placement by reading the diff.

---

## Manual verification (after Task 2)

Launch the harness interactively and confirm the splash shows the wordmark + spinner + checklist, animates, and clears to the normal prompt — both with no MCP servers (instant → ~400 ms splash) and, if feasible, with a server enabled so a phase visibly spins. This is a visual feature; a screenshot/manual look is the real acceptance check.
