import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ConfigError } from "../src/config.ts";
import {
  buildSessionState,
  createSessionStore,
  isValidSessionId,
  loadSession,
  resumeId,
  sessionFilePath,
  sessionPrivatePaths,
  type SessionState,
} from "../src/session_store.ts";

function makeState(id: string, over: Partial<SessionState> = {}): SessionState {
  return {
    version: 1,
    id,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:01:00.000Z",
    unattended: true,
    settings: { provider: "anthropic", model: "m", showThinking: false, maxTurns: 20, maxTokens: 4096, contextWindow: 200000 },
    transcriptPath: "transcripts/t.jsonl",
    webPolicy: { allow: ["https://example.com/*"], deny: [] } as never,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ] as never,
    library: { tools: [], skills: [], mcpServers: [] } as never,
    ...over,
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sess-"));
}

test("round-trip save/load with library snapshot", async () => {
  const dir = await tmp();
  const store = createSessionStore(dir);
  const id = randomUUID();
  const state = makeState(id);
  store.save(state);
  await store.flush();
  assert.deepEqual(await loadSession(dir, id), state);
  assert.equal(((await stat(store.path(id))).mode & 0o777), 0o600);
});

test("maxTurns unlimited round-trips and numbers stay numbers", async () => {
  const dir = await tmp();
  const store = createSessionStore(dir);
  const a = randomUUID();
  const b = randomUUID();
  store.save(makeState(a, { settings: { ...makeState(a).settings, maxTurns: "unlimited" } }));
  store.save(makeState(b));
  await store.flush();
  assert.equal((await loadSession(dir, a)).settings.maxTurns, "unlimited");
  assert.equal((await loadSession(dir, b)).settings.maxTurns, 20);
});

test("secrets are scrubbed from the written file", async () => {
  const dir = await tmp();
  const store = createSessionStore(dir, { secrets: ["sk-abc"] });
  const id = randomUUID();
  store.save(makeState(id, { messages: [{ role: "user", content: "key is sk-abc ok" }] as never }));
  await store.flush();
  const raw = await readFile(store.path(id), "utf8");
  assert.ok(!raw.includes("sk-abc"));
  assert.ok(raw.includes("[redacted]"));
});

test("id validation and traversal", () => {
  assert.ok(isValidSessionId(randomUUID()));
  for (const bad of ["", "x", "../x", "../../x", "a/b", `${randomUUID()}/..`]) assert.ok(!isValidSessionId(bad), bad);
  assert.throws(() => resumeId(["--resume", "../../x"], {}), ConfigError);
  assert.throws(() => sessionFilePath("/tmp/d", "../../x"), ConfigError);
  const id = randomUUID();
  assert.equal(sessionFilePath("/tmp/d", id), join("/tmp/d", `${id}.json`));
});

test("resumeId precedence, = form, none", () => {
  const a = randomUUID();
  const b = randomUUID();
  assert.equal(resumeId(["--resume", a], { HARNESS_RESUME: b }), a);
  assert.equal(resumeId([`--resume=${a}`], { HARNESS_RESUME: b }), a);
  assert.equal(resumeId([], { HARNESS_RESUME: b }), b);
  assert.equal(resumeId([], {}), undefined);
  assert.throws(() => resumeId([], { HARNESS_RESUME: "nope" }), ConfigError);
});

test("sessionPrivatePaths covers the dir", () => {
  const ws = "/w/space";
  const inside = sessionPrivatePaths("/w/space/sessions", ws);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].path, resolve("/w/space/sessions"));
  assert.equal(inside[0].name, "sessions/");
  const outside = sessionPrivatePaths("/elsewhere/s", ws);
  assert.equal(outside[0].path, "/elsewhere/s");
  assert.equal(outside[0].name, "/elsewhere/s/");
});

test("loadSession rejects bad version and corrupt JSON, naming the path", async () => {
  const dir = await tmp();
  const v = randomUUID();
  const c = randomUUID();
  await writeFile(join(dir, `${v}.json`), JSON.stringify({ ...makeState(v), version: 2 }));
  await writeFile(join(dir, `${c}.json`), "{not json");
  await assert.rejects(loadSession(dir, v), (e: Error) => e instanceof ConfigError && e.message.includes(`${v}.json`));
  await assert.rejects(loadSession(dir, c), (e: Error) => e instanceof ConfigError && e.message.includes(`${c}.json`));
  await assert.rejects(loadSession(dir, randomUUID()), ConfigError);
});

test("save into an unwritable dir warns once and does not throw", async () => {
  const dir = await tmp();
  const blocker = join(dir, "file");
  await writeFile(blocker, "x");
  const warnings: string[] = [];
  const store = createSessionStore(join(blocker, "sub"), { warn: (m) => warnings.push(m) });
  assert.doesNotThrow(() => {
    store.save(makeState(randomUUID()));
    store.save(makeState(randomUUID()));
  });
  await store.flush();
  assert.equal(warnings.length, 1);
});

test("buildSessionState copies settings, encodes Infinity, and keeps createdAt on resume", () => {
  const id = randomUUID();
  const config = {
    unattended: true, provider: "anthropic", model: "m", showThinking: true,
    maxTurns: Infinity, maxTokens: 999, contextWindow: 1234, transcriptPath: "t.jsonl",
  } as never;
  const policy = { default: "ask", rules: [] } as never;
  const messages = [{ role: "user", content: "hi" }] as never;
  const lib = { tools: [], mcps: [], skills: [] };
  const s = buildSessionState({ config, sessionId: id, createdAt: "2020-01-01T00:00:00.000Z", now: new Date("2026-01-01T00:00:00Z"), policy, messages, library: lib });
  assert.equal(s.settings.maxTurns, "unlimited");
  assert.equal(s.settings.maxTokens, 999);
  assert.equal(s.settings.contextWindow, 1234);
  assert.equal(s.createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(s.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(s.library, lib);
  assert.doesNotThrow(() => JSON.stringify(s));
  const t = buildSessionState({ config: { ...(config as object), maxTurns: 7, contextWindow: undefined } as never, sessionId: id, now: new Date("2026-01-01T00:00:00Z"), policy, messages });
  assert.equal(t.settings.maxTurns, 7);
  assert.equal("library" in t, false);
  assert.equal("contextWindow" in t.settings, false);
  assert.equal(t.createdAt, t.updatedAt);
});
