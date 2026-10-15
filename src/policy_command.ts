import { rename, writeFile } from "node:fs/promises";
import { compileWebPolicy, loadWebPolicy } from "./tools/web_policy.ts";
import type { CompiledPolicy, WebAction, WebPolicy } from "./tools/web_policy.ts";

// With no policy file, the harness behaves as if the policy were this: ask before every fetch.
const STARTING_POLICY: WebPolicy = { default: "ask", rules: [] };

/**
 * The web policy in effect for this session. Changes made with /policy are validated by
 * compileWebPolicy, take effect immediately, and are written to disk only by save().
 */
export function createPolicyStore(path: string, loaded: CompiledPolicy | undefined) {
  let current = loaded ?? compileWebPolicy(STARTING_POLICY, "web policy");
  let fromFile = loaded !== undefined;
  let dirty = false;

  return {
    path,
    current: () => current,
    fromFile: () => fromFile,
    dirty: () => dirty,

    /** Applies a change to a copy of the policy. Throws, leaving the policy unchanged, if the result is invalid. */
    update(change: (p: WebPolicy) => void): void {
      const draft: WebPolicy = structuredClone(current.policy);
      change(draft);
      current = compileWebPolicy(withoutUnset(draft), "policy");
      dirty = true;
    },

    /** Writes the policy atomically (temp file, then rename), so a crash can't leave half a file. */
    async save(): Promise<void> {
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, formatPolicy(current.policy), "utf8");
      await rename(tmp, path);
      fromFile = true;
      dirty = false;
    },

    /** Re-reads the file, discarding unsaved changes. A missing file means the starting policy. */
    async reload(): Promise<void> {
      const fresh = await loadWebPolicy(path, false);
      current = fresh ?? compileWebPolicy(STARTING_POLICY, "web policy");
      fromFile = fresh !== undefined;
      dirty = false;
    },
  };
}

export type PolicyStore = ReturnType<typeof createPolicyStore>;

function withoutUnset(p: WebPolicy): WebPolicy {
  const out: WebPolicy = { default: p.default, rules: p.rules };
  if (p.maxUrlLength !== undefined) out.maxUrlLength = p.maxUrlLength;
  if (p.maxFetchesPerMessage !== undefined) out.maxFetchesPerMessage = p.maxFetchesPerMessage;
  return out;
}

