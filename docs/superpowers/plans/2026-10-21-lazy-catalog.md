# Lazy-Loading Artifact Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh session loads only the built-in tools; the model discovers, loads, and unloads library tools/MCP servers on demand, and the human persists new installs — the manifest is a catalog, not a startup load-list.

**Architecture:** Separate *installed* (seeded into the session catalog from the manifest, costing nothing) from *loaded* (active in the registry this session). The session constructor already seeds all manifest entries; we make that seed dormant, delete the autoload path (`applyBaseline`), add browsable descriptions to tool/MCP catalog entries, add one model-facing discovery tool (`list_catalog`), and narrow persistence to "new installs only."

**Tech Stack:** TypeScript on Node 24 (native type-stripping), zero runtime dependencies, tests in `node:test` + `node:assert/strict`, `tsc --noEmit` for type-checking.

**Spec:** [`docs/superpowers/specs/2026-10-21-lazy-catalog-design.md`](../specs/2026-10-21-lazy-catalog-design.md)

## Global Constraints

- Zero runtime dependencies; Node 24 type-stripping; `npm run check` (tsc --noEmit) clean; `npm test` green.
- The whole catalog is unattended-only; `test/boundaries.test.ts` invariants hold (normal mode exposes no write/execute/library tool).
- Human-only manifest writes; the model has no persist tool and gains none.
- Installed is always dormant: `applyBaseline` is removed; nothing library-side loads at startup; the manifest `enabled` field stays in the schema but is inert for tools/MCP at startup.
- Persistence is "new installs only": loading/unloading an already-cataloged artifact during a session never appears in `diff()` nor trips the quit-time alert.
- `description` added to tool/MCP entries is optional (no manifest migration; old manifests parse unchanged).
- `hiddenEnv` still hides secrets from model-started servers; `write_file` stays workspace-confined.

## Review Focus

- A persisted dormant tool whose file was deleted/moved, loaded on demand → `set_artifact_enabled`/load surfaces an instructive error, catalog entry intact, no crash. (Task 3)
- A dormant MCP server loaded on demand whose command no longer exists → load surfaces the start error, the entry stays cataloged. (Task 3)
- `list_catalog` on an empty catalog → a clear "nothing installed" line, not a blank or crash. (Task 5)
- A catalog entry with no description (an old manifest entry) → `list_catalog` and `/tools` render it without a description, no crash. (Task 5)
- A session whose only change was loading a persisted item → `/library` reports no changes and quit shows no alert (the core anti-goal: session load/unload is invisible to persistence). (Task 4)

---

### Task 1: Optional `description` on tool and MCP manifest entries

**Files:**
- Modify: `src/library/manifest.ts` (`ToolEntry`, `McpEntry`, `ENTRY_KEYS`, `parseManifest`, `formatManifest`)
- Test: `test/manifest.test.ts`

**Interfaces:**
- Produces: `ToolEntry { kind:"tool"; name:string; file:string; description?:string; enabled:boolean }`; `McpEntry { kind:"mcp"; name:string; server:McpServerConfig; description?:string; enabled:boolean }`. `SkillEntry` is unchanged (its `description` stays required).

