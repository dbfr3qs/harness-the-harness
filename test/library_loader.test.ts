import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolFile, scanToolsDir } from "../src/library/loader.ts";
import { defineTool } from "../src/registry.ts";

const deps = { defineTool, workspaceRoot: "/ws", privatePaths: [] };
const tmp = () => mkdtemp(join(tmpdir(), "loader-"));

const src = (desc: string, name = "echo") => `export default (deps) => deps.defineTool({
  name: ${JSON.stringify(name)}, description: ${JSON.stringify(desc)},
  input_schema: { type: "object", properties: {} },
  handler: async () => "ok",
});
`;

test("loads a valid factory and its handler runs", async () => {
  const d = await tmp();
  const f = join(d, "echo.ts");
  await writeFile(f, src("first"));
  const tool = await loadToolFile(f, deps);
  assert.equal(tool.name, "echo");
  assert.equal(await tool.handler({} as never, {} as never), "ok");
});

test("cache-bust: an edited file re-imports fresh", async () => {
  const d = await tmp();
  const f = join(d, "echo.ts");
  await writeFile(f, src("old description"));
  assert.equal((await loadToolFile(f, deps)).description, "old description");
  await new Promise((r) => setTimeout(r, 5));
  await writeFile(f, src("new description"));
  assert.equal((await loadToolFile(f, deps)).description, "new description");
});

test("no default export throws naming the file", async () => {
  const f = join(await tmp(), "nodefault.ts");
  await writeFile(f, "export const x = 1;\n");
  await assert.rejects(loadToolFile(f, deps), /nodefault\.ts.*default export/s);
});

test("non-function default throws", async () => {
  const f = join(await tmp(), "obj.ts");
  await writeFile(f, "export default { a: 1 };\n");
  await assert.rejects(loadToolFile(f, deps), /obj\.ts.*function/s);
});

test("bad shape throws", async () => {
  const f = join(await tmp(), "bad.ts");
  await writeFile(f, "export default () => ({ name: 'x' });\n");
  await assert.rejects(loadToolFile(f, deps), /bad\.ts.*description/s);
});

test("invalid name throws", async () => {
  const f = join(await tmp(), "badname.ts");
  await writeFile(f, src("d", "bad name!"));
  await assert.rejects(loadToolFile(f, deps), /badname\.ts.*name/s);
});

test("scanToolsDir lists direct .ts files only; missing dir is []", async () => {
  const d = await tmp();
  await writeFile(join(d, "a.ts"), "");
  await writeFile(join(d, "b.txt"), "");
  await mkdir(join(d, "sub"));
  await writeFile(join(d, "sub", "c.ts"), "");
  assert.deepEqual(await scanToolsDir(d), [join(d, "a.ts")]);
  assert.deepEqual(await scanToolsDir(join(d, "nope")), []);
});
