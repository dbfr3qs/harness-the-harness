import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSplash, SPLASH_LOGO, SPINNER_BRAILLE, createSplash } from "../src/splash.ts";
import type { Terminal } from "../src/terminal.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the splash includes the logo lines", () => {
  const out = renderSplash([], 0).map(strip);
  for (const line of SPLASH_LOGO) assert.ok(out.includes(line), `missing logo line: ${JSON.stringify(line)}`);
});

test("phase glyphs reflect state", () => {
  const out = renderSplash(
    [
      { label: "config", state: "done" },
      { label: "MCP servers", state: "active" },
      { label: "library", state: "failed" },
      { label: "registry", state: "pending" },
    ],
    0,
  );
  const s = out.map(strip);
  assert.ok(s.some((l) => l === "   ✓ config"));
  assert.ok(s.some((l) => l === `   ${SPINNER_BRAILLE[0]} MCP servers`));
  assert.ok(s.some((l) => l === "   ✗ library"));
  assert.ok(s.some((l) => l === "     registry")); // pending: no glyph, just padding
});

test("the 'starting up' spinner line is always shown and its frame advances", () => {
  const active = [{ label: "x", state: "active" as const }];
  assert.ok(renderSplash(active, 1).some((l) => l.includes(SPINNER_BRAILLE[1]!)));
  // shown even once every phase has settled — the splash stays up (and animating) until finish() clears it
  const settled = [{ label: "x", state: "done" as const }];
  assert.ok(renderSplash(settled, 2).some((l) => strip(l).includes("starting up")));
  assert.ok(renderSplash(settled, 2).some((l) => l.includes(SPINNER_BRAILLE[2]!)));
});

test("every colored line ends in a reset (no leak)", () => {
  for (const line of renderSplash([{ label: "config", state: "done" }], 0)) {
    if (line.includes("\x1b[")) assert.ok(line.endsWith("\x1b[0m"), `unreset line: ${JSON.stringify(line)}`);
  }
});

const fakeScreenTerm = () => {
  const notes: string[][] = [];
  const term = { screen: true, interactive: true, notes: (l: string[]) => { notes.push(l); }, write() {} } as unknown as Terminal;
  return { term, notes };
};

test("screen splash renders phases to notes and clears on finish", async () => {
  const { term, notes } = fakeScreenTerm();
  const s = createSplash(term, ["MCP servers", "library"]);
  s.set("MCP servers", "done");
  assert.ok(notes.at(-1)!.some((l) => l.replace(/\x1b\[[0-9;]*m/g, "") === "   ✓ MCP servers"));
  await s.finish();
  assert.deepEqual(notes.at(-1), []); // cleared
});

test("finish enforces the ~400ms minimum", async () => {
  const { term } = fakeScreenTerm();
  const s = createSplash(term, ["x"]);
  const t0 = Date.now();
  await s.finish();
  assert.ok(Date.now() - t0 >= 380, `finished too fast: ${Date.now() - t0}ms`);
});

test("batch/non-interactive splash is a silent no-op", async () => {
  let wrote = false;
  const term = { screen: false, interactive: false, notes() {}, write() { wrote = true; } } as unknown as Terminal;
  const s = createSplash(term, ["x"]);
  s.set("x", "done");
  await s.finish();
  assert.equal(wrote, false);
});
