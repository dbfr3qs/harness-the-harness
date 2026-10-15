import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyStore, formatPolicy, runPolicyCommand } from "../src/policy_command.ts";
import type { PolicyCommandContext } from "../src/policy_command.ts";
import { createRegistry } from "../src/registry.ts";
import { createWebFetchTool } from "../src/tools/web_fetch.ts";
import { loadWebPolicy } from "../src/tools/web_policy.ts";

let dir: string;
let n = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-policycmd-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A fresh context with no policy file; `answers` scripts replies to ask().
function ctx(answers: string[] = []): PolicyCommandContext & { asked: string[]; run: (args: string) => ReturnType<typeof runPolicyCommand> } {
  const store = createPolicyStore(join(dir, `policy-${++n}.json`), undefined);
  const asked: string[] = [];
  const c: PolicyCommandContext = {
    store,
    approvals: new Map(),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
  return { ...c, asked, run: (args) => runPolicyCommand(args, c) };
}

const rules = (c: PolicyCommandContext) => c.store.current().policy.rules.map((r) => `${r.action} ${r.match}`);

test("with no file, the starting policy asks before every fetch", async () => {
  const c = ctx();
  assert.equal(c.store.current().policy.default, "ask");
  assert.equal(c.store.fromFile(), false);
  const out = await c.run("");
  assert.match(out.output, /^Web policy: none \(.*does not exist\)\n  default: ask\n  rules: none\n  limits: maxUrlLength off, maxFetchesPerMessage off\n  session approvals: none$/);
  assert.equal(out.changed, false);
});

test("allow/ask/deny add rules, and repeat patterns change the action in place", async () => {
  const c = ctx();
  let out = await c.run("allow docs.example.com");
  assert.match(out.output, /^Added: allow docs\.example\.com\nIn effect now; unsaved/);
  assert.equal(out.changed, true);
  await c.run("deny *.ngrok.io");
  out = await c.run("ask docs.example.com");
  assert.match(out.output, /^Changed \(was allow\): ask docs\.example\.com/);
  out = await c.run("ask docs.example.com");
  assert.match(out.output, /^Unchanged: ask docs\.example\.com/);
  assert.deepEqual(rules(c), ["ask docs.example.com", "deny *.ngrok.io"]);
  assert.equal(c.store.dirty(), true);
  assert.match((await c.run("")).output, /· unsaved changes\n  default: ask\n   1\. ask   docs\.example\.com\n   2\. deny  \*\.ngrok\.io/);
});

test("invalid patterns are rejected with the validator's message and change nothing", async () => {
  const c = ctx();
  await c.run("allow ok.test");
  const before = c.store.current();
  for (const [args, pattern] of [
    ["allow a.test/path", /must be a host/],
    ["allow *", /only use \* as a leading/],
    ["deny a.test:8080", /includes a port/],
    ["allow ftp://a.test/", /http or https URL/],
  ] as const) {
    const out = await c.run(args);
    assert.equal(out.changed, false, args);
    assert.match(out.output, /^Not changed: policy: rules\[1\]\.match/, args);
    assert.match(out.output, pattern, args);
  }
  assert.equal(c.store.current(), before, "the compiled policy object is untouched");
});

test("remove works by number or pattern", async () => {
  const c = ctx();
  await c.run("allow a.test");
  await c.run("allow b.test");
  await c.run("allow c.test");
  assert.match((await c.run("remove 2")).output, /^Removed: allow b\.test/);
  assert.match((await c.run("remove #1")).output, /^Removed: allow a\.test/);
  assert.match((await c.run("remove c.test")).output, /^Removed: allow c\.test/);
  const missing = await c.run("remove 9");
  assert.equal(missing.changed, false);
  assert.match(missing.output, /^Not changed: no rule number 9/);
  assert.match((await c.run("remove nope.test")).output, /^Not changed: no rule for "nope\.test"/);
});

test("default and limits can be set and turned off", async () => {
  const c = ctx();
  assert.match((await c.run("default deny")).output, /^Default for unmatched sites: deny/);
  await c.run("limit url 300");
  await c.run("limit fetches 5");
  assert.deepEqual(c.store.current().policy, { default: "deny", rules: [], maxUrlLength: 300, maxFetchesPerMessage: 5 });
  await c.run("limit url off");
  assert.equal(c.store.current().policy.maxUrlLength, undefined);
  assert.match((await c.run("limit fetches 0")).output, /^Not changed: .*"maxFetchesPerMessage" must be a whole number of 1 or more/);
});

test("bad usage prints help and changes nothing", async () => {
  const c = ctx();
  for (const args of ["allow", "allow a.test b.test", "default maybe", "limit speed 5", "limit url lots", "frobnicate", "save now"]) {
    const out = await c.run(args);
    assert.equal(out.changed, false, args);
    assert.match(out.output, /\/policy allow\|ask\|deny <pattern>/, args);
  }
  assert.equal(c.store.dirty(), false);
});

test("save writes a formatted file atomically that loads back to the same policy", async () => {
  const c = ctx();
  await c.run("default deny");
  await c.run("allow docs.example.com");
  await c.run("allow https://github.com/anthropics/");
  await c.run("limit url 300");
  const out = await c.run("save");
  assert.match(out.output, /^Saved to .*policy-\d+\.json\.$/);
  assert.equal(out.changed, false);
  assert.equal(c.store.dirty(), false);
  assert.equal(c.store.fromFile(), true);

  const text = await readFile(c.store.path, "utf8");
  assert.equal(
    text,
    [
      "{",
      '  "default": "deny",',
      '  "rules": [',
      '    { "match": "docs.example.com", "action": "allow" },',
      '    { "match": "https://github.com/anthropics/", "action": "allow" }',
      "  ],",
      '  "maxUrlLength": 300',
      "}",
      "",
    ].join("\n"),
  );
  assert.deepEqual((await loadWebPolicy(c.store.path, true))?.policy, c.store.current().policy);
  assert.deepEqual((await readdir(dir)).filter((f) => f.includes(".tmp-")), [], "no temp file left behind");
});

test("save offers session approvals as allow rules, keeping non-default ports narrow", async () => {
  const yes = ctx(["y"]);
  yes.approvals.set("example.com", "https://example.com");
  yes.approvals.set("api.example.com:8443", "https://api.example.com:8443");
  const out = await yes.run("save");
  assert.match(yes.asked[0]!, /approved host\(s\) as allow rules: example\.com, https:\/\/api\.example\.com:8443\/\?/);
  assert.match(out.output, /Added allow rule\(s\): example\.com, https:\/\/api\.example\.com:8443\/\./);
  assert.equal(out.changed, true, "adding rules changes the policy in effect");
  assert.deepEqual(rules(yes), ["allow example.com", "allow https://api.example.com:8443/"]);
  assert.match(await readFile(yes.store.path, "utf8"), /"https:\/\/api\.example\.com:8443\/"/);

  // Already-saved approvals are not offered again; "n" saves without them.
  assert.match((await yes.run("save")).output, /^Saved/);
  assert.equal(yes.asked.length, 1);
  const no = ctx(["n"]);
  no.approvals.set("example.com", "https://example.com");
  await no.run("save");
  assert.deepEqual(rules(no), []);
});

test("reload discards unsaved changes; a missing file means the starting policy", async () => {
  const c = ctx();
  await c.run("allow a.test");
  await c.run("save");
  await c.run("deny b.test");
  const out = await c.run("reload");
  assert.match(out.output, /^Reloaded /);
  assert.deepEqual(rules(c), ["allow a.test"]);
  assert.equal(c.store.dirty(), false);

  const empty = ctx();
  await empty.run("allow a.test");
  assert.match((await empty.run("reload")).output, /does not exist; using the starting policy/);
  assert.deepEqual(rules(empty), []);
});

test("a store loaded from a file starts clean and reports its source", async () => {
  const path = join(dir, "existing.json");
  await writeFile(path, formatPolicy({ default: "deny", rules: [{ match: "a.test", action: "allow" }] }));
  const store = createPolicyStore(path, await loadWebPolicy(path, true));
  assert.equal(store.fromFile(), true);
  assert.equal(store.dirty(), false);
  assert.match((await runPolicyCommand("", { store, approvals: new Map(), ask: async () => "" })).output, /^Web policy: .*existing\.json\n  default: deny/);
});

// --- web_fetch reads the live policy ---------------------------------------------------

test("web_fetch enforces policy changes immediately but only redescribes itself on refresh", async () => {
  const c = ctx();
  const webFetch = createWebFetchTool({ confirm: async () => true, pageChars: 100, policy: () => c.store.current() });
  const registry = createRegistry([webFetch]);
  const describe = () => registry.definitions()[0]!.description;
  assert.match(describe(), /The user must approve each fetch/, "the starting policy reads as no policy");

  await c.run("deny blocked.test");
  const out = await registry.dispatch("web_fetch", { url: "https://blocked.test/" });
  assert.equal(out.isError, true);
  assert.match(out.content, /blocked\.test is blocked by the web policy \(rule "blocked\.test"\)/, "enforced at once, no network needed");
  assert.match(describe(), /The user must approve each fetch/, "description unchanged mid-conversation");

  webFetch.refreshDescription();
  assert.match(describe(), /Site access is limited by policy: blocked: blocked\.test; any other site is allowed after the user approves/);
});
