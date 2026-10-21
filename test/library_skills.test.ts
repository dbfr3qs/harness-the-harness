import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkill, scanSkillsDir } from "../src/library/skills.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-skills-"));
  await mkdir(join(dir, "triage"));
  await writeFile(join(dir, "triage", "SKILL.md"), "---\nname: triage\ndescription: Triage bug reports\n---\n\n# Triage\nBody.\n");
  await mkdir(join(dir, "alpha"));
  await writeFile(join(dir, "alpha", "SKILL.md"), "# Alpha\n\nDo the alpha thing.\nMore.\n");
  await mkdir(join(dir, "empty"));
  await writeFile(join(dir, "stray.txt"), "not a skill");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("scanSkillsDir finds skills, parses descriptions, skips dirs without SKILL.md", async () => {
  const skills = await scanSkillsDir(dir);
  assert.deepEqual(skills, [
    { name: "alpha", description: "Do the alpha thing.", dir: join(dir, "alpha") },
    { name: "triage", description: "Triage bug reports", dir: join(dir, "triage") },
  ]);
});

test("scanSkillsDir on a missing dir is empty", async () => {
  assert.deepEqual(await scanSkillsDir(join(dir, "nope")), []);
});

test("readSkill returns text; unknown name throws instructively", async () => {
  assert.match(await readSkill(dir, "alpha"), /Do the alpha thing/);
  await assert.rejects(readSkill(dir, "ghost"), /ghost.*SKILL\.md/s);
});
