# Lazy-Loading Artifact Catalog — Design

**Status:** proposed
**Date:** 2026-10-21
**Builds on:** [`2026-10-21-self-extending-harness-design.md`](2026-10-21-self-extending-harness-design.md)
 (the library, the overlay/manifest two layers, the model's `reload_tools` /
 `add_mcp_server` / `set_artifact_enabled` / `list_skills` / `use_skill` tools,
 unattended-only gating, and human-only persistence). This document changes how
 those pieces behave; it does not replace them.

## Intent and why

The self-extending harness gave the model a persistent library of tools, MCP
servers and skills. But the manifest's `enabled` flag does double duty — it
means both "this exists in the library" and "load it into the session at
startup" — so every installed-and-enabled artifact is loaded into context on
every session whether or not the current task needs it. Loaded tools and MCP
servers enlarge the per-turn tool list (and reset the prompt cache when they
change), so an accumulating library steadily bloats every session.

Skills already avoid this: they cost nothing until the model calls `use_skill`.
We want tools and MCP servers to feel the same way. A session should start lean —
just the harness's built-in tools — and the model should **discover** what the
library holds, **load** only what the task in front of it needs, and **unload**
it when done. When the catalog has nothing suitable, the model **creates** a
tool or **installs** an MCP server on the spot. The human stays the sole
authority over what remains permanently installed between sessions.

The core reframe this document introduces: **installed** (present in the
catalog, its config remembered, costing nothing) becomes cleanly separate from
**loaded** (active in this session — a tool in the live set, a running server).

## Goals

- A fresh session loads **only the built-in tools** it loads today (per mode:
  the read-only set, plus `run_shell`/`write_file` and the library tools in
  unattended mode). No library artifact loads automatically.
- The model can **discover** the whole catalog across all kinds — for each
  artifact: its kind, name, a one-line description, and whether it is currently
  loaded — so it can decide what to bring in.
- The model can **load and unload** any cataloged tool, MCP server or skill on
  demand, within a session, as a cheap toggle.
