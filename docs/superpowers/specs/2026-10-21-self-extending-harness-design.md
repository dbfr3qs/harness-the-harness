# Self-extending harness: live tools, MCP servers, and skills

## Intent and why

The harness should let the model extend its own capabilities **mid-session, without a
restart**, so it can take on open-ended work — including authorized penetration-testing
engagements — where the useful tool, server, or reference material isn't known in advance.

Three abilities, all requested:

1. **Author a native tool** (a TypeScript file), load it into the running registry, and call
   it in the same session.
2. **Add and start an MCP server** live, its tools folding into the live set.
3. **Author skills** (plain text instructions) and pull them into context on demand.

There is a library that **accumulates** over time, so capabilities the model builds can survive
restarts. But **the model never persists on its own.** Within a session the model is free to build,
load, enable and disable its own capabilities as it works; all of that is **session-local**.
Writing any of it into the persisted library — the set the harness loads at startup — is a
**human decision**. When a session's active capabilities differ from the persisted defaults, the
harness tells the user and lets them review the changes and choose what, if anything, to keep.

So two layers:

- **Session-local (model-driven).** What the model has built/enabled/disabled this session. The
  model changes this freely to manage its own capabilities and context mid-task. Gone at session
  end unless the human persists it.
- **Persisted library (human-curated).** The manifest the harness loads at startup. Changed only
  by an explicit human persist action, from a review of what the session did.

The motivating moment: the user asks the model to do a job, the model realizes it needs a
capability it doesn't have (a git wrapper, a protocol client, a recon helper, a remembered
procedure), builds it, and keeps working — without the user restarting anything. Afterward the user
decides whether that capability joins the permanent toolbox.

**Prefer an existing, reputable MCP server over a hand-built tool when the capability is
substantial.** When the model needs a non-trivial capability, it should first look for a known-good
published MCP server (e.g. a Ghidra MCP — far too much to reimplement as a native tool) and add
that, rather than build its own. A native tool is the right choice when no suitable server exists,
or when the functionality is simple enough that a small tool is cleaner than pulling in a server.
This preference belongs in the model-facing instructions for the authoring/add-server tools.

## Goals

- The model can write a native tool and, after an explicit reload step, call it **in the same
  run** (same user message, later turn) — not only after the next message.
- The model can add an MCP server (preferably a reputable existing one; see Intent) and start it
  live; its tools become callable without a restart.
- The model can author a skill and later load its text into context; `list`/`use` surface what
  exists.
- The library lives in a directory separate from the task workspace, and the harness loads the
  persisted, enabled artifacts at startup.
- **The model changes capabilities only for the current session; it never writes the persisted
  library.** Persisting is a human-only action, done from a review of the session's changes.
- The model can enable/disable any artifact for the session (to manage its own context); the human
  can enable/disable and, separately, **persist** — via REPL commands.
- When a session's active set diverges from the persisted defaults, the harness surfaces the
  difference and offers to persist selected changes.
- A broken or crashing artifact (a tool file that fails to import, a server that won't start, a
  handler that throws) is reported back and **cannot take down the running session**.
- These write/execute-capable abilities exist **only in unattended mode**; normal (read-only)
  mode is unchanged, and `test/boundaries.test.ts` still proves no write/execute tool reaches the
  normal tool set.

## Non-goals

- **Not a sandbox for the model's own code.** Native tool files are imported into the harness
  process and run with its permissions, exactly as `run_shell` already does. The surrounding
  sandbox remains the real boundary; this feature does not try to isolate model-authored code.
- **Not a filesystem watcher.** Reload is an explicit step the model (or user) triggers, not an
  automatic watch. (Left open for the builder to revisit if explicit reload proves clumsy.)
- **Not remote/HTTP MCP.** Reuse the existing stdio-only MCP machinery; no new transport.
- **Not a package manager.** Installing dependencies for a tool or server is done by the model
  through `run_shell` inside the sandbox, not by new harness machinery.
- **Not retroactive editing of the running conversation's prompt.** Adding tools mid-run changes
  the request's tool list going forward only (see Constraints on prompt caching).

## Anti-goals (failure even if it technically works)

- Weakening normal-mode guarantees. If after this change the read-only harness can write, execute,
  or self-modify, the feature has failed regardless of what else works.
- A self-authored tool that crashes, hangs, or corrupts state taking down the live session or
  wedging the REPL.
- Secrets reaching model-authored artifacts beyond what `run_shell` already exposes (the MCP
  `hiddenEnv` protection for API keys must still apply to model-started servers).
- Silent failure: a tool that fails to load, or a disabled artifact the model tries to use, must
  produce an instructive message (the house style: errors written for the model to read).

## Constraints (from the existing codebase)

