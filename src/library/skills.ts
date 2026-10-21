import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

function describe(text: string): string {
  const lines = text.split(/\r?\n/);
  let body = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^description:\s*(.*)$/.exec(l);
        if (m && m[1].trim()) return m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
      }
      body = lines.slice(end + 1);
    }
  }
  return body.map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
}

/** One entry per subdirectory of `dir` that holds a SKILL.md, sorted by name. */
export async function scanSkillsDir(dir: string): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = join(dir, ent.name);
    try {
      const text = await readFile(join(skillDir, "SKILL.md"), "utf8");
      out.push({ name: ent.name, description: describe(text), dir: skillDir });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The text of `<dir>/<name>/SKILL.md`. */
export async function readSkill(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name, "SKILL.md"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No skill "${name}": expected ${join(dir, name, "SKILL.md")}. List the available skills first and use one of those names, or create the skill by writing that file.`);
    }
    throw e;
  }
}
