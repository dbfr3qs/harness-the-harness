# harness

A zero-dependency TypeScript CLI that chats with Claude through the Anthropic Messages API and lets it call tools in a loop until it gives a final answer.

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
   ```

   `npm start` loads `.env` automatically if it exists. You can also export the variable in your shell instead. The key is never printed, logged, written to a transcript or included in an error message.

## Running

```sh
npm start                 # interactive REPL
npm start -- --verbose    # also print each tool call, its input and a one-line result preview
npm run check             # type-check (tsc --noEmit)
npm test                  # unit tests (node --test), no network or API key needed
```

Run it directly with `node --env-file=.env src/repl.ts`.

In the REPL:

| Command    | Effect |
| ---------- | ------ |
| `/exit`    | Quit (Ctrl+C and Ctrl+D also exit cleanly) |
| `/reset`   | Clear conversation history |
| `/history` | Show message count, roles and block types |

After each answer the REPL prints that exchange's input and output token totals and the number of model calls. If the loop stops early, it says why: `MAX_TURNS` reached, `MAX_TOKENS` cut-off, or a refusal. After `MAX_TURNS`, send another message and the model continues where it left off.

## Environment variables

| Variable                | Default                           | Purpose |
| ----------------------- | --------------------------------- | ------- |
| `ANTHROPIC_API_KEY`     | none (required)                   | API key; never logged |
| `ANTHROPIC_BASE_URL`    | `https://api.anthropic.com`       | API host |
| `ANTHROPIC_MODEL`       | `claude-sonnet-5-5`               | Model ID (`claude-haiku-5-5` is cheaper for testing) |
| `MAX_TOKENS`            | `4096`                            | `max_tokens` per request |
| `MAX_TURNS`             | `10`                              | Model calls per user message |
| `TIMEOUT_MS`            | `120000`                          | Per-request timeout |
| `MAX_RETRIES`           | `3`                               | Retries on network errors, timeouts, 429, 500 and 529 |
| `MAX_TOOL_OUTPUT_CHARS` | `8000`                            | Tool results longer than this are truncated with a visible marker |
| `WORKSPACE_ROOT`        | current directory                 | Sandbox root for the file tools |
| `TRANSCRIPT_PATH`       | `./transcripts/<timestamp>.jsonl` | JSONL transcript file |

## Tools

| Tool       | Input                     | Returns |
| ---------- | ------------------------- | ------- |
| `get_time` | none                      | Local time in ISO 8601 with offset, plus the IANA time zone |
| `list_dir` | `path` (default `.`)      | One entry per line, directories end in `/`; capped at 200 entries |
| `read_file`| `path` (required)         | UTF-8 file contents; refuses files over 256 KB |

All tools are read-only. File tools only see paths inside `WORKSPACE_ROOT`: `..` traversal, absolute paths elsewhere, and symlinks that escape are refused. `read_file` never reads `.env` or `.env.*` files, in any directory, whatever the case, or through a symlink, because they hold secrets such as the API key. `list_dir` still shows that they exist.

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

`kind` is one of `request`, `response`, `tool_call`, `tool_result` or `error`. Request bodies and full responses (including `usage`) are logged; headers and the API key never are. If logging fails, the REPL prints one warning and carries on.

## Layout

```
src/
  types.ts        content block, message, tool and response types
  config.ts       settings from env vars with defaults
  client.ts       createAnthropicClient(): fetch + timeout + retry
  registry.ts     defineTool, createRegistry, dispatch
  agent.ts        runAgent(): the loop
  log.ts          JSONL transcript writer
  repl.ts         CLI entry point
  tools/          workspace sandboxing, get_time, list_dir, read_file
test/             unit tests (fake model, fake fetch, temp dirs)
```

Dependencies flow one way: `repl` → `agent` → `client` and `registry` → `tools`. `agent.ts` depends only on the `ModelFn` type, so another provider can be added as a new client without touching the loop.

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