- [ ] **Step 1: Write failing tests** in `test/manifest.test.ts`:
  - `parseManifest` accepts a tool entry with `description: "does X"` and preserves it; accepts a tool entry with no `description` (stays `undefined`).
  - `parseManifest` accepts an mcp entry with and without `description`.
  - `parseManifest` rejects a non-string `description` on a tool entry with a message naming the entry.
  - Round-trip: a manifest with a described tool entry and a described mcp entry survives `formatManifest` → `parseManifest` unchanged (asserts `formatManifest`'s mcp branch now emits `description`).
- [ ] **Step 2: Run the tests, verify they fail.** Run: `node --test test/manifest.test.ts`
- [ ] **Step 3: Implement.** Add `description?: string` to `ToolEntry` and `McpEntry`. Add `"description"` to `ENTRY_KEYS.tool` and `ENTRY_KEYS.mcp`. In `parseManifest`, for tool and mcp: if `e.description !== undefined` require it be a string (else `fail`), and carry it onto the returned entry. In `formatManifest`'s mcp branch, include `description: e.description` (omit the key when undefined to keep output clean).
- [ ] **Step 4: Run the tests, verify they pass.**
- [ ] **Step 5: Commit** (`feat: optional description on tool and mcp manifest entries`).

---

### Task 2: Dormant catalog seeding; remove `applyBaseline`

**Files:**
- Modify: `src/library/session.ts` (constructor seed loop; remove `applyBaseline` from `LibrarySession` and impl; add `description?` to `ToolRec`/`McpRec`)
- Modify: `src/repl.ts` (drop the `applyBaseline` call and `libraryNotes`/`libraryWarnings`)
- Test: `test/library_session.test.ts`

**Interfaces:**
- Consumes: `ToolEntry.description`, `McpEntry.description` (Task 1).
- Produces: `LibrarySession` with **no** `applyBaseline`. Constructor seeds: tools and mcps with `enabled: false` (not loaded) plus `description` from the entry; skills with `enabled: e.enabled` plus `description`. `ToolRec`/`McpRec` gain `description?: string`.

- [ ] **Step 1: Write failing tests** in `test/library_session.test.ts` (use the existing registry/startServer stubs there):
  - Given a manifest with an `enabled:true` tool and an `enabled:true` mcp server, creating the session registers **nothing** (the registry stub's `add` is never called) and starts no server.
  - `inventory()` after construction shows the tool and mcp as `enabled:false` (not loaded), `persisted:true`, each carrying its `description`.
  - A manifest skill with `enabled:true` seeds as `enabled:true` in `inventory()`.
  - Remove/replace any existing test that calls `applyBaseline`.
- [ ] **Step 2: Run the tests, verify they fail.** Run: `node --test test/library_session.test.ts`
- [ ] **Step 3: Implement.** In the seed loop set tool/mcp `enabled: false` and skill `enabled: e.enabled`, each with `description: e.description`. Delete the `applyBaseline` method and its entry in the `LibrarySession` interface and the `describeArtifactSource` helper if now unused. In `src/repl.ts` (~line 425–433) delete the `applyBaseline()` call and the `libraryNotes`/`libraryWarnings` it fed; leave the MCP boot-note path for `mcp` (the top-level `mcp.json` servers) untouched.
- [ ] **Step 4: Run `node --test test/library_session.test.ts` and `npm run check`; verify pass.**
- [ ] **Step 5: Commit** (`feat: catalog seeds dormant, no autoload at startup`).

---

### Task 3: Capture descriptions on load; `addServer` takes a description; `inventory()` exposes it

**Files:**
- Modify: `src/library/session.ts` (`addServer`, `reloadTools`, `setEnabled`, `inventory`)
- Test: `test/library_session.test.ts`

**Interfaces:**
- Produces: `addServer(server: McpServerConfig, description?: string)` stores `rec.description`. `reloadTools()` and the tool-load branch of `setEnabled` set `rec.description = tool.description` from the loaded `Tool`. `inventory()` returns `{ kind, name, enabled, persisted, description?: string }` (description from the rec; `enabled` continues to mean "loaded" for tool/mcp, "offered" for skill).

- [ ] **Step 1: Write failing tests** in `test/library_session.test.ts`:
  - `addServer(config, "a reverse-engineering server")` then `inventory()` shows that mcp entry's `description`.
  - After `reloadTools()` loads a stub tool file whose factory returns `description: "greets"`, `inventory()` shows that tool's `description`.
  - Loading a persisted tool whose resolved file does not exist (`setEnabled("tool", name, true)`) throws an instructive Error and leaves the entry present (`inventory()` still lists it, `enabled:false`). (Review Focus.)
  - Loading a cataloged mcp whose `startServer` stub rejects surfaces the error and leaves the entry cataloged. (Review Focus.)
- [ ] **Step 2: Run the tests, verify they fail.**
- [ ] **Step 3: Implement.** Thread an optional `description` through `addServer` into the new `McpRec`. In `reloadTools`, set the stored rec's `description` to `tool.description`. In `setEnabled`'s tool-enable branch, set `rec.description` from the loaded tool. Add `description: rec.description` to each `inventory()` row. The load-failure error paths already throw from `loadToolFile`/`startServer`; ensure the entry/rec is not dropped on failure.
- [ ] **Step 4: Run `node --test test/library_session.test.ts` and `npm run check`; verify pass.**
- [ ] **Step 5: Commit** (`feat: catalog entries carry descriptions for discovery`).

---

### Task 4: Persistence is "new installs only" (diff, formatting, alert)

**Files:**
- Modify: `src/library/session.ts` (`diff`, `buildEntry`)
- Modify: `src/library_command.ts` (`LibraryDiff`, `InventoryItem`, `formatDiff`, `formatInventory`)
- Modify: `src/repl.ts` (`unpersistedLibraryAlert`, the `persist`/`persist-review` cases in `runLibraryCommand`)
- Test: `test/library_session.test.ts`, `test/library_command.test.ts`

**Interfaces:**
- Produces: `diff(): { added: { kind: ArtifactKind; name: string }[] }` (no `enabledChanged`). `buildEntry` writes `enabled: false` for every kind. `LibraryDiff = { added: {kind;name}[] }`. `InventoryItem` gains `description?: string`.

- [ ] **Step 1: Write failing tests:**
  - `test/library_session.test.ts`: reload a new (non-persisted) tool → `diff().added` contains it. Load then unload a **persisted** tool via `setEnabled` → `diff().added` is empty (session load/unload is invisible). After `persist([{kind:"tool",name}])`, `diff().added` is empty even though the tool is still loaded (`buildEntry` wrote `enabled:false`, rec is marked persisted), and the manifest written by `saveManifest` carries the tool's `description`.
  - `test/library_command.test.ts`: `formatDiff({ added: [{kind:"mcp",name:"rea"}] })` names the added server and does **not** mention enabled/disabled changes; `formatDiff({ added: [] })` returns the "no unpersisted session changes" line. `formatInventory` renders an item with a `description` and labels a loaded vs. not-loaded item. Remove the `enabledChanged` assertions.
- [ ] **Step 2: Run both test files, verify they fail.**
- [ ] **Step 3: Implement.** In `diff()`, drop the `enabledChanged` computation and the baseline comparison; return `{ added }` built from recs where `!persisted`. In `buildEntry`, write `enabled: false` for all three kinds, and write `description: rec.description` for the tool and mcp entries (so a persisted artifact stays browsable without loading). In `library_command.ts`: change `LibraryDiff` to `{ added }`, rewrite `formatDiff` to print only the added list (keep the "No unpersisted session changes." empty case), add `description?` to `InventoryItem`, and update `formatInventory` to show the description and read `enabled` as loaded/not-loaded. In `repl.ts`: `unpersistedLibraryAlert` tests `d.added.length === 0`; the `persist` selection is `d.added` only; `persist-review` prints `formatDiff(d)`.
- [ ] **Step 4: Run both test files and `npm run check`; verify pass.**
- [ ] **Step 5: Commit** (`feat: persistence tracks new installs only`).

---

### Task 5: `list_catalog` discovery tool; `add_mcp_server` description; reframed text; drop `list_skills`

**Files:**
- Modify: `src/tools/unattended/library.ts` (add `list_catalog`, remove `list_skills`, add `description` param to `add_mcp_server`, reframe `set_artifact_enabled`/`reload_tools`/`add_mcp_server` text)
- Modify: `test/boundaries.test.ts` (expected unattended tool set/order)
- Test: `test/library_tools.test.ts`

**Interfaces:**
- Consumes: `session.inventory()` with `description` (Task 3), `session.addServer(config, description)` (Task 3).
- Produces: `createLibraryTools(session)` returns `[reload_tools, add_mcp_server, set_artifact_enabled, list_catalog, use_skill]` (`list_catalog` replaces `list_skills` in that slot).

- [ ] **Step 1: Write failing tests:**
  - `test/library_tools.test.ts`: `createLibraryTools` includes a `list_catalog` tool and no `list_skills`. With a stub session whose `inventory()` returns a loaded tool (with description), a dormant mcp (with description), a described-less tool, an enabled skill, and a disabled skill, `list_catalog`'s handler output names each tool/mcp/enabled-skill, marks the tool loaded and the mcp available, shows descriptions where present and omits gracefully where absent, lists the enabled skill without a loaded marker, and **omits the disabled skill**. An empty inventory yields a "nothing installed" line. `add_mcp_server` with a `description` passes it to the session's `addServer`.
  - `test/boundaries.test.ts`: update `libraryTools` list to `["reload_tools","add_mcp_server","set_artifact_enabled","list_catalog","use_skill"]` at its definition (~line 59); the two `deepEqual` expected-set assertions (~lines 74, 109) follow from it; normal-mode assertions unchanged.
- [ ] **Step 2: Run the test files, verify they fail.** Run: `node --test test/library_tools.test.ts test/boundaries.test.ts`
- [ ] **Step 3: Implement.** Add a `list_catalog` tool (empty input schema) whose handler reads `session.inventory()` and formats: skills shown as `skill <name>: <desc>` but only when `enabled` (a disabled skill is hidden, as `list_skills` did); tools/mcp always shown as `<kind> <name> [loaded|available]: <desc>` with the description omitted when absent; empty (or all-hidden) inventory → a one-line "No tools, servers, or skills are installed yet." Remove the `list_skills` tool. Add optional `description` to `add_mcp_server`'s input schema and pass it through `toServerConfig`'s result into `session.addServer(config, description)`. Reframe the three tools' description strings around installed-vs-loaded and the "load deliberately / unload when done / changing the tool set resets the prompt cache" note. Return the tools array in the order above.
- [ ] **Step 4: Run `node --test test/library_tools.test.ts test/boundaries.test.ts` and `npm run check`; verify pass.**
- [ ] **Step 5: Commit** (`feat: list_catalog discovery tool, lazy-load framing`).

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` ("Extending the harness at runtime" subsection)

**Interfaces:** none.

- [ ] **Step 1: Update the README** subsection to describe the installed-vs-loaded model: a fresh session has only built-in tools; the model browses with `list_catalog`, loads/unloads with `set_artifact_enabled`, creates tools and installs MCP servers on demand; the human persists new installs with `/library persist`, and persisted artifacts stay dormant until loaded.
- [ ] **Step 2: Run the full suite** `npm test` and `npm run check`; verify green.
- [ ] **Step 3: Commit** (`docs: lazy-loading catalog`).
