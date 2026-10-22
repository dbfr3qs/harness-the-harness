# Interactive Menus in the TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab-completion opens a navigable menu in the input panel (not scrollback), and `/mcp`/`/tools`/`/skills` open toggle menus to enable/disable artifacts by keypress — every menu carrying a key-hint footer.

**Architecture:** Extend the pure menu core (`src/menu.ts`) with a toggle mode, a scroll viewport, and a footer; use it from the screen's `complete()` (a modal completion menu) and from a new `Terminal.toggle` entry point the REPL drives for the library commands. Keep toggle-marking, viewport math, and the library item-building in the pure, unit-tested layer.

**Tech Stack:** TypeScript on Node 24 (type-stripping), zero runtime deps, tests in `node:test`, `tsc --noEmit`.

**Spec:** [`docs/superpowers/specs/2026-10-22-interactive-menus-design.md`](../specs/2026-10-22-interactive-menus-design.md)

## Global Constraints

- Zero runtime dependencies; Node 24; `npm run check` clean; `npm test` green.
- Changes apply on close: Space only marks pending; Enter applies, Esc/Ctrl-C discards. Nothing starts/stops/loads until Enter.
- The new menus are screen-mode only. In line/plain mode, Tab keeps readline's behavior and a bare `/mcp`/`/tools`/`/skills` keeps printing `formatInventory`.
- The toggle commands are unattended-only (the library exists only then); normal-mode boundaries are untouched.
- Every menu renders a dim instruction footer: pick menus `↑/↓ move · enter select · esc cancel` (completion: `enter insert`); toggle menus `↑/↓ move · space toggle · enter apply · esc cancel`. The old inline title hint is removed.
- `menuKey`'s existing `(items, state, key)` call stays backward-compatible; `renderMenu`'s positional `color` arg becomes an options object and all callers/tests update.

## Review Focus

- Tab pressed while not in input mode (an `ask` yes/no prompt is up, or the agent is busy): the completion menu must NOT open or clobber that mode. (Task 2)
- Toggle Enter with nothing marked, or an empty inventory: "No changes." / "Nothing in the library yet.", and no `setEnabled` calls. (Task 3, Task 1 empty guard)
- A long list (the 15 commands, a long model list) on a small terminal: the viewport keeps the highlighted row and the footer visible; the cursor never lands on an undrawn row. (Task 1 viewport, Task 2 panel)
- Completion insert must replace the typed word, not append it (never `/mc` + `/mcp ` → `/mc/mcp `). (Task 2)
- Digit keys (1–9) in a toggle menu must not pick-and-apply — only Space toggles, Enter applies. (Task 1)

---

### Task 1: Menu core — toggle mode, viewport, footer, applied-toggles

**Files:**
- Modify: `src/menu.ts`
- Test: `test/menu.test.ts`

**Interfaces:**
- Produces:
  - `MenuItem<T>` gains `on?: boolean` (current on/off state, for toggle menus).
  - `MenuState` gains `toggled?: ReadonlySet<number>` (item indices the user has flipped relative to `on`).
  - `menuKey<T>(items, state, key, opts?: { toggle?: boolean }): MenuState` — in toggle mode, Space (`key.name === "space"` or `key.sequence === " "`) returns a new state with the current index added/removed from `toggled` and no `done` (menu stays open), and a digit key does NOT finish; Enter still finishes `"select"`. In select mode (default) behavior is unchanged (digits pick-and-finish, Space ignored). Every returned state carries `toggled` forward.
  - `appliedToggles<T>(items: MenuItem<T>[], state: MenuState): { value: T; on: boolean }[]` — for each index in `toggled`, the item's `value` and its new effective state (`!item.on`), in index order.
  - `menuViewport(count: number, index: number, maxRows: number): { start: number; end: number }` — the slice of item indices to show so `index` stays visible in at most `maxRows` rows (`end` exclusive).
  - `renderMenu<T>(title, items, index, opts?: { color?: boolean; toggle?: boolean; toggled?: ReadonlySet<number>; footer?: string; maxRows?: number }): string[]` — toggle mode draws `●`/`○` per item (from `item.on` XOR `toggled.has(i)`) instead of the `N.` number; a `footer`, when given, is a dim last line; `maxRows` applies `menuViewport` with `… N more` markers above/below; the inline title hint is removed.

- [ ] **Step 1: Write the failing tests** in `test/menu.test.ts`:
  - toggle `menuKey`: Space on index 1 returns `toggled` containing 1 and no `done`; Space again removes 1; a digit `"2"` returns no `done` (does not finish); Enter returns `done: "select"`; up/down still move and preserve `toggled`.
  - select `menuKey` (no opts): Space is ignored (unchanged state); a digit still finishes `"select"` (regression).
  - `appliedToggles`: items `[{on:true},{on:false},{on:false}]` with `toggled={1}` → `[{value:items[1].value, on:true}]`; empty `toggled` → `[]`.
  - `menuViewport(20, 0, 5)` → `{start:0,end:5}`; `menuViewport(20, 18, 5)` keeps 18 within `[start,end)`; `menuViewport(3, 0, 10)` → `{start:0,end:3}`.
  - `renderMenu` toggle: a line for an on item starts with `●`, an off with `○`; a flipped item reflects the pending state; the `footer` string appears as the last line; no `(↑/↓ or 1-N …)` hint in the title.
  - `renderMenu` with an empty items array returns without throwing (no `Math.max(...[])` → `-Infinity` crash), so a defensive call is safe.
  - Update existing `renderMenu`/`menuKey` tests for the removed title hint and the `opts` signature (`{ color: false }` instead of positional `false`).
