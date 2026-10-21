# Restartable Sessions — Design

**Status:** proposed
**Date:** 2026-10-21
**Relates to:** the lazy-loading artifact catalog
([`2026-10-21-lazy-catalog-design.md`](2026-10-21-lazy-catalog-design.md)) — a
session's *loaded* working set is what this feature must capture and rebuild.

## Intent and why

Today the harness is ephemeral: quit it and the conversation, your settings,
and whatever tools and MCP servers you had loaded are gone. A long working
session — especially an unattended one that has built up a tailored tool set —
can't survive a deliberate quit, let alone a crash or a `kill`.

We want to **quit and come back to the exact same session.** Each session gets
a stable UUID. On quit (and after every turn), the harness writes the session's
full state to disk. On quit it prints the command to resume that exact session.
Relaunching with that id restores the conversation *and* the working setup —
settings, web policy, and the loaded tools/skills/MCP servers — so it feels like
you never left.

## Goals

- **Stable identity:** every session has a UUID, generated at startup for a new
  session and carried by a resumed one.
- **Resume command on quit:** quitting prints the exact command to resume this
  session, e.g. `npm start -- --resume <uuid>`.
- **Full restore on resume:**
  - the **conversation** — the complete message history, so the model continues
    with full context;
  - the **settings** — provider, model, thinking-shown, turn cap, max-tokens,
    any context-window override, and the live web policy (including unsaved
    changes made via `/policy`);
  - the **library working set** — the session's catalog as it stood: every
    session-added artifact and, for all catalog artifacts, whether it was
    *loaded*. On resume, loaded tools are re-loaded, loaded MCP servers are
    relaunched, and skills' offered state is restored.
  - the **mode** — a session started unattended resumes unattended (and so
    re-enables the library); a normal session resumes normal.
- **Save after every turn** (and on quit), atomically, so a crash or `kill`
  never loses more than the turn in flight.
- **Best-effort working-set restore:** if a loaded MCP server's command no
  longer launches, or a loaded tool file is gone, resume warns and continues —
  it never aborts the whole restore over one artifact.

## Non-goals

- **Editing or merging sessions, branching, or a session picker UI.** Resume is
  by explicit UUID on the command line; listing/cleaning old sessions is out of
  scope (sessions accumulate on disk; the user manages the directory).
- **Cross-provider or cross-machine portability guarantees.** A session resumes
  against the same provider/model it recorded; we do not translate a
  conversation held with one provider for another (the existing provider-mixing
  guard still applies).
- **Replacing the transcript.** The append-only JSONL transcript stays as the
  human-readable log; the session file is a separate, rewritten state snapshot.
  (A resumed session continues appending to its recorded transcript path.)
- **Restoring in-flight tool calls or a partially-streamed reply.** The save
  boundary is a completed turn; an interrupted turn resumes from the last
  completed one.

## Anti-goals (failure even if it technically works)

- **The provider API key written to disk.** The session file must never contain
  `config.secrets` (the provider API key) — the writer scrubs them exactly as
  the transcript logger does (`split`/`join` on the serialized line). `apiKey`
  and `baseUrl` are never saved; they come from the current environment on
  resume. (An MCP server's own `env` — which may hold a user/model-supplied
  token — IS stored, see below; that is the user's decision and is protected by
  file confinement, not by scrubbing.)
