# Interactive Menus in the TUI — Design

**Status:** proposed
**Date:** 2026-10-22

## Intent and why

Two rough edges in the terminal UI:

1. **Tab-completion spills into the scrollback.** When you press Tab on an
   ambiguous slash command (a bare `/`, say), there's no shared prefix to
   extend, so the harness prints the candidate list into the conversation
   output above the input box. The list belongs *at* the prompt, not mixed into
   the model's output.
2. **The library listings are read-only text.** `/mcp`, `/tools`, and `/skills`
   print what's installed, but to actually enable or disable something you have
   to retype `/mcp enable <name>`. You should be able to arrow over the list and
   flip things with a keypress.

Both are the same shape — a navigable list rendered in the input panel — and the
harness already has the widget for it (`src/menu.ts` + the screen's menu mode,
which the `/model` picker uses today). This makes both features mostly a matter
of using that widget in two more places, and giving every menu a printed
instruction line so the keys are discoverable.

## Goals

- **Tab-completion opens a menu in the input panel, not the scrollback.** When
  Tab finds 2+ candidates and no further common prefix to insert, open the
  existing menu widget in the bottom panel listing the candidates; arrow to one
  and press Enter to insert it into the input box (with its trailing space, cursor
  ready for the next argument). It does **not** run the command. Behavior that
  already works is unchanged: a single candidate, or a longer shared prefix, still
  completes inline with no menu.
- **`/mcp`, `/tools`, `/skills` run bare open a toggle menu.** It lists the
  installed artifacts of that kind with their current enabled/loaded state
  (● on / ○ off). **Space** marks a pending toggle on the highlighted row (the
  marker flips to show the pending state); **Enter** applies every marked change;
  **Esc / Ctrl-C** cancels and discards the marks. Applying calls the existing
  `LibrarySession.setEnabled(kind, name, enabled)` per changed item and prints a
  short summary of what changed. The typed forms (`/mcp enable <name>`, etc.) are
  unchanged.
- **Changes apply on close, not live.** Space only marks intent; nothing starts,
  stops, loads, or unloads until Enter. Esc leaves the session exactly as it was.
- **Every menu prints an instruction footer** — a dim one-line hint of the keys,
  tailored to the menu kind:
  - pick-one (completion, `/model`, `/provider`): `↑/↓ move · enter select · esc cancel`
    (the completion menu may word it `enter insert`);
  - toggle (`/mcp`, `/tools`, `/skills`): `↑/↓ move · space toggle · enter apply · esc cancel`.
- Reuse `src/menu.ts` and the screen's menu mode; keep the new logic (toggle
  marking, which changes to apply) in the pure, unit-tested layer.

## Non-goals

- No new command syntax and no change to the `LibrarySession` API — the toggle
  menu drives the existing `setEnabled`.
- No interactive menu for `/library` (persist), `/policy`, or other commands here
  — only the completion menu and the `/mcp`/`/tools`/`/skills` toggle. (`/model`
  and `/provider` keep their current pick-one menu; they only gain the footer.)
- No mouse support.
- Plain / line mode (no screen, e.g. `--plain` or a piped stdin) is not getting a
  new toggle UI: a bare `/mcp` there keeps today's text listing, and Tab keeps
  today's behavior. The interactive menus are a screen-mode feature. (The toggle
  commands only exist in unattended mode anyway, where the library is wired.)

## Anti-goals (failure even if it technically works)

- A menu whose keys you have to guess — the footer is the point; a menu without it
  has failed the request.
- Space or Enter in the toggle menu silently starting/stopping a server before you
  meant to (the apply-on-close contract).
- The completion menu running a command instead of inserting it, or clobbering
  text the cursor isn't at the end of.
- Any regression to the existing `/model` picker, to inline single-candidate
  completion, or to the typed `/mcp enable` forms.

## Constraints

- Zero runtime dependencies; Node 24; `npm run check` clean; `node:test`.
- `src/menu.ts` is pure and unit-tested (`menuKey`, `renderMenu`); the toggle
  behavior and the apply-diff computation must stay in that pure layer so they're
  testable without a terminal. The screen/terminal rendering and key plumbing are
  the integration seam.
- The toggle menus are unattended-only (the library and these commands exist only
  then); the normal-mode boundaries are untouched.

## Decided design

### The menu widget gains a toggle mode

`src/menu.ts` today drives a pick-one menu (`menuKey` moves/selects/cancels,
`renderMenu` draws rows, disabled rows skipped). Extend it so a menu can be a
**toggle** menu:

- Each item carries its current on/off state; the menu tracks a pending on/off per
  item (seeded from current). `menuKey` handles **Space** only in toggle mode:
  it flips the highlighted item's pending state and stays open. Select menus
  ignore Space.
- Enter in a toggle menu finishes with "apply"; the caller reads the pending map
  and computes the changed items. Cancel (Esc/Ctrl-C) finishes with "cancel" and
  the caller applies nothing.
- `renderMenu` draws the ●/○ marker from each item's pending state in toggle mode,
  and draws the **instruction footer** line (text chosen by the menu kind) below
  the rows.

The exact shape (a `kind: "select" | "toggle"` on the menu, pending state in
`MenuState`, a helper that returns the changed items) is the builder's, kept pure.

### Tab-completion uses the menu instead of the scrollback

