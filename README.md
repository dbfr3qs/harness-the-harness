# harness

A zero-dependency TypeScript CLI that chats with a model through the Anthropic Messages API and lets it call tools in a loop until it gives a final answer. It works with Claude (Anthropic) or with DeepSeek through DeepSeek's Anthropic-compatible endpoint; see [Providers](#providers).

- No runtime dependencies: plain `fetch`, `node:readline/promises`, `node:fs/promises`, `node:test`.
- Runs `.ts` files directly on Node 24 or later (type stripping); `tsc` is used only for type-checking.

## Setup

1. Install the dev dependencies (TypeScript and Node types, for type-checking only):

   ```sh
   npm install
   ```

2. Set your API key. The simplest way is a `.env` file in the project root (it is gitignored):

   ```sh
   ANTHROPIC_API_KEY=sk-ant-...
   DEEPSEEK_API_KEY=sk-...        # only needed for PROVIDER=deepseek
   ```

   `npm start` loads `.env` automatically if it exists. You can also export the variables in your shell instead. Keys are never printed, logged, written to a transcript or included in an error message, and `read_file` refuses to open `.env`.

## Running

```sh
npm start                 # interactive REPL
npm start -- --verbose    # print each tool call's full input and a one-line preview of every result
npm run check             # type-check (tsc --noEmit)
npm test                  # unit tests (node --test), no network or API key needed
```

Run it directly with `node --env-file=.env src/repl.ts`.

In the REPL:

