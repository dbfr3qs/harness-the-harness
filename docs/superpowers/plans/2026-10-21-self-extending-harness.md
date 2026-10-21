# Self-extending harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model build, hot-load and toggle its own native tools, MCP servers and skills mid-session (unattended mode only), with the persisted library curated by the human.

**Architecture:** A mutable registry plus a per-turn re-read of tool definitions makes new tools callable without a restart. A `src/library/` subsystem stores artifacts and a human-only manifest; a per-session coordinator (`LibrarySession`) applies the manifest baseline at startup and holds an in-memory overlay of everything the model changes this session. Model-facing tools (under `src/tools/unattended/`) mutate only the overlay; REPL commands let the human inspect the overlay diff and persist it.

**Tech Stack:** TypeScript on Node 24 (native type-stripping, dynamic `import()`), `node:` builtins only, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-21-self-extending-harness-design.md`

## Global Constraints

- Zero runtime dependencies: plain `fetch` and `node:` builtins only. No new npm deps.
- Tests use `node:test` + `node:assert/strict`; no network or API key.
- Tool/manifest errors are written as guidance for the model/user to read (house style).
- Files that persist (the manifest) are written atomically (temp file + `rename`), as in `src/settings.ts`.
- Config/manifest validation uses a `parse*` function that throws `ConfigError` naming the problem (`src/config.ts`).
- The whole feature is **unattended-only**. `test/boundaries.test.ts` must still prove normal mode exposes no write/execute tool and that no tool imports a module that writes settings/manifest/logs.
- Library artifacts live outside the workspace; `write_file`'s workspace confinement is **not** changed.
- Default library root env var: `HARNESS_LIBRARY_ROOT`; default path `~/.harness/library`.

## Review Focus

- **Bad tool file** (throws on import, no default export, factory returns wrong shape): reported per-file, session keeps running — pinned in Task 5.
- **Name collision** (a loaded tool named like a built-in or an already-loaded tool): refused, built-in never shadowed — pinned in Tasks 1 and 5.
- **Edited tool re-import** (same path loaded again after an edit must get the new code, not a cached module): cache-busting query — pinned in Task 5.
- **MCP server lifecycle** (disabling a session server closes its process; quit closes every session-started server; `hiddenEnv` still hides API keys): pinned in Tasks 7 and 9.
- **Corrupt/unknown manifest** (bad JSON, unknown keys, wrong types): `ConfigError` naming the problem, and a missing file means an empty library — pinned in Task 4.

---

### Task 1: Mutable registry

**Files:**
- Modify: `src/registry.ts` (`createRegistry`)
- Test: `test/registry.test.ts`

**Interfaces:**
- Produces: `createRegistry(builtins: Tool[])` now also returns `add(tool: Tool): void`, `remove(name: string): void`, `has(name: string): boolean`. `definitions()` and `dispatch()` read the current set (built-ins + added). Built-ins are locked: `add` throws if `tool.name` collides with a built-in or an already-added tool; `remove` throws for a built-in name and is a no-op for an unknown name.

- [ ] **Step 1: Write failing tests** in `test/registry.test.ts`:
  - `test("add makes a tool dispatchable and listed")` — after `add`, `definitions()` includes it and `dispatch(name,…)` runs its handler.
  - `test("add refuses a name that collides with a built-in or an added tool")` — throws; `dispatch` of the built-in name still runs the original.
  - `test("remove drops an added tool but refuses a built-in")` — `remove("read_file")` throws; `remove("added")` removes it; `remove("never-added")` is a no-op.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/registry.test.ts`
- [ ] **Step 3: Implement** the mutation API in `createRegistry`. Keep a separate `dynamic` map; `byName` lookups and `definitions()` merge built-ins + dynamic (built-ins first, then insertion order).
- [ ] **Step 4: Run tests, verify they pass.** Run: `node --test test/registry.test.ts`
- [ ] **Step 5: Commit.** `git commit -m "feat: mutable registry (runtime add/remove of tools)"`

---

### Task 2: Agent loop re-reads tool definitions each turn

**Files:**
- Modify: `src/agent.ts` (move `const tools = registry.definitions()` from top of `runAgent` into the per-turn loop, before the `model({...})` call)
- Test: `test/agent.test.ts`

**Interfaces:**
- Consumes: Task 1's `registry.add`.
- Produces: no signature change; behavior change only.

