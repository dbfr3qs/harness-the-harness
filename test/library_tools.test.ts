import { test } from "node:test";
import assert from "node:assert/strict";
import { createLibraryTools } from "../src/tools/unattended/library.ts";
import type { LibrarySession } from "../src/library/session.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import type { ArtifactKind } from "../src/library/manifest.ts";
import type { SkillInfo } from "../src/library/skills.ts";

// The model touches the library only through these tools, so each test drives a tool's handler
// against a fake session and checks it dispatches to the matching session method with the right
// arguments. The session itself is covered by test/library_session.test.ts.

interface Calls {
  reloadTools: number;
  addServer: McpServerConfig[];
  setEnabled: { kind: ArtifactKind; name: string; enabled: boolean }[];
  listSkills: number;
  readSkill: string[];
}

function fakeSession(overrides: Partial<LibrarySession> = {}): { session: LibrarySession; calls: Calls } {
  const calls: Calls = { reloadTools: 0, addServer: [], setEnabled: [], listSkills: 0, readSkill: [] };
  const base: LibrarySession = {
    toolsDir: "/home/u/.harness/library/tools",
    async reloadTools() {
      calls.reloadTools++;
      return { loaded: ["alpha", "beta"], failed: [] };
    },
    async addServer(server) {
      calls.addServer.push(server);
      return { tools: [`${server.name}__a`], instructions: `drive ${server.name} like so` };
    },
    async setEnabled(kind, name, enabled) {
      calls.setEnabled.push({ kind, name, enabled });
      return `${enabled ? "Enabled" : "Disabled"} ${kind} "${name}".`;
    },
    listSkills() {
      calls.listSkills++;
      return [{ name: "writing", description: "how to write", dir: "/s/writing" }] satisfies SkillInfo[];
    },
    async readSkill(name) {
      calls.readSkill.push(name);
      return `SKILL ${name}`;
    },
    inventory() {
      return [];
    },
    diff() {
      return { added: [], enabledChanged: [] };
    },
    async persist() {},
    closeAll() {},
  };
  return { session: { ...base, ...overrides }, calls };
}

const ctx = { signal: new AbortController().signal };
const find = (session: LibrarySession, name: string) => {
  const tool = createLibraryTools(session).find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" exists`);
  return tool!;
};

test("createLibraryTools exposes exactly the model tools, and no persist tool", () => {
  const { session } = fakeSession();
  const names = createLibraryTools(session).map((t) => t.name);
  assert.deepEqual(names, ["reload_tools", "add_mcp_server", "set_artifact_enabled", "list_skills", "use_skill"]);
  assert.ok(!names.includes("persist"), "there is no persist tool");
});

test("reload_tools dispatches to session.reloadTools and notes the changes are session-only", async () => {
  const { session, calls } = fakeSession();
  const out = await find(session, "reload_tools").handler({}, ctx);
  assert.equal(calls.reloadTools, 1);
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.match(out, /session/i); // mentions the tools are session-only until persisted
  assert.match(out, /cache/i); // mentions the prompt cache
});

test("reload_tools reports a failed file instead of throwing", async () => {
  const { session } = fakeSession({
    async reloadTools() {
      return { loaded: ["ok_tool"], failed: [{ file: "broken.ts", error: "factory boom" }] };
    },
  });
  const out = await find(session, "reload_tools").handler({}, ctx);
  assert.match(out, /ok_tool/);
  assert.match(out, /broken\.ts/);
  assert.match(out, /factory boom/);
});

test("add_mcp_server validates its input and dispatches to session.addServer", async () => {
  const { session, calls } = fakeSession();
  const out = await find(session, "add_mcp_server").handler(
    { name: "rea", command: "rea-server", args: ["--stdio"], env: { TOKEN: "x" } },
    ctx,
  );
  assert.equal(calls.addServer.length, 1);
  assert.deepEqual(calls.addServer[0], { name: "rea", command: "rea-server", args: ["--stdio"], env: { TOKEN: "x" }, interactive: false });
  assert.match(out, /rea__a/); // tools gained
  assert.match(out, /drive rea like so/); // the server's instructions are appended
});

test("add_mcp_server defaults args and omits env when not given", async () => {
  const { session, calls } = fakeSession();
  await find(session, "add_mcp_server").handler({ name: "docs", command: "docs-server" }, ctx);
  assert.deepEqual(calls.addServer[0], { name: "docs", command: "docs-server", args: [], interactive: false });
});

test("add_mcp_server rejects a bad name before touching the session", async () => {
  const { session, calls } = fakeSession();
  await assert.rejects(() => find(session, "add_mcp_server").handler({ name: "bad name!", command: "x" }, ctx));
  assert.equal(calls.addServer.length, 0);
});

test("set_artifact_enabled dispatches to session.setEnabled", async () => {
  const { session, calls } = fakeSession();
  const out = await find(session, "set_artifact_enabled").handler({ kind: "tool", name: "alpha", enabled: false }, ctx);
  assert.deepEqual(calls.setEnabled[0], { kind: "tool", name: "alpha", enabled: false });
  assert.match(out, /alpha/);
});

test("list_skills dispatches to session.listSkills and lists names and descriptions", async () => {
  const { session, calls } = fakeSession();
  const out = await find(session, "list_skills").handler({}, ctx);
  assert.equal(calls.listSkills, 1);
  assert.match(out, /writing/);
  assert.match(out, /how to write/);
});

test("use_skill dispatches to session.readSkill", async () => {
  const { session, calls } = fakeSession();
  const out = await find(session, "use_skill").handler({ name: "writing" }, ctx);
  assert.deepEqual(calls.readSkill, ["writing"]);
  assert.match(out, /SKILL writing/);
});

test("use_skill rejects a traversing name before calling readSkill", async () => {
  for (const bad of ["../secrets", "a/b", "..", "nested/skill", "a\\b"]) {
    const { session, calls } = fakeSession();
    await assert.rejects(
      () => find(session, "use_skill").handler({ name: bad }, ctx),
      /path|separator|\.\./i,
      `"${bad}" must be rejected`,
    );
    assert.equal(calls.readSkill.length, 0, `readSkill must not be called for "${bad}"`);
  }
});

test("reload_tools names the tools directory and steers the model to run_shell, not write_file", async () => {
  const { session } = fakeSession();
  const tool = find(session, "reload_tools");
  assert.ok(tool.description.includes("/home/u/.harness/library/tools"));
  assert.ok(tool.description.includes("run_shell"));
  assert.ok(!/with write_file/.test(tool.description), "does not tell the model to author with write_file");
  const out = await tool.handler({}, ctx);
  assert.ok(String(out).includes("/home/u/.harness/library/tools"));
});
