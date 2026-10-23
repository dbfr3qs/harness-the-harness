import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSplash, SPLASH_LOGO, SPINNER_BRAILLE } from "../src/splash.ts";

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

test("the spinner frame advances and the 'starting up' line hides when all settled", () => {
  const active = [{ label: "x", state: "active" as const }];
  assert.ok(renderSplash(active, 1).some((l) => l.includes(SPINNER_BRAILLE[1]!)));
  const settled = [{ label: "x", state: "done" as const }];
  assert.ok(!renderSplash(settled, 0).some((l) => strip(l).includes("starting up")));
});

test("every colored line ends in a reset (no leak)", () => {
  for (const line of renderSplash([{ label: "config", state: "done" }], 0)) {
    if (line.includes("\x1b[")) assert.ok(line.endsWith("\x1b[0m"), `unreset line: ${JSON.stringify(line)}`);
  }
});