- [ ] **Step 1: Write a failing test** `test("a tool added mid-run is callable later in the same run")`: a fake `ModelFn` that on call 1 emits a tool_use for a tool whose handler calls `registry.add(newTool)`, and on call 2 emits a tool_use for `newTool`, then on call 3 returns text. Assert `newTool`'s handler ran and the run finished `done`.
- [ ] **Step 2: Run test, verify it fails** (today call 2 errors "unknown tool"). Run: `node --test test/agent.test.ts`
- [ ] **Step 3: Implement**: read `registry.definitions()` inside the `while` loop each turn so the per-call `tools` reflects the current set.
- [ ] **Step 4: Run test, verify it passes.** Run: `node --test test/agent.test.ts`
- [ ] **Step 5: Commit.** `git commit -m "feat: agent loop sees tools added mid-run"`

---

### Task 3: Library paths

**Files:**
- Create: `src/library/paths.ts`
- Test: `test/library_paths.test.ts`

**Interfaces:**
- Produces:
  - `interface LibraryPaths { root: string; toolsDir: string; skillsDir: string; manifestPath: string }`
  - `function libraryPaths(env?: NodeJS.ProcessEnv): LibraryPaths` — root from `env.HARNESS_LIBRARY_ROOT` or `join(homedir(), ".harness", "library")`; `toolsDir = root/tools`, `skillsDir = root/skills`, `manifestPath = root/manifest.json`.

- [ ] **Step 1: Write failing tests**: default root ends with `.harness/library`; `HARNESS_LIBRARY_ROOT=/x` yields `root === "/x"` and the three subpaths joined under it.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_paths.test.ts`
- [ ] **Step 3: Implement** `libraryPaths` using `node:os` `homedir` and `node:path` `join`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: library paths"`

---

### Task 4: Manifest (persisted, human-only)

**Files:**
- Create: `src/library/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig` and its validation from `src/mcp/config.ts` (reuse `parseMcpConfig` by wrapping a single-server `{ mcpServers: { [name]: server } }`, or a shared helper; do not duplicate the rules).
- Produces:
  - `type ArtifactKind = "tool" | "skill" | "mcp"`
  - `interface ToolEntry { kind: "tool"; name: string; file: string; enabled: boolean }` (`file` is relative to `toolsDir`)
  - `interface SkillEntry { kind: "skill"; name: string; description: string; enabled: boolean }` (`name` is the skill dir)
  - `interface McpEntry { kind: "mcp"; name: string; server: McpServerConfig; enabled: boolean }`
  - `type ManifestEntry = ToolEntry | SkillEntry | McpEntry`
  - `interface Manifest { entries: ManifestEntry[] }`
  - `function parseManifest(json: unknown, source: string): Manifest`
  - `async function loadManifest(path: string): Promise<Manifest>` — missing file ⇒ `{ entries: [] }`; broken JSON ⇒ `ConfigError`.
  - `async function saveManifest(path: string, m: Manifest): Promise<void>` — atomic (temp + `rename`), creating `dirname(path)` if needed.
  - `function formatManifest(m: Manifest): string` — stable JSON + trailing newline.

- [ ] **Step 1: Write failing tests**: round-trips a manifest of each kind; unknown top-level key ⇒ `ConfigError`; an entry with an unknown `kind` ⇒ `ConfigError`; an `mcp` entry with a bad server (no `command`) ⇒ `ConfigError` from the reused validation; `loadManifest` of a missing path ⇒ empty; `saveManifest` then `loadManifest` returns equal entries.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/manifest.test.ts`
- [ ] **Step 3: Implement** mirroring `src/settings.ts` structure (`parse*`/`ConfigError`, atomic save). Validate `mcp` entries through the shared MCP rules.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: library manifest (persisted, atomic)"`

---

### Task 5: Tool loader (hot import of a factory file)

**Files:**
- Create: `src/library/loader.ts`
- Test: `test/library_loader.test.ts` (writes temp `.ts` files under the scratch/tmp dir)

**Interfaces:**
- Consumes: `defineTool`, `Tool`, `NAME_PATTERN`-equivalent validation from `src/registry.ts`; `PrivatePath` from `src/tools/private_paths.ts`.
- Produces:
  - `interface ToolFactoryDeps { defineTool: typeof defineTool; workspaceRoot: string; privatePaths: PrivatePath[] }`
  - `type ToolFactory = (deps: ToolFactoryDeps) => Tool`
  - `async function loadToolFile(file: string, deps: ToolFactoryDeps): Promise<Tool>` — dynamic-imports with a cache-busting query, requires a **default export** that is a function, calls it with `deps`, validates the returned object has string `name` (matching the registry name pattern), string `description`, object `input_schema`, and function `handler`; throws an instructive `Error` otherwise.
  - `async function scanToolsDir(dir: string): Promise<string[]>` — absolute paths of `*.ts` files **directly** in `dir` (not subdirectories); missing dir ⇒ `[]`.

