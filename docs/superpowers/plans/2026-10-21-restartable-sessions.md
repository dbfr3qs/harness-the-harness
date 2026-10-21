# Restartable Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session a UUID, save its full state (conversation, settings, web policy, loaded tools/servers/skills) after every completed run, and resume it exactly with `--resume <uuid>`.

**Architecture:** A new `src/session_store.ts` owns the on-disk `SessionState` (atomic, 0600, queued non-throwing writes, provider-key scrubbing, UUID validation). `LibrarySession` gains `snapshot()`/`restore()`; `PolicyStore` gains `restore()`. `src/repl.ts` reads `--resume` early, threads the restored state through construction, saves after each completed run and on quit, and prints the resume command.

**Tech Stack:** TypeScript on Node 24 (native type-stripping), zero runtime dependencies, tests in `node:test` + `node:assert/strict`, `tsc --noEmit` to type-check.

**Spec:** [`docs/superpowers/specs/2026-10-21-restartable-sessions-design.md`](../specs/2026-10-21-restartable-sessions-design.md)

## Global Constraints

- Zero runtime dependencies; Node 24; `npm run check` clean; `npm test` green.
- The session file is sensitive: its directory is a private path the model can neither read nor write (so it can't exfiltrate a conversation or plant a file that executes on resume), files are written mode `0600`, and `sessions/` is git-ignored.
- `config.secrets` (the provider API key) is never written to the file; `apiKey`/`baseUrl` come from the current environment on resume. An MCP server's own `env` IS stored as-is (same as `/library persist` writes to the manifest).
- Save boundary is a **completed run** (a user message fully answered, `messages[]` well-formed) and quit; writes are queued/coalesced, atomic (temp+rename), and never throw into the conversation (mirror `createTranscriptLogger`).
- The saved `unattended` flag is authoritative on resume (equivalent to `--unattended`); the normal-mode boundaries invariant holds across save/restore.
- Saved settings win over env/`harness.json` for `provider`, `model`, `showThinking`, `maxTurns`, `maxTokens`, `contextWindow`; `maxTurns: Infinity` serialises as `"unlimited"`.
- A UUID is validated before any path is built (no `../` traversal); a missing/corrupt/unknown-version file fails fast with a clear message.
- Working-set restore is best-effort: a missing tool file, a content-hash mismatch, or an unstartable server warns and the rest still restores; gaps are surfaced to the model via a `[harness note: …]`.
- Human-only-persist and unattended-only catalog invariants are unchanged.

## Review Focus

- A resume id containing path traversal (`--resume ../../etc/x`) — rejected before any path is built. (Task 3)
- `maxTurns: Infinity` — round-trips through JSON as `"unlimited"`, not `null`. (Task 3)
- The provider API key — never present in the written session file. (Task 3)
- The `sessions/` directory — returned as a private path so `write_file` refuses to write there (the model cannot plant a session file that would execute on the next resume). (Task 3)
- A loaded MCP server whose command is gone, or a session tool file that's missing/changed, at resume — a warning, and the rest of the working set still restores. (Task 2)

---

### Task 1: `PolicyStore.restore()`

**Files:**
- Modify: `src/policy_command.ts` (the `createPolicyStore` return object)
- Test: `test/policy_command.test.ts`

**Interfaces:**
- Consumes: `compileWebPolicy`, `withoutUnset`, `WebPolicy` (already imported).
- Produces: `restore(policy: WebPolicy, dirty: boolean): void` on `PolicyStore` — installs `policy` as the live policy (recompiled), sets `fromFile` to `false`, and sets the dirty flag to `dirty`.

- [ ] **Step 1: Write the failing test** in `test/policy_command.test.ts`: create a store from an on-disk policy, call `restore({ default: "deny", rules: [] }, true)`, assert `store.current().policy.default === "deny"`, `store.dirty() === true`, and `store.fromFile() === false`; call `restore(sameAsFile, false)` and assert `dirty() === false`.
- [ ] **Step 2: Run `node --test test/policy_command.test.ts`; verify it fails.**
- [ ] **Step 3: Implement `restore`** by recompiling `withoutUnset(policy)` via `compileWebPolicy`, assigning `current`, `fromFile = false`, `dirty = dirty`.
- [ ] **Step 4: Run the test; verify it passes.**
- [ ] **Step 5: Commit** (`feat: PolicyStore.restore for resuming a saved policy`).

---

### Task 2: `LibrarySession` snapshot and restore

**Files:**
- Modify: `src/library/session.ts` (`LibrarySession` interface + impl; new `LibrarySnapshot` type)
- Test: `test/library_session.test.ts`

**Interfaces:**
- Consumes: the existing overlay maps, `loadToolFile`, `startAndRegister`/`addServer`, `setEnabled`; `McpServerConfig`.
- Produces, exported from `src/library/session.ts`:

```ts
export interface LibrarySnapshot {
  tools: { name: string; file: string; hash: string; description?: string; sessionAdded: boolean; loaded: boolean }[];
  mcps:  { name: string; server: McpServerConfig; description?: string; sessionAdded: boolean; loaded: boolean }[];
  skills: { name: string; offered: boolean; sessionAdded: boolean }[];
}
```
  and on `LibrarySession`: `snapshot(): LibrarySnapshot` and `restore(snap: LibrarySnapshot): Promise<{ warnings: string[] }>`. `hash` is the SHA-256 of the tool file's bytes (`node:crypto` `createHash`), hex.

- [ ] **Step 1: Write failing tests** in `test/library_session.test.ts` (reuse the fake `registry`/`startServer`):
  - `snapshot()` after reloading a session-added tool and `addServer`-ing a server reports both with `sessionAdded:true`, `loaded:true`, the tool's `file`+`hash`+`description` and the server's full `server` config; a manifest-seeded-but-dormant tool appears with `sessionAdded:false`, `loaded:false`.
  - **Round-trip:** take a snapshot from session A, build a fresh session B from the SAME manifest, `await b.restore(snapA)`, and assert `b.inventory()` matches A's loaded/catalog state (the session-added tool is registered and loaded; the server is started; skills' offered flags match).
  - **Best-effort (Review Focus):** restoring a snapshot whose session-added tool `file` does not exist, plus one whose server `startServer` rejects, returns `warnings` naming both and still restores the rest (a third, valid loaded tool ends up registered).
  - A content-hash mismatch (file exists but bytes differ from `hash`) adds a warning and still loads the tool.