`src/screen.ts`'s `complete()` currently, when there's no further common prefix,
calls `draw(... hits ...\n)` to print the list into the scrollback. Replace that
branch: open the menu mode with the candidates as a **modal** pick-one menu
(title shows the typed prefix, e.g. `Complete: /pr`; footer `↑/↓ move · enter
insert · esc cancel`). On select, **replace the typed last word** with the chosen
candidate — i.e. insert `candidate.slice(word.length)` at the cursor, where `word`
is the prefix the completer returned (the candidate already carries its trailing
space); inserting the whole candidate would double the prefix. On Esc the line is
left untouched. The menu is **modal**: while it is open, keys drive the menu, not
the input line (to type a different prefix you press Esc, then keep typing, then
Tab again). The inline-insert branch (a longer shared prefix) and the
single-candidate case are unchanged, and `complete()` only opens the menu in
input mode (guarded — never over an `ask` prompt or while the agent is busy).

### The library commands open the toggle menu

`src/repl.ts`'s `runLibraryCommand`, for a bare `{ type: "list", kind }` in screen
mode, builds the toggle menu's items from `session.inventory()` filtered to that
kind — label, the current `enabled` as the on-state, and a dim hint for
loaded/available/offered — opens the toggle menu, and on apply calls
`session.setEnabled(kind, name, on)` for each changed item, collecting failures
into the printed summary (mirroring how `setEnabled` errors are surfaced today).
On cancel, nothing changes. In plain/line mode, the bare command keeps printing
`formatInventory` as it does now.

## Decisions settled after builder review

- **Completion menu is modal** (your choice): title shows the typed prefix; Esc
  leaves the line untouched; typing doesn't edit the line while the menu is open.
- **Insert replaces the typed word** (`candidate.slice(word.length)`), not append.
- **`complete()` opens the menu only in input mode** — never over an `ask` prompt
  or while the agent is busy (guard on the screen's mode); this fixes a latent bug
  where Tab would clobber an `ask` prompt's state.
- **Digit keys don't apply in a toggle menu.** `menuKey` treats 1–9 as
  "pick item N and finish" today; in toggle mode that would silently apply. In
  toggle mode, Space toggles and Enter applies — digit shortcuts are disabled.
  (Select/completion menus keep digit quick-pick.)
- **Long lists scroll/window** around the cursor so the highlighted row, and the
  footer, stay visible on small terminals (the completion list alone is 15
  commands; inventories and model lists can be long). This is a `renderMenu` /
  `MenuState` change; the current panel truncates from the top with no window.
- **The toggle menu is reached through a new optional `Terminal` member** (the
  existing one, `choose`, returns a single value; a toggle needs the changed set).
  Name/signature the builder's; `runLibraryCommand` is already async and can await
  it, reading `term` directly.
- **Screen-mode only for the new menus.** In line/plain mode: Tab keeps readline's
  current behavior, and a bare `/mcp`/`/tools`/`/skills` keeps printing
  `formatInventory`. (Accepted inconsistency: `/model` still menus on a line-mode
  TTY; matching the toggle there would mean teaching `selectFromMenu` toggle
  support, which is out of scope here.)
- **`renderMenu`'s inline title hint** (`(↑/↓ or 1-N, Enter to choose, Esc to
  cancel)`) is removed/replaced by the footer so they don't duplicate or
  contradict (the toggle footer must not say "1-N … choose"). `/model` and
  `/provider` get the footer; their existing title-text tests update accordingly.
- **Empty inventory**: don't open a menu (`Math.max(...[])` is `-Infinity`); print
  "Nothing in the library yet." Enter with no pending changes → "No changes." and
  no writes.
- **Apply is sequential, non-atomic, continue-on-failure**: call `setEnabled` per
  changed item (inventory order), collect the returned strings/errors into a
  short summary (one line per changed item), then call `updateStatus()` (the tool
  count changed) and show activity while applying (a server start can take
  seconds).

## Left to the builder

- The exact `menu.ts` toggle extension: how `kind`/pending-state live on the menu
  and `MenuState`, the `menuKey` Space handling, the changed-items helper, and how
  `renderMenu` draws markers and the footer — all kept pure and unit-tested.
- The footer strings per menu kind.
- The `screen.ts` menu-mode plumbing for the completion menu (opening it from
  `complete()` and inserting the pick at the cursor) and for a toggle menu opened
  from a command.
- The `repl.ts` wiring of `/mcp`/`/tools`/`/skills` bare → toggle menu → apply via
  `setEnabled`, the summary line, and the plain-mode fallback; plus the `/model`/
  `/provider` menus gaining the footer.
- The scroll/window math in `renderMenu`/`MenuState` (keep cursor + footer in
  view), and carrying `kind`/pending through every `menuKey` branch (incl.
  `step`) while keeping its `(items, state, key)` signature backward-compatible
  (existing `test/menu.test.ts` calls it that way). Space arrives as
  `key.name === "space"` / `sequence === " "` — handle both.
- Tests: `menuKey` toggle (Space flips the highlighted item's pending state and
  stays open; select menus ignore Space; digits don't apply in toggle mode; Enter
  finishes "apply", cancel finishes "cancel"), the changed-items helper (only
  items whose pending differs from current), the scroll window (cursor stays
  visible past the viewport), `renderMenu` output (●/○ markers in toggle mode,
  footer text per kind, no inline title hint), and the library-command apply path
  (the right `setEnabled` calls for the marked diffs, nothing on cancel; empty →
  "Nothing in the library yet."; no-op → "No changes."). Update the existing
  `test/menu.test.ts`, `test/screen.test.ts`, and `/model` picker tests for the
  footer/title change. Screen/terminal rendering and key plumbing are integration,
  verified by the suite and `npm run check`.