- Once an artifact is **installed**, its config is remembered in the catalog, so
  loading it again never requires re-specifying it (the model never re-types an
  MCP server's command).
- The model can **install** into the catalog on demand: author a tool and add
  it, or register an MCP server. Both of the user's scenarios are supported —
  the human asks the model to install something, or the model decides it needs
  something.
- Two tiers of installation, decided **per item**:
  - **Session install** — by the model or human, lives only for this session.
  - **Permanent install** — survives between sessions; the human's call, through
    the existing `/library persist` flow.
- **Permanent install does not imply autoload.** "Remain permanently installed
  and available" means present in the catalog, not loaded at startup. A
  persisted artifact defaults to dormant; the human may separately opt specific
  artifacts into autoload.

## Non-goals

- **A startup autoload core / allowlist, and autoload itself.** The user's
  instruction is "built-ins only, for now." Nothing library-side loads at
  startup, and there is no mechanism (command or flag) to mark an artifact to
  autoload. A real autoload flag and a default-on core are a deferred future
  feature, not built here.
- **Auto-discovery of MCP servers from a registry or the internet.** The model
  installs a server by knowing or finding its launch command, exactly as today —
  there is no searchable index of installable servers.
- **Anything in normal / read-only mode.** The whole catalog remains
  unattended-only. The read-only boundary is unchanged.
- **Model-driven persistence.** The model still cannot write the manifest; only
  the human persists. This invariant does not move.

## Anti-goals (failure even if it technically works)

- A session that silently carries library artifacts in context that the model
  is not using. If startup is not lean, the feature has failed.
- The model making any catalog change permanent without the human.
- Load/unload churn that resets the prompt cache so often it costs more context
  than lazy loading saves. Loading should be deliberate and batched, not
  per-turn thrashing.
- Discovery that lists dormant artifacts by name only, with no description — the
  model could not then choose intelligently, defeating the point.

## Constraints

- Zero runtime dependencies; Node 24 native type-stripping; tests in
  `node:test` + `node:assert/strict`; `tsc --noEmit` clean.
- Unattended-only gating preserved; `test/boundaries.test.ts` invariants hold
  (normal mode exposes no write/execute/library tool).
- Human-only manifest writes preserved; the model has no persist tool.
- `hiddenEnv` continues to hide secrets from model-started servers; `write_file`
  stays workspace-confined (tool files are authored via `run_shell` into
  `toolsDir`).

## What already works (so the build stays small)

Against the current code, most of the load/unload behavior already exists; the
gaps are narrow. Recorded here so the plan does not rebuild what is there.

- The session overlay already seeds **all** manifest entries, including
  `enabled: false` ones, into its `tools` / `skills` / `mcps` maps
  (`src/library/session.ts`). A dormant entry is therefore already present and
  loadable.
- `set_artifact_enabled` already **loads and unloads** tools (add/remove from
  the registry) and MCP servers (start / stop while keeping the config in the
  `mcps` map), and flips a skill's offered state. Unload-then-reload of an MCP
  server already reuses the remembered config — no re-specification.
- `reload_tools` already rescans `toolsDir` and loads tool files the model
  authored, so **creating** a tool already works and survives on disk.
- `/library persist` already folds selected overlay changes into the manifest,
  per item, human-gated.

The missing pieces are: the model cannot **see** dormant catalog entries;
tools and MCP servers have **no description** to browse by; and the manifest's
`enabled` flag **conflates installed with autoload**, so a lean startup is not
expressible.

## Decided design

### 1. Installed is always dormant — no autoload (decided)

Presence in the manifest means **installed / available**, and nothing more. A
fresh session loads **only the built-in tools**; `applyBaseline` loads **no**
library artifact into the registry. Loading is always on demand, driven by the
model (or the human) during the session. "Permanently installed" means present
in the catalog — never loaded at startup.

This removes autoload as a concept for now. Consequences the builder must carry
through:

- The manifest's `enabled` field no longer drives startup loading. `applyBaseline`
  stops loading enabled entries; it only **seeds the catalog** (so persisted
  artifacts are discoverable and loadable) and records skills. Keep the field in
  the schema for backward compatibility (an existing manifest may carry it) but
  treat it as inert at startup; do not add a surface to set it. Reintroducing a
  real autoload flag is a deferred non-goal (below).
- **`diff()` / persist / quit-alert are reworked around "new installs only."**
  The only persist-worthy change is a **newly installed** artifact not yet in the
  manifest (the `added` axis). Loading and unloading an already-cataloged
  artifact during a session is the normal workflow and must **never** appear in
  the diff or trip the quit-time "unpersisted changes" alert. The
  `enabledChanged` axis — which today compares session loaded-state to the
  baseline — is removed or repurposed so that session load/unload is invisible to
  persistence. The quit alert fires only when the session installed something new
  that the human has not persisted.
- Persisting records the artifact as installed (dormant); it does not record or
  depend on whether it happened to be loaded when persisted.

### 2. A description for every catalog kind

Discovery needs a one-line description per artifact. Skills already carry one.
Add a `description` to tool and MCP catalog entries so dormant artifacts can be
browsed meaningfully:

- **Tool:** captured at install time from the loaded `Tool.description` (the
  file's factory already produces it), stored in the catalog so a dormant tool
  still has a description without loading its file.
- **MCP server:** supplied when the server is installed (a short human/model
  line on what it is for), stored on the catalog entry.

The builder decides the exact field placement (extending `ToolEntry` /
`McpEntry` and the session's in-memory records) and keeps `parseManifest`
validation and the boundaries/round-trip tests honest.

### 3. A model-facing discovery tool

The model gains a way to **browse the whole catalog** — tools, MCP servers and
skills together — each shown with kind, name, description, and whether it is
currently loaded. This is the one genuinely new model-facing capability.

The exact surface is left to the builder: a single `list_catalog` tool spanning
all kinds is preferred (it matches the model's mental model of "what can I bring
in?"), but generalizing `list_skills` into it, or adding per-kind listers, is
acceptable if cleaner. `use_skill` remains the way to actually read a skill;
`set_artifact_enabled` remains the way to load/unload a tool or server. Whatever
the surface, the model must be able to go from "what exists?" to "load this one"
without the human.

### 4. Load / unload stays `set_artifact_enabled`, reframed

Keep `set_artifact_enabled`; it already performs load/unload for all three
kinds. Reframe its description in terms the model will reach for ("load",
"unload") and make clear that an unloaded artifact stays installed and can be
re-loaded cheaply. Reframe `reload_tools`' and `add_mcp_server`'s result text so
the model understands the new catalog mental model (installed vs loaded, and
that loading changes the tool set / resets the prompt cache, so it should load
deliberately and unload when done).

### 5. Install stays the model's to do, permanence stays the human's

- **Create a tool:** author a `.ts` file into `toolsDir` with `run_shell`, then
  `reload_tools` (unchanged). The tool enters the session catalog, dormant-by-
  default framing notwithstanding — a freshly reloaded tool is loaded (the model
  just asked for it); the model unloads it when done.
- **Install an MCP server:** `add_mcp_server` registers the config in the
  session catalog (remembered for cheap re-load) and starts it. The model may
  then unload it; the config persists in the catalog for the session. A dormant-
  from-the-start install (register without starting) is an optional convenience
  the builder may add if it is cheap; it is not required, since install → use →
  unload already leaves the config cataloged.
- **Permanence:** `/library persist`, per item, human-gated — unchanged, except
  for the autoload-off default from §1.

## Decisions settled after builder review

These were raised by the builder check and are settled here so the plan does not
reopen them:

- **Autoload: not built.** Decided above (§1) — always dormant, no autoload flag
  or command, `diff()`/alert reworked to "new installs only."
- **Skill "loaded" state in discovery.** Skills are read on demand via
  `use_skill` and never enter the tool set, so they have no loaded/unloaded
  state. The discovery listing shows skills as plain available entries (name +
  description); the "loaded" indicator applies only to tools and MCP servers.
- **Tool descriptions.** Add an optional `description` to `ToolEntry` (and the
  session's `ToolRec`), defaulted/optional so existing manifests still parse (no
  migration). Capture it from the loaded `Tool.description` whenever a tool is
  loaded (`reloadTools` / `setEnabled`), and write it in `buildEntry` on persist,
  so a dormant persisted tool still has a browsable description without importing
  its file.
- **Manifest field name.** Keep `enabled` in the schema (inert at startup) rather
  than renaming — simpler and backward-compatible.
- **MCP description.** `add_mcp_server` gains an optional `description` string the
  model supplies; stored on the catalog entry. Optional, not required.
- **MCP "install without starting".** Not built — install-then-use-then-unload
  already leaves the config cataloged, which covers the need.

## Left to the builder

- The exact discovery-tool surface (single `list_catalog` preferred, vs.
  generalizing `list_skills`, vs. per-kind listers) and its output format.
- Reframed description/result text for `set_artifact_enabled`, `reload_tools` and
  `add_mcp_server` (installed-vs-loaded language, the prompt-cache note).
- The precise reshaping of `diff()`, the `/library` output and the quit alert
  around "new installs only," and the matching updates to
  `test/library_command.test.ts`.
- All other test specifics, following the existing library tests' style, plus:
  a test that a fresh session with a non-empty (dormant) manifest loads **no**
  library artifact into the registry (the lean-startup invariant); and the
  `test/boundaries.test.ts` expected-unattended-set + ordering assertions updated
  to include the new discovery tool. Normal/read-only invariants are unchanged.