- [ ] **Step 2: Run `node --test test/library_session.test.ts`; verify failure.**
- [ ] **Step 3: Implement `snapshot()`** (read the `tools`/`skills`/`mcps` maps; compute each loaded/known tool file's hash) **and `restore(snap)`**: for each `sessionAdded` tool, insert a dormant `ToolRec` (new private helper — `reloadTools` can't, it scans and loads the whole dir) with `file`/`description`; for each `sessionAdded` server, insert a dormant `McpRec` with its `server`/`description`; set skills' offered flags; then for every entry marked `loaded`, load it (tool via the existing load path with a hash check; server via `startAndRegister`), collecting a warning per failure instead of throwing. Return `{ warnings }`.
- [ ] **Step 4: Run the tests; verify pass, and `npm run check`.**
- [ ] **Step 5: Commit** (`feat: LibrarySession snapshot/restore for session resume`).

---

### Task 3: The session store module

**Files:**
- Create: `src/session_store.ts`
- Test: `test/session_store.test.ts`

**Interfaces:**
- Consumes: `Message` (`src/types.ts`), `WebPolicy` (`src/tools/web_policy.ts`), `LibrarySnapshot` (Task 2), `PrivatePath` (`src/tools/private_paths.ts`), the atomic-write + queued-non-throwing pattern from `src/log.ts`.
- Produces, exported:

```ts
export interface SessionState {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  unattended: boolean;
  settings: { provider: string; model: string; showThinking: boolean;
              maxTurns: number | "unlimited"; maxTokens: number; contextWindow?: number };
  transcriptPath: string;
  webPolicy: WebPolicy;
  messages: Message[];
  library?: LibrarySnapshot;
}
export function isValidSessionId(s: string): boolean;          // UUID v4 shape only
export function resumeId(argv: string[], env: NodeJS.ProcessEnv): string | undefined; // --resume <id> | --resume=<id> | HARNESS_RESUME; flag beats env; throws ConfigError on a non-UUID
export function sessionFilePath(dir: string, id: string): string;           // validates id first
export function sessionPrivatePaths(dir: string, workspaceRoot: string): PrivatePath[]; // like transcriptPrivatePaths, but the whole dir, read+write
export function createSessionStore(dir: string, opts?: { secrets?: string[]; warn?: (m: string) => void }):
  { save(state: SessionState): void; path(id: string): string };           // queued, atomic, 0600, scrubs secrets, never throws
export async function loadSession(dir: string, id: string): Promise<SessionState>; // validates id, parses, checks version===1 and basic shape; throws clear ConfigError otherwise
```