| Command    | Effect |
| ---------- | ------ |
| `/exit`    | Quit (Ctrl+D, or Ctrl+C on an empty line, also quits; see [Stopping a run](#stopping-a-run)) |
| `/reset`   | Clear conversation history |
| `/history` | Show message count, roles and block types |
| `/policy`  | View or change the `web_fetch` site policy (see [Changing the policy from the REPL](#changing-the-policy-from-the-repl)) |
| `/provider` | Switch between Claude and DeepSeek from a menu; `/provider deepseek` switches directly (see [Providers](#providers)) |
| `/model`   | Switch model within the current provider from a menu; `/model <id>` switches directly |
| `/turns`   | Show the model-call limit per message; `/turns <n>` or `/turns unlimited` changes it for the session |
| `/context` | Show how full the context window is (see [Context meter](#context-meter)) |
| `/defaults` | Show what the harness starts with; `/defaults save` keeps this session's provider, models, thinking and turns, `/defaults clear` removes them (see [Saved defaults](#saved-defaults)) |
| `/thinking` | Show or hide the model's thinking: `/thinking on`, `/thinking off` (see [Seeing the model's thinking](#seeing-the-models-thinking)) |

Press Tab to complete commands and their arguments (provider names, the current provider's models, `/policy` subcommands and existing rule patterns); press it twice to list the options. A line that starts with an unknown `/word` is reported as an unknown command rather than sent to the model; paths such as `/etc/hosts` still go through.

Responses stream by default: text appears as the model writes it, and an animated row of dots (one to five and back) shows while it's waiting for the first output of each model call. The dots only appear when output is a terminal. Set `STREAM=0` to use plain non-streaming requests.

Each tool call is shown as a dim line as it runs (`→ read_file src/agent.ts`), with a `✗` line under it if the tool returned an error, so a long run of tool calls is never a silent wait. The model's thinking is hidden unless you turn it on with `/thinking on`.

After each answer the REPL prints that exchange's token totals, the number of model calls and the number of tool calls, e.g. `[tokens: 9413 in + 42240 cached, 5951 out · 8 model call(s) · 19 tool call(s)]`. "Cached" is input the provider served from its prompt cache (DeepSeek caches automatically); it is still input the model read, just billed at a lower rate. If the loop stops early, it says why: `MAX_TURNS` reached while the model was still calling tools, `MAX_TOKENS` cut-off, or a refusal. After `MAX_TURNS`, send another message and the model continues where it left off; `/turns <n>` raises the limit first if it needs more room.

### Context meter

Every answer's summary line ends with how much of the model's context window the conversation now fills, e.g. `context 23.5k/1M (2%)`. `/context` shows the detail:

```
Context: 250,000 of 1,000,000 tokens (25%) · claude-haiku-5-5 · 12 message(s)
  ████████░░░░░░░░░░░░░░░░░░░░░░  750k left
```

- **Used** is measured from the last response's `usage`: fresh and cached input plus the output, which is what the next request starts from. Your next message and any tool results add to it.
- **The window** comes from Anthropic's models API for Claude models (looked up once per model), and from DeepSeek's published 1M-token limit for DeepSeek. If it can't be found, the meter shows tokens only; set `CONTEXT_WINDOW` to supply it.
- From 80% full, a warning follows the summary line. The harness never drops old messages, so a full context makes requests fail; `/reset` starts a fresh conversation.
- After `/provider` or `/model`, the reading is marked `≈` until the next response measures it again, since providers count tokens differently (and a provider switch removes thinking blocks).

### Stopping a run

Press **Ctrl+C** while the model is working to stop it and get the prompt back. The request in flight is cancelled, a `web_fetch` in progress or waiting for approval is abandoned, and the conversation keeps every completed step: tool calls that had not run yet are recorded as interrupted, so you can send "continue" just as after `MAX_TURNS`. A partly written reply is discarded, and if nothing had come back yet, your message is taken back too.

| Where | Ctrl+C does |
| ----- | ----------- |
| While the model is working | Stops the run. A second press, if it hasn't stopped yet, quits |
| At the prompt, with text typed | Clears the line |
| At an empty prompt | Quits (skipping the `/exit` warning about unsaved `/policy` changes) |
| At an empty prompt, within 1.5 s of a run finishing by itself | Asks you to press again, so a press meant to stop a run that had just finished doesn't quit |

With `/turns unlimited` (or `MAX_TURNS=unlimited`) there is no limit on model calls per message, so Ctrl+C is the way to stop a run that is going nowhere.

## Providers

Both providers are reached with the same client, because DeepSeek serves the Anthropic Messages API at `https://api.deepseek.com/anthropic`. Pick one per run:

```sh
npm start                                   # Claude
PROVIDER=deepseek npm start                 # DeepSeek, deepseek-flash
PROVIDER=deepseek MODEL=deepseek-v4-pro npm start
```

The startup line shows which is in use (`harness · deepseek / deepseek-flash · ...`). Each provider only ever receives its own key.

### Switching during a session

`/provider` and `/model` open a menu: move with ↑/↓ (or j/k), press Enter or a number to choose, Esc to cancel. A provider whose key isn't set is listed but greyed out. Without a terminal (piped input) they print the choices instead; `/provider <name>` and `/model <id>` work either way.

- **The conversation carries over.** Switching provider keeps the history, with one exception: thinking blocks are removed, because each provider only accepts thinking blocks it wrote (Claude rejects DeepSeek's with a 400). Switching model within a provider keeps everything.
- **Each provider remembers its model** for the session, so switching away and back returns to the model you were using. `MODEL` and `BASE_URL` belong to the provider named by `PROVIDER`; the other provider uses its defaults.
- **`/model` lists the usual models.** For Claude, `/model <id>` also accepts any other model ID (Anthropic reports unknown ones clearly); for DeepSeek only the listed models are accepted.
- Switches last for the session only. To start with them next time, run `/defaults save` (see [Saved defaults](#saved-defaults)).
- Each switch is logged in the transcript as a `session` line with the provider, model and base URL.

Things to know about DeepSeek:

- **Model names are checked.** DeepSeek silently maps unknown model names to `deepseek-flash` (and `claude-opus*` names to the pricier `deepseek-v4-pro`), so with `PROVIDER=deepseek` the harness only accepts `deepseek-flash` and `deepseek-v4-pro`. If DeepSeek adds models, update the list in `src/config.ts`.
- **It thinks by default.** Responses start with a `thinking` block, which is kept in history and sent back verbatim like Claude's. It is not printed.
- **`is_error` on tool results is ignored**, so the harness's tool errors always begin with `Error:` in the text itself.
- **Data goes to DeepSeek.** Your messages, and anything the tools return (workspace file contents, fetched pages), are sent to DeepSeek's servers under DeepSeek's terms.
- DeepSeek caches repeated input automatically, so most of a long tool loop's input shows up as `cached` in the token line.

## Seeing the model's thinking

`/thinking on` prints the model's thinking dimmed, after a `✻`, before its answer and between tool calls. It streams as it arrives (or prints with each response when `STREAM=0`). `/thinking off` hides it again. Either way, thinking is kept in the conversation and written to the transcript.

What you see depends on the model:

- **DeepSeek** returns its thinking as written. Nothing about the request changes.
- **Claude 5 models** (`claude-*-5*`) think by default but return the thinking empty unless asked. With thinking shown, requests add `"thinking": {"type": "adaptive", "display": "summarized"}`, and Claude returns a summary of its reasoning, written by a separate model. Claude never returns the raw reasoning. Cost is the same either way, since the model thinks regardless; when streaming, the answer starts a little later because the summary streams first.
- **Older Claude models** (4.8 and earlier) only think when thinking is turned on in the request, which changes cost and behaviour, so the harness doesn't do it and there is nothing to show.

Models may skip thinking on simple requests, so not every answer has any.

## Saved defaults

The harness starts with the provider, model, thinking and turn settings saved in `harness.json` in the project root. Set things up the way you like during a session, then:

```
/defaults          show what the next start will use, and where each setting comes from
/defaults save     save this session's provider, models, thinking and turns
/defaults clear    delete harness.json; the built-in defaults apply again
```

```json
{
  "provider": "deepseek",
  "models": { "anthropic": "claude-haiku-5-5", "deepseek": "deepseek-v4-pro" },
  "showThinking": true,
  "maxTurns": "unlimited"
}
```

- **One model per provider** is saved: the one in use, plus the one you last used with the other provider this session (or the one already saved), so `/provider` switches to it as well.
- **Environment variables win.** For each setting, the order is: environment variable (`PROVIDER`, `MODEL`, `SHOW_THINKING`, `MAX_TURNS`, from `.env` or your shell), then `harness.json`, then the built-in default. `/defaults` shows which one decides each setting, and `/defaults save` warns if an environment variable will still win over what you saved.
- **No keys.** The file only holds the settings above; keys stay in `.env`. Anything else in it is an error at startup, as is an invalid value (such as a DeepSeek model that doesn't exist), so a typo can't silently change what runs.
- **Private.** `harness.json` is gitignored, and the model's file tools can't read it.
- Set `HARNESS_SETTINGS` to keep the file somewhere else.

## Environment variables

| Variable                | Default                           | Purpose |
| ----------------------- | --------------------------------- | ------- |
| `PROVIDER`              | `anthropic`                       | `anthropic` or `deepseek` |
| `ANTHROPIC_API_KEY`     | none                              | Key for `PROVIDER=anthropic` (required then); never logged |
| `DEEPSEEK_API_KEY`      | none                              | Key for `PROVIDER=deepseek` (required then); never logged |
| `MODEL`                 | per provider                      | `claude-sonnet-5-5` or `deepseek-flash` (`claude-haiku-5-5` is cheaper for testing) |
| `BASE_URL`              | per provider                      | `https://api.anthropic.com` or `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | none              | Older names for `MODEL` and `BASE_URL`; used only with `PROVIDER=anthropic`, and `MODEL`/`BASE_URL` win |
| `MAX_TOKENS`            | `4096`                            | `max_tokens` per request |
| `MAX_TURNS`             | `10`                              | Model calls per user message, or `unlimited`; `/turns` changes it for the session |
| `TIMEOUT_MS`            | `120000`                          | Idle timeout: the longest wait for the next piece of a response (the whole response when not streaming) |
| `MAX_RETRIES`           | `3`                               | Retries on network errors, timeouts, 429, 500 and 529 (and overloaded errors mid-stream, until text has been shown) |
| `STREAM`                | `true`                            | Stream responses (SSE); `0`/`false` for non-streaming requests |
| `SHOW_THINKING`         | `false`                           | Start with the model's thinking shown (same as `/thinking on`) |
| `WEB_POLICY`            | `web-policy.json`                 | Site policy for `web_fetch` (see below). If set explicitly, the file must exist |
| `HARNESS_SETTINGS`      | `harness.json`                    | Saved defaults file (see [Saved defaults](#saved-defaults)) |
| `CONTEXT_WINDOW`        | per model                         | Context window size for the meter, for models whose window isn't known |
| `MAX_TOOL_OUTPUT_CHARS` | `8000`                            | Tool results longer than this are truncated with a visible marker |
| `WORKSPACE_ROOT`        | current directory                 | Sandbox root for the file tools |
| `TRANSCRIPT_PATH`       | `./transcripts/<timestamp>.jsonl` | JSONL transcript file |

## Tools

| Tool       | Input                     | Returns |
| ---------- | ------------------------- | ------- |
| `get_time` | none                      | Local time in ISO 8601 with offset, plus the IANA time zone |
| `list_dir` | `path` (default `.`)      | One entry per line, directories end in `/`; capped at 200 entries |
| `read_file`| `path` (required)         | UTF-8 file contents; refuses files over 256 KB |
| `web_fetch`| `url` (required), `offset` | Readable text of a web page (HTML converted to text, links kept as absolute URLs), in parts of up to `MAX_TOOL_OUTPUT_CHARS` minus 500 |

All tools are read-only. `web_fetch` is the only one that reaches the network. File tools only see paths inside `WORKSPACE_ROOT`: `..` traversal, absolute paths elsewhere, and symlinks that escape are refused. `read_file` never reads `.env` or `.env.*` files, in any directory, whatever the case, or through a symlink, because they hold secrets such as the API key. `list_dir` still shows that they exist.

Some paths are private: neither tool reads or lists them, by any path or symlink, and `list_dir` leaves them out of listings with a note saying so.

- **`.git/`** (at any depth): the repository's internals, including your name and email in `.git/config`.
- **The transcript directory** (`transcripts/` by default; wherever `TRANSCRIPT_PATH` points). Transcripts hold whole past conversations, and without this a model could read conversations held with another provider. If `TRANSCRIPT_PATH` puts transcripts directly in the workspace root, only the current transcript file is private.
- **Settings files**: `harness.json` (wherever `HARNESS_SETTINGS` points) and the web policy file (`web-policy.json`, or wherever `WEB_POLICY` points). The tool description already tells the model what the policy allows.

**The model can't change any file.** No tool writes, deletes or runs anything; the only code that writes is the transcript logger and `/defaults save`, `/defaults clear` and `/policy save`, which run only when you type them. Slash commands are recognised only in what you type, never in model output. `test/boundaries.test.ts` fails if anything under `src/tools/` gains a write or execute API, or imports the code that saves settings, so a tool like that can't be added by accident (the spec requires the owner's approval for one).

Tools reject arguments they don't define (for example an `offset` passed to `read_file`) instead of ignoring them, so the model isn't misled by a result that silently ignored part of its request.

### web_fetch safeguards

A fetched URL can carry data out of the workspace (for example, file contents placed in a query string after the model reads a page containing injected instructions), so `web_fetch` has these protections:

- **A site policy, if you add one** (next section), decides first: `allow` fetches without asking, `deny` refuses, `ask` uses the prompt below.
- **Otherwise you approve every fetch.** The REPL shows the full URL and asks `[y]es / [n]o / [a]lways for <host>`. `a` approves that host until you exit. A declined fetch returns an error telling the model not to retry. If input is closed (piped stdin), fetches are declined.
- **Public addresses only.** Loopback, private, link-local (including cloud metadata at `169.254.169.254`), CGNAT, multicast and reserved ranges are refused, including IPv4 written inside IPv6. The check runs inside the DNS lookup, so the address that was checked is the address connected to. Every redirect hop is checked again (up to 5 hops); you're only asked about the URL the model chose.
- **Limits.** `http`/`https` only, no credentials in URLs, a 20-second timeout, a 2 MB download cap (stated in the result when hit), and text content types only (HTML, plain text, JSON, XML).

### Web policy (site allowlist)

With no policy file, `web_fetch` asks before every fetch. To control which sites it can reach, copy the example and edit it:

```sh
cp web-policy.example.json web-policy.json
```

```json
{
  "default": "deny",
  "rules": [
    { "match": "docs.anthropic.com",             "action": "allow" },
    { "match": "*.wikipedia.org",                "action": "allow" },
    { "match": "https://github.com/anthropics/", "action": "allow" },
    { "match": "github.com",                     "action": "ask" },
    { "match": "*.ngrok.io",                     "action": "deny" }
  ]
}
```

**Actions:** `allow` fetches without asking, `ask` shows the approval prompt, and `deny` refuses without asking. A denied fetch tells the model which sites are allowed and not to retry.

**Matching:**

| Pattern | Matches |
| ------- | ------- |
| `docs.anthropic.com` | That host exactly, on any port. Not its subdomains. |
| `*.wikipedia.org` | Any subdomain (`en.wikipedia.org`, `a.b.wikipedia.org`), but not `wikipedia.org` itself; list that separately if you want it. |
| `https://github.com/anthropics/` | That scheme, host and port, and paths under that prefix on `/` boundaries (`/v1` matches `/v1/models` but not `/v10`). |

Hosts are compared after normalising case, punycode and a trailing dot.

**Precedence:** when several rules match, `deny` beats `allow`, which beats `ask`. `default` (which is `deny` if omitted) applies only when no rule matches. Answering `a` at the prompt approves an `ask` host for the session, but it can never override `deny`.

**Redirects** are checked against the policy on every hop, so an open redirect on an allowed site can't lead somewhere else. A redirect may go to an `allow` site, or stay on the host that was just approved. Anything else is refused, since there's no prompt in the middle of a redirect.

**The model sees the policy:** the `web_fetch` description lists the allowed, ask and blocked sites, so the model doesn't waste turns on URLs that will be refused.

**Optional limits** (not set in the example, so they don't apply until you add them):

| Setting | Effect |
| ------- | ------ |
| `"maxUrlLength": 300` | Refuses URLs longer than this. It's hard to fit file contents into a short URL. |
| `"maxFetchesPerMessage": 5` | Caps the fetches a single user message can trigger, including follow-up pages read with `offset`. Denied and declined fetches don't count. |

An allowlist limits *where* requests go, not what they carry. An allowed site that records what's in its URLs (search pages, for example) could still receive data in a query string, which is what `maxUrlLength` narrows.

#### Changing the policy from the REPL

```
/policy                          show the policy in effect, its rules (numbered), limits and session approvals
/policy allow|ask|deny <pattern> add a rule, or change the action of the existing rule for <pattern>
/policy remove <pattern | #>     remove a rule by pattern or number
/policy default allow|ask|deny   action for sites no rule matches
/policy limit url <n | off>      set or clear maxUrlLength
/policy limit fetches <n | off>  set or clear maxFetchesPerMessage
/policy save                     write the policy to its file (web-policy.json, or WEB_POLICY)
/policy reload                   re-read the file, discarding unsaved changes
```

- **Changes take effect immediately** but stay in this session until you run `/policy save`. `/policy` shows when there are unsaved changes, and `/exit` warns once before discarding them.
- **With no policy file,** you start from "ask before every fetch" (`default: ask`, no rules), and `/policy save` creates the file.
- **Every change is validated** exactly like the file, so an invalid pattern is rejected with the same error and the policy is left unchanged.
- **Saving** writes the same format as `web-policy.example.json`, atomically (temporary file, then rename). If you approved hosts with `[a]lways` this session, `/policy save` offers to keep them as `allow` rules. A host approved on a non-default port is saved in URL form, so the rule stays limited to that port.
- **Only you can change the policy.** `/policy` commands are handled by the REPL and never reach the model, and the model has no tool that writes files.
- **How the model finds out:** the tool definitions aren't changed mid-conversation, since that would rewrite the start of the prompt. Instead, your next message carries a short `[harness note: ...]` stating the new policy. The `web_fetch` description picks up the policy again after `/reset`, or straight away if the conversation is empty. Refusals always quote the policy in effect.

**Safety of the file:** a policy file that exists but is invalid (bad JSON, unknown settings or actions, malformed patterns) stops the REPL at startup with an error, rather than running without a policy. Each decision is logged in the transcript with the rule that matched. The REPL banner shows which policy is in effect.

## Adding a new tool

1. Create `src/tools/<name>.ts` and export a tool built with `defineTool`. If it needs config such as the workspace root, export a factory function instead (see `list_dir.ts`).

   ```ts
   import { defineTool } from "../registry.ts";

   export const wordCountTool = defineTool({
     name: "word_count", // must match ^[a-zA-Z0-9_-]{1,128}$ and be unique
     description:
       "Count the words in a piece of text. Use it when the user asks how long a text is. " +
       "Returns the word count as a number. Words are split on whitespace.",
     input_schema: {
       type: "object",
       properties: { text: { type: "string", description: "The text to count" } },
       required: ["text"],
     },
     handler: async (input) => {
       const text = input.text as string; // presence and type are already validated by dispatch
       if (text.length > 1_000_000) throw new Error("text is over 1,000,000 characters; pass a shorter excerpt.");
       return String(text.split(/\s+/).filter(Boolean).length);
     },
   });
   ```

2. Register it in `src/repl.ts` by adding it to the `createRegistry([...])` list.

3. Add tests, for example in `test/tools.test.ts`.

Guidelines:

- **The description is a prompt.** In three or four sentences, say what the tool does, when to use it, what it returns, and its limits. Do not describe tools in the system prompt as well.
- **Throw to report failure.** `dispatch` turns any thrown error into an `Error: …` result with `is_error: true`, so the model can read it and correct course. Write messages that say what went wrong and what to try instead.
- **Validation is automatic.** `dispatch` checks that the input is an object, that required keys exist, and that `string`, `number`, `integer`, `boolean` (and string `enum`) properties have the right types before your handler runs.
- **Long output is handled.** Results over `MAX_TOOL_OUTPUT_CHARS` are truncated with a `[truncated: N more chars]` marker.

## Transcripts

Each REPL session appends one JSON object per line to `TRANSCRIPT_PATH`:

```json
{ "ts": "2026-10-15T06:37:12.345Z", "kind": "request", "data": { "model": "...", "messages": [ ... ] } }
```

`kind` is one of `request`, `response`, `tool_call`, `tool_result`, `error` or `session` (a `/provider` or `/model` switch). Request bodies and full responses (including `usage`) are logged; headers and the API key never are. If logging fails, the REPL prints one warning and carries on.

## Layout

```
src/
  types.ts        content block, message, tool and response types
  config.ts       settings from env vars with defaults; the provider table
  client.ts       createAnthropicClient(): fetch + timeout + retry, streaming or not
  sse.ts          SSE parsing; rebuilds the streamed message exactly as the API would return it
  registry.ts     defineTool, createRegistry, dispatch
  agent.ts        runAgent(): the loop
  log.ts          JSONL transcript writer
  repl.ts         CLI entry point
  spinner.ts      waiting animation
  menu.ts         arrow-key menu for the terminal
  complete.ts     Tab completion for slash commands
  model_command.ts /provider and /model
  settings.ts     harness.json: load, validate, save
  context_meter.ts context usage, formatting and /context
  defaults_command.ts /defaults
  turns_command.ts /turns
  tools/          workspace sandboxing, private paths, get_time, list_dir, read_file, web_fetch, web_policy
test/             unit tests (fake model, fake fetch, temp dirs)
```

Dependencies flow one way: `repl` → `agent` → `client` and `registry` → `tools`. `agent.ts` depends only on the `ModelFn` type, so another provider can be added as a new client without touching the loop. DeepSeek didn't need one: it speaks the same protocol, so `config.ts` just picks its key, base URL and model.

Streaming lives entirely in the client. It rebuilds the stream into the same message object a non-streaming request returns, including thinking signatures and tool inputs, so the agent loop and history handling are identical in both modes. A stream that fails before any text is shown is retried; one that fails after text has appeared is reported as an error instead, so an answer is never printed twice. An unknown delta type is an error rather than being skipped, because a block that can't be rebuilt exactly would corrupt the history.

## API check (raw curl)

Load the key from `.env` into the shell, then send one request with a `tools` array. The response should have `"stop_reason": "tool_use"`.

```sh
set -a; . ./.env; set +a

curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-haiku-5-5",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "tools": [{
      "name": "read_file",
      "description": "Read a UTF-8 text file inside the workspace and return its contents. Refuses files over 256 KB.",
      "input_schema": {
        "type": "object",
        "properties": { "path": { "type": "string", "description": "Path relative to the workspace root" } },
        "required": ["path"]
      }
    }],
    "messages": [{ "role": "user", "content": "What is in package.json?" }]
  }'
```