- **A resume that silently drops part of the setup.** If something can't be
  restored (a missing tool file, a server that won't start), the user is told
  plainly at resume; the gap is never swallowed.
- **A save that can corrupt the session on a crash mid-write.** Writes are
  atomic (temp file + rename), like `saveManifest`.
- **A normal (read-only) session resuming with write/execute tools it never
  had.** Mode is part of the restored state and must round-trip exactly; the
  boundaries invariant holds across save/restore.

## Constraints

- Zero runtime dependencies; Node 24 (native type-stripping); tests in
  `node:test` + `node:assert/strict`; `npm run check` clean.
- The session file is sensitive (it holds the whole conversation): it must be
  covered by the same private-path confinement that protects transcripts, so
  the model's own file tools can't read another provider's session or exfiltrate
  one (see `transcriptPrivatePaths` in `src/repl.ts`).
- Human-only-persist and unattended-only invariants from the catalog feature are
  unchanged. Restoring a working set re-loads/relaunches only what the saved
  session recorded as loaded — it introduces no new model-reachable capability.

## Decided design

### Session identity and the resume flag

- A session id is a `crypto.randomUUID()` generated at startup, unless
  `--resume <uuid>` (or `HARNESS_RESUME=<uuid>`) is given, in which case the id
  is that value and its session file is loaded.
- `--resume <uuid>` is read early (before building the registry, policy, and
  library), because the loaded state determines mode, settings, and the working
  set to rebuild. A resume whose file is missing or unreadable fails fast with a
  clear message naming the id and the path looked at.

### Where the session lives

- `sessions/<uuid>.json` under the working directory by default; overridable by
  env (e.g. `SESSIONS_DIR`). One JSON object per session, rewritten in full each
  save, atomically (temp + rename).
- The directory is confined as a private path like transcripts, so model file
  tools can neither read **nor write** it. The no-write half matters: a session
  file holds tool file paths and MCP launch configs that are executed on resume,
  so an unattended model that could plant or edit one would gain code execution
  on the next restart. Files are written mode `0600`, and `sessions/` is added to
  `.gitignore`.

### What the file holds

A single versioned JSON object:
- `version` (integer, starting at 1; load fails clearly on an unknown/newer
  version), `id`, `createdAt` (preserved across resumes), `updatedAt`.
- `unattended: boolean` and the restorable settings (`provider`, `model`,
  `showThinking`, `maxTurns`, `maxTokens`, `contextWindow?`). `maxTurns` of
  `Infinity` is encoded as the string `"unlimited"` (JSON turns `Infinity` into
  `null`); the loader decodes it. `apiKey` and `baseUrl` are NOT saved — they
  come from the current environment.
- `transcriptPath` — so a resume keeps appending to the same transcript.
- `webPolicy` — the live compiled policy's source JSON (what `/policy` would
  save), so unsaved policy edits survive. On resume this is restored as the live
  policy regardless of the on-disk policy file.
- `messages` — the full `Message[]` conversation array (persisted directly, not
  reconstructed from the transcript).
- `library` (unattended sessions only) — the session overlay: for each
  session-added catalog artifact, its kind/name and the data needed to rebuild
  it (tool → file path + a content hash; mcp → full launch config including its
  `env` as-is; skill → name + offered flag); and for every catalog artifact
  (session-added or from the manifest), whether it was *loaded*.
  Persisted-library artifacts are re-seeded from the manifest as usual, then
  their loaded state is re-applied.

### Save cadence

- The save boundary is a **completed run** — the point where a user message has
  been fully answered (all tool round-trips done) and the `messages[]` array is
  well-formed. Saving mid-run is forbidden: between an `assistant(tool_use)` and
  the following `user(tool_results)` the array is invalid. So a `kill` mid-run
  loses only the in-flight run, resuming from the last completed one.
- The save also runs on quit. `/reset` saves an empty conversation. A session
  that never completed a run (no messages) writes no file and prints no resume
  command.
- Saving is best-effort and must never throw into the conversation (same
  discipline as the transcript logger): writes are queued/coalesced so they
  never block the REPL, and a failed save warns once then goes quiet.

### Restore flow on resume

1. Read and validate the session file (UUID validated before any path is built,
   so `--resume ../../x` cannot escape `sessions/`); the file's `unattended` is
   **authoritative** — resuming an unattended session re-enables the library
   exactly as `--unattended` would, regardless of flags/env.
2. Restore settings (saved values win over env/`harness.json` for the fields
   listed above; `apiKey`/`baseUrl` from the environment; fail fast with a clear
   message if the provider key is missing or the model check fails). Restore the
   web policy as the live policy via a new `PolicyStore.restore(json)` — this
   wins over the on-disk policy file, and a broken/missing on-disk policy must
   NOT fail the resume. Do this before `createWebFetchTool` (or call
   `refreshDescription()`), since the tool description captures the policy.
3. Build the registry and (unattended) the library session as usual — the
   catalog seeds dormant from the manifest. The manifest is the source of truth
   for persisted artifacts; the saved overlay for session-added ones. An item
   persisted between save and resume is treated as persisted; a loaded item now
   missing from the manifest is a warning, not a failure.