- **Zero runtime dependencies.** Plain `fetch` and `node:` builtins only; Node 24 type-stripping;
  tests with `node:test`. No new npm deps.
- **Repo idioms.** Tools are built with `defineTool`; config-needing tools are factory functions
  (see `list_dir.ts`); errors are written as guidance for the model. Settings/manifest files are
  validated with a `parse*`/`ConfigError` function and written atomically (temp file + rename), as
  in `src/settings.ts`.
- **Reuse existing machinery.** MCP: `src/mcp/config.ts` (`parseMcpConfig`, `McpServerConfig`),
  `src/mcp/start.ts` (`startMcpServers`, with `hiddenEnv` and the per-server `close`). Registry:
  `src/registry.ts`. Tool assembly: `src/agent_tools.ts` (`assembleTools`). REPL wiring:
  `src/repl.ts` (around lines 373–383, 435–436, 715–717).
- **The agent loop reads the tool list once per run.** `runAgent` does `const tools =
  registry.definitions()` at the top (`src/agent.ts:61`) and reuses it for every turn of that run.
  For a tool built mid-run to be callable later in the *same* run, `runAgent` must re-read
  `registry.definitions()` **each turn** (cheap; `tools` is already passed per model call). This is
  a required change, called out so the builder doesn't miss it.
- **Prompt caching cost.** Tool definitions sit at the start of each request. Adding tools mid-run
  changes that prefix and invalidates the prompt cache from there (see the note at
  `src/repl.ts:698`, which deliberately appends to history rather than editing tool definitions).
  This is an accepted cost of live tool loading, not a bug to design around; worth a one-line note
  to the model when it reloads.

## Design decisions already made

These are settled. The builder implements them; the user can veto any on review.

- **Library location.** A single library directory, separate from the per-session workspace, so
  the same toolbox is available from any workspace. Configurable (an env var, e.g.
  `LIBRARY_ROOT`); default under the user's home (e.g. `~/.harness/library/`). *(My call — the
  exact env name and default path are the most likely thing to adjust.)*
- **Library layout.**
  - `library/tools/<name>.ts` — one native tool per file.
  - `library/skills/<name>/SKILL.md` — one skill per directory (room for helper files beside it).
  - MCP servers are entries in the manifest (command/args/env), reusing the `McpServerConfig`
    shape; there is no separate MCP file to hand-edit.
  - `library/manifest.json` — the index: every artifact, its kind, and its `enabled` flag.
- **Native tool contract.** A tool file default-exports a **factory** `(deps) => Tool`. The deps
  object the harness passes in includes `defineTool` itself plus the context a tool needs
  (workspace root, private paths, and the loader can extend this). This is the deliberate answer to
  "what does a file outside the repo import": **nothing.** A file at `~/.harness/library/tools/foo.ts`
  cannot resolve a relative `../registry.ts` and the harness is not a published package, so the file
  imports no harness code at all — it receives `defineTool` as a dep and returns the built tool.
  (`node:` builtins it may still import normally.) The tool-authoring instructions the model reads
  must show exactly this factory shape. The scanner loads files directly in `library/tools/`;
  anything in subdirectories is treated as a helper and ignored.
