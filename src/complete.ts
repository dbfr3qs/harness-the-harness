import { PROVIDER_NAMES } from "./config.ts";

/** What the completer needs to know about the session at the moment Tab is pressed. */
export interface CompletionState {
  models: string[]; // the current provider's model IDs
  policyPatterns: string[]; // patterns of the web policy's rules, in order
}

export const COMMANDS = ["/exit", "/reset", "/history", "/policy", "/provider", "/model", "/thinking", "/turns", "/maxtokens", "/defaults", "/context", "/tools", "/skills", "/mcp", "/library"];
const POLICY_SUBCOMMANDS = ["show", "help", "allow", "ask", "deny", "remove", "default", "limit", "save", "reload"];
const ACTIONS = ["allow", "ask", "deny"];

/**
 * A readline completer for slash commands: returns [candidates, the text they replace].
 * Only the last word is completed; earlier words decide which candidates fit. A completed
 * word gets a trailing space so the next Tab moves on to the next argument.
 */
export function completeSlashCommand(line: string, state: CompletionState): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const words = line.split(/\s+/);
  const last = words.pop()!;
  const options = candidates(words, state);
  const hits = options.filter((o) => o.startsWith(last)).map((o) => `${o} `);
  return [hits, last];
}

// Candidates for the word after `before` (the words already typed).
function candidates(before: string[], state: CompletionState): string[] {
  const [command, sub, arg] = before;
  switch (before.length) {
    case 0:
      return COMMANDS;
    case 1:
      if (command === "/provider") return PROVIDER_NAMES;
      if (command === "/model") return state.models;
      if (command === "/policy") return POLICY_SUBCOMMANDS;
      if (command === "/thinking") return ["on", "off"];
      if (command === "/turns") return ["unlimited"];
      if (command === "/defaults") return ["save", "clear"];
      return [];
    case 2:
      if (command !== "/policy") return [];
      if (sub === "default") return ACTIONS;
      if (sub === "limit") return ["url", "fetches"];
      // Existing patterns, to change a rule's action or remove it; remove also takes #n.
      if (sub === "remove") return [...state.policyPatterns, ...state.policyPatterns.map((_, i) => `#${i + 1}`)];
      if (ACTIONS.includes(sub!)) return state.policyPatterns;
      return [];
    case 3:
      return command === "/policy" && sub === "limit" && (arg === "url" || arg === "fetches") ? ["off"] : [];
    default:
      return [];
  }
}