4. Rebuild the working set from the saved `library`: register session-added
   tools from their files (warn on a missing file or a content-hash mismatch —
   the code on disk changed since), re-start loaded MCP servers from their stored
   configs (`hiddenEnv` is recomputed at startup and applied exactly as it is for
   boot servers — it is a list of env-var *names* to drop, not stored values),
   restore skills' offered flags, and load exactly the artifacts that were
   loaded. Each failure is collected and reported; none aborts the restore. If
   anything failed to restore, a `[harness note: …]` is injected into the first
   user message (mirroring the policy-change note) so the model knows those tools
   are unavailable.
5. Seed `messages` with the saved conversation and continue.

### Quit message

On quit, after the existing goodbye/alert lines, print the resume command and
the session file path, e.g.:
`Resume this session: npm start -- --resume <uuid>  (saved to sessions/<uuid>.json)`.

## Decisions settled after builder review

- **MCP server `env` is stored as-is** (user's choice), exactly as
  `/library persist` already writes it to the manifest. Protection is by file
  confinement (private-path, no model read/write), `0600`, and `.gitignore` —
  not by stripping. Only `config.secrets` (the provider API key) is scrubbed.
- **Scope is core-setup-only.** Restored: conversation, settings, web policy,
  loaded tools/servers/skills. NOT restored (v1 non-goals): interactive
  "always-allow" host/tool approvals (`approvedHosts`, `approvedMcpTools`),
  queued/unsent input (`pendingInput`/`autoSend`), and `lastModel`.
- **Save boundary = completed run** (not per model/tool step); `kill` mid-run
  loses only the in-flight run.
- **The saved `unattended` mode is authoritative on resume.**
- **Saved settings win over env/`harness.json`**; `apiKey`/`baseUrl` always come
  from the environment; `maxTurns: Infinity` ⇒ `"unlimited"`.
- **Tool files are restored by path + content hash**, best-effort (warn, don't
  snapshot source, don't abort).
- **Manifest wins for persisted artifacts; saved overlay for session-added.**
- **Restore gaps are surfaced to the model** via a `[harness note: …]`.
- **Concurrent/duplicate resume of one UUID is unsupported** in v1 (no lockfile;
  last writer wins). `mcp.json` boot servers are not captured (only library
  servers); `webPolicyPath`/`mcpConfigPath` are not saved.

## Left to the builder

- The exact session-store module (`src/session_store.ts`: `save(state)`,
  `load(id)`, UUID validation, path resolution, private-path registration,
  `0600`, queued/coalesced non-throwing writes mirroring `createTranscriptLogger`).
- The `SessionState` shape and the `version`-check loader; the `Message[]` passes
  through as plain JSON (opaque thinking blocks with signatures untouched).
- `PolicyStore.restore(json)` (installs a compiled policy; sets `fromFile`/`dirty`
  so `/exit` still warns when the restored policy differs from the on-disk file).
- `LibrarySession.snapshot()` / `restore(snapshot)` — capturing the closure-
  private `tools`/`skills`/`mcps` maps (session-added data + loaded flags) and a
  primitive to add a *dormant* (not-loaded) session-added tool rec, which the
  session currently lacks (`reloadTools` only loads).
- Resume flag/env parsing (`--resume <uuid>` and `--resume=<uuid>`, plus
  `HARNESS_RESUME`; flag beats env) and the early-load ordering in `src/repl.ts`
  so mode/settings/policy/transcriptPath/library-snapshot are threaded from the
  early read through registry and library construction; add `sessions/` to
  `.gitignore`; extract state-building and working-set restore into testable
  functions (`main()` itself is untested).
- All tests, following existing style, plus: a round-trip test (save a session
  with a loaded tool + a loaded model-started MCP server + a web-policy edit,
  then load and assert the restored state); a secrets test (the provider API key
  never appears in the written file); a mode round-trip (an unattended session
  restores the library tools; a normal session restores none and the boundaries
  invariant holds); a best-effort test (a missing tool file / content-hash
  mismatch / unstartable server yields a warning and a completed restore of the
  rest); a UUID-validation test (a traversal id is rejected); and a `maxTurns:
  Infinity` round-trip.