- **Hot-reload mechanism.** Dynamic `import()` of the `.ts` file with a cache-busting query
  (`?v=<timestamp>`), so an edited file re-imports fresh. Loaded tools are validated (name matches
  the registry's `NAME_PATTERN`, no collision with a built-in or another enabled tool) before they
  join the live set; a file that throws on import, exports the wrong shape, or collides is
  reported and skipped, leaving the session running.
- **Mutable registry.** `createRegistry` gains the ability to add / replace / remove tools at
  runtime (today the set is frozen at construction). `definitions()` and `dispatch()` read the
  current set. The built-in tools cannot be removed or shadowed.
- **Two layers: persisted manifest vs. session overlay.** The `manifest.json` is the **persisted,
  human-curated** set: validated and written atomically like `harness.json`, and written **only** by
  a human persist action. At startup the harness loads exactly the manifest's enabled tools/skills
  and starts its enabled MCP servers — nothing else, even if other files sit in the library dir.
  On top of that the session keeps an in-memory **overlay** of everything the model (or human) has
  built, loaded, enabled or disabled this session. Every model-driven change — `reload_tools`,
  `add_mcp_server`, enable/disable — writes the **overlay only**, never the manifest. The live set
  the model sees is manifest-plus-overlay. Disabling a tool/skill in the overlay stops offering it;
  disabling an MCP server closes its connection for the session.
- **Persist is a separate, human-only action.** A REPL command (e.g. `/library`) shows the overlay
  diff against the persisted manifest — what the model added, enabled, disabled this session — and
  lets the human persist selected items (writing manifest entries and copying any authored file into
  its permanent place) or discard them. The harness **alerts the user when an unpersisted diff
  exists** (at least on quit; the builder may also surface it on demand). Nothing the model did
  reaches the next startup unless the human persists it here.
- **MCP connection tracking.** `startMcpServers` today returns a single *aggregate* `close()` over
  all startup servers. To start/stop model-added servers individually (overlay enable/disable and
  quit-time cleanup), the loader tracks each model-started connection in a map — starting one via
  `startMcpServers([oneServer])` or `connectMcpServer` directly — so it has a per-server handle, and
  the existing teardown at `src/repl.ts` is extended to also close these.
- **Trigger model.** Explicit, model-callable steps (and matching REPL commands), not a watcher.
- **Unattended-only, enforced by the boundaries test.** All of this — authoring, reload, add-server,
  enable/disable, skill reading, and the human persist command — lives behind the unattended gate
  alongside `run_shell`/`write_file`. `test/boundaries.test.ts` is extended to prove the library
  tools, the mutable-registry mutation API, and MCP-start-after-launch are never reachable in normal
  mode.
- **`hiddenEnv` still applies.** Model-started MCP servers go through the same `startMcpServers`
  path, so API keys remain hidden from them.

## Proposed surface (shape for the builder; exact names are the builder's to finalize)

Model-facing tools (unattended only):

- `reload_tools` — rescan `library/tools/`, import each file, and add it to the **session overlay**
  (enabled for this session). The loop is write → reload → call (two steps). This does **not** write
  the manifest; the tool is gone next startup unless the human persists it. Reports which loaded,
  which failed and why.
- `add_mcp_server` — validate an MCP server spec, start it, and fold its tools into the **session
  overlay** (not the manifest). The model should prefer a reputable existing server here (see
  Intent). Because a server's `instructions` and its `name__<tool>` naming note normally go into the
  session system prompt (assembled once, prompt-cached), a mid-run start **delivers them by appending
  a note to history** — the same mechanism the web-policy change uses (`src/repl.ts` ~695) — rather
  than rebuilding the cached system prompt. Reports tools gained (and their instructions) or the
  startup failure.
- `enable_artifact` / `disable_artifact` (or one `set_artifact_enabled`) — toggle any artifact by
  name+kind **for the session** (overlay), applied live. The model uses this to manage its own
  context. It never persists.
- `list_skills` / `use_skill` — list enabled skills with one-line descriptions; read one skill's
  text into context.

The model has **no** persist tool — persisting is human-only (see below).

**Authoring the files.** The library sits outside the workspace, and `write_file` stays
workspace-confined (it never writes outside the workspace, even in unattended mode — that invariant
and its boundaries test are left untouched). So the model does not author into the library with
`write_file`. Instead it uses `run_shell` (already unconfined in unattended mode) to write the
`.ts` / `SKILL.md` file into the library, or a dedicated unattended library-write tool the builder
may add; the authoring step and the register/reload step may be combined into one tool if that
reads better. The point settled here: **the library-authoring path is not `write_file`, and
`write_file`'s workspace confinement does not change.**

REPL commands (human curation, following the existing `src/*_command.ts` pattern):

- `/tools`, `/skills`, `/mcp` — list each kind with its enabled state (persisted vs. session-only),
  and take an enable/disable argument to change the session overlay, same as the model's tools.
- `/library` (or `/persist`) — show the overlay diff against the persisted manifest (what the
  session built, enabled, disabled) and let the human persist selected items into the manifest
  (writing entries and moving any authored file into place) or discard them. This is the **only**
  path that writes the manifest. On quit, if an unpersisted diff exists, the harness alerts the user
  and offers this review.

## Left to the builder

- Exact tool and command names, and whether authoring/reloading is one tool or several.
- Manifest JSON schema specifics (fields per kind, versioning).
- Skill-description source (frontmatter in `SKILL.md` vs. a manifest field) and how much a skill
  loads at once.
- Error-message wording (follow the house style).
- Exact default library path and env var name.
- Whether a mid-run reload should surface the prompt-cache cost to the model, and how.
- The persist-review UX: exact `/library` layout, how the diff is shown, whether persist is
  item-by-item or all-at-once, and the precise quit-time alert.
- How the model discovers reputable existing MCP servers (it has `web_fetch`; whether to add any
  convenience beyond prompting it to search is the builder's call).

## Resolved: everything is unattended-only

The whole feature — authoring, tool/MCP loading, reload, enable/disable, *and* skill reading
(`list_skills`/`use_skill`) — is available only in unattended mode. Normal (read-only) mode gains
nothing and is provably unchanged by `test/boundaries.test.ts`. (The user confirmed they don't want
read-only skill hot-reloading in normal mode.)