- [ ] **Step 1: Write failing tests**:
  - loads a valid factory file and the returned tool's handler runs.
  - **cache-bust**: load a file, rewrite it to return a different description, load again, assert the new description (proves it is not the cached module).
  - a file with no default export, a default export that is not a function, and a factory returning a bad shape each **throw** with a message naming the file/problem.
  - a factory returning a tool whose name is invalid throws.
  - `scanToolsDir` ignores subdirectories and a missing dir returns `[]`.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_loader.test.ts`
- [ ] **Step 3: Implement** using `import(pathToFileURL(file).href + "?v=" + Date.now())` (`node:url` `pathToFileURL`) and `node:fs/promises` `readdir`. Reuse the registry's name check (export it from `src/registry.ts` if not already reachable).
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: hot tool-file loader (factory contract)"`

---

### Task 6: Skills (scan, describe, read)

**Files:**
- Create: `src/library/skills.ts`
- Test: `test/library_skills.test.ts`

**Interfaces:**
- Produces:
  - `interface SkillInfo { name: string; description: string; dir: string }`
  - `async function scanSkillsDir(dir: string): Promise<SkillInfo[]>` — one entry per subdirectory containing `SKILL.md`; `description` from a leading `description:` frontmatter line, else the first non-heading, non-empty line; missing dir ⇒ `[]`.
  - `async function readSkill(dir: string, name: string): Promise<string>` — the `SKILL.md` text; throws an instructive error if absent.

- [ ] **Step 1: Write failing tests**: a skills dir with two skill subdirs yields both with descriptions parsed from frontmatter and from a first line; a subdir without `SKILL.md` is skipped; `readSkill` returns the text and throws for an unknown name.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_skills.test.ts`
- [ ] **Step 3: Implement** with `node:fs/promises`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: library skills (scan/read)"`

---

### Task 7: Per-server MCP start helper + tracking

**Files:**
- Modify: `src/mcp/start.ts` (add a single-server start that returns a per-server handle; keep `startMcpServers` working)
- Test: `test/mcp_start.test.ts` (reuse `test/fixtures/fake_mcp_server.ts`)