- [ ] **Step 1: Write failing tests** in `test/session_store.test.ts`:
  - **Round-trip:** `save` a `SessionState` with messages, a web policy, and a `library` snapshot, then `loadSession` and `deepEqual` the result.
  - **maxTurns (Review Focus):** a state with `settings.maxTurns: "unlimited"` round-trips as `"unlimited"` (never `null`); a numeric value round-trips numerically.
  - **Secrets (Review Focus):** `createSessionStore(dir, { secrets: ["sk-abc"] })` saving a state whose messages contain `"sk-abc"` writes a file that does not contain `sk-abc` (it's `[redacted]`).
  - **Traversal (Review Focus):** `resumeId(["--resume","../../x"], {})` throws `ConfigError`; `sessionFilePath(dir, "../../x")` throws; `isValidSessionId` accepts a real `randomUUID()` and rejects `"../x"`, `""`, `"x"`.
  - **Private path (Review Focus):** `sessionPrivatePaths(dir, workspaceRoot)` returns a path covering `dir` (so `write_file`/read tools refuse it); assert the returned `path` is `dir` when `dir !== workspaceRoot`.
  - **Resume id precedence:** `--resume a…` beats `HARNESS_RESUME=b…`; `--resume=<id>` form works; none given → `undefined`.
  - **Version/corruption:** `loadSession` on a `{version:2,…}` file and on malformed JSON each throw a `ConfigError` naming the path.
  - Non-throwing save: a save into an unwritable dir warns via the `warn` hook and does not throw.
- [ ] **Step 2: Run `node --test test/session_store.test.ts`; verify failure.**
- [ ] **Step 3: Implement the module.** Reuse `log.ts`'s queue+scrub discipline for `save` (serialize, `split/join` each secret, `mkdir -p`, temp file + `rename`, `chmod 0600`); `maxTurns` is already `number | "unlimited"` in `SessionState`, so the caller encodes `Infinity`→`"unlimited"` when building the state (provide the state as-is — no `Infinity` reaches JSON). `sessionPrivatePaths` mirrors `transcriptPrivatePaths` but always protects the directory. `resumeId` parses like `promptFilePath` and validates with `isValidSessionId`.
- [ ] **Step 4: Run the tests; verify pass, and `npm run check`.**
- [ ] **Step 5: Commit** (`feat: session store (save/load, uuid validation, private paths)`).

---

### Task 4: Wire resume and save into the REPL

**Files:**
- Modify: `src/repl.ts`, `src/config.ts` (if a settings-merge helper is cleaner there), `.gitignore`
- Test: `test/config.test.ts` (for any pure helper added there); the rest is integration, verified by `npm run check` + full suite

**Interfaces:**
- Consumes: everything from Tasks 1–3 (`resumeId`, `loadSession`, `createSessionStore`, `sessionPrivatePaths`, `PolicyStore.restore`, `LibrarySession.snapshot`/`restore`).
- Produces: a resumable REPL. A pure helper `buildSessionState(parts): SessionState` (place in `src/session_store.ts` if it keeps `repl.ts` thin) assembles the state from `config`, `sessionId`, timestamps, the live policy (`policyStore.current().policy`), `messages`, and `librarySession?.snapshot()`, encoding `Infinity`→`"unlimited"`.

- [ ] **Step 1: Add a `buildSessionState` test** (in `test/session_store.test.ts`) asserting it copies the settings, encodes `Infinity` maxTurns as `"unlimited"`, includes the library snapshot when given one and omits it otherwise, and sets `createdAt` from the prior state when resuming.
- [ ] **Step 2: Run it; verify failure.**
- [ ] **Step 3: Implement the wiring** in `src/repl.ts`:
  - Read `resumeId(process.argv, process.env)` first; if set, `await loadSession(dir, id)` and let it override mode (`unattended`), settings (session wins over env), `transcriptPath`, and hold its `webPolicy`/`library` for below; else generate `crypto.randomUUID()`. A load error exits with a clear message (like other config errors).
  - A broken/missing on-disk web policy must NOT fail a resume: on resume, skip the fatal `loadWebPolicy` exit and instead build the policy store from the session's policy, then `policyStore.restore(savedPolicy, dirty)` where `dirty` is whether it differs from the on-disk file.
  - Register `sessionPrivatePaths(dir, workspaceRoot)` into `privatePaths` before `assembleTools` (so the model can't read or write the session dir).
  - After the library session is built (unattended) and `registry` exists, `await librarySession.restore(savedLibrary)`; collect warnings. Seed `messages` from the saved conversation.
  - If any restore warnings exist, append a `[harness note: …]` to the first user message (reuse the `policyChangedSinceDescription` mechanism's shape) listing the unavailable tools/servers.
  - Create the store with `createSessionStore(dir, { secrets: config.secrets })`. After each completed run (where `runAgent` returns and `messages` is well-formed) and in `quit()`, call `store.save(buildSessionState(...))`. `/reset` saves an empty conversation.
  - In `quit()` and the post-loop exit, after the existing lines, print `Resume this session: npm start -- --resume <id>  (saved to <path>)` — only if a save has happened.
  - Add `sessions/` to `.gitignore`.
- [ ] **Step 4: Run `npm run check` and the full `npm test`; verify green.** Manually confirm (note in the report) that a normal (non-resumed) session still starts and that `--resume <id>` on a saved session restores mode, settings, policy, messages, and the loaded working set.
- [ ] **Step 5: Commit** (`feat: resumable sessions wired into the REPL`).

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document restartable sessions** in `README.md`: each session has a UUID; state is saved after every completed run and on quit to `sessions/<uuid>.json` (0600, git-ignored, model-inaccessible); quit prints the resume command; `--resume <uuid>` restores the conversation, settings, web policy, and loaded tools/servers/skills, resuming in the same mode; secrets note (provider key never saved; server env is); best-effort restore warns and continues.
- [ ] **Step 2: Run the full `npm test` and `npm run check`; verify green.**
- [ ] **Step 3: Commit** (`docs: restartable sessions`).
