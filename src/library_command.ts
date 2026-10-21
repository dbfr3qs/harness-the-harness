import type { ArtifactKind } from "./library/manifest.ts";

// The /tools, /skills, /mcp and /library commands, parsed and formatted here so the REPL only has to
// dispatch to a LibrarySession. Pure and unit-tested (test/library_command.test.ts); mirrors the
// split in src/policy_command.ts. The library is wired only in unattended mode (see src/repl.ts).

export interface InventoryItem {
  kind: ArtifactKind;
  name: string;
  enabled: boolean;
  persisted: boolean;
}

export interface LibraryDiff {
  added: { kind: ArtifactKind; name: string }[];
  enabledChanged: { kind: ArtifactKind; name: string; enabled: boolean }[];
}

/** What a typed library command means. The REPL turns each into one LibrarySession call. */
export type LibraryAction =
  | { type: "list"; kind: ArtifactKind }
  | { type: "enable"; kind: ArtifactKind; name: string }
  | { type: "disable"; kind: ArtifactKind; name: string }
  | { type: "persist" }
  | { type: "persist-review" }
  | { type: "error"; message: string };

export const LIBRARY_HELP = [
  "/tools                  list the library's tools and whether each is loaded",
  "/tools enable <name>    load a tool into this session",
  "/tools disable <name>   remove a tool from this session",
  "/skills [enable|disable <name>]  list skills, or flip whether one is offered",
  "/mcp [enable|disable <name>]     list MCP servers, or start/stop one",
  "/library                review this session's unpersisted changes",
  "/library persist        fold this session's changes into the saved library",
].join("\n");

// The three list/toggle commands, each fixed to one artifact kind.
const COMMAND_KIND: Record<string, ArtifactKind> = {
  "/tools": "tool",
  "/skills": "skill",
  "/mcp": "mcp",
};

/** Parse one typed command line into an action, or an instructive error action. */
export function parseLibraryCommand(line: string): LibraryAction {
  const [command = "", ...rest] = line.trim().split(/\s+/).filter(Boolean);

  if (command === "/library") {
    const [sub, ...extra] = rest;
    if (sub === undefined) return { type: "persist-review" };
    if (sub === "persist" && extra.length === 0) return { type: "persist" };
    return error(`Unknown /library command "${sub}".`);
  }

  const kind = COMMAND_KIND[command];
  if (kind === undefined) return error(`"${command}" is not a library command.`);

  const [sub, name, ...extra] = rest;
  if (sub === undefined) return { type: "list", kind };
  if (sub === "enable" || sub === "disable") {
    if (name === undefined || extra.length > 0) return error(`Usage: ${command} ${sub} <name>`);
    return { type: sub, kind, name };
  }
  return error(`Unknown ${command} command "${sub}".`);
}

function error(message: string): LibraryAction {
  return { type: "error", message: `${message}\n\n${LIBRARY_HELP}` };
}

/** List artifacts with their enabled state and whether they come from the saved library. */
export function formatInventory(items: InventoryItem[]): string {
  if (items.length === 0) return "Nothing in the library yet.";
  const width = Math.max(...items.map((it) => it.name.length));
  return items
    .map((it) => {
      const mark = it.enabled ? "●" : "○";
      const state = it.enabled ? "enabled" : "disabled";
      const origin = it.persisted ? "persisted" : "session-only";
      return `  ${mark} ${it.kind.padEnd(5)} ${it.name.padEnd(width)}  ${state} · ${origin}`;
    })
    .join("\n");
}

/** Render the overlay's difference from the saved library: what was added, what was toggled. */
export function formatDiff(diff: LibraryDiff): string {
  const { added, enabledChanged } = diff;
  if (added.length === 0 && enabledChanged.length === 0) return "No unpersisted session changes.";
  const lines = ["Unpersisted session changes:"];
  if (added.length) {
    lines.push("  added since the saved library:");
    for (const a of added) lines.push(`    + ${a.kind} ${a.name}`);
  }
  if (enabledChanged.length) {
    lines.push("  enabled/disabled changed from the saved library:");
    for (const c of enabledChanged) lines.push(`    ~ ${c.kind} ${c.name} → ${c.enabled ? "enabled" : "disabled"}`);
  }
  return lines.join("\n");
}