**Interfaces:**
- Consumes: `connectMcpServer` (`src/mcp/client.ts`), `createMcpTools` (`src/mcp/tools.ts`), `McpServerConfig`, `McpStartOptions`.
- Produces:
  - `interface StartedServer { name: string; tools: Tool[]; instructions?: string; warnings: string[]; close(): void }`
  - `async function startOneServer(server: McpServerConfig, opts: McpStartOptions): Promise<StartedServer>` — starts one server, builds its tools, exposes `instructions` (the server's own text) and a **per-server** `close()`. On failure throws an instructive `Error` (so the caller can report it without taking down the session).

- [ ] **Step 1: Write failing tests**: `startOneServer` against the fake server returns its tools and a working `close()`; `hiddenEnv` names are not visible to the server (assert via the fake echoing its env); a bad command throws an instructive error.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/mcp_start.test.ts`
- [ ] **Step 3: Implement** `startOneServer`; refactor `startMcpServers` to build on it if it reduces duplication, keeping its current return shape and tests green.
- [ ] **Step 4: Run tests, verify they pass.** Run: `node --test test/mcp_start.test.ts test/mcp_client.test.ts test/mcp_tools.test.ts`
- [ ] **Step 5: Commit.** `git commit -m "feat: start and track one MCP server at a time"`

---

### Task 8: Library session (overlay + baseline + diff + persist)

**Files:**
- Create: `src/library/session.ts`
- Test: `test/library_session.test.ts`

**Interfaces:**
- Consumes: Tasks 1,4,5,6,7 (`registry.add/remove/has`, manifest types + `saveManifest`, `loadToolFile`/`scanToolsDir`, skills, `startOneServer`), and `LibraryPaths`.
- Produces: `createLibrarySession(deps: LibrarySessionDeps): Promise<LibrarySession>` where
  - `interface LibrarySessionDeps { paths: LibraryPaths; manifest: Manifest; toolDeps: ToolFactoryDeps; registry: { add(t: Tool): void; remove(name: string): void; has(name: string): boolean }; startServer(s: McpServerConfig): Promise<StartedServer> }`
  - `interface LibrarySession {`
    - `applyBaseline(): Promise<{ notes: string[]; warnings: string[] }>` — load the manifest's **enabled** tools into the registry, start its enabled servers (tracking each handle), record its enabled skills. A failing artifact is a warning, not a throw.
    - `reloadTools(): Promise<{ loaded: string[]; failed: { file: string; error: string }[] }>` — scan `toolsDir`, load each file, `registry.add` (replacing a prior session-loaded version of the same name), mark session-enabled. Does **not** touch the manifest.
    - `addServer(server: McpServerConfig): Promise<{ tools: string[]; instructions?: string }>` — `startServer`, `registry.add` each tool, track the handle, session-enable. Throws instructively on failure (nothing added).
    - `setEnabled(kind: ArtifactKind, name: string, enabled: boolean): Promise<string>` — session-only; enabling loads/starts, disabling `registry.remove`s tools or `close()`s a server. Returns a human-readable line.
    - `listSkills(): SkillInfo[]` — enabled skills; `readSkill(name): Promise<string>`.
    - `inventory(): { kind: ArtifactKind; name: string; enabled: boolean; persisted: boolean }[]` — for the REPL listings.
    - `diff(): { added: {kind;name}[]; enabledChanged: {kind;name;enabled}[] }` — overlay vs persisted manifest.
    - `persist(selection: {kind;name}[], manifestPath: string): Promise<void>` — **human-only**; folds the selected overlay changes into the manifest and `saveManifest`s (moving any session-authored tool file into its manifest `file` location). The exact selection/UX is the REPL's (Task 10); this writes what it's handed.
    - `closeAll(): void` — close every session-started server (for quit). }`

- [ ] **Step 1: Write failing tests** (inject fakes for `registry`/`startServer`):
  - `applyBaseline` loads only enabled manifest tools (a disabled entry is skipped) and a failing tool file becomes a warning, not a throw.
  - `reloadTools` picks up a new temp tool file and adds it; a bad file appears in `failed`, the good ones still load.
  - `addServer` adds the server's tools and tracks a handle; `setEnabled("mcp",name,false)` calls that handle's `close()` and removes its tools.
  - `diff` reports a reloaded tool as `added` (not in manifest) and reports a baseline tool disabled this session under `enabledChanged`.
  - `persist` of a selected added tool writes a manifest entry (verified via `loadManifest`) and leaves unselected changes out.
  - `closeAll` closes all tracked server handles.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_session.test.ts`
- [ ] **Step 3: Implement** the coordinator. Keep it pure of REPL/IO beyond the injected deps and the manifest/file operations it owns.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: library session (overlay, baseline, diff, persist)"`

---

### Task 9: Model-facing tools (unattended only) + boundaries

**Files:**
- Create: `src/tools/unattended/library.ts` (all model tools for this feature, built as factories over a `LibrarySession`)
- Modify: `src/agent_tools.ts` (register them in unattended mode, after `run_shell`/`write_file`, before MCP tools)
- Modify: `test/boundaries.test.ts` (update the exact unattended tool-name list; keep normal mode unchanged)
- Test: `test/library_tools.test.ts`

**Interfaces:**
- Consumes: `LibrarySession` (Task 8).
- Produces: `createLibraryTools(session: LibrarySession): Tool[]` returning tools:
  - `reload_tools` → `session.reloadTools()`, reports loaded/failed and a one-line note that new tools are session-only until the user persists them, plus the prompt-cache note.
  - `add_mcp_server` (input: `name`, `command`, `args?`, `env?`) → validates to an `McpServerConfig`, `session.addServer`, reports tools gained and appends the server's `instructions` into the result text (so the model sees how to drive them). Description instructs the model to prefer a reputable existing server.
  - `set_artifact_enabled` (input: `kind`, `name`, `enabled`) → `session.setEnabled`.
  - `list_skills` → `session.listSkills()`; `use_skill` (input: `name`) → `session.readSkill(name)`.
  - **No persist tool.**
- `assembleTools` gains an optional `libraryTools?: Tool[]`, pushed only when `unattended`.

- [ ] **Step 1: Write failing tests**:
  - `test/library_tools.test.ts`: each tool dispatches to its session method (inject a fake session); `add_mcp_server` includes the server instructions in its result; a failing `reload_tools` file is reported, not thrown.
  - `test/boundaries.test.ts`: update `test("unattended mode adds run_shell and write_file, and nothing else")` to assert the new exact unattended set (built-ins + `run_shell`, `write_file`, `reload_tools`, `add_mcp_server`, `set_artifact_enabled`, `list_skills`, `use_skill`); keep the normal-mode `deepEqual(["get_time","list_dir","read_file","web_fetch"])` assertion unchanged; keep the "no tool imports a settings/manifest/log writer" check passing (library model tools import **only** the session interface, never `manifest.ts`'s `saveManifest` directly — persist lives in the REPL path).
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_tools.test.ts test/boundaries.test.ts`
- [ ] **Step 3: Implement** the tools under `src/tools/unattended/` and wire `assembleTools`. Ensure the "no interactive tool writes/executes" scan (top-level `src/tools/*.ts`) is untouched — these live in `unattended/`.
- [ ] **Step 4: Run tests, verify they pass.** Run: `node --test test/library_tools.test.ts test/boundaries.test.ts test/tools.test.ts`
- [ ] **Step 5: Commit.** `git commit -m "feat: model tools for self-extension (unattended only)"`

---

### Task 10: REPL wiring + commands + quit alert

**Files:**
- Create: `src/library_command.ts` (parse/format for `/tools`, `/skills`, `/mcp`, `/library`, following `src/policy_command.ts`)
- Modify: `src/repl.ts` (build `LibrarySession`, `applyBaseline`, pass `libraryTools` to `assembleTools`, add commands, extend `quit` to `session.closeAll()` and alert on an unpersisted diff; MCP instruction note to history uses the existing append mechanism)
- Test: `test/library_command.test.ts`

**Interfaces:**
- Consumes: `LibrarySession.inventory/diff/setEnabled/persist/closeAll`.
- Produces (pure, testable): `formatInventory(items)`, `parseLibraryCommand(line)` → an action (`list`/`enable`/`disable`/`persist`/`persist-review`), and `formatDiff(diff)`. The interactive `/library` persist flow in `repl.ts` is thin over these.

- [ ] **Step 1: Write failing tests** in `test/library_command.test.ts`: `/tools` with no arg parses to a list action; `/mcp disable foo` parses to a disable of kind mcp; `formatInventory` marks persisted vs session-only and enabled state; `formatDiff` renders added vs enable-changed; an unknown subcommand is an instructive error.
- [ ] **Step 2: Run tests, verify they fail.** Run: `node --test test/library_command.test.ts`
- [ ] **Step 3: Implement** the command module, then wire `repl.ts`: construct `libraryPaths`/`loadManifest`/`createLibrarySession` near the existing MCP startup (~`src/repl.ts:373`), call `applyBaseline` and feed `libraryTools` into `assembleTools` (~`:382`); register the commands beside the others; in `quit` (~`:430`) call `session.closeAll()` and, if `session.diff()` is non-empty, print the alert offering `/library`. Deliver a mid-run server's instructions by appending a note to history (the mechanism near `src/repl.ts:698`), not by rebuilding the cached system prompt.
- [ ] **Step 4: Run tests + type-check + full suite.** Run: `node --test test/library_command.test.ts && npm run check && npm test`
- [ ] **Step 5: Commit.** `git commit -m "feat: library REPL commands, baseline load, quit-time persist alert"`

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (an "Extending the harness at runtime" subsection under Unattended mode)

**Interfaces:** none.

- [ ] **Step 1:** Document the library location/env var, the two layers (session overlay vs persisted manifest), the model tools, the `/tools /skills /mcp /library` commands, the human-only persist, and that it is unattended-only. Note the factory contract for authored tool files (the exact shape the model must write).
- [ ] **Step 2: Type-check + full suite once more.** Run: `npm run check && npm test`
- [ ] **Step 3: Commit.** `git commit -m "docs: runtime self-extension (library, skills, MCP)"`

---

## Phases (natural review points)

- **Phase A — native tools hot-reload:** Tasks 1–5, 8 (tools-only paths), 9 (`reload_tools`, `set_artifact_enabled`), 10 (`/tools`, `/library`). Ships "model builds and hot-loads native tools; human persists."
- **Phase B — skills:** Task 6 + the `list_skills`/`use_skill`/`/skills` parts of 9–10.
- **Phase C — live MCP:** Task 7 + `add_mcp_server`/`/mcp` parts of 9–10.

The task list above is ordered to build these up; a reviewer may gate at the end of each phase.