/** JSON with one rule per line, matching web-policy.example.json. */
export function formatPolicy(p: WebPolicy): string {
  const lines = [`  "default": ${JSON.stringify(p.default)}`];
  const rules = p.rules.map((r) => `    { "match": ${JSON.stringify(r.match)}, "action": ${JSON.stringify(r.action)} }`);
  lines.push(rules.length ? `  "rules": [\n${rules.join(",\n")}\n  ]` : `  "rules": []`);
  if (p.maxUrlLength !== undefined) lines.push(`  "maxUrlLength": ${p.maxUrlLength}`);
  if (p.maxFetchesPerMessage !== undefined) lines.push(`  "maxFetchesPerMessage": ${p.maxFetchesPerMessage}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

// --- the /policy command -------------------------------------------------------

export const POLICY_HELP = [
  "/policy                         show the web_fetch policy in effect",
  "/policy allow|ask|deny <pattern> add a rule, or change the action of the rule for <pattern>",
  "/policy remove <pattern | #>    remove a rule",
  "/policy default allow|ask|deny  action for sites no rule matches",
  "/policy limit url <n | off>     maxUrlLength",
  "/policy limit fetches <n | off> maxFetchesPerMessage",
  "/policy save                    write the policy to its file",
  "/policy reload                  re-read the file, discarding unsaved changes",
  'Patterns: a host ("docs.anthropic.com"), "*.domain" for its subdomains, or a URL prefix ("https://github.com/anthropics/").',
].join("\n");

export interface PolicyCommandContext {
  store: PolicyStore;
  /** Hosts approved with [a]lways this session: host -> origin of the first approved URL. */
  approvals: Map<string, string>;
  /** Asks the user a question at the prompt and returns the answer. */
  ask: (question: string) => Promise<string>;
}

export interface PolicyCommandResult {
  output: string;
  changed: boolean; // the policy in effect changed, so the model should be told
}

const ACTIONS = new Set<WebAction>(["allow", "ask", "deny"]);

export async function runPolicyCommand(args: string, ctx: PolicyCommandContext): Promise<PolicyCommandResult> {
  const { store } = ctx;
  const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const usage = (msg: string): PolicyCommandResult => ({ output: `${msg}\n\n${POLICY_HELP}`, changed: false });
  const changed = (output: string): PolicyCommandResult => ({ output: `${output}\n${unsavedNote(store)}`, changed: true });

  try {
    switch (sub) {
      case "":
      case "show":
        return { output: describeStore(ctx), changed: false };

      case "help":
        return { output: POLICY_HELP, changed: false };

      case "allow":
      case "ask":
      case "deny": {
        if (rest.length !== 1) return usage(`Usage: /policy ${sub} <pattern>`);
        const pattern = rest[0]!;
        let verb = "Added";
        store.update((p) => {
          const existing = p.rules.find((r) => r.match === pattern);
          if (existing) {
            verb = existing.action === sub ? "Unchanged" : `Changed (was ${existing.action})`;
            existing.action = sub;
          } else {
            p.rules.push({ match: pattern, action: sub });
          }
        });
        return changed(`${verb}: ${sub} ${pattern}`);
      }

      case "remove": {
        if (rest.length !== 1) return usage("Usage: /policy remove <pattern | #>");
        const target = rest[0]!;
        let removed = "";
        store.update((p) => {
          const index = /^#?\d+$/.test(target)
            ? Number(target.replace("#", "")) - 1
            : p.rules.findIndex((r) => r.match === target);
          const rule = p.rules[index];
          if (!rule) throw new Error(`no rule ${/^#?\d+$/.test(target) ? `number ${target.replace("#", "")}` : `for "${target}"`}; run /policy to see the rules`);
          removed = `${rule.action} ${rule.match}`;
          p.rules.splice(index, 1);
        });
        return changed(`Removed: ${removed}`);
      }

      case "default": {
        const action = rest[0] as WebAction;
        if (rest.length !== 1 || !ACTIONS.has(action)) return usage("Usage: /policy default allow|ask|deny");
        store.update((p) => {
          p.default = action;
        });
        return changed(`Default for unmatched sites: ${action}`);
      }

      case "limit": {
        const [which, value] = rest;
        const key = which === "url" ? "maxUrlLength" : which === "fetches" ? "maxFetchesPerMessage" : undefined;
        if (!key || rest.length !== 2 || (value !== "off" && !/^\d+$/.test(value!))) {
          return usage("Usage: /policy limit url|fetches <n | off>");
        }
        store.update((p) => {
          if (value === "off") delete p[key];
          else p[key] = Number(value);
        });
        return changed(`${key}: ${value === "off" ? "off" : value}`);
      }

      case "save": {
        if (rest.length > 0) return usage("Usage: /policy save");
        const extra = await offerApprovals(ctx);
        await store.save();
        return { output: `Saved to ${store.path}.${extra}`, changed: extra !== "" };
      }

      case "reload": {
        if (rest.length > 0) return usage("Usage: /policy reload");
        await store.reload();
        return {
          output: store.fromFile() ? `Reloaded ${store.path}.` : `${store.path} does not exist; using the starting policy (ask before every fetch).`,
          changed: true,
        };
      }

      default:
        return usage(`Unknown /policy command "${sub}".`);
    }
  } catch (err) {
    return { output: `Not changed: ${err instanceof Error ? err.message : String(err)}`, changed: false };
  }
}

// Offers to keep this session's [a]lways approvals as allow rules. Returns text to report.
async function offerApprovals(ctx: PolicyCommandContext): Promise<string> {
  const { store } = ctx;
  // A host rule matches any port, so a non-default port needs the URL form to stay that narrow.
  const rules = [...ctx.approvals.values()].map((origin) => {
    const u = new URL(origin);
    return u.port ? `${u.origin}/` : u.hostname;
  });
  const pending = rules.filter((r) => !store.current().policy.rules.some((x) => x.match === r));
  if (pending.length === 0) return "";
  const answer = (await ctx.ask(`Also save this session's approved host(s) as allow rules: ${pending.join(", ")}? [y/n] `))
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") return "";
  store.update((p) => {
    for (const match of pending) p.rules.push({ match, action: "allow" });
  });
  return ` Added allow rule(s): ${pending.join(", ")}.`;
}

function unsavedNote(store: PolicyStore): string {
  return `In effect now; unsaved (/policy save writes ${store.path}). The model is told with your next message.`;
}

export function describeStore(ctx: Pick<PolicyCommandContext, "store" | "approvals">): string {
  const { store } = ctx;
  const p = store.current().policy;
  const source = store.fromFile() ? store.path : `none (${store.path} does not exist)`;
  const lines = [`Web policy: ${source}${store.dirty() ? " · unsaved changes" : ""}`, `  default: ${p.default}`];
  if (p.rules.length === 0) lines.push("  rules: none");
  p.rules.forEach((r, i) => lines.push(`  ${String(i + 1).padStart(2)}. ${r.action.padEnd(5)} ${r.match}`));
  lines.push(`  limits: maxUrlLength ${p.maxUrlLength ?? "off"}, maxFetchesPerMessage ${p.maxFetchesPerMessage ?? "off"}`);
  lines.push(`  session approvals: ${ctx.approvals.size ? [...ctx.approvals.keys()].join(", ") : "none"}`);
  return lines.join("\n");
}