- [ ] **Step 2: Run `node --test test/menu.test.ts`; verify it fails.**
- [ ] **Step 3: Implement** the additions in `src/menu.ts`, keeping every function pure.
- [ ] **Step 4: Run the tests; verify pass, and `npm run check`.**
- [ ] **Step 5: Commit** (`feat: menu core gains toggle mode, viewport, footer`).

---

### Task 2: Screen — completion menu and toggle plumbing

**Files:**
- Modify: `src/screen.ts`, `src/terminal.ts` (the `Terminal` interface), `src/menu.ts`'s `selectFromMenu` only if its `renderMenu` call needs the footer
- Test: `test/screen.test.ts`

**Interfaces:**
- Consumes: Task 1's `menuKey(…, {toggle})`, `renderMenu(…, opts)`, `appliedToggles`, `menuViewport`.
- Produces:
  - `Terminal` gains optional `toggle?<T>(title: string, items: MenuItem<T>[]): Promise<{ value: T; on: boolean }[] | undefined>` — resolves the applied changes on Enter, `[]` when nothing changed, `undefined` on cancel. Implemented in `createScreen`; omitted in `createLineTerminal` (so the REPL falls back).
  - The screen `Mode` menu variant gains `toggle?: boolean` and `footer: string`; `panel()` passes `toggle`/`toggled`/`footer`/`maxRows` (from `rows()`) to `renderMenu`, and the `onKey` menu branch passes `{ toggle: mode.toggle }` to `menuKey`. The existing `choose()` sets `footer` to the select footer (`↑/↓ move · enter select · esc cancel`), so `/model` and `/provider` gain it.
  - `complete()` ambiguous branch: only when `mode.kind === "input"`, open a modal pick menu (title `Complete: <line>`, footer `↑/↓ move · enter insert · esc cancel`) with the candidates; on select, insert `candidate.slice(word.length)` at the cursor; on cancel, leave the line unchanged. The single-candidate and shared-prefix branches are unchanged.

- [ ] **Step 1: Write the failing tests** in `test/screen.test.ts` (reuse the existing screen test harness):
  - Tab on a bare `/` opens a menu in the panel (the candidate commands appear in the panel output, NOT via a scrollback write) and Enter inserts the highlighted command into the input: the buffer becomes exactly the selected candidate (the first is `/exit `), with a single leading `/` (not `//exit`).
  - Tab while `mode.kind === "ask"` (a prompt is open) does not open a menu and leaves the ask prompt intact.
  - A toggle menu opened via `term.toggle` renders `●`/`○` rows and the toggle footer; Space then Enter resolves with the flipped item; Esc resolves `undefined`.
- [ ] **Step 2: Run `node --test test/screen.test.ts`; verify failure.**
- [ ] **Step 3: Implement** the `Terminal.toggle` screen method, the `Mode`/`panel()`/`onKey` wiring, and the guarded `complete()` menu.
- [ ] **Step 4: Run `node --test test/screen.test.ts test/menu.test.ts` and `npm run check`; verify pass.**
- [ ] **Step 5: Commit** (`feat: completion menu in the panel, toggle menu plumbing`).

---

### Task 3: Wire the library commands to the toggle menu

**Files:**
- Modify: `src/library_command.ts` (pure item-builder), `src/repl.ts` (`runLibraryCommand` list case)
- Test: `test/library_command.test.ts`

**Interfaces:**
- Consumes: Task 2's `term.toggle` / `term.screen`; `session.inventory()` and `session.setEnabled(kind, name, enabled)` (unchanged); `InventoryItem`.
- Produces: `libraryMenuItems(items: InventoryItem[], kind: ArtifactKind): MenuItem<string>[]` in `src/library_command.ts` — the items of that kind, `label` = name, `value` = name, `on` = `enabled`, `hint` = the loaded/available (tool, mcp) or offered (skill) state plus persisted/session-only (matching `formatInventory`'s wording).

- [ ] **Step 1: Write the failing test** in `test/library_command.test.ts`: `libraryMenuItems` over a mixed inventory filters to the requested kind, sets `on` from `enabled`, and builds the hint (a loaded persisted tool → hint contains "loaded" and "persisted"; a session-only available server → "available" and "session-only").
- [ ] **Step 2: Run `node --test test/library_command.test.ts`; verify failure.**
- [ ] **Step 3: Implement** `libraryMenuItems`, then wire `runLibraryCommand`'s `{ type: "list", kind }` case: when `term.screen && term.toggle`, build items via `libraryMenuItems(session.inventory(), kind)`; if empty, `say("Nothing in the library yet.")`; else `await term.toggle(<title>, items)` → on `undefined` do nothing; on `[]` say "No changes."; otherwise for each `{value, on}` `await session.setEnabled(kind, value, on)`, collect the returned line (and any thrown error) into a printed summary, then `updateStatus()`. When `!term.screen`, keep the current `say(formatInventory(...))`. Show activity around the apply (a server start can take seconds).
- [ ] **Step 4: Run `node --test test/library_command.test.ts`, `npm run check`, and the full `npm test`; verify green.** In the report, describe how the apply path and the plain-mode fallback were confirmed (reasoning, since `runLibraryCommand` isn't unit-tested).
- [ ] **Step 5: Commit** (`feat: /mcp /tools /skills open a toggle menu`).

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`** — the status-bar/commands/menu material: note that Tab shows a navigable completion menu at the prompt (screen mode), and that `/mcp`/`/tools`/`/skills` open a toggle menu (Space marks, Enter applies, Esc discards); mention every menu shows a key-hint footer.
- [ ] **Step 2: Run the full `npm test` and `npm run check`; verify green.**
- [ ] **Step 3: Commit** (`docs: interactive completion and toggle menus`).
